#pragma once

#include <winsock2.h>

namespace audio_tap
{
	// Hooks the shared-mode WASAPI render path of this process, where SADX's sound (BASS and DirectSound)
	// ends up as one mixed stream. Call once at startup, before the game opens its audio device.
	void Init();

	// The browser gateway asked for the game's sound ({"cmd":"audio"} on the browser input socket):
	// stream it to `from` for a few seconds; the gateway repeats the request while anyone listens.
	void Request(const sockaddr_in& from, bool on);
}
