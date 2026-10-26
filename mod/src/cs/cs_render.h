#pragma once
#include <cstdint>
#include <vector>
#include "cs_mdl.h"

// Drawing inside SADX's frame with its own Direct3D 8 device: the game keeps the camera in VIEW and PROJECTION
// for the viewport being drawn (each split-screen player's), so geometry goes in world coordinates with WORLD set
// to identity. Every render state touched is put back afterwards: the game caches its own.
namespace cs
{
	struct Vec3
	{
		float x, y, z;
	};

	// Where a model stands: SADX world position of its feet, its axes (forward, up, side) and size.
	struct Placement
	{
		Vec3 origin;
		Vec3 forward;
		Vec3 up;
		Vec3 side;
		float scale;
	};

	struct ColorVertex
	{
		Vec3 pos;
		uint32_t argb;
	};

	namespace render
	{
		// A studio model posed with these bones (model space, GoldSrc axes: X forward, Y left, Z up).
		void Model(const StudioModel& model, const std::vector<Mat34>& bones, const Placement& where);

		// Untextured triangles and lines, already in world coordinates (placeholder soldier, effects).
		void Triangles(const std::vector<ColorVertex>& vertices);
		void Lines(const std::vector<ColorVertex>& vertices);

		// Textures belong to the device; a model's are created on its first draw.
		void ForgetModel(const StudioModel& model);
	}
}
