#include "pch.h"
#include <cmath>
#include <map>
#include "d3d8vars.h"
#include "cs_render.h"

namespace cs { namespace render
{
	namespace
	{
		struct Vertex
		{
			float x, y, z;
			DWORD color;
			float u, v;
		};
		constexpr DWORD FVF = D3DFVF_XYZ | D3DFVF_DIFFUSE | D3DFVF_TEX1;

		// Light from above and in front, plus ambient, baked into vertex colors (D3D lighting stays off).
		constexpr Vec3 Light = { 0.35f, 0.85f, 0.4f };

		std::map<const StudioModel*, std::vector<IDirect3DTexture8*>> textures;

		// Sets the states this file draws with and puts the game's back when it goes out of scope.
		class States
		{
		public:
			explicit States(IDirect3DDevice8* device) : d(device)
			{
				d->GetTransform(D3DTS_WORLD, &world);
				d->GetVertexShader(&shader);
				d->GetTexture(0, &texture);
				for (auto& s : render) d->GetRenderState(s.first, &s.second);
				for (auto& s : stage) d->GetTextureStageState(0, s.first, &s.second);
				d->GetTextureStageState(1, D3DTSS_COLOROP, &stage1Color);

				D3DMATRIX identity = {};
				identity._11 = identity._22 = identity._33 = identity._44 = 1.0f;
				d->SetTransform(D3DTS_WORLD, &identity);
				d->SetVertexShader(FVF);
				d->SetRenderState(D3DRS_LIGHTING, FALSE);
				d->SetRenderState(D3DRS_ZENABLE, TRUE);
				d->SetRenderState(D3DRS_ZWRITEENABLE, TRUE);
				d->SetRenderState(D3DRS_CULLMODE, D3DCULL_NONE);
				d->SetRenderState(D3DRS_ALPHABLENDENABLE, FALSE);
				d->SetRenderState(D3DRS_ALPHATESTENABLE, TRUE);
				d->SetRenderState(D3DRS_ALPHAREF, 0x80);
				d->SetRenderState(D3DRS_ALPHAFUNC, D3DCMP_GREATEREQUAL);
				d->SetTextureStageState(0, D3DTSS_COLORARG1, D3DTA_TEXTURE);
				d->SetTextureStageState(0, D3DTSS_COLORARG2, D3DTA_DIFFUSE);
				d->SetTextureStageState(0, D3DTSS_ALPHAARG1, D3DTA_TEXTURE);
				d->SetTextureStageState(0, D3DTSS_MAGFILTER, D3DTEXF_LINEAR);
				d->SetTextureStageState(0, D3DTSS_MINFILTER, D3DTEXF_LINEAR);
				d->SetTextureStageState(0, D3DTSS_ADDRESSU, D3DTADDRESS_WRAP);
				d->SetTextureStageState(0, D3DTSS_ADDRESSV, D3DTADDRESS_WRAP);
				d->SetTextureStageState(1, D3DTSS_COLOROP, D3DTOP_DISABLE);
			}

			~States()
			{
				d->SetTransform(D3DTS_WORLD, &world);
				d->SetVertexShader(shader);
				d->SetTexture(0, texture);
				if (texture) texture->Release();
				for (auto& s : render) d->SetRenderState(s.first, s.second);
				for (auto& s : stage) d->SetTextureStageState(0, s.first, s.second);
				d->SetTextureStageState(1, D3DTSS_COLOROP, stage1Color);
			}

			// Textured (modulated by the vertex color) or vertex color only.
			void Textured(IDirect3DTexture8* tex)
			{
				d->SetTexture(0, tex);
				d->SetTextureStageState(0, D3DTSS_COLOROP, tex ? D3DTOP_MODULATE : D3DTOP_SELECTARG2);
				d->SetTextureStageState(0, D3DTSS_ALPHAOP, tex ? D3DTOP_SELECTARG1 : D3DTOP_DISABLE);
				d->SetRenderState(D3DRS_ALPHATESTENABLE, tex ? TRUE : FALSE);
			}

		private:
			IDirect3DDevice8* d;
			D3DMATRIX world{};
			DWORD shader = 0;
			IDirect3DBaseTexture8* texture = nullptr;
			DWORD stage1Color = 0;
			std::pair<D3DRENDERSTATETYPE, DWORD> render[9] = {
				{ D3DRS_LIGHTING, 0 }, { D3DRS_ZENABLE, 0 }, { D3DRS_ZWRITEENABLE, 0 }, { D3DRS_CULLMODE, 0 },
				{ D3DRS_ALPHABLENDENABLE, 0 }, { D3DRS_ALPHATESTENABLE, 0 }, { D3DRS_ALPHAREF, 0 },
				{ D3DRS_ALPHAFUNC, 0 }, { D3DRS_SRCBLEND, 0 },
			};
			std::pair<D3DTEXTURESTAGESTATETYPE, DWORD> stage[9] = {
				{ D3DTSS_COLOROP, 0 }, { D3DTSS_COLORARG1, 0 }, { D3DTSS_COLORARG2, 0 }, { D3DTSS_ALPHAOP, 0 },
				{ D3DTSS_ALPHAARG1, 0 }, { D3DTSS_MAGFILTER, 0 }, { D3DTSS_MINFILTER, 0 },
				{ D3DTSS_ADDRESSU, 0 }, { D3DTSS_ADDRESSV, 0 },
			};
		};

		IDirect3DTexture8* MakeTexture(IDirect3DDevice8* device, const ModelTexture& source)
		{
			if (source.argb.empty()) return nullptr;
			IDirect3DTexture8* tex = nullptr;
			if (FAILED(device->CreateTexture(source.width, source.height, 1, 0, D3DFMT_A8R8G8B8, D3DPOOL_MANAGED, &tex))) return nullptr;
			D3DLOCKED_RECT locked;
			if (FAILED(tex->LockRect(0, &locked, nullptr, 0)))
			{
				tex->Release();
				return nullptr;
			}
			for (int y = 0; y < source.height; ++y)
			{
				memcpy(static_cast<uint8_t*>(locked.pBits) + y * locked.Pitch, source.argb.data() + y * source.width, source.width * 4);
			}
			tex->UnlockRect(0);
			return tex;
		}

		DWORD Shade(const Vec3& normal, DWORD base = 0xFFFFFFFF)
		{
			float d = normal.x * Light.x + normal.y * Light.y + normal.z * Light.z;
			const float lit = 0.55f + 0.5f * (d > 0.0f ? d : 0.0f);
			auto channel = [&](int shift) {
				const float c = ((base >> shift) & 0xFF) * (lit > 1.0f ? 1.0f : lit);
				return static_cast<DWORD>(c) << shift;
			};
			return (base & 0xFF000000) | channel(16) | channel(8) | channel(0);
		}

		// GoldSrc model space (X forward, Y left, Z up) to SADX world with the placement's axes.
		Vec3 ToWorld(const Placement& p, float x, float y, float z, bool point)
		{
			const float s = point ? p.scale : 1.0f;
			Vec3 out = {
				(p.forward.x * x - p.side.x * y + p.up.x * z) * s,
				(p.forward.y * x - p.side.y * y + p.up.y * z) * s,
				(p.forward.z * x - p.side.z * y + p.up.z * z) * s,
			};
			if (point)
			{
				out.x += p.origin.x;
				out.y += p.origin.y;
				out.z += p.origin.z;
			}
			return out;
		}
	}

	void Model(const StudioModel& model, const std::vector<Mat34>& bones, const Placement& where)
	{
		IDirect3DDevice8* device = Direct3D_Device;
		if (!device || !model.Loaded() || bones.size() < static_cast<size_t>(model.BoneCount())) return;

		auto& texs = textures[&model];
		if (texs.empty())
		{
			for (const auto& t : model.Textures()) texs.push_back(MakeTexture(device, t));
			if (texs.empty()) texs.push_back(nullptr);
		}

		States states(device);
		std::vector<Vertex> out;
		for (const auto& mesh : model.Meshes())
		{
			out.clear();
			out.reserve(mesh.triangles.size());
			for (const auto& v : mesh.triangles)
			{
				const Mat34& m = bones[v.bone];
				const float px = m.m[0][0] * v.pos[0] + m.m[0][1] * v.pos[1] + m.m[0][2] * v.pos[2] + m.m[0][3];
				const float py = m.m[1][0] * v.pos[0] + m.m[1][1] * v.pos[1] + m.m[1][2] * v.pos[2] + m.m[1][3];
				const float pz = m.m[2][0] * v.pos[0] + m.m[2][1] * v.pos[1] + m.m[2][2] * v.pos[2] + m.m[2][3];
				const float nx = m.m[0][0] * v.normal[0] + m.m[0][1] * v.normal[1] + m.m[0][2] * v.normal[2];
				const float ny = m.m[1][0] * v.normal[0] + m.m[1][1] * v.normal[1] + m.m[1][2] * v.normal[2];
				const float nz = m.m[2][0] * v.normal[0] + m.m[2][1] * v.normal[1] + m.m[2][2] * v.normal[2];
				const Vec3 p = ToWorld(where, px, py, pz, true);
				const Vec3 n = ToWorld(where, nx, ny, nz, false);
				out.push_back({ p.x, p.y, p.z, Shade(n), v.u, v.v });
			}
			const bool textured = mesh.texture >= 0 && mesh.texture < static_cast<int>(texs.size()) && texs[mesh.texture];
			states.Textured(textured ? texs[mesh.texture] : nullptr);
			device->DrawPrimitiveUP(D3DPT_TRIANGLELIST, static_cast<UINT>(out.size() / 3), out.data(), sizeof(Vertex));
		}
	}

	void Triangles(const std::vector<ColorVertex>& vertices)
	{
		IDirect3DDevice8* device = Direct3D_Device;
		if (!device || vertices.size() < 3) return;
		States states(device);
		states.Textured(nullptr);
		std::vector<Vertex> out;
		out.reserve(vertices.size());
		for (const auto& v : vertices) out.push_back({ v.pos.x, v.pos.y, v.pos.z, v.argb, 0.0f, 0.0f });
		device->DrawPrimitiveUP(D3DPT_TRIANGLELIST, static_cast<UINT>(out.size() / 3), out.data(), sizeof(Vertex));
	}

	void Lines(const std::vector<ColorVertex>& vertices)
	{
		IDirect3DDevice8* device = Direct3D_Device;
		if (!device || vertices.size() < 2) return;
		States states(device);
		states.Textured(nullptr);
		std::vector<Vertex> out;
		out.reserve(vertices.size());
		for (const auto& v : vertices) out.push_back({ v.pos.x, v.pos.y, v.pos.z, v.argb, 0.0f, 0.0f });
		device->DrawPrimitiveUP(D3DPT_LINELIST, static_cast<UINT>(out.size() / 2), out.data(), sizeof(Vertex));
	}

	void ForgetModel(const StudioModel& model)
	{
		auto it = textures.find(&model);
		if (it == textures.end()) return;
		for (auto* tex : it->second)
			if (tex) tex->Release();
		textures.erase(it);
	}
} }
