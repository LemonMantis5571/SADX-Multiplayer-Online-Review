#include "pch.h"
#include <cmath>
#include <cstring>
#include <fstream>
#include <iterator>
#include "cs_mdl.h"

namespace cs
{
	namespace
	{
		// Offsets in studiohdr_t and friends (studio.h, version 10).
		constexpr size_t HDR_NUMBONES = 140, HDR_BONEINDEX = 144, HDR_NUMSEQ = 164, HDR_SEQINDEX = 168,
			HDR_NUMSEQGROUPS = 172, HDR_SEQGROUPINDEX = 176, HDR_NUMTEXTURES = 180, HDR_TEXTUREINDEX = 184,
			HDR_NUMSKINREF = 192, HDR_SKININDEX = 200, HDR_NUMBODYPARTS = 204, HDR_BODYPARTINDEX = 208,
			HDR_SIZE = 244;
		constexpr size_t BONE_SIZE = 112, SEQ_SIZE = 176, SEQGROUP_SIZE = 104, TEXTURE_SIZE = 80,
			BODYPART_SIZE = 76, MODEL_SIZE = 112, MESH_SIZE = 20;
		constexpr int STUDIO_X = 1, STUDIO_Y = 2, STUDIO_Z = 4;
		constexpr int STUDIO_NF_MASKED = 0x40;

		bool ReadFile(const std::wstring& path, std::vector<uint8_t>& data)
		{
			std::ifstream file(path, std::ios::binary);
			if (!file) return false;
			data.assign(std::istreambuf_iterator<char>(file), std::istreambuf_iterator<char>());
			return true;
		}

		// Bounds-checked reads: a damaged file yields false, never a read past the buffer.
		struct Reader
		{
			const std::vector<uint8_t>& d;
			bool ok = true;

			template <typename T> T at(size_t offset)
			{
				T value{};
				if (offset + sizeof(T) > d.size()) { ok = false; return value; }
				std::memcpy(&value, d.data() + offset, sizeof(T));
				return value;
			}

			bool has(size_t offset, size_t length) const { return offset <= d.size() && length <= d.size() - offset; }
		};

		void AngleQuaternion(const float angles[3], float q[4])
		{
			const float sy = std::sin(angles[2] * 0.5f), cy = std::cos(angles[2] * 0.5f);
			const float sp = std::sin(angles[1] * 0.5f), cp = std::cos(angles[1] * 0.5f);
			const float sr = std::sin(angles[0] * 0.5f), cr = std::cos(angles[0] * 0.5f);
			q[0] = sr * cp * cy - cr * sp * sy;
			q[1] = cr * sp * cy + sr * cp * sy;
			q[2] = cr * cp * sy - sr * sp * cy;
			q[3] = cr * cp * cy + sr * sp * sy;
		}

		void QuaternionSlerp(const float p[4], float q[4], float t, float out[4])
		{
			float a = 0.0f, b = 0.0f;
			for (int i = 0; i < 4; ++i)
			{
				a += (p[i] - q[i]) * (p[i] - q[i]);
				b += (p[i] + q[i]) * (p[i] + q[i]);
			}
			if (a > b)
				for (int i = 0; i < 4; ++i) q[i] = -q[i];
			const float cosom = p[0] * q[0] + p[1] * q[1] + p[2] * q[2] + p[3] * q[3];
			float sclp, sclq;
			if (1.0f + cosom > 0.000001f)
			{
				if (1.0f - cosom > 0.000001f)
				{
					const float omega = std::acos(cosom), sinom = std::sin(omega);
					sclp = std::sin((1.0f - t) * omega) / sinom;
					sclq = std::sin(t * omega) / sinom;
				}
				else
				{
					sclp = 1.0f - t;
					sclq = t;
				}
				for (int i = 0; i < 4; ++i) out[i] = sclp * p[i] + sclq * q[i];
			}
			else
			{
				out[0] = -q[1]; out[1] = q[0]; out[2] = -q[3]; out[3] = q[2];
				sclp = std::sin((1.0f - t) * 1.5707963f);
				sclq = std::sin(t * 1.5707963f);
				for (int i = 0; i < 3; ++i) out[i] = sclp * p[i] + sclq * out[i];
			}
		}

		void QuaternionMatrix(const float q[4], const float pos[3], Mat34& m)
		{
			m.m[0][0] = 1.0f - 2.0f * q[1] * q[1] - 2.0f * q[2] * q[2];
			m.m[1][0] = 2.0f * q[0] * q[1] + 2.0f * q[3] * q[2];
			m.m[2][0] = 2.0f * q[0] * q[2] - 2.0f * q[3] * q[1];
			m.m[0][1] = 2.0f * q[0] * q[1] - 2.0f * q[3] * q[2];
			m.m[1][1] = 1.0f - 2.0f * q[0] * q[0] - 2.0f * q[2] * q[2];
			m.m[2][1] = 2.0f * q[1] * q[2] + 2.0f * q[3] * q[0];
			m.m[0][2] = 2.0f * q[0] * q[2] + 2.0f * q[3] * q[1];
			m.m[1][2] = 2.0f * q[1] * q[2] - 2.0f * q[3] * q[0];
			m.m[2][2] = 1.0f - 2.0f * q[0] * q[0] - 2.0f * q[1] * q[1];
			m.m[0][3] = pos[0];
			m.m[1][3] = pos[1];
			m.m[2][3] = pos[2];
		}

		void Concat(const Mat34& a, const Mat34& b, Mat34& out)
		{
			for (int r = 0; r < 3; ++r)
			{
				for (int c = 0; c < 4; ++c)
				{
					out.m[r][c] = a.m[r][0] * b.m[0][c] + a.m[r][1] * b.m[1][c] + a.m[r][2] * b.m[2][c];
				}
				out.m[r][3] += a.m[r][3];
			}
		}

		// One channel of mstudioanim_t, walked like the Half-Life SDK (StudioCalcBoneQuaterion / Position): the run
		// holding frame k. Returns the reader position of that run, and k within it.
		bool FindRun(Reader& r, size_t& values, int& k)
		{
			if (r.at<uint8_t>(values + 1) < r.at<uint8_t>(values)) k = 0;
			for (int guard = 0; guard < 4096; ++guard)
			{
				const uint8_t valid = r.at<uint8_t>(values), total = r.at<uint8_t>(values + 1);
				if (!r.ok || total == 0) return false;
				if (total > k) return true;
				k -= total;
				values += (valid + 1) * 2;
				if (r.at<uint8_t>(values + 1) < r.at<uint8_t>(values)) k = 0;
			}
			return false;
		}

		int Value(Reader& r, size_t values, int index)
		{
			return r.at<int16_t>(values + index * 2);
		}

		// Rotation channel: the values at frame k and k+1 (slerped by the caller).
		bool AngleValues(Reader& r, size_t values, int frame, int& v1, int& v2)
		{
			int k = frame;
			if (!FindRun(r, values, k)) return false;
			const uint8_t valid = r.at<uint8_t>(values), total = r.at<uint8_t>(values + 1);
			if (valid > k)
			{
				v1 = Value(r, values, k + 1);
				if (valid > k + 1) v2 = Value(r, values, k + 2);
				else v2 = total > k + 1 ? v1 : Value(r, values, valid + 2);
			}
			else
			{
				v1 = Value(r, values, valid);
				v2 = total > k + 1 ? v1 : Value(r, values, valid + 2);
			}
			return r.ok;
		}

		// Position channel: already interpolated by s (the SDK blends positions a little differently).
		bool PositionValue(Reader& r, size_t values, int frame, float s, float& out)
		{
			int k = frame;
			if (!FindRun(r, values, k)) return false;
			const uint8_t valid = r.at<uint8_t>(values), total = r.at<uint8_t>(values + 1);
			if (valid > k)
			{
				out = valid > k + 1 ? Value(r, values, k + 1) * (1.0f - s) + s * Value(r, values, k + 2)
					: static_cast<float>(Value(r, values, k + 1));
			}
			else
			{
				out = total <= k + 1 ? Value(r, values, valid) * (1.0f - s) + s * Value(r, values, valid + 2)
					: static_cast<float>(Value(r, values, valid));
			}
			return r.ok;
		}
	}

	bool StudioModel::Load(const std::wstring& path)
	{
		bones_.clear();
		sequences_.clear();
		meshes_.clear();
		textures_.clear();
		groups_.clear();

		std::vector<uint8_t> data;
		if (!ReadFile(path, data) || data.size() < HDR_SIZE || std::memcmp(data.data(), "IDST", 4) != 0) return false;
		Reader r{ data };
		if (r.at<int>(4) != 10) return false;

		// Skeleton.
		const int numBones = r.at<int>(HDR_NUMBONES);
		const size_t boneIndex = r.at<int>(HDR_BONEINDEX);
		if (numBones <= 0 || numBones > 128 || !r.has(boneIndex, numBones * BONE_SIZE)) return false;
		std::vector<Bone> bones(numBones);
		for (int i = 0; i < numBones; ++i)
		{
			const size_t b = boneIndex + i * BONE_SIZE;
			std::memcpy(bones[i].name, data.data() + b, 32);
			bones[i].name[31] = '\0';
			bones[i].parent = r.at<int>(b + 32);
			for (int j = 0; j < 6; ++j)
			{
				bones[i].value[j] = r.at<float>(b + 64 + j * 4);
				bones[i].scale[j] = r.at<float>(b + 88 + j * 4);
			}
			if (bones[i].parent >= i) return false; // parents come first
		}

		// Sequences (blend 0) and where their animation lives.
		const int numSeq = r.at<int>(HDR_NUMSEQ);
		const size_t seqIndex = r.at<int>(HDR_SEQINDEX);
		const int numGroups = r.at<int>(HDR_NUMSEQGROUPS);
		const size_t groupIndex = r.at<int>(HDR_SEQGROUPINDEX);
		if (numSeq < 0 || numSeq > 512 || !r.has(seqIndex, numSeq * SEQ_SIZE)) return false;
		if (numGroups < 1 || numGroups > 64 || !r.has(groupIndex, numGroups * SEQGROUP_SIZE)) return false;
		const size_t group0Data = r.at<int>(groupIndex + 100);
		std::vector<Sequence> sequences(numSeq);
		for (int i = 0; i < numSeq; ++i)
		{
			const size_t s = seqIndex + i * SEQ_SIZE;
			std::memcpy(sequences[i].name, data.data() + s, 32);
			sequences[i].name[31] = '\0';
			sequences[i].fps = r.at<float>(s + 32);
			sequences[i].frames = r.at<int>(s + 56);
			sequences[i].motionType = r.at<int>(s + 68);
			sequences[i].motionBone = r.at<int>(s + 72);
			sequences[i].group = r.at<int>(s + 156);
			sequences[i].blends = r.at<int>(s + 120);
			sequences[i].anim = static_cast<size_t>(r.at<int>(s + 124)) + (sequences[i].group == 0 ? group0Data : 0);
			if (sequences[i].group < 0 || sequences[i].group >= numGroups) sequences[i].frames = 0;
		}

		// Other sequence groups: <name>01.mdl, <name>02.mdl... next to the model.
		std::vector<std::vector<uint8_t>> groups(numGroups);
		const std::wstring stem = path.size() > 4 ? path.substr(0, path.size() - 4) : path;
		for (int g = 1; g < numGroups; ++g)
		{
			wchar_t suffix[8];
			swprintf_s(suffix, L"%02d.mdl", g);
			if (!ReadFile(stem + suffix, groups[g]) || groups[g].size() < 8 || std::memcmp(groups[g].data(), "IDSQ", 4) != 0)
			{
				groups[g].clear();
			}
		}

		// Textures and skins, from the model or from <name>T.mdl.
		std::vector<uint8_t> textureFile;
		const std::vector<uint8_t>* textureData = &data;
		if (r.at<int>(HDR_NUMTEXTURES) == 0)
		{
			if (ReadFile(stem + L"T.mdl", textureFile) && textureFile.size() >= HDR_SIZE && std::memcmp(textureFile.data(), "IDST", 4) == 0)
				textureData = &textureFile;
		}
		Reader t{ *textureData };
		const int numTextures = t.at<int>(HDR_NUMTEXTURES);
		const size_t textureIndex = t.at<int>(HDR_TEXTUREINDEX);
		std::vector<ModelTexture> textures;
		if (numTextures > 0 && numTextures <= 64 && t.has(textureIndex, numTextures * TEXTURE_SIZE))
		{
			for (int i = 0; i < numTextures; ++i)
			{
				const size_t tx = textureIndex + i * TEXTURE_SIZE;
				ModelTexture tex;
				const int flags = t.at<int>(tx + 64);
				tex.width = t.at<int>(tx + 68);
				tex.height = t.at<int>(tx + 72);
				const size_t pixels = t.at<int>(tx + 76);
				tex.masked = (flags & STUDIO_NF_MASKED) != 0;
				const size_t count = static_cast<size_t>(tex.width) * tex.height;
				if (tex.width <= 0 || tex.height <= 0 || tex.width > 1024 || tex.height > 1024 || !t.has(pixels, count + 768))
				{
					textures.push_back({});
					continue;
				}
				const uint8_t* index = textureData->data() + pixels;
				const uint8_t* palette = index + count;
				tex.argb.resize(count);
				for (size_t p = 0; p < count; ++p)
				{
					const uint8_t c = index[p];
					const uint32_t alpha = tex.masked && c == 255 ? 0x00 : 0xFF;
					tex.argb[p] = (alpha << 24) | (palette[c * 3] << 16) | (palette[c * 3 + 1] << 8) | palette[c * 3 + 2];
				}
				textures.push_back(std::move(tex));
			}
		}
		const int numSkinRef = t.at<int>(HDR_NUMSKINREF);
		const size_t skinIndex = t.at<int>(HDR_SKININDEX);
		auto skinTexture = [&](int skinref) {
			if (skinref < 0 || skinref >= numSkinRef || !t.has(skinIndex + skinref * 2, 2)) return skinref < static_cast<int>(textures.size()) ? skinref : -1;
			const int texture = t.at<int16_t>(skinIndex + skinref * 2);
			return texture >= 0 && texture < static_cast<int>(textures.size()) ? texture : -1;
		};

		// Meshes: the first model of every body part, triangle commands expanded to a plain list.
		const int numBodyParts = r.at<int>(HDR_NUMBODYPARTS);
		const size_t bodyPartIndex = r.at<int>(HDR_BODYPARTINDEX);
		if (numBodyParts <= 0 || numBodyParts > 32 || !r.has(bodyPartIndex, numBodyParts * BODYPART_SIZE)) return false;
		std::vector<ModelMesh> meshes;
		for (int bp = 0; bp < numBodyParts; ++bp)
		{
			const size_t part = bodyPartIndex + bp * BODYPART_SIZE;
			if (r.at<int>(part + 64) < 1) continue;
			const size_t model = r.at<int>(part + 72);
			if (!r.has(model, MODEL_SIZE)) return false;
			const int numMesh = r.at<int>(model + 72);
			const size_t meshIndex = r.at<int>(model + 76);
			const int numVerts = r.at<int>(model + 80);
			const size_t vertInfo = r.at<int>(model + 84), vertIndex = r.at<int>(model + 88);
			const int numNorms = r.at<int>(model + 92);
			const size_t normInfo = r.at<int>(model + 96), normIndex = r.at<int>(model + 100);
			if (numMesh < 0 || numMesh > 256 || !r.has(meshIndex, numMesh * MESH_SIZE)) return false;
			if (numVerts < 0 || !r.has(vertInfo, numVerts) || !r.has(vertIndex, numVerts * 12)) return false;
			if (numNorms < 0 || !r.has(normInfo, numNorms) || !r.has(normIndex, numNorms * 12)) return false;

			for (int m = 0; m < numMesh; ++m)
			{
				const size_t mesh = meshIndex + m * MESH_SIZE;
				ModelMesh out;
				out.texture = skinTexture(r.at<int>(mesh + 8));
				const float width = out.texture >= 0 && textures[out.texture].width ? static_cast<float>(textures[out.texture].width) : 1.0f;
				const float height = out.texture >= 0 && textures[out.texture].height ? static_cast<float>(textures[out.texture].height) : 1.0f;
				size_t cmd = r.at<int>(mesh + 4);

				auto vertex = [&](size_t at) -> ModelVertex {
					ModelVertex v{};
					const int vi = r.at<int16_t>(at), ni = r.at<int16_t>(at + 2);
					const int s = r.at<int16_t>(at + 4), tt = r.at<int16_t>(at + 6);
					if (vi < 0 || vi >= numVerts || ni < 0 || ni >= numNorms) { r.ok = false; return v; }
					v.bone = r.at<uint8_t>(vertInfo + vi);
					for (int k = 0; k < 3; ++k)
					{
						v.pos[k] = r.at<float>(vertIndex + vi * 12 + k * 4);
						v.normal[k] = r.at<float>(normIndex + ni * 12 + k * 4);
					}
					v.u = s / width;
					v.v = tt / height;
					if (v.bone >= numBones) r.ok = false;
					return v;
				};

				for (int guard = 0; guard < 65536; ++guard)
				{
					int count = r.at<int16_t>(cmd);
					cmd += 2;
					if (!r.ok || count == 0) break;
					const bool fan = count < 0;
					count = fan ? -count : count;
					std::vector<ModelVertex> run;
					for (int k = 0; k < count; ++k, cmd += 8) run.push_back(vertex(cmd));
					if (!r.ok) return false;
					for (int k = 2; k < count; ++k)
					{
						if (fan)
						{
							out.triangles.push_back(run[0]);
							out.triangles.push_back(run[k - 1]);
							out.triangles.push_back(run[k]);
						}
						else if (k % 2 == 0)
						{
							out.triangles.push_back(run[k - 2]);
							out.triangles.push_back(run[k - 1]);
							out.triangles.push_back(run[k]);
						}
						else
						{
							out.triangles.push_back(run[k - 1]);
							out.triangles.push_back(run[k - 2]);
							out.triangles.push_back(run[k]);
						}
					}
				}
				if (!out.triangles.empty()) meshes.push_back(std::move(out));
			}
		}
		if (!r.ok || meshes.empty()) return false;

		bones_ = std::move(bones);
		sequences_ = std::move(sequences);
		meshes_ = std::move(meshes);
		textures_ = std::move(textures);
		groups[0] = std::move(data);
		groups_ = std::move(groups);
		// The bones a player's gait sequence drives, picked like the SDK's GameStudioModelRenderer (Counter-Strike):
		// from the root on, off at "Bip01 Spine", back on at each child of "Bip01 Pelvis" (CS models list the
		// spine and arms before the legs).
		gait_.assign(bones_.size(), false);
		const int spine = FindBone("Bip01 Spine");
		const int pelvis = FindBone("Bip01 Pelvis");
		bool copy = spine >= 0;
		for (size_t b = 0; b < bones_.size(); ++b)
		{
			if (static_cast<int>(b) == spine) copy = false;
			else if (pelvis >= 0 && bones_[b].parent == pelvis) copy = true;
			gait_[b] = copy;
		}
		return true;
	}

	int StudioModel::FindSequence(const char* name) const
	{
		for (size_t i = 0; i < sequences_.size(); ++i)
			if (_stricmp(sequences_[i].name, name) == 0) return static_cast<int>(i);
		return -1;
	}

	int StudioModel::FindBone(const char* name) const
	{
		for (size_t i = 0; i < bones_.size(); ++i)
			if (_stricmp(bones_[i].name, name) == 0) return static_cast<int>(i);
		return -1;
	}

	int StudioModel::SequenceFrames(int sequence) const
	{
		return sequence >= 0 && sequence < static_cast<int>(sequences_.size()) ? sequences_[sequence].frames : 0;
	}

	float StudioModel::SequenceFps(int sequence) const
	{
		return sequence >= 0 && sequence < static_cast<int>(sequences_.size()) ? sequences_[sequence].fps : 30.0f;
	}

	void StudioModel::Rotations(int sequence, int blend, float frame, std::vector<float>& pos, std::vector<float>& quat) const
	{
		const size_t n = bones_.size();
		pos.assign(n * 3, 0.0f);
		quat.assign(n * 4, 0.0f);
		for (size_t b = 0; b < n; ++b)
		{
			float angles[3] = { bones_[b].value[3], bones_[b].value[4], bones_[b].value[5] };
			AngleQuaternion(angles, &quat[b * 4]);
			for (int j = 0; j < 3; ++j) pos[b * 3 + j] = bones_[b].value[j];
		}
		if (sequence < 0 || sequence >= static_cast<int>(sequences_.size())) return;
		const Sequence& seq = sequences_[sequence];
		if (seq.frames <= 0 || seq.group >= static_cast<int>(groups_.size()) || groups_[seq.group].empty()) return;

		Reader r{ groups_[seq.group] };
		const int f = static_cast<int>(frame);
		const float s = frame - f;
		for (size_t b = 0; b < n; ++b)
		{
			const size_t anim = seq.anim + (static_cast<size_t>(blend) * n + b) * 12;
			if (!r.has(anim, 12)) return;
			const Bone& bone = bones_[b];

			float a1[3], a2[3];
			for (int j = 0; j < 3; ++j)
			{
				const uint16_t offset = r.at<uint16_t>(anim + (j + 3) * 2);
				a1[j] = a2[j] = bone.value[j + 3];
				int v1, v2;
				if (offset && AngleValues(r, anim + offset, f, v1, v2))
				{
					a1[j] = bone.value[j + 3] + v1 * bone.scale[j + 3];
					a2[j] = bone.value[j + 3] + v2 * bone.scale[j + 3];
				}
			}
			float q1[4], q2[4];
			AngleQuaternion(a1, q1);
			AngleQuaternion(a2, q2);
			QuaternionSlerp(q1, q2, s, &quat[b * 4]);

			for (int j = 0; j < 3; ++j)
			{
				const uint16_t offset = r.at<uint16_t>(anim + j * 2);
				float v;
				if (offset && PositionValue(r, anim + offset, f, s, v))
					pos[b * 3 + j] = bone.value[j] + v * bone.scale[j];
			}
		}
		// Movement baked into the root (run cycles) stays where the game puts the player.
		if (seq.motionBone >= 0 && seq.motionBone < static_cast<int>(n))
		{
			if (seq.motionType & STUDIO_X) pos[seq.motionBone * 3 + 0] = 0.0f;
			if (seq.motionType & STUDIO_Y) pos[seq.motionBone * 3 + 1] = 0.0f;
			if (seq.motionType & STUDIO_Z) pos[seq.motionBone * 3 + 2] = 0.0f;
		}
	}

	void StudioModel::Pose(int sequence, float frame, int gait, float gaitFrame, std::vector<Mat34>& out) const
	{
		std::vector<float> pos, quat;
		const int blends = sequence >= 0 && sequence < static_cast<int>(sequences_.size()) ? sequences_[sequence].blends : 1;
		// Counter-Strike's aim sequences have nine blends, a 3x3 grid of pitch and yaw: the middle one aims level
		// and straight ahead.
		Rotations(sequence, blends > 2 && blends % 2 ? blends / 2 : 0, frame, pos, quat);
		if (blends == 2)
		{
			// Level aim: halfway between the down and up blends (the engine's StudioSlerpBones at pitch 0).
			std::vector<float> pos2, quat2;
			Rotations(sequence, 1, frame, pos2, quat2);
			for (size_t b = 0; b < bones_.size(); ++b)
			{
				float q[4];
				QuaternionSlerp(&quat[b * 4], &quat2[b * 4], 0.5f, q);
				for (int i = 0; i < 4; ++i) quat[b * 4 + i] = q[i];
				for (int i = 0; i < 3; ++i) pos[b * 3 + i] = (pos[b * 3 + i] + pos2[b * 3 + i]) * 0.5f;
			}
		}
		if (gait >= 0)
		{
			std::vector<float> gpos, gquat;
			Rotations(gait, 0, gaitFrame, gpos, gquat);
			for (size_t b = 0; b < bones_.size(); ++b)
			{
				if (!gait_[b]) continue;
				std::copy(gpos.begin() + b * 3, gpos.begin() + b * 3 + 3, pos.begin() + b * 3);
				std::copy(gquat.begin() + b * 4, gquat.begin() + b * 4 + 4, quat.begin() + b * 4);
			}
		}
		Build(pos, quat, nullptr, nullptr, out);
	}

	void StudioModel::PoseOn(int sequence, float frame, const StudioModel& owner, const std::vector<Mat34>& ownerBones,
		std::vector<Mat34>& out) const
	{
		std::vector<float> pos, quat;
		Rotations(sequence, 0, frame, pos, quat);
		Build(pos, quat, &owner, &ownerBones, out);
	}

	void StudioModel::Build(const std::vector<float>& pos, const std::vector<float>& quat, const StudioModel* owner,
		const std::vector<Mat34>* ownerBones, std::vector<Mat34>& out) const
	{
		out.resize(bones_.size());
		for (size_t b = 0; b < bones_.size(); ++b)
		{
			const int match = owner ? owner->FindBone(bones_[b].name) : -1;
			if (match >= 0 && match < static_cast<int>(ownerBones->size()))
			{
				out[b] = (*ownerBones)[match];
				continue;
			}
			Mat34 local;
			QuaternionMatrix(&quat[b * 4], &pos[b * 3], local);
			if (bones_[b].parent < 0) out[b] = local;
			else Concat(out[bones_[b].parent], local, out[b]);
		}
	}
}
