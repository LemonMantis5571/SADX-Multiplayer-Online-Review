#include "pch.h"
#include "netplay.h"
#include "packet.h"

Packet::Packet(uint8_t identifier, int8_t to, bool reliable)
{
#ifdef MULTI_NETPLAY
	m_packet = enet_packet_create(NULL, sizeof(identifier) + sizeof(to), reliable ? ENET_PACKET_FLAG_RELIABLE : 0);
	m_reliable = reliable;
	sender = netplay.GetPlayerNum();
	recipient = to;

	int8_t address = (((((uint8_t)(sender)) << 4) & 0xF0) | ((uint8_t)(recipient + 1)) & 0x0F);
	*this << address << identifier;
#endif
}

Packet::Packet(ENetPacket* packet)
{
#ifdef MULTI_NETPLAY
	m_packet = packet;
	if (!m_packet)
	{
		return;
	}

	m_received = true;
	m_reliable = packet->flags & ENET_PACKET_FLAG_RELIABLE;

	int8_t address = 0;
	if (!read(address) || !read(m_identifier))
	{
		m_identifier = UINT8_MAX;
		return;
	}

	sender = ((address & 0xF0) >> 4);
	recipient = (address & 0x0F) - 1;
#endif
}

Packet::Packet(Packet&& other) noexcept
	: position(other.position),
	  sent(other.sent),
	  m_reliable(other.m_reliable),
	  m_received(other.m_received),
	  m_packet(other.m_packet),
	  sender(other.sender),
	  recipient(other.recipient),
	  m_identifier(other.m_identifier)
{
	other.m_packet = nullptr;
	other.sent = false;
	other.m_received = false;
}

Packet& Packet::operator=(Packet&& other) noexcept
{
	if (this != &other)
	{
		Destroy();
		position = other.position;
		sent = other.sent;
		m_reliable = other.m_reliable;
		m_received = other.m_received;
		m_packet = other.m_packet;
		sender = other.sender;
		recipient = other.recipient;
		m_identifier = other.m_identifier;

		other.m_packet = nullptr;
		other.sent = false;
		other.m_received = false;
	}

	return *this;
}

Packet::~Packet()
{
	Destroy();
}

void Packet::Destroy()
{
#ifdef MULTI_NETPLAY
	if (m_packet && (m_received || !sent))
	{
		enet_packet_destroy(m_packet);
	}
	m_packet = nullptr;
#endif
}

uint8_t Packet::GetIndentifier()
{
	return m_identifier;
}

int8_t Packet::GetSender()
{
	return sender;
}

int8_t Packet::GetReceiver()
{
	return recipient;
}

bool Packet::Send(ENetPeer* peer)
{
#ifdef MULTI_NETPLAY
	if (!m_packet || !peer)
	{
		return false;
	}

	const bool succeeded = enet_peer_send(peer, m_reliable ? 1 : 0, m_packet) == 0;
	sent = sent || succeeded;
	return succeeded;
#else
	return false;
#endif
}

size_t Packet::size()
{
	return m_packet ? m_packet->dataLength : 0;
}

uint8_t* Packet::at(size_t position)
{
	if (position < size())
	{
		return (BYTE*)(m_packet->data + position);
	}
	else
	{
		return nullptr;
	}
}

uint8_t* Packet::operator[](size_t position)
{
	return at(position);
}
