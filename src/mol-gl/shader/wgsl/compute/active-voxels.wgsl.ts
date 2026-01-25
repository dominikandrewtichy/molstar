/**
 * Copyright (c) 2025-2026 mol* contributors, licensed under MIT, See LICENSE file for more info.
 *
 * @author Alexander Rose <alexander.rose@weirdbyte.de>
 */

/**
 * Compute shader for identifying active voxels in a volume for marching cubes.
 * An active voxel is one that contains the isosurface (has corners on both sides of the isovalue).
 *
 * This replaces the fragment shader-based approach in WebGL with a true compute shader.
 */
export const activeVoxels_wgsl = /* wgsl */`
// Uniforms for the active voxels computation
struct ActiveVoxelsUniforms {
    isoValue: f32,
    gridDim: vec3<f32>,
    _pad0: f32,
    gridTexDim: vec3<f32>,
    _pad1: f32,
    scale: vec2<f32>,
    _pad2: vec2<f32>,
}

@group(0) @binding(0) var<uniform> uniforms: ActiveVoxelsUniforms;
@group(0) @binding(1) var volumeData: texture_3d<f32>;
@group(0) @binding(2) var volumeSampler: sampler;
@group(0) @binding(3) var triCountTable: texture_2d<u32>;
@group(0) @binding(4) var<storage, read_write> activeVoxels: array<vec4<u32>>;

// Cube corners (excluding origin)
const c1 = vec3<f32>(1.0, 0.0, 0.0);
const c2 = vec3<f32>(1.0, 1.0, 0.0);
const c3 = vec3<f32>(0.0, 1.0, 0.0);
const c4 = vec3<f32>(0.0, 0.0, 1.0);
const c5 = vec3<f32>(1.0, 0.0, 1.0);
const c6 = vec3<f32>(1.0, 1.0, 1.0);
const c7 = vec3<f32>(0.0, 1.0, 1.0);

fn voxelValue(pos: vec3<f32>) -> f32 {
    let clampedPos = clamp(pos, vec3<f32>(0.0), uniforms.gridDim - vec3<f32>(1.0));
    let normalizedPos = clampedPos / uniforms.gridDim;
    let sample = textureSampleLevel(volumeData, volumeSampler, normalizedPos, 0.0);
    return sample.r; // Assuming data is in red channel
}

fn getTriCount(caseIndex: u32) -> u32 {
    let x = caseIndex % 16u;
    let y = caseIndex / 16u;
    return textureLoad(triCountTable, vec2<u32>(x, y), 0).r;
}

@compute @workgroup_size(8, 8, 8)
fn main(@builtin(global_invocation_id) globalId: vec3<u32>) {
    let gridDimU = vec3<u32>(uniforms.gridDim);

    // Check bounds
    if (globalId.x >= gridDimU.x || globalId.y >= gridDimU.y || globalId.z >= gridDimU.z) {
        return;
    }

    let posXYZ = vec3<f32>(globalId);
    let isoValue = uniforms.isoValue;

    // Get MC case as the sum of corners that are below the given iso level
    var caseIndex: u32 = 0u;
    if (voxelValue(posXYZ) <= isoValue) { caseIndex |= 1u; }
    if (voxelValue(posXYZ + c1) <= isoValue) { caseIndex |= 2u; }
    if (voxelValue(posXYZ + c2) <= isoValue) { caseIndex |= 4u; }
    if (voxelValue(posXYZ + c3) <= isoValue) { caseIndex |= 8u; }
    if (voxelValue(posXYZ + c4) <= isoValue) { caseIndex |= 16u; }
    if (voxelValue(posXYZ + c5) <= isoValue) { caseIndex |= 32u; }
    if (voxelValue(posXYZ + c6) <= isoValue) { caseIndex |= 64u; }
    if (voxelValue(posXYZ + c7) <= isoValue) { caseIndex |= 128u; }

    // Cases 0 and 255 have no triangles
    if (caseIndex == 0u || caseIndex == 255u) {
        caseIndex = 0u;
    }

    // Handle out of bounds positions
    let checkPos = posXYZ + vec3<f32>(1.0, 2.0, 1.0);
    if (checkPos.x >= uniforms.gridDim.x || checkPos.y >= uniforms.gridDim.y || checkPos.z >= uniforms.gridDim.z) {
        caseIndex = 0u;
    }

    // Get total vertices to generate for calculated MC case
    let triCount = getTriCount(caseIndex);
    let vertexCount = triCount * 3u;

    // Write to output buffer
    // Store: (vertexCount, caseIndex, 0, 0) for each voxel
    let index = globalId.x + globalId.y * gridDimU.x + globalId.z * gridDimU.x * gridDimU.y;
    activeVoxels[index] = vec4<u32>(vertexCount, caseIndex, 0u, 0u);
}
`;

/**
 * Compute shader for 2D texture-based active voxels output (for compatibility with histogram pyramid).
 */
export const activeVoxels2d_wgsl = /* wgsl */`
// Uniforms for the active voxels computation
struct ActiveVoxelsUniforms {
    isoValue: f32,
    gridDim: vec3<f32>,
    gridTexDim: vec3<f32>,
    _pad0: f32,
    scale: vec2<f32>,
    texSize: vec2<u32>,
}

@group(0) @binding(0) var<uniform> uniforms: ActiveVoxelsUniforms;
@group(0) @binding(1) var volumeData: texture_2d<f32>;
@group(0) @binding(2) var volumeSampler: sampler;
@group(0) @binding(3) var triCountTable: texture_2d<u32>;
@group(0) @binding(4) var outputTexture: texture_storage_2d<rgba8unorm, write>;

// Cube corners (excluding origin)
const c1 = vec3<f32>(1.0, 0.0, 0.0);
const c2 = vec3<f32>(1.0, 1.0, 0.0);
const c3 = vec3<f32>(0.0, 1.0, 0.0);
const c4 = vec3<f32>(0.0, 0.0, 1.0);
const c5 = vec3<f32>(1.0, 0.0, 1.0);
const c6 = vec3<f32>(1.0, 1.0, 1.0);
const c7 = vec3<f32>(0.0, 1.0, 1.0);

fn int_div(a: f32, b: f32) -> f32 {
    return f32(i32(a) / i32(b));
}

fn int_mod(a: f32, b: f32) -> f32 {
    return a - b * f32(i32(a) / i32(b));
}

fn index3dFrom2d(coord: vec2<f32>) -> vec3<f32> {
    let gridTexPos = coord * uniforms.gridTexDim.xy;
    let columnRow = floor(gridTexPos / uniforms.gridDim.xy);
    let posXY = gridTexPos - columnRow * uniforms.gridDim.xy;
    let posZ = columnRow.y * int_div(uniforms.gridTexDim.x, uniforms.gridDim.x) + columnRow.x;
    return vec3<f32>(posXY, posZ);
}

fn texture3dFrom2dNearest(pos: vec3<f32>, gridDim: vec3<f32>, texDim: vec2<f32>) -> vec4<f32> {
    let zSlice = floor(pos.z * gridDim.z + 0.5);
    let column = int_div(int_mod(zSlice * gridDim.x, texDim.x), gridDim.x);
    let row = int_div(zSlice * gridDim.x, texDim.x);
    let coord = (vec2<f32>(column * gridDim.x, row * gridDim.y) + (pos.xy * gridDim.xy)) / (texDim / uniforms.scale);
    return textureSampleLevel(volumeData, volumeSampler, coord, 0.0);
}

fn voxelValue(pos: vec3<f32>) -> f32 {
    let clampedPos = clamp(pos, vec3<f32>(0.0), uniforms.gridDim - vec3<f32>(1.0));
    let v = texture3dFrom2dNearest(clampedPos / uniforms.gridDim, uniforms.gridDim, uniforms.gridTexDim.xy);
    return v.r; // Assuming red channel
}

fn getTriCount(caseIndex: u32) -> u32 {
    let x = caseIndex % 16u;
    let y = caseIndex / 16u;
    return textureLoad(triCountTable, vec2<u32>(x, y), 0).r;
}

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) globalId: vec3<u32>) {
    let texSize = uniforms.texSize;

    // Check bounds
    if (globalId.x >= texSize.x || globalId.y >= texSize.y) {
        return;
    }

    let uv = vec2<f32>(globalId.xy) / vec2<f32>(uniforms.gridTexDim.xy);
    let posXYZ = index3dFrom2d(uv);
    let isoValue = uniforms.isoValue;

    // Get MC case as the sum of corners that are below the given iso level
    var c: f32 = 0.0;
    if (voxelValue(posXYZ) <= isoValue) { c += 1.0; }
    if (voxelValue(posXYZ + c1) <= isoValue) { c += 2.0; }
    if (voxelValue(posXYZ + c2) <= isoValue) { c += 4.0; }
    if (voxelValue(posXYZ + c3) <= isoValue) { c += 8.0; }
    if (voxelValue(posXYZ + c4) <= isoValue) { c += 16.0; }
    if (voxelValue(posXYZ + c5) <= isoValue) { c += 32.0; }
    if (voxelValue(posXYZ + c6) <= isoValue) { c += 64.0; }
    if (voxelValue(posXYZ + c7) <= isoValue) { c += 128.0; }

    // Cases 0 and 255 have no triangles
    if (c == 0.0 || c == 255.0) {
        c = 0.0;
    }

    // Handle out of bounds positions
    let checkPos = posXYZ + vec3<f32>(1.0, 2.0, 1.0);
    if (checkPos.x >= uniforms.gridDim.x || checkPos.y >= uniforms.gridDim.y || checkPos.z >= uniforms.gridDim.z) {
        c = 0.0;
    }

    // Get total triangles to generate for calculated MC case from triCount texture
    let caseIndex = u32(c);
    let triCount = getTriCount(caseIndex);
    let vertexCount = f32(triCount * 3u);

    // Output: (vertexCount * 3, vertexCount * 3, vertexCount * 3, caseIndex / 255.0)
    let output = vec4<f32>(vertexCount / 255.0, vertexCount / 255.0, vertexCount / 255.0, c / 255.0);
    textureStore(outputTexture, vec2<i32>(globalId.xy), output);
}
`;
