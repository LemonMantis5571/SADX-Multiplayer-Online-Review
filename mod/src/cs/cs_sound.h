#pragma once
#include <string>

// Counter-Strike's own sounds (.wav from the host's install) through the Mod Loader's BASS (DirectSound without
// it), a few voices per sound so automatic fire overlaps. Mixed into the game's own stream, they reach the
// browser through audio_tap with the rest of the game's sound.
namespace cs { namespace sound
{
	// Returns an id for Play, or -1 when the file is missing or not plain PCM.
	int Load(const std::wstring& path);
	void Play(int id, float volume = 1.0f);
} }
