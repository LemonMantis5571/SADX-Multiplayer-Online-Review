#include "pch.h"
#include <cmath>
#include <cstring>
#include <fstream>
#include <vector>
#include <mmsystem.h>
#include <dsound.h>
#include "cs_sound.h"

#pragma comment(lib, "dsound.lib")

namespace cs { namespace sound
{
	namespace
	{
		constexpr size_t Voices = 6; // a sound playing this many times at once steals its oldest voice

		struct Sound
		{
			std::vector<IDirectSoundBuffer*> voices;
			size_t next = 0;
		};

		IDirectSound8* device = nullptr;
		bool tried = false;
		std::vector<Sound> sounds;

		bool Open()
		{
			if (device || tried) return device != nullptr;
			tried = true;
			if (FAILED(DirectSoundCreate8(nullptr, &device, nullptr))) return false;
			// The game's window (sounds load once a level is running); GLOBALFOCUS buffers play without its focus.
			HWND window = WindowHandle;
			if (FAILED(device->SetCooperativeLevel(window ? window : GetDesktopWindow(), DSSCL_PRIORITY)))
			{
				device->Release();
				device = nullptr;
			}
			return device != nullptr;
		}

		// RIFF/WAVE with a PCM "fmt " chunk; CS's sounds are 8- or 16-bit mono at 11-44 kHz.
		bool ParseWave(const std::vector<uint8_t>& file, WAVEFORMATEX& format, const uint8_t*& samples, DWORD& bytes)
		{
			if (file.size() < 12 || memcmp(file.data(), "RIFF", 4) != 0 || memcmp(file.data() + 8, "WAVE", 4) != 0) return false;
			bool haveFormat = false;
			samples = nullptr;
			for (size_t at = 12; at + 8 <= file.size();)
			{
				DWORD size;
				memcpy(&size, file.data() + at + 4, 4);
				if (size > file.size() - at - 8) size = static_cast<DWORD>(file.size() - at - 8);
				if (memcmp(file.data() + at, "fmt ", 4) == 0 && size >= 16)
				{
					memcpy(&format, file.data() + at + 8, 16);
					format.cbSize = 0;
					haveFormat = format.wFormatTag == WAVE_FORMAT_PCM;
				}
				else if (memcmp(file.data() + at, "data", 4) == 0)
				{
					samples = file.data() + at + 8;
					bytes = size;
				}
				at += 8 + size + (size & 1);
			}
			return haveFormat && samples && bytes > 0;
		}
	}

	int Load(const std::wstring& path)
	{
		if (!Open()) return -1;
		std::ifstream in(path, std::ios::binary);
		if (!in) return -1;
		std::vector<uint8_t> file((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
		WAVEFORMATEX format{};
		const uint8_t* samples;
		DWORD bytes;
		if (!ParseWave(file, format, samples, bytes)) return -1;

		DSBUFFERDESC desc{};
		desc.dwSize = sizeof(desc);
		desc.dwFlags = DSBCAPS_CTRLVOLUME | DSBCAPS_GLOBALFOCUS | DSBCAPS_GETCURRENTPOSITION2;
		desc.dwBufferBytes = bytes;
		desc.lpwfxFormat = &format;
		IDirectSoundBuffer* buffer = nullptr;
		if (FAILED(device->CreateSoundBuffer(&desc, &buffer, nullptr))) return -1;
		void* p1; void* p2; DWORD n1, n2;
		if (SUCCEEDED(buffer->Lock(0, bytes, &p1, &n1, &p2, &n2, 0)))
		{
			memcpy(p1, samples, n1);
			if (p2) memcpy(p2, samples + n1, n2);
			buffer->Unlock(p1, n1, p2, n2);
		}
		Sound sound;
		sound.voices.push_back(buffer);
		for (size_t i = 1; i < Voices; ++i)
		{
			IDirectSoundBuffer* copy = nullptr;
			if (SUCCEEDED(device->DuplicateSoundBuffer(buffer, &copy))) sound.voices.push_back(copy);
		}
		sounds.push_back(std::move(sound));
		return static_cast<int>(sounds.size() - 1);
	}

	void Play(int id, float volume)
	{
		if (id < 0 || id >= static_cast<int>(sounds.size())) return;
		Sound& sound = sounds[id];
		IDirectSoundBuffer* voice = nullptr;
		for (size_t i = 0; i < sound.voices.size() && !voice; ++i)
		{
			DWORD status = 0;
			sound.voices[i]->GetStatus(&status);
			if (!(status & DSBSTATUS_PLAYING)) voice = sound.voices[i];
		}
		if (!voice)
		{
			voice = sound.voices[sound.next];
			sound.next = (sound.next + 1) % sound.voices.size();
			voice->Stop();
		}
		const float v = volume < 0.01f ? 0.01f : (volume > 1.0f ? 1.0f : volume);
		voice->SetVolume(static_cast<LONG>(2000.0f * std::log10(v)) - 600); // a bit under the game's own sounds
		voice->SetCurrentPosition(0);
		voice->Play(0, 0, 0);
	}
} }
