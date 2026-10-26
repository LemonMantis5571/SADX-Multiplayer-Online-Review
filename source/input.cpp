#include "pch.h"
#include "SADXModLoader.h"
#include "FastFunctionHook.hpp"
#include "splitscreen.h"
#include "netplay.h"
#include "camera.h"
#include "multiplayer.h"
#include <winsock2.h>
#include <ws2tcpip.h>
#include "json.hpp"
#include "audio_tap.h"

#pragma comment(lib, "ws2_32.lib")

// Everything related to inputs
// Networking part of the code originally by @michael-fadely

DataPointer(bool*, pInputStatusForEachPlayer, 0x40F30C); // we get a pointer to `ucInputStatusForEachPlayer` since the input mod replaces the array

namespace
{
	constexpr uint16_t BrowserInputPort = 27016;
	constexpr ULONGLONG BrowserInputTimeoutMs = 900;

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

	SOCKET browserInputSocket = INVALID_SOCKET;
	bool browserWinsockStarted = false;
	BrowserPad browserPads[PLAYER_MAX]{};

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
	void ApplyBrowserPad(int index, BrowserPad& state)
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

	void ResetBrowserPad(BrowserPad& state)
	{
		state.active = false;
		state.lastUpdate = 0;
		state.buttons = 0;
		state.x1 = state.y1 = state.x2 = state.y2 = 0;
		state.neutralPending = true;
	}

	void SendModStatus(const nlohmann::json& request, const sockaddr_in& target, int targetLength)
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
				{"browserInput", browserPads[i].active},
				{"inputAgeMs", browserPads[i].active ? static_cast<int>(GetTickCount64() - browserPads[i].lastUpdate) : -1}
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
		sendto(browserInputSocket, body.c_str(), static_cast<int>(body.size()), 0,
			reinterpret_cast<const sockaddr*>(&target), targetLength);
	}

	void ReceiveBrowserPackets()
	{
		if (browserInputSocket == INVALID_SOCKET) return;

		char buffer[4096];
		for (;;)
		{
			sockaddr_in sender{};
			int senderLength = sizeof(sender);
			const int received = recvfrom(browserInputSocket, buffer, sizeof(buffer), 0,
				reinterpret_cast<sockaddr*>(&sender), &senderLength);
			if (received == SOCKET_ERROR)
			{
				const int error = WSAGetLastError();
				if (error != WSAEWOULDBLOCK) PrintDebug("[MULTI] Browser input receive failed: %d\n", error);
				break;
			}

			try
			{
				const auto request = nlohmann::json::parse(buffer, buffer + received, nullptr, false);
				if (request.is_discarded() || !request.is_object()) continue;

				const auto command = request.value("cmd", std::string());
				if (command == "status")
				{
					SendModStatus(request, sender, senderLength);
					continue;
				}
				if (command == "releaseAll")
				{
					for (auto& state : browserPads) ResetBrowserPad(state);
					continue;
				}
				if (command == "audio")
				{
					audio_tap::Request(sender, request.value("on", true));
					continue;
				}

				const int seat = request.value("seat", 0) - 1;
				if (seat < 0 || seat >= PLAYER_MAX) continue;

				auto& state = browserPads[seat];
				if (request.value("release", false))
				{
					ResetBrowserPad(state);
					continue;
				}

				const auto buttons = request.find("b");
				const auto axes = request.find("a");
				state.buttons = buttons != request.end() && buttons->is_object() ? ReadButtons(*buttons) : 0;
				state.x1 = axes != request.end() && axes->is_object() ? AxisToSADX(JsonAxis(*axes, "lx")) : 0;
				state.y1 = axes != request.end() && axes->is_object() ? AxisToSADX(JsonAxis(*axes, "ly")) : 0;
				state.x2 = axes != request.end() && axes->is_object() ? AxisToSADX(JsonAxis(*axes, "rx")) : 0;
				state.y2 = axes != request.end() && axes->is_object() ? AxisToSADX(JsonAxis(*axes, "ry")) : 0;
				state.active = true;
				state.neutralPending = false;
				state.lastUpdate = GetTickCount64();
			}
			catch (const std::exception& e)
			{
				PrintDebug("[MULTI] Browser input packet ignored: %s\n", e.what());
			}
		}
	}

	void ApplyBrowserInputs()
	{
#ifdef MULTI_NETPLAY
		if (netplay.IsConnected()) return;
#endif
		if (!multiplayer::IsEnabled())
		{
			for (auto& state : browserPads)
				if (state.active) ResetBrowserPad(state);
			return;
		}
		const auto now = GetTickCount64();
		for (int i = 0; i < PLAYER_MAX; ++i)
		{
			auto& state = browserPads[i];
			if (state.active && now - state.lastUpdate > BrowserInputTimeoutMs)
			{
				state.buttons = 0;
				state.x1 = state.y1 = state.x2 = state.y2 = 0;
				state.active = false;
				state.neutralPending = true;
			}
			if (state.active || state.neutralPending)
			{
				ApplyBrowserPad(i, state);
				state.neutralPending = false;
			}
		}
	}
}

static void InitBrowserInput()
{
	WSADATA data{};
	const int startup = WSAStartup(MAKEWORD(2, 2), &data);
	if (startup != 0)
	{
		PrintDebug("[MULTI] Browser input WSAStartup failed: %d\n", startup);
		return;
	}
	browserWinsockStarted = true;

	browserInputSocket = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
	if (browserInputSocket == INVALID_SOCKET)
	{
		PrintDebug("[MULTI] Browser input socket failed: %d\n", WSAGetLastError());
		return;
	}

	sockaddr_in address{};
	address.sin_family = AF_INET;
	address.sin_port = htons(BrowserInputPort);
	address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
	if (bind(browserInputSocket, reinterpret_cast<const sockaddr*>(&address), sizeof(address)) == SOCKET_ERROR)
	{
		PrintDebug("[MULTI] Browser input could not bind 127.0.0.1:%u: %d\n", BrowserInputPort, WSAGetLastError());
		closesocket(browserInputSocket);
		browserInputSocket = INVALID_SOCKET;
		return;
	}

	u_long nonBlocking = 1;
	if (ioctlsocket(browserInputSocket, FIONBIO, &nonBlocking) == SOCKET_ERROR)
	{
		PrintDebug("[MULTI] Browser input could not enable nonblocking mode: %d\n", WSAGetLastError());
		closesocket(browserInputSocket);
		browserInputSocket = INVALID_SOCKET;
		return;
	}

	PrintDebug("[MULTI] Browser input listening on 127.0.0.1:%u\n", BrowserInputPort);
}

void ShutdownBrowserInput()
{
	if (browserInputSocket != INVALID_SOCKET)
	{
		closesocket(browserInputSocket);
		browserInputSocket = INVALID_SOCKET;
	}
	if (browserWinsockStarted)
	{
		WSACleanup();
		browserWinsockStarted = false;
	}
}

#ifdef MULTI_NETPLAY
static SONIC_INPUT net_analogs[PLAYER_MAX]{};
static PDS_PERIPHERAL net_pers[PLAYER_MAX]{};
#endif

FastFunctionHook<void, Sint8> PadReadOnP_hook(0x40EF70);
FastFunctionHook<void, Sint8> PadReadOffP_hook(0x40EFA0);
FastFunctionHook<void>        GetPlayersInputData_hook(0x40F170);

static void __cdecl PadReadOnP_r(int8_t pnum)
{
	if (!multiplayer::IsActive())
	{
		PadReadOnP_hook.Original(pnum);
		return;
	}

	if (pnum == -1)
	{
		for (int i = 0; i < PLAYER_MAX; ++i)
		{
			pInputStatusForEachPlayer[i] = TRUE;
		}
	}
	else
	{
		pInputStatusForEachPlayer[pnum] = TRUE;
	}
}

static void __cdecl PadReadOffP_r(int8_t pnum)
{
	if (!multiplayer::IsActive())
	{
		PadReadOffP_hook.Original(pnum);
		return;
	}

	if (pnum < 0)
	{
		for (int i = 0; i < PLAYER_MAX; ++i)
		{
			pInputStatusForEachPlayer[i] = FALSE;
		}
	}
	else
	{
		pInputStatusForEachPlayer[pnum] = FALSE;
	}
}

// Patch analog forward calculation to use multiplayer cameras
static void __cdecl GetPlayersInputData_r()
{
	if (!splitscreen::IsActive())
	{
		GetPlayersInputData_hook.Original();
		return;
	}

	for (int i = 0; i < PLAYER_MAX; ++i)
	{
		auto controller = per[i];
		Float lx = (Float)(controller->x1 << 8); // left stick x
		Float ly = (Float)(controller->y1 << 8); // left stick y

		Angle ang;
		Float strk;

		if (lx > 3072.0f || lx < -3072.0f || ly > 3072.0f || ly < -3072.0f)
		{
			lx = lx <= 3072.0f ? (lx >= -3072.0f ? 0.0f : lx + 3072.0f) : lx - 3072.0f;
			ly = ly <= 3072.0f ? (ly >= -3072.0f ? 0.0f : ly + 3072.0f) : ly - 3072.0f;

			auto cam_ang = GetCameraAngle(i);

			if (cam_ang)
			{
				ang = -cam_ang->y - -njArcTan2(ly, lx);
			}
			else
			{
				ang = njArcTan2(ly, lx);
			}

			Float magnitude = ly * ly + lx * lx;
			strk = njSqrt(magnitude) * magnitude * 3.9187027e-14;
			if (strk > 1.0f)
			{
				strk = 1.0f;
			}
		}
		else
		{
			strk = 0.0f;
			ang = 0;
		}

		input_data[i] = { ang, strk };

		if (ucInputStatus == TRUE && pInputStatusForEachPlayer[i])
		{
			input_dataG[i] = input_data[i];
		}
		else
		{
			input_dataG[i] = {};
		}
	}
}

unsigned int GetPressedButtons(int pnum)
{
	return PressedButtons[pnum];
}

unsigned int GetPressedButtons()
{
	unsigned int buttons = 0;
	for (int i = 0; i < PLAYER_MAX; ++i)
	{
		buttons |= GetPressedButtons(i);
	}
	return buttons;
}

bool MenuSelectButtonsPressedM(int pnum)
{
	return (GetPressedButtons(pnum) & (Buttons_Start | Buttons_A));
}

bool MenuSelectButtonsPressedM()
{
	return (GetPressedButtons() & (Buttons_Start | Buttons_A));
}

bool MenuBackButtonsPressedM(int pnum)
{
	return (GetPressedButtons(pnum) & (Buttons_X | Buttons_B));
}

bool MenuBackButtonsPressedM()
{
	return (GetPressedButtons() & (Buttons_X | Buttons_B));
}

#ifdef MULTI_NETPLAY
static bool InputListener(Packet& packet, Netplay::PACKET_TYPE type, Netplay::PNUM pnum)
{
	switch (type)
	{
	case Netplay::PACKET_INPUT_BUTTONS:
		packet >> net_pers[pnum].on;
		net_pers[pnum].on &= ~Buttons_Start;
		return true;
	case Netplay::PACKET_INPUT_STICK_X:
		packet >> net_pers[pnum].x1 >> net_pers[pnum].x2;
		return true;
	case Netplay::PACKET_INPUT_STICK_Y:
		packet >> net_pers[pnum].y1 >> net_pers[pnum].y2;
		return true;
	case Netplay::PACKET_INPUT_ANALOG:
		packet >> net_analogs[pnum];
		return true;
	default:
		return false;
	}
}

static bool InputSender(Packet& packet, Netplay::PACKET_TYPE type, Netplay::PNUM pnum)
{
	switch (type)
	{
	case Netplay::PACKET_INPUT_BUTTONS:
		packet << net_pers[pnum].on;
		return true;
	case Netplay::PACKET_INPUT_STICK_X:
		packet << net_pers[pnum].x1 << net_pers[pnum].x2;
		return true;
	case Netplay::PACKET_INPUT_STICK_Y:
		packet << net_pers[pnum].y1 << net_pers[pnum].y2;
		return true;
	case Netplay::PACKET_INPUT_ANALOG:
		packet << net_analogs[pnum];
		return true;
	default:
		return false;
	}
}
#endif

void InitInputPatches()
{
	InitBrowserInput();

	// Enable inputs for the other players
	for (int i = 2; i < PLAYER_MAX; i++)
	{
		pInputStatusForEachPlayer[i] = TRUE;
	}

	PadReadOnP_hook.Hook(PadReadOnP_r);
	PadReadOffP_hook.Hook(PadReadOffP_r);
	GetPlayersInputData_hook.Hook(GetPlayersInputData_r);

	// Fix relevant PadReadOnP calls that pass 2 or 3 instead of -1
	WriteData((uint8_t*)0x40C336, 0xFFui8);
	WriteData((uint8_t*)0x40C34B, 0xFFui8);
	WriteData((uint8_t*)0x40C378, 0xFFui8);
	WriteData((uint8_t*)0x40C3FA, 0xFFui8);
	WriteData((uint8_t*)0x413D0F, 0xFFui8);

#ifdef MULTI_NETPLAY
	netplay.RegisterListener(Netplay::PACKET_INPUT_BUTTONS, InputListener);
	netplay.RegisterListener(Netplay::PACKET_INPUT_STICK_X, InputListener);
	netplay.RegisterListener(Netplay::PACKET_INPUT_STICK_Y, InputListener);
	netplay.RegisterListener(Netplay::PACKET_INPUT_ANALOG, InputListener);
#endif
}

extern "C"
{
	__declspec(dllexport) void __cdecl OnInput()
	{
		static bool first_input_logged = false;
		if (!first_input_logged)
		{
			PrintDebug("[MULTI] First input callback reached\n");
			first_input_logged = true;
		}

		ReceiveBrowserPackets();

#ifdef MULTI_NETPLAY
		if (!netplay.IsConnected())
		{
			ApplyBrowserInputs();
			return;
		}

		// Move first controller inputs to proper player
		if (netplay.GetPlayerNum() != 0)
		{
			*per[netplay.GetPlayerNum()] = *per[0];
			*per[0] = {};
		}

		// Update local/online controller data
		for (int i = 0; i < PLAYER_MAX; ++i)
		{
			auto orig = *per[0];
			auto local_per = per[i];
			auto& net_per = net_pers[i];

			if (i == netplay.GetPlayerNum())
			{
				if (local_per->press || local_per->release)
				{
					net_per.on = local_per->on;
					netplay.Send(Netplay::PACKET_INPUT_BUTTONS, InputSender);
				}

				if (local_per->x1 != net_per.x1 || local_per->x2 != net_per.x2)
				{
					net_per.x1 = local_per->x1;
					net_per.x2 = local_per->x2;
					netplay.Send(Netplay::PACKET_INPUT_STICK_X, InputSender);
				}

				if (local_per->y1 != net_per.y1 || local_per->y2 != net_per.y2)
				{
					net_per.y1 = local_per->y1;
					net_per.y2 = local_per->y2;
					netplay.Send(Netplay::PACKET_INPUT_STICK_Y, InputSender);
				}
			}
			else
			{
				local_per->x1 = net_per.x1;
				local_per->x2 = net_per.x2;
				local_per->y1 = net_per.y1;
				local_per->y2 = net_per.y2;

				local_per->on = net_per.on;
				local_per->off = ~local_per->on;

				const auto mask = local_per->on ^ net_per.old;
				local_per->release = net_per.old & mask;
				local_per->press = local_per->on & mask;

				net_per.old = local_per->old = local_per->on;

				local_per->l = local_per->on & Buttons_L ? UCHAR_MAX : 0;
				local_per->r = local_per->on & Buttons_R ? UCHAR_MAX : 0;
			}
		}
#endif
		ApplyBrowserInputs();
	}

	__declspec(dllexport) void __cdecl OnControl()
	{
		// Allow input from the rest of the players
		for (int i = 2; i < PLAYER_MAX; i++)
		{
			if (CheckPadReadModeP(i))
			{
				perG[i] = *per[i];
			}
			else
			{
				perG[i] = {};
			}
		}

#ifdef MULTI_NETPLAY
		// Update netplay analog data
		if (netplay.IsConnected())
		{
			// Move first controller analog to proper player
			if (netplay.GetPlayerNum() != 0)
			{
				input_data[netplay.GetPlayerNum()] = input_data[0];
				input_data[0] = {};
			}

			for (auto i = 0; i < PLAYER_MAX; i++)
			{
				auto& current = input_dataG[i];
				auto& net_analog = net_analogs[i];

				if (i == netplay.GetPlayerNum())
				{
					if (current.angle != net_analog.angle || std::abs(current.stroke - net_analog.stroke) >= std::numeric_limits<float>::epsilon())
					{
						net_analog = current;
						netplay.Send(Netplay::PACKET_INPUT_ANALOG, InputSender);
					}
				}
				else
				{
					input_dataG[i] = net_analog;
				}
			}
		}
#endif
	}
}
