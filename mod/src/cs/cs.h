#pragma once

// Counter-Strike characters: soldiers from the host's own Counter-Strike 1.6 (models and sounds are read from
// its install, never shipped) with their weapons, playing on Sonic's movement. A CS player is Sonic everywhere
// in the mod; this module draws the soldier instead of Sonic, keeps Sonic's action buttons for the weapons, and
// kills enemies through the same check as the bomb item's explosion (CheckItemExplosion).
//
// Character ids continue the game's (Sonic 0 ... Metal Sonic 8): terrorists 9-12, counter-terrorists 13-16.
namespace cs
{
	constexpr int FirstCharacter = 9;
	constexpr int LastCharacter = 16;

	inline bool IsCharacter(int character)
	{
		return character >= FirstCharacter && character <= LastCharacter;
	}

	// Reads the Counter-Strike folder from <mod>\sadx-online.ini and hooks the explosion check (mod Init).
	void Init(const char* modPath);

	// The player's CS character, or -1 when it isn't one.
	void SetPlayer(int pnum, int character);
	int GetCharacter(int pnum);

	// Around Sonic's update for player tasks: Sonic doesn't see the weapon buttons; then the weapons run.
	void BeforeSonic(task* tp);
	void AfterSonic(task* tp);

	// Draws the soldier instead of Sonic; false when this player isn't a CS character.
	bool Display(task* tp);
}
