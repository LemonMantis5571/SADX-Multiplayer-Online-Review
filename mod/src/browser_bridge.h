#pragma once

// The bridge between SADX Multiplayer and the SADX Online room (gateway/): browser seats arrive as JSON
// over UDP on 127.0.0.1:27016 and are applied to the players' controllers each frame; the room also asks
// for the game's state (stage, characters, split-screen layout) and its sound (audio_tap) on that port.
namespace browser_bridge
{
	// Binds 127.0.0.1:27016, or the port after --bridge-port on the command line (from the mod's Init).
	void Init();

	// Closes the socket (from the mod's OnExit).
	void Shutdown();

	// Reads every pending packet: pads, status requests, sound requests (start of OnInput).
	void Receive();

	// Adds the browser seats to what the game read this frame from the host's own keyboard and
	// controllers (end of OnInput).
	void Apply();
}
