// What the mod reports about SADX, in the names and colors the pages show.

export type Character = { name: string; color: string; short: string };

// SADX's Characters enum (what the mod reports per seat).
export const CHARACTERS: Record<number, Character> = {
  0: { name: 'Sonic', color: '#3b6fe0', short: 'S' },
  1: { name: 'Eggman', color: '#c4453f', short: 'E' },
  2: { name: 'Tails', color: '#d99a2b', short: 'T' },
  3: { name: 'Knuckles', color: '#c83c48', short: 'K' },
  4: { name: 'Tikal', color: '#c98858', short: 'Ti' },
  5: { name: 'Amy', color: '#d9649e', short: 'A' },
  6: { name: 'E-102 Gamma', color: '#7d8aa6', short: 'γ' },
  7: { name: 'Big', color: '#8a68d6', short: 'B' },
  8: { name: 'Metal Sonic', color: '#5368c9', short: 'M' },
};

// The names the host's launcher uses (lib/game.mjs) -> the enum above.
export const CHARACTER_IDS: Record<string, number> = {
  sonic: 0, eggman: 1, tails: 2, knuckles: 3, tikal: 4, amy: 5, gamma: 6, big: 7, metalsonic: 8,
};

export const DEFAULT_CAST = [0, 2, 3, 5]; // what the launcher starts when the mod hasn't answered yet

export const STAGES: Record<number, string> = {
  0: 'Hedgehog Hammer', 1: 'Emerald Coast', 2: 'Windy Valley', 3: 'Twinkle Park', 4: 'Speed Highway',
  5: 'Red Mountain', 6: 'Sky Deck', 7: 'Lost World', 8: 'Ice Cap', 9: 'Casinopolis', 10: 'Final Egg',
  12: 'Hot Shelter', 15: 'Chaos 0', 16: 'Chaos 2', 17: 'Chaos 4', 18: 'Chaos 6', 19: 'Perfect Chaos',
  20: 'Egg Hornet', 21: 'Egg Walker', 22: 'Egg Viper', 23: 'ZERO', 24: 'E-101 Beta', 25: 'E-101 mkII',
  26: 'Station Square', 29: 'Egg Carrier', 32: 'Egg Carrier', 33: 'Mystic Ruins', 34: 'El Pasado',
  35: 'Twinkle Circuit', 36: 'Sky Chase', 37: 'Sky Chase', 38: 'Sand Hill', 39: 'Jardín Chao',
  40: 'Jardín Chao', 41: 'Jardín Chao', 42: 'Carrera Chao',
};

// The launcher's level names (host panel).
export const LEVEL_NAMES: Record<string, string> = {
  emeraldcoast: 'Emerald Coast', windyvalley: 'Windy Valley', twinklepark: 'Twinkle Park', speedhighway: 'Speed Highway',
  redmountain: 'Red Mountain', skydeck: 'Sky Deck', lostworld: 'Lost World', icecap: 'Ice Cap', casinopolis: 'Casinopolis',
  finalegg: 'Final Egg', hotshelter: 'Hot Shelter', hedgehoghammer: 'Hedgehog Hammer', chaos0: 'Chaos 0', chaos2: 'Chaos 2',
  chaos4: 'Chaos 4', chaos6: 'Chaos 6', perfectchaos: 'Perfect Chaos', egghornet: 'Egg Hornet', eggwalker: 'Egg Walker',
  eggviper: 'Egg Viper', zero: 'ZERO', e101: 'E-101 Beta', e101r: 'E-101 mkII', stationsquare: 'Station Square',
  eggcarrieroutside: 'Egg Carrier (fuera)', eggcarrierinside: 'Egg Carrier (dentro)', mysticruins: 'Mystic Ruins', past: 'El Pasado',
  twinklecircuit: 'Twinkle Circuit', skychase1: 'Sky Chase 1', skychase2: 'Sky Chase 2', sandhill: 'Sand Hill',
  ssgarden: 'Jardín Chao (Station Square)', ecgarden: 'Jardín Chao (Egg Carrier)', mrgarden: 'Jardín Chao (Mystic Ruins)', chaorace: 'Carrera Chao',
};

export const CHAR_NAMES: Record<string, string> = {
  sonic: 'Sonic', tails: 'Tails', knuckles: 'Knuckles', amy: 'Amy', big: 'Big', gamma: 'E-102 Gamma',
  eggman: 'Eggman', tikal: 'Tikal', metalsonic: 'Metal Sonic',
};

export const MOD_CHARS = ['sonic', 'eggman', 'tails', 'knuckles', 'tikal', 'amy', 'gamma', 'big', 'metalsonic']; // enum order

export const EMOTES = ['👍', '😂', '😮', '🔥', '💀', '❤️', '👏', 'GG'];

export function characterName(want: string | null | undefined): string | null {
  return want && CHARACTER_IDS[want] !== undefined ? CHARACTERS[CHARACTER_IDS[want]].name : null;
}
