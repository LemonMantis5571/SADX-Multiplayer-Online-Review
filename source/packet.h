#pragma once

#include <cstring>
#include <utility>
#include "enet/enet.h"

class Packet
{
private:
	size_t position = 0;
	bool sent = false;
	bool m_reliable = false;
	bool m_received = false;
	ENetPacket* m_packet = nullptr;

	int8_t sender = -1;
	int8_t recipient = -1;
	uint8_t m_identifier = 0;

public:
	Packet() {};
	Packet(uint8_t identifier, int8_t to = -1, bool reliable = false);
	Packet(ENetPacket* packet);
	Packet(const Packet&) = delete;
	Packet& operator=(const Packet&) = delete;
	Packet(Packet&& other) noexcept;
	Packet& operator=(Packet&& other) noexcept;
	~Packet();

	void Destroy();

	uint8_t GetIndentifier();
	int8_t GetSender();
	int8_t GetReceiver();

	bool Send(ENetPeer* peer);

	size_t size();

	uint8_t* at(size_t);
	uint8_t* operator[](size_t);

	template<typename T>
	bool read(T& data)
	{
#ifdef MULTI_NETPLAY
		if (!m_packet)
		{
			return false;
		}

		auto end_pos = position + sizeof(T);

		if (end_pos <= m_packet->dataLength)
		{
			std::memcpy(&data, m_packet->data + position, sizeof(T));
			position = end_pos;
			return true;
		}
		else
		{
			return false;
		}
#else
		return false;
#endif
	}

	template<typename T>
	bool write(const T& data)
	{
#ifdef MULTI_NETPLAY
		if (!m_packet)
		{
			return false;
		}

		auto end_pos = position + sizeof(T);

		if (end_pos > m_packet->dataLength)
		{
			if (enet_packet_resize(m_packet, end_pos) < 0)
			{
				return false;
			}
		}

		std::memcpy(m_packet->data + position, &data, sizeof(T));
		position = end_pos;
		return true;
#else
		return false;
#endif
	}

	template<typename T>
	Packet& operator<<(const T& data)
	{
		write(data);
		return *this;
	}

	template<typename T>
	Packet& operator>>(T& data)
	{
		read(data);
		return *this;
	}
};
