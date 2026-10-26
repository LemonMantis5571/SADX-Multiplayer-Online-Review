#pragma once

#include <vector>
#include <chrono>
#include "enet/enet.h"
#include "packet.h"

class Netplay
{
public:
	enum class Type
	{
		Client,
		Server
	};

	enum class Error
	{
		None,
		InitializationFailed,
		ServerCreationFailed,
		ClientCreationFailed,
		NoPeerAvailable,
		ConnectionFailed,
		AlreadyRunning,
		TimedOut,
		VersionMismatch
	};

	enum PACKET_TYPE : uint8_t
	{
		PACKET_CUSTOM, // for mods, keep as 0
		PACKET_PNUM,

		PACKET_INPUT_BUTTONS,
		PACKET_INPUT_STICK_X,
		PACKET_INPUT_STICK_Y,
		PACKET_INPUT_ANALOG,

		PACKET_PLAYER_LOCATION,
		PACKET_PLAYER_MODE,
		PACKET_PLAYER_SMODE,
		PACKET_PLAYER_FLAG,
		PACKET_PLAYER_ANIM,
		PACKET_PLAYER_RINGS,
		PACKET_PLAYER_SCORE,
		PACKET_PLAYER_LIVES,

		PACKET_GAME_TIMER,
		PACKET_GAME_CLOCK,
		PACKET_GAME_MODE,
		PACKET_GAME_LEVEL,
		PACKET_GAME_ACTSWAP,
		PACKET_GAME_EXIT,
		PACKET_GAME_STAGECHG,
		PACKET_GAME_PAUSE,
		PACKET_GAME_RAND,

		PACKET_MENU_CONFIRM,
		PACKET_MENU_SYNC,
		PACKET_MENU_CHAR,
		PACKET_MENU_START,

		PACKET_OBJECT_RHINOTANK
	};

	using PNUM = int8_t;
	using PACKET_CALL = bool(*)(Packet& packet, Netplay::PACKET_TYPE type, Netplay::PNUM pnum);

	template<typename T>
	bool Send(PACKET_TYPE type, const T& data, PNUM player = -1, bool reliable = false)
	{
		if (!IsConnected())
		{
			return false;
		}

		Packet packet = Packet(type, player, reliable);
		if (!packet.write(data))
		{
			packet.Destroy();
			return false;
		}

		if (IsServer())
		{
			bool sent = false;
			for (auto& p : m_ConnectedPeers)
			{
				auto peer_pnum = reinterpret_cast<int>(p->data);
				if (player == -1 || player == peer_pnum)
				{
					sent = packet.Send(p) || sent;
				}
			}
			return sent;
		}
		else
		{
			return packet.Send(m_pPeer);
		}
	}

	bool Send(PACKET_TYPE type, PACKET_CALL cb, PNUM player = -1, bool reliable = false);
	void RegisterListener(PACKET_TYPE type, PACKET_CALL);

	bool PollMessage(PACKET_TYPE, Packet& packet);
	void Poll();

	int GetPlayerCount();
	int GetPlayerNum();
	bool IsPlayerConnected(int pnum);
	bool IsConnected();
	bool IsConnecting();

	bool Create(Type type, const char* address, unsigned __int16 port);
	void Exit();

	Netplay();
	~Netplay();

private:
	enum class State
	{
		Stopped,
		Connecting,
		Handshaking,
		Connected
	};

	enum PACKET_CHANNEL : enet_uint8
	{
		CHANNEL_RELIABLE,
		CHANNEL_UNRELIABLE,

		MAX_CHANNEL
	};

	struct PacketHeader
	{
		PACKET_TYPE identifier;
		PNUM player_num; // of sender, or additional identifier
	};

	static constexpr int32_t Version = 2;
	static constexpr int ConnectionTimeoutSeconds = 10;

	Error last_error = Error::None;
	Type m_Type = Type::Client;
	State m_State = State::Stopped;
	bool m_EnetInitialized = false;
	PNUM PlayerNum = -1;
	PNUM PlayerCount = 0;
	std::chrono::steady_clock::time_point m_ConnectionDeadline;

	void UpdatePeers();
	bool IsServer();
	void HandleEvent(ENetEvent&);
	void ReadPacket(Packet&);
	void Cleanup();

	std::vector<ENetPeer*> m_ConnectedPeers;
	std::vector<std::pair<PACKET_TYPE, PACKET_CALL>> listeners;

	ENetAddress m_Address;
	ENetHost* m_pHost = nullptr;
	ENetPeer* m_pPeer = nullptr;
};

extern Netplay netplay;
