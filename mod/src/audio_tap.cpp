#include "pch.h"
#include <winsock2.h>
#include <ws2tcpip.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <atomic>
#include <cstring>
#include <mutex>
#include <thread>
#include <unordered_map>
#include "audio_tap.h"

// The game's sound for the browser gateway.
//
// Windows' per-process loopback capture hears only silence from SADX (its BASS/DirectSound stream isn't
// attributed to the process), so the sound is taken from inside instead: on Vista and later DirectSound
// mixes into a shared-mode WASAPI stream in this process, and every buffer it hands to Windows
// (IAudioRenderClient::ReleaseBuffer) is the final mix of music, effects and voices. The vtables of
// the WASAPI client classes are shared by every instance, so patching them through a probe client of our
// own catches the game's stream too. While the gateway keeps asking, each released buffer is sent to it
// over UDP: a 16-byte header ("SAUD", sequence, rate, channels, bits, float) and the samples as they are.
namespace audio_tap
{
	namespace
	{
		using InitializeFn = HRESULT(STDMETHODCALLTYPE*)(IAudioClient*, AUDCLNT_SHAREMODE, DWORD, REFERENCE_TIME, REFERENCE_TIME, const WAVEFORMATEX*, LPCGUID);
		using GetServiceFn = HRESULT(STDMETHODCALLTYPE*)(IAudioClient*, REFIID, void**);
		using GetBufferFn = HRESULT(STDMETHODCALLTYPE*)(IAudioRenderClient*, UINT32, BYTE**);
		using ReleaseBufferFn = HRESULT(STDMETHODCALLTYPE*)(IAudioRenderClient*, UINT32, DWORD);

		InitializeFn originalInitialize = nullptr;
		GetServiceFn originalGetService = nullptr;
		GetBufferFn originalGetBuffer = nullptr;
		ReleaseBufferFn originalReleaseBuffer = nullptr;

		struct Format
		{
			DWORD rate = 0;
			WORD channels = 0;
			WORD bits = 0;
			bool isFloat = false;
		};

		struct Stream
		{
			Format format;
			BYTE* data = nullptr; // from GetBuffer, valid until ReleaseBuffer
		};

		std::mutex lock;
		std::unordered_map<IAudioClient*, Format> clientFormats;
		std::unordered_map<IAudioRenderClient*, Stream> streams;
		Format mixFormat; // for a stream opened before the hooks (shared mode uses the mix format)

		SOCKET tapSocket = INVALID_SOCKET;
		sockaddr_in target{};
		std::atomic<ULONGLONG> sendUntil{ 0 };
		uint32_t sequence = 0;

		// The one stream sent to the gateway: the first to hand Windows a buffer, the game's own, open from boot.
		// A second stream in the process (another audio library) would interleave with it into noise; if this
		// one stops releasing buffers for a while, the next stream that does takes over.
		IAudioRenderClient* chosen = nullptr;
		ULONGLONG chosenLast = 0;
		constexpr ULONGLONG SwitchAfterMs = 500;

		constexpr ULONGLONG RequestLifetimeMs = 5000;
		constexpr int MaxPayload = 32 * 1024;
		const GUID SubtypeFloat = { 0x00000003, 0x0000, 0x0010, { 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71 } };

		Format ReadFormat(const WAVEFORMATEX* fmt)
		{
			Format f;
			f.rate = fmt->nSamplesPerSec;
			f.channels = fmt->nChannels;
			f.bits = fmt->wBitsPerSample;
			f.isFloat = fmt->wFormatTag == WAVE_FORMAT_IEEE_FLOAT;
			if (fmt->wFormatTag == WAVE_FORMAT_EXTENSIBLE && fmt->cbSize >= 22)
				f.isFloat = reinterpret_cast<const WAVEFORMATEXTENSIBLE*>(fmt)->SubFormat == SubtypeFloat;
			return f;
		}

		void Send(const Format& f, const BYTE* data, UINT32 frames, bool silent)
		{
			if (tapSocket == INVALID_SOCKET || !f.rate || !f.channels || !f.bits) return;
			sockaddr_in to;
			{
				std::lock_guard<std::mutex> guard(lock);
				to = target;
			}
			const int frameBytes = f.channels * f.bits / 8;
			int remaining = static_cast<int>(frames) * frameBytes;
			const int chunk = (MaxPayload / frameBytes) * frameBytes;
			char packet[16 + MaxPayload];
			int offset = 0;
			while (remaining > 0)
			{
				const int bytes = remaining < chunk ? remaining : chunk;
				std::memcpy(packet, "SAUD", 4);
				const uint32_t seq = sequence++;
				std::memcpy(packet + 4, &seq, 4);
				std::memcpy(packet + 8, &f.rate, 4);
				packet[12] = static_cast<char>(f.channels);
				packet[13] = static_cast<char>(f.bits);
				packet[14] = f.isFloat ? 1 : 0;
				packet[15] = 0;
				if (silent || !data) std::memset(packet + 16, 0, bytes);
				else std::memcpy(packet + 16, data + offset, bytes);
				sendto(tapSocket, packet, 16 + bytes, 0, reinterpret_cast<const sockaddr*>(&to), sizeof(to));
				offset += bytes;
				remaining -= bytes;
			}
		}

		HRESULT STDMETHODCALLTYPE Initialize_r(IAudioClient* self, AUDCLNT_SHAREMODE mode, DWORD flags, REFERENCE_TIME duration,
			REFERENCE_TIME periodicity, const WAVEFORMATEX* format, LPCGUID session)
		{
			const HRESULT hr = originalInitialize(self, mode, flags, duration, periodicity, format, session);
			if (SUCCEEDED(hr) && format && !(flags & AUDCLNT_STREAMFLAGS_LOOPBACK))
			{
				std::lock_guard<std::mutex> guard(lock);
				clientFormats[self] = ReadFormat(format);
			}
			return hr;
		}

		HRESULT STDMETHODCALLTYPE GetService_r(IAudioClient* self, REFIID iid, void** out)
		{
			const HRESULT hr = originalGetService(self, iid, out);
			if (SUCCEEDED(hr) && out && *out && IsEqualIID(iid, __uuidof(IAudioRenderClient)))
			{
				std::lock_guard<std::mutex> guard(lock);
				const auto known = clientFormats.find(self);
				streams[static_cast<IAudioRenderClient*>(*out)].format = known != clientFormats.end() ? known->second : mixFormat;
			}
			return hr;
		}

		HRESULT STDMETHODCALLTYPE GetBuffer_r(IAudioRenderClient* self, UINT32 frames, BYTE** data)
		{
			const HRESULT hr = originalGetBuffer(self, frames, data);
			if (SUCCEEDED(hr) && data)
			{
				std::lock_guard<std::mutex> guard(lock);
				auto& stream = streams[self];
				if (!stream.format.rate) stream.format = mixFormat;
				stream.data = *data;
			}
			return hr;
		}

		HRESULT STDMETHODCALLTYPE ReleaseBuffer_r(IAudioRenderClient* self, UINT32 frames, DWORD flags)
		{
			// The buffer is only ours until it's released: copy it out first.
			const ULONGLONG now = GetTickCount64();
			bool send = false;
			Stream stream;
			{
				std::lock_guard<std::mutex> guard(lock);
				if (!chosen || chosen == self || now - chosenLast > SwitchAfterMs) chosen = self;
				if (chosen == self)
				{
					chosenLast = now;
					send = frames && now < sendUntil.load();
					const auto found = streams.find(self);
					if (send && found != streams.end()) stream = found->second;
				}
			}
			if (send) Send(stream.format, stream.data, frames, (flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0);
			return originalReleaseBuffer(self, frames, flags);
		}

		template<typename T>
		void PatchSlot(void** vtable, int index, T replacement, T& original)
		{
			if (vtable[index] == reinterpret_cast<void*>(replacement)) return;
			DWORD protect;
			if (!VirtualProtect(&vtable[index], sizeof(void*), PAGE_EXECUTE_READWRITE, &protect)) return;
			original = reinterpret_cast<T>(vtable[index]);
			vtable[index] = reinterpret_cast<void*>(replacement);
			VirtualProtect(&vtable[index], sizeof(void*), protect, &protect);
		}

		// On its own thread: COM is set up there and torn down again, so the game's thread keeps whatever
		// apartment it chooses later.
		void InstallHooks()
		{
			const HRESULT com = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
			IMMDeviceEnumerator* devices = nullptr;
			IMMDevice* device = nullptr;
			IAudioClient* client = nullptr;
			IAudioRenderClient* render = nullptr;
			WAVEFORMATEX* mix = nullptr;
			if (SUCCEEDED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, __uuidof(IMMDeviceEnumerator), reinterpret_cast<void**>(&devices)))
				&& SUCCEEDED(devices->GetDefaultAudioEndpoint(eRender, eConsole, &device))
				&& SUCCEEDED(device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, reinterpret_cast<void**>(&client)))
				&& SUCCEEDED(client->GetMixFormat(&mix))
				&& SUCCEEDED(client->Initialize(AUDCLNT_SHAREMODE_SHARED, 0, 1000000, 0, mix, nullptr))
				&& SUCCEEDED(client->GetService(__uuidof(IAudioRenderClient), reinterpret_cast<void**>(&render))))
			{
				mixFormat = ReadFormat(mix);
				void** clientTable = *reinterpret_cast<void***>(client);
				void** renderTable = *reinterpret_cast<void***>(render);
				PatchSlot(clientTable, 3, &Initialize_r, originalInitialize);   // IAudioClient::Initialize
				PatchSlot(clientTable, 14, &GetService_r, originalGetService);  // IAudioClient::GetService
				PatchSlot(renderTable, 3, &GetBuffer_r, originalGetBuffer);     // IAudioRenderClient::GetBuffer
				PatchSlot(renderTable, 4, &ReleaseBuffer_r, originalReleaseBuffer); // IAudioRenderClient::ReleaseBuffer
				PrintDebug("[MULTI] Audio tap ready (%u Hz, %u channels, %u bits%s)\n",
					mixFormat.rate, mixFormat.channels, mixFormat.bits, mixFormat.isFloat ? " float" : "");
			}
			else
			{
				PrintDebug("[MULTI] Audio tap unavailable: no default playback device\n");
			}
			if (render) render->Release();
			if (client) client->Release();
			if (device) device->Release();
			if (devices) devices->Release();
			if (mix) CoTaskMemFree(mix);
			if (SUCCEEDED(com)) CoUninitialize();
		}
	}

	void Init()
	{
		WSADATA wsa;
		if (WSAStartup(MAKEWORD(2, 2), &wsa) == 0)
		{
			tapSocket = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
			if (tapSocket != INVALID_SOCKET)
			{
				u_long nonBlocking = 1;
				ioctlsocket(tapSocket, FIONBIO, &nonBlocking);
				int size = 1 << 20;
				setsockopt(tapSocket, SOL_SOCKET, SO_SNDBUF, reinterpret_cast<const char*>(&size), sizeof(size));
			}
		}
		std::thread(InstallHooks).join();
	}

	void Request(const sockaddr_in& from, bool on)
	{
		if (!originalReleaseBuffer) return;
		{
			std::lock_guard<std::mutex> guard(lock);
			target = from;
		}
		sendUntil = on ? GetTickCount64() + RequestLifetimeMs : 0;
	}
}
