#pragma once
#include <string>

// Counter-Strike's own sounds (.wav from the host's install) through DirectSound, a few voices per sound so
// automatic fire overlaps. Being in SADX's process, they reach the browser through audio_tap like the game's.
namespace cs { namespace sound
{
	// Returns an id for Play, or -1 when the file is missing or not plain PCM.
	int Load(const std::wstring& path);
	void Play(int id, float volume = 1.0f);
} }
