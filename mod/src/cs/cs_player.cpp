#include "pch.h"
#include <algorithm>
#include <cmath>
#include <map>
#include <string>
#include <vector>
#include "SADXModLoader.h"
#include "FastFunctionHook.hpp"
#include "sadx_utils.h"
#include "multiplayer.h"
#include "collision.h"
#include "cs.h"
#include "cs_mdl.h"
#include "cs_render.h"
#include "cs_sound.h"

namespace cs
{
	namespace
	{
		constexpr float Scale = 0.15f;          // GoldSrc units to SADX: a 72-unit soldier stands ~11 tall, like Sonic
		constexpr float HullHalf = 36.0f;       // a GoldSrc player's origin is the middle of his 72-unit hull
		constexpr unsigned WeaponButtons = Buttons_B | Buttons_X; // Sonic's AttackButtons: the weapons have them

		struct Kit
		{
			const char* model;
			bool terrorist;
		};
		const Kit Kits[] = {
			{ "terror", true }, { "leet", true }, { "arctic", true }, { "guerilla", true },
			{ "gign", false }, { "gsg9", false }, { "sas", false }, { "urban", false },
		};

		enum Weapon { Rifle, Awp, Deagle, Knife, WeaponCount };
		struct WeaponDef
		{
			const char* model[2];    // [terrorist, counter-terrorist]
			const char* anim[2];     // player sequences ref_aim_<anim>, ref_shoot_<anim>, ref_reload_<anim>
			const char* fire[2];
			const char* clipout;
			const char* clipin;
			int fireFrames;          // at 60 fps
			int clip;                // 0: no ammo (knife)
			int reloadFrames;
			float range;
			float cone;              // degrees each side of where the player faces
			bool automatic;
			bool pierce;             // every enemy in the cone (AWP)
			bool melee;
		};
		const WeaponDef Weapons[WeaponCount] = {
			{ { "p_ak47.mdl", "p_m4a1.mdl" }, { "ak47", "rifle" }, { "weapons/ak47-1.wav", "weapons/m4a1_unsil-1.wav" },
				"weapons/ak47_clipout.wav", "weapons/ak47_clipin.wav", 6, 30, 150, 110.0f, 14.0f, true, false, false },
			{ { "p_awp.mdl", "p_awp.mdl" }, { "rifle", "rifle" }, { "weapons/awp1.wav", "weapons/awp1.wav" },
				"weapons/awp_clipout.wav", "weapons/awp_clipin.wav", 88, 10, 174, 110.0f, 5.0f, false, true, false },
			{ { "p_deagle.mdl", "p_deagle.mdl" }, { "onehanded", "onehanded" }, { "weapons/deagle-1.wav", "weapons/deagle-1.wav" },
				"weapons/de_clipout.wav", "weapons/de_clipin.wav", 14, 7, 132, 100.0f, 12.0f, false, false, false },
			{ { "p_knife.mdl", "p_knife.mdl" }, { "knife", "knife" }, { "weapons/knife_slash1.wav", "weapons/knife_slash1.wav" },
				nullptr, nullptr, 24, 0, 0, 16.0f, 50.0f, false, false, true },
		};
		constexpr int MaxGrenades = 3;
		constexpr int GrenadeRegenFrames = 600;
		constexpr int GrenadeFuseFrames = 90;
		constexpr float ExplosionRadius = 45.0f;

		struct Player
		{
			int character = -1;
			int weapon = Rifle;
			int clip[WeaponCount] = {};
			int cooldown = 0;
			int reload = 0;
			int grenades = MaxGrenades;
			int grenadeRegen = 0;
			int shootFrames = 0;     // the upper body plays the shoot sequence this long
			float gaitFrame = 0.0f;
			float upperFrame = 0.0f;
			float speed = 0.0f;       // forward speed this frame, for the stand-in's stride
			bool greeted = false;
			unsigned on = 0, press = 0, release = 0;
		};
		Player players[PLAYER_MAX];

		struct Sphere
		{
			NJS_POINT3 center;
			float radius;
			int until;               // GameTimer
			int owner;
		};
		std::vector<Sphere> spheres;

		struct Grenade
		{
			NJS_POINT3 pos;
			NJS_POINT3 velocity;
			int fuse;
			int owner;
		};
		std::vector<Grenade> grenades;

		struct Tracer
		{
			Vec3 from, to;
			int until;
			uint32_t color;
		};
		std::vector<Tracer> tracers;

		struct Blast
		{
			Vec3 center;
			int start;
		};
		std::vector<Blast> blasts;

		std::wstring csDir;          // ...\Half-Life (cstrike\ and valve\ inside), from sadx-online.ini
		std::map<std::string, StudioModel> models;
		std::map<std::string, int> soundIds;
		task* effects = nullptr;

		FastFunctionHook<BOOL, NJS_POINT3*> CheckItemExplosion_h(0x4C0550);

		// ---- assets from the host's Counter-Strike ----

		std::wstring Widen(const std::string& s)
		{
			return std::wstring(s.begin(), s.end());
		}

		const StudioModel* GetModel(const std::string& relative)
		{
			if (csDir.empty()) return nullptr;
			auto it = models.find(relative);
			if (it == models.end())
			{
				it = models.emplace(relative, StudioModel()).first;
				if (!it->second.Load(csDir + L"\\cstrike\\" + Widen(relative)))
					it->second.Load(csDir + L"\\valve\\" + Widen(relative));
				PrintDebug("[CS] %s %s\n", relative.c_str(), it->second.Loaded() ? "loaded" : "missing");
			}
			return it->second.Loaded() ? &it->second : nullptr;
		}

		const StudioModel* PlayerModel(int character)
		{
			const char* name = Kits[character - FirstCharacter].model;
			return GetModel(std::string("models\\player\\") + name + "\\" + name + ".mdl");
		}

		void PlaySfx(const char* relative, float volume = 1.0f)
		{
			if (!relative || csDir.empty()) return;
			auto it = soundIds.find(relative);
			if (it == soundIds.end())
			{
				std::string path = relative;
				for (auto& c : path) if (c == '/') c = '\\';
				int id = sound::Load(csDir + L"\\cstrike\\sound\\" + Widen(path));
				if (id < 0) id = sound::Load(csDir + L"\\valve\\sound\\" + Widen(path));
				it = soundIds.emplace(relative, id).first;
			}
			sound::Play(it->second, volume);
		}

		// ---- geometry ----

		Vec3 Axis(taskwk* twp, float x, float y, float z)
		{
			NJS_POINT3 v = { x, y, z };
			PConvertVector_P2G(twp, &v);
			return { v.x, v.y, v.z };
		}

		Placement PlaceOf(taskwk* twp)
		{
			Placement p;
			p.forward = Axis(twp, 1.0f, 0.0f, 0.0f);
			p.up = Axis(twp, 0.0f, 1.0f, 0.0f);
			p.side = Axis(twp, 0.0f, 0.0f, 1.0f);
			p.scale = Scale;
			p.origin = { twp->pos.x + p.up.x * HullHalf * Scale, twp->pos.y + p.up.y * HullHalf * Scale,
				twp->pos.z + p.up.z * HullHalf * Scale };
			return p;
		}

		Vec3 At(const Placement& p, float x, float y, float z) // GoldSrc axes, same as render::Model
		{
			return { p.origin.x + (p.forward.x * x - p.side.x * y + p.up.x * z) * p.scale,
				p.origin.y + (p.forward.y * x - p.side.y * y + p.up.y * z) * p.scale,
				p.origin.z + (p.forward.z * x - p.side.z * y + p.up.z * z) * p.scale };
		}

		float Dist2(const NJS_POINT3& a, const NJS_POINT3& b)
		{
			const float dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
			return dx * dx + dy * dy + dz * dz;
		}

		void Box(std::vector<ColorVertex>& out, const Placement& p, float x0, float x1, float y0, float y1, float z0, float z1,
			uint32_t color, float pitch = 0.0f, float pivotZ = 0.0f)
		{
			auto corner = [&](float x, float y, float z) {
				if (pitch != 0.0f) // swing about the hip/shoulder (rotation in the X-Z plane)
				{
					const float c = std::cos(pitch), s = std::sin(pitch), dz = z - pivotZ;
					const float nx = x * c - dz * s, nz = x * s + dz * c;
					x = nx;
					z = nz + pivotZ;
				}
				return At(p, x, y, z);
			};
			const Vec3 c[8] = { corner(x0, y0, z0), corner(x1, y0, z0), corner(x1, y1, z0), corner(x0, y1, z0),
				corner(x0, y0, z1), corner(x1, y0, z1), corner(x1, y1, z1), corner(x0, y1, z1) };
			auto shade = [&](float k) {
				auto ch = [&](int sh) { return static_cast<uint32_t>(((color >> sh) & 0xFF) * k) << sh; };
				return (color & 0xFF000000) | ch(16) | ch(8) | ch(0);
			};
			const int faces[6][4] = { {4, 5, 6, 7}, {0, 3, 2, 1}, {0, 1, 5, 4}, {2, 3, 7, 6}, {1, 2, 6, 5}, {3, 0, 4, 7} };
			const float light[6] = { 1.0f, 0.45f, 0.8f, 0.7f, 0.9f, 0.6f };
			for (int f = 0; f < 6; ++f)
			{
				const uint32_t col = shade(light[f]);
				const int* q = faces[f];
				out.push_back({ c[q[0]], col }); out.push_back({ c[q[1]], col }); out.push_back({ c[q[2]], col });
				out.push_back({ c[q[0]], col }); out.push_back({ c[q[2]], col }); out.push_back({ c[q[3]], col });
			}
		}

		// Without the host's CS files: a boxy soldier in his team's colors, legs swinging with his speed.
		void DrawStandIn(const Player& pl, const Placement& p)
		{
			const bool t = Kits[pl.character - FirstCharacter].terrorist;
			const uint32_t body = t ? 0xFFB59A62 : 0xFF2E3B55, legs = t ? 0xFF6B5B3E : 0xFF1E2533;
			const uint32_t head = t ? 0xFF222222 : 0xFF111827, skin = 0xFFE0B08F, gun = 0xFF2A2A2A;
			const float swing = std::sin(pl.gaitFrame * 0.35f) * 0.6f * (pl.speed > 2.0f ? 1.0f : pl.speed / 2.0f);
			std::vector<ColorVertex> v;
			Box(v, p, -4, 4, 2, 9, -36, -4, legs, swing, -4);
			Box(v, p, -4, 4, -9, -2, -36, -4, legs, -swing, -4);
			Box(v, p, -5, 5, -10, 10, -4, 22, body);
			Box(v, p, -4, 4, -4, 4, 22, 32, skin);
			Box(v, p, -4.5f, 4.5f, -4.5f, 4.5f, 27, 33, head);
			Box(v, p, -2, 16, 6, 10, 10, 15, body);
			Box(v, p, -2, 16, -10, -6, 10, 15, body);
			Box(v, p, 4, 34, -6, -3, 11, 15, gun);
			render::Triangles(v);
		}

		// ---- combat ----

		void AddSphere(const NJS_POINT3& center, float radius, int frames, int owner)
		{
			spheres.push_back({ center, radius, GameTimer + frames, owner });
		}

		// Enemies near the shooter come from the list the mod keeps for the homing attack (about 100 units).
		std::vector<taskwk*> Targets(int pnum, const NJS_POINT3& from, const Vec3& forward, float range, float cone, bool all)
		{
			std::vector<taskwk*> out;
			const float minCos = std::cos(cone * 3.14159265f / 180.0f);
			taskwk* best = nullptr;
			float bestScore = -1.0f;
			colaround* list = GetTargetEnemyList(static_cast<Uint8>(pnum));
			for (int i = 0; list && i < 656 && list[i].twp; ++i)
			{
				taskwk* e = list[i].twp;
				const float dx = e->pos.x - from.x, dy = e->pos.y - from.y, dz = e->pos.z - from.z;
				const float flat = std::sqrt(dx * dx + dz * dz), dist = std::sqrt(dx * dx + dy * dy + dz * dz);
				if (dist > range || std::fabs(dy) > 40.0f || flat < 0.001f) continue;
				const float c = (dx * forward.x + dz * forward.z) / (flat * std::sqrt(forward.x * forward.x + forward.z * forward.z) + 1e-6f);
				if (c < minCos && dist > 8.0f) continue; // point-blank counts whatever the angle
				if (all) out.push_back(e);
				else if (c - dist / range * 0.3f > bestScore)
				{
					bestScore = c - dist / range * 0.3f;
					best = e;
				}
			}
			if (best) out.push_back(best);
			return out;
		}

		void HitPlayers(int shooter, const NJS_POINT3& center, float radius, bool launch)
		{
			for (int i = 0; i < PLAYER_MAX; ++i)
			{
				taskwk* ptwp = playertwp[i];
				if (!ptwp || Dist2(ptwp->pos, center) > radius * radius) continue;
				if (launch) EnemyBounceThing(static_cast<Uint8>(i), 0.0f, 4.0f, 0.0f); // grenade jump, teammates too
				if (i != shooter && multiplayer::IsBattleMode()) HurtCharacter(static_cast<char>(i));
			}
		}

		void Fire(int pnum, Player& pl, taskwk* twp, const WeaponDef& w, bool terrorist)
		{
			const Vec3 forward = Axis(twp, 1.0f, 0.0f, 0.0f), up = Axis(twp, 0.0f, 1.0f, 0.0f);
			const Vec3 muzzle = { twp->pos.x + up.x * 7.0f + forward.x * 4.0f, twp->pos.y + up.y * 7.0f + forward.y * 4.0f,
				twp->pos.z + up.z * 7.0f + forward.z * 4.0f };
			PlaySfx(w.fire[terrorist ? 0 : 1], w.melee ? 0.8f : 1.0f);
			pl.shootFrames = 10;
			pl.upperFrame = 0.0f;

			if (w.melee)
			{
				NJS_POINT3 at = { twp->pos.x + forward.x * 10.0f, twp->pos.y + up.y * 5.0f, twp->pos.z + forward.z * 10.0f };
				AddSphere(at, 12.0f, 3, pnum);
				if (!Targets(pnum, twp->pos, forward, w.range, w.cone, false).empty()) PlaySfx("weapons/knife_hit1.wav");
				return;
			}

			const auto hits = Targets(pnum, twp->pos, forward, w.range, w.cone, w.pierce);
			for (taskwk* e : hits)
			{
				AddSphere(e->pos, 4.0f, 3, pnum);
				tracers.push_back({ muzzle, { e->pos.x, e->pos.y + 3.0f, e->pos.z }, GameTimer + 4, 0xFFFFE08A });
			}
			if (hits.empty())
			{
				tracers.push_back({ muzzle, { muzzle.x + forward.x * w.range, muzzle.y + forward.y * w.range,
					muzzle.z + forward.z * w.range }, GameTimer + 3, 0xFFFFE08A });
			}
			// In battle mode, other players in the line of fire take the hit.
			if (multiplayer::IsBattleMode())
			{
				for (int i = 0; i < PLAYER_MAX; ++i)
				{
					taskwk* other = playertwp[i];
					if (i == pnum || !other) continue;
					const float dx = other->pos.x - twp->pos.x, dz = other->pos.z - twp->pos.z;
					const float flat = std::sqrt(dx * dx + dz * dz);
					if (flat > w.range || flat < 0.001f || std::fabs(other->pos.y - twp->pos.y) > 20.0f) continue;
					if ((dx * forward.x + dz * forward.z) / flat >= std::cos(w.cone * 3.14159265f / 180.0f))
						HurtCharacter(static_cast<char>(i));
				}
			}
		}

		void ThrowGrenade(int pnum, taskwk* twp)
		{
			const Vec3 forward = Axis(twp, 1.0f, 0.0f, 0.0f);
			const NJS_POINT3 speed = playerpwp[pnum] ? playerpwp[pnum]->spd : NJS_POINT3{};
			grenades.push_back({ { twp->pos.x + forward.x * 4.0f, twp->pos.y + 8.0f, twp->pos.z + forward.z * 4.0f },
				{ forward.x * (2.4f + speed.x * 0.5f), 1.8f, forward.z * (2.4f + speed.x * 0.5f) }, GrenadeFuseFrames, pnum });
			PlaySfx("weapons/pinpull.wav");
			PlaySfx("radio/ct_fireinhole.wav");
		}

		void Explode(const Grenade& g)
		{
			AddSphere(g.pos, ExplosionRadius, 6, g.owner);
			HitPlayers(g.owner, g.pos, ExplosionRadius, true);
			blasts.push_back({ { g.pos.x, g.pos.y, g.pos.z }, GameTimer });
			PlaySfx("weapons/explode3.wav");
		}

		// ---- effects task: grenades in flight, tracers, explosions, drawn in every player's viewport ----

		template <typename T, typename F> void RemoveIf(std::vector<T>& v, F expired)
		{
			v.erase(std::remove_if(v.begin(), v.end(), expired), v.end());
		}

		void __cdecl EffectsExec(task* tp)
		{
			for (size_t i = 0; i < grenades.size();)
			{
				Grenade& g = grenades[i];
				g.velocity.y -= 0.09f;
				g.pos.x += g.velocity.x;
				g.pos.y += g.velocity.y;
				g.pos.z += g.velocity.z;
				Angle3 slope{};
				const float ground = GetShadowPos(g.pos.x, g.pos.y + 6.0f, g.pos.z, &slope);
				if (ground > -1000000.0f && g.pos.y < ground + 0.5f && g.velocity.y < 0.0f)
				{
					g.pos.y = ground + 0.5f;
					g.velocity.y = -g.velocity.y * 0.35f;
					g.velocity.x *= 0.6f;
					g.velocity.z *= 0.6f;
					if (g.velocity.y > 0.4f) PlaySfx("weapons/he_bounce-1.wav", 0.6f);
				}
				if (--g.fuse <= 0)
				{
					Explode(g);
					grenades.erase(grenades.begin() + i);
				}
				else ++i;
			}
			const int now = GameTimer;
			RemoveIf(spheres, [now](const Sphere& s) { return now >= s.until; });
			RemoveIf(tracers, [now](const Tracer& t) { return now >= t.until; });
			RemoveIf(blasts, [now](const Blast& b) { return now - b.start > 24; });
		}

		// Drawn from the first CS player's display, once per viewport: a task of its own draws when the camera
		// isn't always the 3D one, while a player's display always has it.
		void DrawEffects()
		{
			std::vector<ColorVertex> tris;
			// Each shot: two crossed thin ribbons (seen from any side, where a 1-pixel line barely shows) and a flash
			// at the muzzle.
			for (const auto& tr : tracers)
			{
				const Vec3 d = { tr.to.x - tr.from.x, tr.to.y - tr.from.y, tr.to.z - tr.from.z };
				const float len = std::sqrt(d.x * d.x + d.y * d.y + d.z * d.z);
				if (len < 0.01f) continue;
				const float flat = std::sqrt(d.x * d.x + d.z * d.z);
				const Vec3 across = flat > 0.01f ? Vec3{ -d.z / flat * 0.25f, 0.0f, d.x / flat * 0.25f } : Vec3{ 0.25f, 0.0f, 0.0f };
				const Vec3 upward = { 0.0f, 0.25f, 0.0f };
				for (const Vec3& w : { across, upward })
				{
					const Vec3 a = { tr.from.x - w.x, tr.from.y - w.y, tr.from.z - w.z }, b = { tr.from.x + w.x, tr.from.y + w.y, tr.from.z + w.z };
					const Vec3 c = { tr.to.x + w.x, tr.to.y + w.y, tr.to.z + w.z }, e = { tr.to.x - w.x, tr.to.y - w.y, tr.to.z - w.z };
					tris.push_back({ a, tr.color }); tris.push_back({ b, tr.color }); tris.push_back({ c, tr.color });
					tris.push_back({ a, tr.color }); tris.push_back({ c, tr.color }); tris.push_back({ e, tr.color });
				}
				if (tr.until - GameTimer >= 3)
				{
					Placement flash = { tr.from, { 1, 0, 0 }, { 0, 1, 0 }, { 0, 0, -1 }, 1.0f };
					Box(tris, flash, -1.2f, 1.2f, -0.4f, 0.4f, -0.4f, 0.4f, 0xFFFFF6C8);
					Box(tris, flash, -0.4f, 0.4f, -1.2f, 1.2f, -0.4f, 0.4f, 0xFFFFF6C8);
					Box(tris, flash, -0.4f, 0.4f, -0.4f, 0.4f, -1.2f, 1.2f, 0xFFFFF6C8);
				}
			}
			const Placement identity = { {}, { 1, 0, 0 }, { 0, 1, 0 }, { 0, 0, -1 }, 1.0f };
			for (const auto& g : grenades)
			{
				Placement p = identity;
				p.origin = { g.pos.x, g.pos.y, g.pos.z };
				Box(tris, p, -0.8f, 0.8f, -0.8f, 0.8f, -0.8f, 0.8f, 0xFF3F5A2A);
			}
			for (const auto& b : blasts)
			{
				const float age = static_cast<float>(GameTimer - b.start);
				const float r = 6.0f + age * 2.2f;
				Placement p = identity;
				p.origin = b.center;
				const uint32_t color = age < 6 ? 0xFFFFF2B0 : age < 14 ? 0xFFFFA030 : 0xFF6A3A20;
				Box(tris, p, -r, r, -r * 0.3f, r * 0.3f, -r * 0.3f, r * 0.3f, color);
				Box(tris, p, -r * 0.3f, r * 0.3f, -r, r, -r * 0.3f, r * 0.3f, color);
				Box(tris, p, -r * 0.3f, r * 0.3f, -r * 0.3f, r * 0.3f, -r, r, color);
			}
			render::Triangles(tris);
		}

		void __cdecl EffectsDestroy(task* tp)
		{
			if (effects == tp) effects = nullptr;
			grenades.clear();
			tracers.clear();
			blasts.clear();
			spheres.clear();
		}

		void EnsureEffects()
		{
			if (effects) return;
			effects = CreateElementalTask(LoadObj_Data1, LEV_6, EffectsExec);
			if (effects)
			{
				effects->dest = EffectsDestroy;
			}
		}

		// Enemies run this (through the bomb item's check) to see whether they are inside an explosion.
		BOOL __cdecl CheckItemExplosion_r(NJS_POINT3* pos)
		{
			if (CheckItemExplosion_h.Original(pos)) return TRUE;
			const int now = GameTimer;
			for (const auto& s : spheres)
			{
				if (now < s.until && Dist2(*pos, s.center) <= s.radius * s.radius)
				{
					AddEnemyScoreM(s.owner, 10);
					return TRUE;
				}
			}
			return FALSE;
		}

		int PlayerOf(task* tp)
		{
			if (!tp || !tp->twp) return -1;
			const int pnum = TASKWK_PLAYERID(tp->twp);
			return pnum >= 0 && pnum < PLAYER_MAX && players[pnum].character >= 0 ? pnum : -1;
		}

		int SequenceOr(const StudioModel& m, const std::string& name, const char* fallback)
		{
			const int s = m.FindSequence(name.c_str());
			return s >= 0 ? s : m.FindSequence(fallback);
		}
	}

	void Init(const char* modPath)
	{
		wchar_t value[MAX_PATH] = {};
		const std::wstring ini = Widen(std::string(modPath)) + L"\\sadx-online.ini";
		GetPrivateProfileStringW(L"CounterStrike", L"Path", L"", value, MAX_PATH, ini.c_str());
		csDir = value;
		PrintDebug("[CS] Counter-Strike folder: %ls\n", csDir.empty() ? L"(none: stand-in soldiers)" : csDir.c_str());
		CheckItemExplosion_h.Hook(CheckItemExplosion_r);
	}

	void SetPlayer(int pnum, int character)
	{
		if (pnum < 0 || pnum >= PLAYER_MAX) return;
		players[pnum] = Player();
		players[pnum].character = IsCharacter(character) ? character : -1;
		for (int w = 0; w < WeaponCount; ++w) players[pnum].clip[w] = Weapons[w].clip;
	}

	int GetCharacter(int pnum)
	{
		return pnum >= 0 && pnum < PLAYER_MAX ? players[pnum].character : -1;
	}

	void BeforeSonic(task* tp)
	{
		const int pnum = PlayerOf(tp);
		if (pnum < 0) return;
		Player& pl = players[pnum];
		PDS_PERIPHERAL& pad = perG[pnum];
		pl.on = pad.on;
		pl.press = pad.press;
		pl.release = pad.release;
		pad.on &= ~WeaponButtons;
		pad.press &= ~WeaponButtons;
		pad.release &= ~WeaponButtons;
	}

	void AfterSonic(task* tp)
	{
		const int pnum = PlayerOf(tp);
		if (pnum < 0) return;
		Player& pl = players[pnum];
		PDS_PERIPHERAL& pad = perG[pnum];
		pad.on = pl.on;
		pad.press = pl.press;
		pad.release = pl.release;

		taskwk* twp = tp->twp;
		EnsureEffects();
		const bool terrorist = Kits[pl.character - FirstCharacter].terrorist;
		if (!pl.greeted)
		{
			pl.greeted = true;
			PlaySfx(terrorist ? "radio/letsgo.wav" : "radio/locknload.wav");
		}

		// Animation clocks: legs with the running speed, the upper body with its own sequence.
		const float speed = playerpwp[pnum] ? std::fabs(playerpwp[pnum]->spd.x) : 0.0f;
		pl.speed = speed;
		pl.gaitFrame += 0.5f + speed * 0.35f;
		pl.upperFrame += 0.5f;
		if (pl.shootFrames > 0) --pl.shootFrames;

		const WeaponDef& w = Weapons[pl.weapon];
		if (pl.press & Buttons_B)
		{
			pl.weapon = (pl.weapon + 1) % WeaponCount;
			pl.reload = 0;
			pl.cooldown = 12;
			PlaySfx("items/gunpickup2.wav", 0.7f);
		}
		if (pl.press & Buttons_Y)
		{
			if (pl.grenades > 0)
			{
				--pl.grenades;
				ThrowGrenade(pnum, twp);
				pl.shootFrames = 12;
			}
			else PlaySfx("weapons/dryfire_rifle.wav", 0.6f);
		}
		if (pl.grenades < MaxGrenades && ++pl.grenadeRegen >= GrenadeRegenFrames)
		{
			pl.grenadeRegen = 0;
			++pl.grenades;
		}

		if (pl.cooldown > 0) --pl.cooldown;
		if (pl.reload > 0)
		{
			if (--pl.reload == w.reloadFrames / 3) PlaySfx(w.clipin, 0.7f);
			if (pl.reload == 0) pl.clip[pl.weapon] = w.clip;
		}

		const bool trigger = w.automatic ? (pl.on & Buttons_X) != 0 : (pl.press & Buttons_X) != 0;
		if (trigger && pl.cooldown == 0 && pl.reload == 0)
		{
			if (w.clip && pl.clip[pl.weapon] == 0)
			{
				pl.reload = w.reloadFrames;
				PlaySfx(w.clipout, 0.7f);
			}
			else
			{
				if (w.clip) --pl.clip[pl.weapon];
				pl.cooldown = w.fireFrames;
				Fire(pnum, pl, twp, w, terrorist);
				if (w.clip && pl.clip[pl.weapon] == 0)
				{
					pl.reload = w.reloadFrames;
					PlaySfx(w.clipout, 0.7f);
				}
			}
		}
	}

	bool Display(task* tp)
	{
		const int pnum = PlayerOf(tp);
		if (pnum < 0) return false;
		const Player& pl = players[pnum];
		taskwk* twp = tp->twp;
		const Placement where = PlaceOf(twp);

		int first = 0;
		while (first < PLAYER_MAX && (players[first].character < 0 || !playertwp[first])) ++first;
		if (first == pnum) DrawEffects();

		const StudioModel* body = PlayerModel(pl.character);
		if (!body)
		{
			DrawStandIn(pl, where);
			return true;
		}

		const bool terrorist = Kits[pl.character - FirstCharacter].terrorist;
		const WeaponDef& w = Weapons[pl.weapon];
		const std::string anim = w.anim[terrorist ? 0 : 1];
		const float speed = playerpwp[pnum] ? std::fabs(playerpwp[pnum]->spd.x) : 0.0f;
		const bool ground = (twp->flag & Status_Ground) != 0;
		const int gait = !ground ? body->FindSequence("jump") : speed > 2.0f ? body->FindSequence("run")
			: speed > 0.2f ? body->FindSequence("walk") : body->FindSequence("idle1");
		const int upper = pl.reload > 0 ? SequenceOr(*body, "ref_reload_" + anim, "ref_reload_carbine")
			: pl.shootFrames > 0 ? SequenceOr(*body, "ref_shoot_" + anim, "ref_shoot_carbine")
			: SequenceOr(*body, "ref_aim_" + anim, "ref_aim_carbine");

		auto frameOf = [&](int sequence, float clock) {
			const int frames = body->SequenceFrames(sequence);
			if (frames <= 1) return 0.0f;
			return std::fmod(clock * body->SequenceFps(sequence) / 30.0f, static_cast<float>(frames - 1));
		};
		std::vector<Mat34> bones;
		body->Pose(upper, frameOf(upper, pl.upperFrame), gait, frameOf(gait, pl.gaitFrame), bones);
		render::Model(*body, bones, where);

		// The weapon follows the player's skeleton bone by bone (the engine's bone merge).
		if (const StudioModel* gun = GetModel(std::string("models\\") + w.model[terrorist ? 0 : 1]))
		{
			std::vector<Mat34> gunBones;
			gun->Pose(0, 0.0f, -1, 0.0f, gunBones);
			for (int b = 0; b < gun->BoneCount(); ++b)
			{
				const int match = body->FindBone(gun->BoneName(b));
				if (match >= 0) gunBones[b] = bones[match];
			}
			render::Model(*gun, gunBones, where);
		}
		return true;
	}
}
