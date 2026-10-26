#include "pch.h"
#include "SADXFunctions.h"
#include "netplay.h"
#include "multiplayer.h"

#ifdef MULTI_NETPLAY
#pragma comment(lib,"ws2_32.lib")
#pragma comment(lib,"winmm.lib")
#endif

// Networking system
// Listener system originally by @michael-fadely

#define PRINT(text, ...) PrintDebug("[Multi] " text "\n", __VA_ARGS__)

bool Netplay::Send(PACKET_TYPE type, PACKET_CALL cb, PNUM player, bool reliable)
{
#ifdef MULTI_NETPLAY
	if (IsConnected())
	{
		Packet packet = Packet(type, player, reliable);

		if (!cb(packet, type, PlayerNum))
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
#endif
	return false;
}

void Netplay::RegisterListener(PACKET_TYPE type, PACKET_CALL cb)
{
#ifdef MULTI_NETPLAY
	listeners.push_back({ type, cb });
#endif
}

int Netplay::GetPlayerCount()
{
	return IsConnected() ? PlayerCount : 0;
}

int Netplay::GetPlayerNum()
{
	return PlayerNum;
}

bool Netplay::IsPlayerConnected(int pnum)
{
	return pnum >= 0 && pnum < GetPlayerCount() && pnum < PLAYER_MAX;
}

bool Netplay::IsConnected()
{
#ifdef MULTI_NETPLAY
	return m_State == State::Connected;
#else
	return false;
#endif
}

bool Netplay::IsConnecting()
{
#ifdef MULTI_NETPLAY
	return m_State == State::Connecting || m_State == State::Handshaking;
#else
	return false;
#endif
}

bool Netplay::IsServer()
{
	return m_Type == Type::Server;
}

void Netplay::ReadPacket(Packet& packet)
{
#ifdef MULTI_NETPLAY
	const auto header = packet.GetIndentifier();
	const auto sender = packet.GetSender();
	const auto receiver = packet.GetReceiver();
	if (header == UINT8_MAX || header > PACKET_OBJECT_RHINOTANK ||
		sender < 0 || sender >= PLAYER_MAX || receiver < -1 || receiver >= PLAYER_MAX)
	{
		packet.Destroy();
		return;
	}

	if (header == PACKET_PNUM)
	{
		if (!IsServer() && sender == 0 && (m_State == State::Handshaking || IsConnected()))
		{
			PNUM incoming_count = 0;
			int32_t incoming_version = 0;
			const auto assigned_player = receiver;

			if (!packet.read(incoming_count) || !packet.read(incoming_version) ||
				assigned_player < 1 || assigned_player >= PLAYER_MAX ||
				incoming_count < 2 || incoming_count > PLAYER_MAX ||
				assigned_player >= incoming_count)
			{
				last_error = Error::ConnectionFailed;
				packet.Destroy();
				Cleanup();
				return;
			}

			if (incoming_version != Version)
			{
				last_error = Error::VersionMismatch;
				PRINT("Server/client version mismatch");
				packet.Destroy();
				Cleanup();
				return;
			}

			PlayerNum = assigned_player;
			PlayerCount = incoming_count;
			m_State = State::Connected;
			last_error = Error::None;
		}

		packet.Destroy();
		return;
	}

	if (!IsConnected())
	{
		packet.Destroy();
		return;
	}

	// If we're the server, bounce packet to other peers.
	if (IsServer() && receiver != PlayerNum)
	{
		for (auto& p : m_ConnectedPeers)
		{
			auto peer_pnum = reinterpret_cast<int>(p->data);

			// Do not send back to sender.
			if (sender != peer_pnum && (receiver == -1 || receiver == peer_pnum))
			{
				packet.Send(p);
			}
		}
	}

	if (receiver == -1 || receiver == PlayerNum)
	{
		for (auto& listener : listeners)
		{
			if (header == listener.first && listener.second(packet, static_cast<PACKET_TYPE>(header), sender))
			{
				packet.Destroy();
				return;
			}
		}
	}

	packet.Destroy();
#endif
}

void Netplay::UpdatePeers()
{
#ifdef MULTI_NETPLAY
	PlayerCount = static_cast<PNUM>(m_ConnectedPeers.size() + 1);

	for (size_t i = 0; i < m_ConnectedPeers.size(); ++i)
	{
		Packet pnum_packet = Packet(PACKET_PNUM, static_cast<PNUM>(i + 1), true);
		pnum_packet << PlayerCount << Version;
		pnum_packet.Send(m_ConnectedPeers[i]);
		m_ConnectedPeers[i]->data = reinterpret_cast<void*>(i + 1);
	}
#endif
}

bool Netplay::PollMessage(PACKET_TYPE type, Packet& packet)
{
#ifdef MULTI_NETPLAY
	ENetEvent event;
	while (m_pHost && enet_host_service(m_pHost, &event, 1) > 0)
	{
		if (event.type == ENET_EVENT_TYPE_RECEIVE)
		{
			Packet incoming(event.packet);
			auto receiver = incoming.GetReceiver();

			if (incoming.GetIndentifier() == type && (PlayerNum == -1 || receiver == -1 || receiver == PlayerNum))
			{
				packet = std::move(incoming);
				return true;
			}

			ReadPacket(incoming);
		}
		else
		{
			HandleEvent(event);
		}
	}
#endif
	return false;
}

void Netplay::Poll()
{
#ifdef MULTI_NETPLAY
	if (!m_pHost || m_State == State::Stopped)
	{
		return;
	}

	ENetEvent event;
	while (m_pHost && enet_host_service(m_pHost, &event, 0) > 0)
	{
		HandleEvent(event);
	}

	if (IsConnecting() && std::chrono::steady_clock::now() >= m_ConnectionDeadline)
	{
		last_error = Error::TimedOut;
		PRINT("Timed out while connecting");
		Cleanup();
	}
#endif
}

void Netplay::HandleEvent(ENetEvent& event)
{
#ifdef MULTI_NETPLAY
	switch (event.type)
	{
	case ENET_EVENT_TYPE_CONNECT:
		if (IsServer() && m_State == State::Connected)
		{
			if (multiplayer::IsActive() || m_ConnectedPeers.size() >= PLAYER_MAX - 1)
			{
				enet_peer_disconnect(event.peer, 0);
				enet_host_flush(m_pHost);
				return;
			}

			m_ConnectedPeers.push_back(event.peer);
			UpdatePeers();
		}
		else if (!IsServer() && m_State == State::Connecting)
		{
			m_pPeer = event.peer;
			m_State = State::Handshaking;
		}
		else if (!IsServer())
		{
			enet_peer_reset(event.peer);
		}
		break;

	case ENET_EVENT_TYPE_RECEIVE:
	{
		Packet packet(event.packet);
		ReadPacket(packet);
		break;
	}

	case ENET_EVENT_TYPE_DISCONNECT:
		if (IsServer())
		{
			auto peer_position = std::find(m_ConnectedPeers.begin(), m_ConnectedPeers.end(), event.peer);
			const bool was_connected_peer = peer_position != m_ConnectedPeers.end();
			if (was_connected_peer)
			{
				m_ConnectedPeers.erase(peer_position);
			}
			event.peer->data = nullptr;

			if (was_connected_peer && m_State == State::Connected && !m_ConnectedPeers.empty() && multiplayer::IsActive())
			{
				last_error = Error::ConnectionFailed;
				PRINT("Closing the session after a player left during a match");
				for (auto* peer : m_ConnectedPeers)
				{
					enet_peer_disconnect(peer, 0);
				}
				enet_host_flush(m_pHost);
				Cleanup();
			}
			else if (was_connected_peer && m_State == State::Connected)
			{
				UpdatePeers();
			}
		}
		else
		{
			last_error = Error::ConnectionFailed;
			Cleanup();
		}
		break;
	}
#endif
}

void Netplay::Cleanup()
{
#ifdef MULTI_NETPLAY
	if (m_pPeer)
	{
		enet_peer_reset(m_pPeer);
		m_pPeer = nullptr;
	}

	if (m_pHost)
	{
		enet_host_destroy(m_pHost);
		m_pHost = nullptr;
	}

	m_ConnectedPeers.clear();
	PlayerNum = -1;
	PlayerCount = 0;
	m_State = State::Stopped;
#endif
}

bool Netplay::Create(Type type, const char* ip, unsigned __int16 port)
{
#ifdef MULTI_NETPLAY
	if (m_State != State::Stopped || m_pHost)
	{
		last_error = Error::AlreadyRunning;
		return false;
	}

	if (!m_EnetInitialized)
	{
		last_error = Error::InitializationFailed;
		return false;
	}

	m_Type = type;
	PlayerNum = -1;
	PlayerCount = 0;
	m_ConnectedPeers.clear();

	m_Address.host = ENET_HOST_ANY;
	m_Address.port = port;

	if (type == Type::Server)
	{
		m_pHost = enet_host_create(&m_Address, PLAYER_MAX - 1, MAX_CHANNEL, 0, 0);

		if (m_pHost == nullptr)
		{
			last_error = Error::ServerCreationFailed;
			PRINT("An error occurred while trying to create an ENet server host.");
			return false;
		}
		
		PlayerCount = 1;
		PlayerNum = 0;
		m_State = State::Connected;
		last_error = Error::None;
		PRINT("Created server on all interfaces at port %d", port);
		return true;
	}
	else
	{
		if (enet_address_set_host(&m_Address, ip == nullptr ? "localhost" : ip) < 0)
		{
			last_error = Error::ConnectionFailed;
			PRINT("Could not resolve the server address");
			return false;
		}
		m_Address.port = port;

		m_pHost = enet_host_create(NULL, 1, MAX_CHANNEL, 0, 0);

		if (m_pHost == nullptr)
		{
			last_error = Error::ClientCreationFailed;
			PRINT("An error occured while trying to create an ENet server host");
			return false;
		}

		m_pPeer = enet_host_connect(m_pHost, &m_Address, 2, 0);

		if (m_pPeer == nullptr)
		{
			last_error = Error::NoPeerAvailable;
			PRINT("No available peers for initializing an ENet connection");
			Cleanup();
			return false;
		}

		m_State = State::Connecting;
		m_ConnectionDeadline = std::chrono::steady_clock::now() + std::chrono::seconds(ConnectionTimeoutSeconds);
		last_error = Error::None;
		PRINT("Connecting to %s:%d", ip == nullptr ? "localhost" : ip, port);
		return true;
	}
#endif
	return false;
}

void Netplay::Exit()
{
#ifdef MULTI_NETPLAY
	if (!m_pHost)
	{
		PlayerNum = -1;
		PlayerCount = 0;
		m_State = State::Stopped;
		return;
	}

	if (IsServer())
	{
		for (auto* peer : m_ConnectedPeers)
		{
			enet_peer_disconnect(peer, 0);
		}
		enet_host_flush(m_pHost);
	}
	else if (m_pPeer && m_State != State::Connecting)
	{
		enet_peer_disconnect(m_pPeer, 0);
		enet_host_flush(m_pHost);

		const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(1000);
		ENetEvent event;
		while (m_pHost && std::chrono::steady_clock::now() < deadline && enet_host_service(m_pHost, &event, 10) > 0)
		{
			if (event.type == ENET_EVENT_TYPE_RECEIVE)
			{
				enet_packet_destroy(event.packet);
			}
			else if (event.type == ENET_EVENT_TYPE_DISCONNECT && event.peer == m_pPeer)
			{
				break;
			}
		}
	}

	Cleanup();
#endif
}

Netplay::Netplay()
{
#ifdef MULTI_NETPLAY
	if (enet_initialize() != 0)
	{
		last_error = Error::InitializationFailed;
	}
	else
	{
		m_EnetInitialized = true;
	}
#endif
}

Netplay::~Netplay()
{
#ifdef MULTI_NETPLAY
	Exit();
	if (m_EnetInitialized)
	{
		enet_deinitialize();
		m_EnetInitialized = false;
	}
#endif
}

Netplay netplay;
