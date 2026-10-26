#pragma once
#include <cstdint>
#include <string>
#include <vector>

// GoldSrc studio models (Half-Life / Counter-Strike 1.6, MDL version 10), read from the host's own install:
// skeleton, sequences with the engine's compressed animation, meshes (triangle strips and fans) and 8-bit
// paletted textures. Laid out after the Half-Life SDK's studio.h; every offset is checked against the file, so
// a damaged model is refused instead of crashing the game.
namespace cs
{
	struct Mat34
	{
		float m[3][4];
	};

	struct ModelTexture
	{
		int width = 0;
		int height = 0;
		bool masked = false;          // palette index 255 is transparent (STUDIO_NF_MASKED)
		std::vector<uint32_t> argb;   // decoded from the palette
	};

	struct ModelVertex
	{
		int bone;
		float pos[3];                 // in its bone's space
		float normal[3];
		float u, v;
	};

	struct ModelMesh
	{
		int texture;                  // index into textures, -1 without one
		std::vector<ModelVertex> triangles; // three per triangle, strips and fans already expanded
	};

	class StudioModel
	{
	public:
		// Reads path, plus <name>T.mdl when the textures live apart and <name>NN.mdl for other sequence groups.
		bool Load(const std::wstring& path);
		bool Loaded() const { return !bones_.empty(); }

		int FindSequence(const char* name) const;
		int FindBone(const char* name) const;
		int SequenceFrames(int sequence) const;
		float SequenceFps(int sequence) const;
		int BoneCount() const { return static_cast<int>(bones_.size()); }
		const char* BoneName(int bone) const { return bones_[bone].name; }

		// Model-space bone transforms for a frame of a sequence (two-blend aim sequences mixed half and half: level
		// aim). With a gait sequence, the bones before "Bip01 Spine" (pelvis and legs) come from it, like the
		// engine does for players.
		void Pose(int sequence, float frame, int gait, float gaitFrame, std::vector<Mat34>& out) const;

		const std::vector<ModelMesh>& Meshes() const { return meshes_; }
		const std::vector<ModelTexture>& Textures() const { return textures_; }

	private:
		struct Bone
		{
			char name[32];
			int parent;
			float value[6];
			float scale[6];
		};

		struct Sequence
		{
			char name[32];
			float fps;
			int frames;
			int motionType;
			int motionBone;
			int group;
			int blends;                  // aim sequences have two (looking down, looking up)
			size_t anim;                 // offset of the first blend's mstudioanim_t array in its group's data
		};

		void Rotations(int sequence, int blend, float frame, std::vector<float>& pos, std::vector<float>& quat) const;

		std::vector<Bone> bones_;
		std::vector<Sequence> sequences_;
		std::vector<ModelMesh> meshes_;
		std::vector<ModelTexture> textures_;
		std::vector<std::vector<uint8_t>> groups_; // sequence group data: [0] is the model file itself
		int spine_ = -1;
	};
}
