#include "pch.h"
#include "SADXModLoader.h"
#include "splitscreen.h"
#include "multiplayer.h"
#ifdef MULTI_NETPLAY
#include "netplay.h"
#endif
#include <winsock2.h>
#include <ws2tcpip.h>
#include "json.hpp"
#include "audio_tap.h"
#include "browser_bridge.h"

namespace browser_bridge
{
	namespace
	{
		constexpr uint16_t Port = 27016;
		constexpr ULONGLONG TimeoutMs = 900; // a seat whose state isn't renewed goes neutral

		struct BrowserPad
		{
			bool active = false;
			bool neutralPending = false;
			ULONGLONG lastUpdate = 0;
			uint32_t buttons = 0;
			uint32_t oldButtons = 0;
			int16_t x1 = 0;
			int16_t y1 = 0;
			int16_t x2 = 0;
			int16_t y2 = 0;
		};

		SOCKET bridgeSocket = INVALID_SOCKET;
		bool winsockStarted = false;
		BrowserPad pads[PLAYER_MAX]{};

		bool JsonBool(const nlohmann::json& obj, const char* name)
		{
			const auto it = obj.find(name);
			return it != obj.end() && it->is_boolean() && it->get<bool>();
		}

		float JsonAxis(const nlohmann::json& obj, const char* name)
		{
			const auto it = obj.find(name);
			if (it == obj.end() || !it->is_number()) return 0.0f;
			const float value = it->get<float>();
			return value < -1.0f ? -1.0f : value > 1.0f ? 1.0f : value;
		}

		int16_t AxisToSADX(float value)
		{
			const float scaled = value * 127.0f;
			return static_cast<int16_t>(scaled < 0.0f ? scaled - 0.5f : scaled + 0.5f);
		}

		uint32_t ReadButtons(const nlohmann::json& buttons)
		{
			uint32_t result = 0;
			if (JsonBool(buttons, "a")) result |= Buttons_A;
			if (JsonBool(buttons, "b")) result |= Buttons_B;
			if (JsonBool(buttons, "x")) result |= Buttons_X;
			if (JsonBool(buttons, "y")) result |= Buttons_Y;
			if (JsonBool(buttons, "up")) result |= Buttons_Up;
			if (JsonBool(buttons, "down")) result |= Buttons_Down;
			if (JsonBool(buttons, "left")) result |= Buttons_Left;
			if (JsonBool(buttons, "right")) result |= Buttons_Right;
			if (JsonBool(buttons, "lb") || JsonBool(buttons, "lt")) result |= Buttons_L;
			if (JsonBool(buttons, "rb") || JsonBool(buttons, "rt")) result |= Buttons_R;
			if (JsonBool(buttons, "start")) result |= Buttons_Start;
			if (JsonBool(buttons, "back")) result |= Buttons_D;
			return result;
		}

		// The browser's input adds to what the game already read this frame from the host PC's keyboard or
		// controller (OnInput runs after that): a seat held by a browser page, even an idle one, doesn't lock
		// out whoever plays that character on the host.
		void ApplyPad(int index, BrowserPad& state)
		{
			auto controller = per[index];
			if (!controller) return;

			const auto stick = [](int16_t browser, int16_t host) { return browser != 0 ? browser : host; };
			const auto buttons = state.buttons | controller->on;
			controller->x1 = stick(state.x1, controller->x1);
			controller->y1 = stick(state.y1, controller->y1);
			controller->x2 = stick(state.x2, controller->x2);
			controller->y2 = stick(state.y2, controller->y2);
			controller->on = buttons;
			controller->off = ~buttons;
			const auto changed = state.oldButtons ^ buttons;
			controller->press = changed & buttons;
			controller->release = changed & state.oldButtons;
			controller->old = buttons;
			if (buttons & Buttons_L) controller->l = 0xFF;
			if (buttons & Buttons_R) controller->r = 0xFF;
			state.oldButtons = buttons;
		}

		void ResetPad(BrowserPad& state)
		{
			state.active = false;
			state.lastUpdate = 0;
			state.buttons = 0;
			state.x1 = state.y1 = state.x2 = state.y2 = 0;
			state.neutralPending = true;
		}

		void SendStatus(const nlohmann::json& request, const sockaddr_in& target, int targetLength)
		{
			nlohmann::json response = {
				{"t", "mod_status"},
				{"id", request.value("id", std::string())},
				{"multiplayerEnabled", multiplayer::IsEnabled()},
				{"multiplayerActive", multiplayer::IsActive()},
				{"playerCount", multiplayer::GetPlayerCount()},
				{"gameMode", static_cast<int>(GameMode)},
				{"stage", static_cast<int>(ssStageNumber)},
				{"splitscreen", splitscreen::IsActive()},
				{"players", nlohmann::json::array()}
			};

			for (int i = 0; i < PLAYER_MAX; ++i)
			{
				nlohmann::json player = {
					{"seat", i + 1},
					{"character", multiplayer::GetCharacter(i)},
					{"browserInput", pads[i].active},
					{"inputAgeMs", pads[i].active ? static_cast<int>(GetTickCount64() - pads[i].lastUpdate) : -1}
				};
				// This player's part of the window (fractions), so the gateway can stream it on its own.
				// Outside split-screen (menus, cutscenes) the whole window is one view and there is none.
				if (splitscreen::IsActive() && splitscreen::IsScreenEnabled(i))
				{
					if (const auto* ratio = splitscreen::GetScreenRatio(i))
						player["screen"] = { ratio->x, ratio->y, ratio->w, ratio->h };
				}
				if (playertwp[i])
				{
					player["x"] = playertwp[i]->pos.x;
					player["y"] = playertwp[i]->pos.y;
					player["z"] = playertwp[i]->pos.z;
				}
				response["players"].push_back(player);
			}

			const auto body = response.dump();
			sendto(bridgeSocket, body.c_str(), static_cast<int>(body.size()), 0,
				reinterpret_cast<const sockaddr*>(&target), targetLength);
		}
	}

	void Init()
	{
		WSADATA data{};
		const int startup = WSAStartup(MAKEWORD(2, 2), &data);
		if (startup != 0)
		{
			PrintDebug("[ONLINE] Browser bridge WSAStartup failed: %d\n", startup);
			return;
		}
		winsockStarted = true;

		bridgeSocket = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
		if (bridgeSocket == INVALID_SOCKET)
		{
			PrintDebug("[ONLINE] Browser bridge socket failed: %d\n", WSAGetLastError());
			return;
		}

		sockaddr_in address{};
		address.sin_family = AF_INET;
		address.sin_port = htons(Port);
		address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
		if (bind(bridgeSocket, reinterpret_cast<const sockaddr*>(&address), sizeof(address)) == SOCKET_ERROR)
		{
			PrintDebug("[ONLINE] Browser bridge could not bind 127.0.0.1:%u: %d\n", Port, WSAGetLastError());
			closesocket(bridgeSocket);
			bridgeSocket = INVALID_SOCKET;
			return;
		}

		u_long nonBlocking = 1;
		if (ioctlsocket(bridgeSocket, FIONBIO, &nonBlocking) == SOCKET_ERROR)
		{
			PrintDebug("[ONLINE] Browser bridge could not enable nonblocking mode: %d\n", WSAGetLastError());
			closesocket(bridgeSocket);
			bridgeSocket = INVALID_SOCKET;
			return;
		}

		PrintDebug("[ONLINE] Browser bridge listening on 127.0.0.1:%u\n", Port);
	}

	void Shutdown()
	{
		if (bridgeSocket != INVALID_SOCKET)
		{
			closesocket(bridgeSocket);
			bridgeSocket = INVALID_SOCKET;
		}
		if (winsockStarted)
		{
			WSACleanup();
			winsockStarted = false;
		}
	}

	void Receive()
	{
		if (bridgeSocket == INVALID_SOCKET) return;

		char buffer[4096];
		for (;;)
		{
			sockaddr_in sender{};
			int senderLength = sizeof(sender);
			const int received = recvfrom(bridgeSocket, buffer, sizeof(buffer), 0,
				reinterpret_cast<sockaddr*>(&sender), &senderLength);
			if (received == SOCKET_ERROR)
			{
				const int error = WSAGetLastError();
				if (error != WSAEWOULDBLOCK) PrintDebug("[ONLINE] Browser bridge receive failed: %d\n", error);
				break;
			}

			try
			{
				const auto request = nlohmann::json::parse(buffer, buffer + received, nullptr, false);
				if (request.is_discarded() || !request.is_object()) continue;

				const auto command = request.value("cmd", std::string());
				if (command == "status")
				{
					SendStatus(request, sender, senderLength);
					continue;
				}
				if (command == "releaseAll")
				{
					for (auto& state : pads) ResetPad(state);
					continue;
				}
				if (command == "audio")
				{
					audio_tap::Request(sender, request.value("on", true));
					continue;
				}

				const int seat = request.value("seat", 0) - 1;
				if (seat < 0 || seat >= PLAYER_MAX) continue;

				auto& state = pads[seat];
				if (request.value("release", false))
				{
					ResetPad(state);
					continue;
				}

				const auto buttons = request.find("b");
				const auto axes = request.find("a");
				const bool hasAxes = axes != request.end() && axes->is_object();
				state.buttons = buttons != request.end() && buttons->is_object() ? ReadButtons(*buttons) : 0;
				state.x1 = hasAxes ? AxisToSADX(JsonAxis(*axes, "lx")) : 0;
				state.y1 = hasAxes ? AxisToSADX(JsonAxis(*axes, "ly")) : 0;
				state.x2 = hasAxes ? AxisToSADX(JsonAxis(*axes, "rx")) : 0;
				state.y2 = hasAxes ? AxisToSADX(JsonAxis(*axes, "ry")) : 0;
				state.active = true;
				state.neutralPending = false;
				state.lastUpdate = GetTickCount64();
			}
			catch (const std::exception& e)
			{
				PrintDebug("[ONLINE] Browser bridge packet ignored: %s\n", e.what());
			}
		}
	}

	void Apply()
	{
#ifdef MULTI_NETPLAY
		if (netplay.IsConnected()) return;
#endif
		if (!multiplayer::IsEnabled())
		{
			for (auto& state : pads)
				if (state.active) ResetPad(state);
			return;
		}
		const auto now = GetTickCount64();
		for (int i = 0; i < PLAYER_MAX; ++i)
		{
			auto& state = pads[i];
			if (state.active && now - state.lastUpdate > TimeoutMs)
			{
				state.buttons = 0;
				state.x1 = state.y1 = state.x2 = state.y2 = 0;
				state.active = false;
				state.neutralPending = true;
			}
			if (state.active || state.neutralPending)
			{
				ApplyPad(i, state);
				state.neutralPending = false;
			}
		}
	}
}
