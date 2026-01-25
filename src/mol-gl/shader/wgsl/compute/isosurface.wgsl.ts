/**
 * Copyright (c) 2025-2026 mol* contributors, licensed under MIT, See LICENSE file for more info.
 *
 * @author Alexander Rose <alexander.rose@weirdbyte.de>
 */

/**
 * Compute shader for marching cubes isosurface extraction.
 *
 * Uses the histogram pyramid to efficiently locate active voxels and generate
 * vertices, normals, and group IDs for the isosurface mesh.
 *
 * Algorithm from "High-speed Marching Cubes using HistoPyramids"
 * by C Dyken, G Ziegler, C Theobalt, HP Seidel
 * https://doi.org/10.1111/j.1467-8659.2008.01182.x
 */
export const isosurface_wgsl = /* wgsl */`
struct IsosurfaceUniforms {
    isoValue: f32,
    levels: f32,
    size: f32,           // 2^levels
    count: f32,          // Total vertex count

    gridDim: vec3<f32>,
    invert: u32,         // Boolean as u32

    gridTexDim: vec3<f32>,
    packedGroup: u32,    // Boolean as u32

    gridDataDim: vec3<f32>,
    constantGroup: u32,  // Boolean as u32

    gridTransform: mat4x4<f32>,
    gridTransformAdjoint: mat3x3<f32>,

    scale: vec2<f32>,
    axisOrder: u32,      // 0=012, 1=021, 2=102, 3=120, 4=201, 5=210
    _pad: u32,
}

@group(0) @binding(0) var<uniform> uniforms: IsosurfaceUniforms;
@group(0) @binding(1) var pyramidTexture: texture_2d<i32>;   // Histogram pyramid
@group(0) @binding(2) var activeVoxelsBase: texture_2d<f32>; // Base level active voxels
@group(0) @binding(3) var volumeData: texture_2d<f32>;       // Volume data (2D packed)
@group(0) @binding(4) var triIndices: texture_2d<f32>;       // MC edge table
@group(0) @binding(5) var volumeSampler: sampler;

// Output storage buffers
@group(1) @binding(0) var<storage, read_write> vertexBuffer: array<vec4<f32>>;
@group(1) @binding(1) var<storage, read_write> groupBuffer: array<vec4<f32>>;
@group(1) @binding(2) var<storage, read_write> normalBuffer: array<vec4<f32>>;

// Cube corners (excluding origin)
const c1 = vec3<f32>(1.0, 0.0, 0.0);
const c2 = vec3<f32>(1.0, 1.0, 0.0);
const c3 = vec3<f32>(0.0, 1.0, 0.0);
const c4 = vec3<f32>(0.0, 0.0, 1.0);
const c5 = vec3<f32>(1.0, 0.0, 1.0);
const c6 = vec3<f32>(1.0, 1.0, 1.0);
const c7 = vec3<f32>(0.0, 1.0, 1.0);

fn intDiv(a: f32, b: f32) -> f32 {
    return f32(i32(a) / i32(b));
}

fn intMod(a: f32, b: f32) -> f32 {
    return a - b * f32(i32(a) / i32(b));
}

fn ivec2Div(a: vec2<f32>, b: vec2<f32>) -> vec2<f32> {
    return vec2<f32>(
        f32(i32(a.x) / i32(b.x)),
        f32(i32(a.y) / i32(b.y))
    );
}

fn index3dFrom2d(coord: vec2<f32>) -> vec3<f32> {
    let gridTexPos = coord * uniforms.gridTexDim.xy;
    let columnRow = ivec2Div(gridTexPos, uniforms.gridDim.xy);
    let posXY = gridTexPos - columnRow * uniforms.gridDim.xy;
    let posZ = columnRow.y * intDiv(uniforms.gridTexDim.x, uniforms.gridDim.x) + columnRow.x;
    return vec3<f32>(posXY, posZ);
}

fn texture3dFrom2dNearest(pos: vec3<f32>, gridDim: vec3<f32>, texDim: vec2<f32>) -> vec4<f32> {
    let zSlice = floor(pos.z * gridDim.z + 0.5);
    let column = intDiv(intMod(zSlice * gridDim.x, texDim.x), gridDim.x);
    let row = intDiv(zSlice * gridDim.x, texDim.x);
    let coord = (vec2<f32>(column * gridDim.x, row * gridDim.y) + (pos.xy * gridDim.xy)) / (texDim / uniforms.scale);
    return textureSampleLevel(volumeData, volumeSampler, coord + 0.5 / (texDim / uniforms.scale), 0.0);
}

fn voxel(pos: vec3<f32>) -> vec4<f32> {
    let clampedPos = clamp(pos, vec3<f32>(0.0), uniforms.gridDim - vec3<f32>(1.0));
    return texture3dFrom2dNearest(clampedPos / uniforms.gridDim, uniforms.gridDim, uniforms.gridTexDim.xy);
}

fn voxelValuePadded(pos: vec3<f32>) -> f32 {
    let clampedPos = clamp(pos, vec3<f32>(0.0), uniforms.gridDim - vec3<f32>(2.0, 2.0, 1.0));
    let v = texture3dFrom2dNearest(clampedPos / uniforms.gridDim, uniforms.gridDim, uniforms.gridTexDim.xy);
    return v.r; // Assuming red channel
}

fn pyramidVoxel(pos: vec2<f32>) -> i32 {
    let texCoord = vec2<i32>(pos / (vec2<f32>(1.0, 0.5) * uniforms.size));
    return textureLoad(pyramidTexture, texCoord, 0).r;
}

fn baseVoxel(pos: vec2<f32>) -> vec4<f32> {
    let texCoord = vec2<i32>(pos / uniforms.size);
    return textureLoad(activeVoxelsBase, texCoord, 0);
}

fn packIntToRGB(value: f32) -> vec3<f32> {
    let v = u32(value);
    let r = f32(v & 0xFFu) / 255.0;
    let g = f32((v >> 8u) & 0xFFu) / 255.0;
    let b = f32((v >> 16u) & 0xFFu) / 255.0;
    return vec3<f32>(r, g, b);
}

fn getGroup(p: vec3<f32>) -> vec4<f32> {
    var group: f32;

    // Note: swap x and z because texture is flipped around y
    switch (uniforms.axisOrder) {
        case 0u: { // 012 -> 210
            group = p.z + p.y * uniforms.gridDataDim.z + p.x * uniforms.gridDataDim.z * uniforms.gridDataDim.y;
        }
        case 1u: { // 021 -> 120
            group = p.y + p.z * uniforms.gridDataDim.y + p.x * uniforms.gridDataDim.y * uniforms.gridDataDim.z;
        }
        case 2u: { // 102 -> 201
            group = p.z + p.x * uniforms.gridDataDim.z + p.y * uniforms.gridDataDim.z * uniforms.gridDataDim.x;
        }
        case 3u: { // 120 -> 021
            group = p.x + p.z * uniforms.gridDataDim.x + p.y * uniforms.gridDataDim.x * uniforms.gridDataDim.z;
        }
        case 4u: { // 201 -> 102
            group = p.y + p.x * uniforms.gridDataDim.y + p.z * uniforms.gridDataDim.y * uniforms.gridDataDim.x;
        }
        default: { // 210 -> 012
            group = p.x + p.y * uniforms.gridDataDim.x + p.z * uniforms.gridDataDim.x * uniforms.gridDataDim.y;
        }
    }

    if (group > 16777215.5) {
        return vec4<f32>(1.0, 1.0, 1.0, 1.0);
    }
    return vec4<f32>(packIntToRGB(group), 1.0);
}

fn idot2(a: vec2<i32>, b: vec2<i32>) -> i32 {
    return a.x * b.x + a.y * b.y;
}

fn idot4(a: vec4<i32>, b: vec4<i32>) -> i32 {
    return a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) globalId: vec3<u32>) {
    // Get 1D index
    let vI = i32(globalId.x);

    // Ignore indices outside the grid
    if (vI >= i32(uniforms.count)) {
        return;
    }

    var offset = vec2<i32>(i32(uniforms.size) - 2, 0);

    var start: i32 = 0;
    var starts = vec4<i32>(0);
    var ends = vec4<i32>(0);
    var diff: i32 = 2;
    var m = vec4<i32>(0);
    var position = vec2<i32>(0);
    let vI4 = vec4<i32>(vI, vI, vI, vI);

    var relativePosition = vec2<i32>(0);
    var end: i32 = 0;
    var pos1 = vec2<i32>(0);
    var pos2 = vec2<i32>(0);
    var pos3 = vec2<i32>(0);
    var pos4 = vec2<i32>(0);
    let vI3 = vec3<i32>(vI, vI, vI);
    var mask = vec3<i32>(0);

    // Traverse the different levels of the pyramid
    for (var i: i32 = 1; i < 14; i = i + 1) {
        if (f32(i) >= uniforms.levels) {
            break;
        }

        offset.x = offset.x - diff;
        diff = diff * 2;
        relativePosition = position + offset;

        end = start + pyramidVoxel(vec2<f32>(relativePosition));
        pos1 = relativePosition;
        starts.x = start;
        ends.x = end;
        pos2 = relativePosition + vec2<i32>(1, 0);
        starts.y = ends.x;
        ends.y = ends.x + pyramidVoxel(vec2<f32>(pos2));
        pos3 = relativePosition + vec2<i32>(0, 1);
        starts.z = ends.y;
        ends.z = ends.y + pyramidVoxel(vec2<f32>(pos3));
        pos4 = relativePosition + vec2<i32>(1, 1);
        starts.w = ends.z;

        mask = vec3<i32>(
            select(0, 1, vI3.x >= starts.x && vI3.x < ends.x),
            select(0, 1, vI3.y >= starts.y && vI3.y < ends.y),
            select(0, 1, vI3.z >= starts.z && vI3.z < ends.z)
        );
        m = vec4<i32>(mask, 1 - select(0, 1, mask.x != 0 || mask.y != 0 || mask.z != 0));

        relativePosition = m.x * pos1 + m.y * pos2 + m.z * pos3 + m.w * pos4;
        start = idot4(m, starts);
        position = 2 * (relativePosition - offset);
    }

    // Final level - read from base
    end = start + i32(baseVoxel(vec2<f32>(position)).r * 255.0);
    pos1 = position;
    starts.x = start;
    ends.x = end;
    pos2 = position + vec2<i32>(1, 0);
    starts.y = ends.x;
    ends.y = ends.x + i32(baseVoxel(vec2<f32>(pos2)).r * 255.0);
    pos3 = position + vec2<i32>(0, 1);
    starts.z = ends.y;
    ends.z = ends.y + i32(baseVoxel(vec2<f32>(pos3)).r * 255.0);
    pos4 = position + vec2<i32>(1, 1);
    starts.w = ends.z;

    mask = vec3<i32>(
        select(0, 1, vI3.x >= starts.x && vI3.x < ends.x),
        select(0, 1, vI3.y >= starts.y && vI3.y < ends.y),
        select(0, 1, vI3.z >= starts.z && vI3.z < ends.z)
    );
    m = vec4<i32>(mask, 1 - select(0, 1, mask.x != 0 || mask.y != 0 || mask.z != 0));
    position = m.x * pos1 + m.y * pos2 + m.z * pos3 + m.w * pos4;

    let coord2d = (vec2<f32>(position) / uniforms.size) / uniforms.scale;
    let coord3d = floor(index3dFrom2d(coord2d) + vec3<f32>(0.5));

    let edgeIndex = floor(baseVoxel(vec2<f32>(position)).a * 255.0 + 0.5);

    // Current vertex for the up to 15 MC cases
    var currentVertex = vI - idot4(m, starts);

    // Ensure winding-order is the same for negative and positive iso-levels
    if (uniforms.invert == 1u) {
        let v = currentVertex - 3 * (currentVertex / 3);  // imod(currentVertex + 1, 3)
        let v2 = (currentVertex + 1) - 3 * ((currentVertex + 1) / 3);
        if (v2 == 1) {
            currentVertex = currentVertex + 2;
        } else if (v2 == 0) {
            currentVertex = currentVertex - 2;
        }
    }

    // Get index into triIndices table
    let mcIndex = 16 * i32(edgeIndex) + currentVertex;
    let mcCoord = vec2<i32>(mcIndex % 64, mcIndex / 64);
    let mcData = textureLoad(triIndices, mcCoord, 0);

    // Bit mask for getting MC case corner
    let m0 = vec4<f32>(floor(mcData.a * 255.0 + 0.5));

    // Get edge value masks
    let m1 = vec4<f32>(
        select(0.0, 1.0, m0.x == 0.0),
        select(0.0, 1.0, m0.x == 1.0),
        select(0.0, 1.0, m0.x == 2.0),
        select(0.0, 1.0, m0.x == 3.0)
    );
    let m2 = vec4<f32>(
        select(0.0, 1.0, m0.x == 4.0),
        select(0.0, 1.0, m0.x == 5.0),
        select(0.0, 1.0, m0.x == 6.0),
        select(0.0, 1.0, m0.x == 7.0)
    );
    let m3 = vec4<f32>(
        select(0.0, 1.0, m0.x == 8.0),
        select(0.0, 1.0, m0.x == 9.0),
        select(0.0, 1.0, m0.x == 10.0),
        select(0.0, 1.0, m0.x == 11.0)
    );

    // Apply bit masks to get edge endpoints
    let b0 = coord3d +
        m1.y * c1 +
        m1.z * c2 +
        m1.w * c3 +
        m2.x * c4 +
        m2.y * c5 +
        m2.z * c6 +
        m2.w * c7 +
        m3.y * c1 +
        m3.z * c2 +
        m3.w * c3;

    let b1 = coord3d +
        m1.x * c1 +
        m1.y * c2 +
        m1.z * c3 +
        m2.x * c5 +
        m2.y * c6 +
        m2.z * c7 +
        m2.w * c4 +
        m3.x * c4 +
        m3.y * c5 +
        m3.z * c6 +
        m3.w * c7;

    let d0 = voxel(b0);
    let d1 = voxel(b1);

    let v0 = d0.r;
    let v1 = d1.r;

    let t = (uniforms.isoValue - v0) / (v0 - v1);

    // Vertex position
    let vertexPos = (uniforms.gridTransform * vec4<f32>(b0 + t * (b0 - b1), 1.0)).xyz;
    vertexBuffer[vI] = vec4<f32>(vertexPos, 1.0);

    // Group ID
    var groupValue: vec4<f32>;
    if (uniforms.constantGroup == 1u) {
        if (uniforms.packedGroup == 1u) {
            groupValue = vec4<f32>(voxel(coord3d).rgb, 1.0);
        } else {
            groupValue = getGroup(coord3d);
        }
    } else {
        if (uniforms.packedGroup == 1u) {
            groupValue = vec4<f32>(select(d1.rgb, d0.rgb, t < 0.5), 1.0);
        } else {
            groupValue = getGroup(select(b1, b0, t < 0.5));
        }
    }
    groupBuffer[vI] = groupValue;

    // Normals from gradients
    var n0 = -normalize(vec3<f32>(
        voxelValuePadded(b0 - c1) - voxelValuePadded(b0 + c1),
        voxelValuePadded(b0 - c3) - voxelValuePadded(b0 + c3),
        voxelValuePadded(b0 - c4) - voxelValuePadded(b0 + c4)
    ));
    var n1 = -normalize(vec3<f32>(
        voxelValuePadded(b1 - c1) - voxelValuePadded(b1 + c1),
        voxelValuePadded(b1 - c3) - voxelValuePadded(b1 + c3),
        voxelValuePadded(b1 - c4) - voxelValuePadded(b1 + c4)
    ));

    var normal = -vec3<f32>(
        n0.x + t * (n0.x - n1.x),
        n0.y + t * (n0.y - n1.y),
        n0.z + t * (n0.z - n1.z)
    );

    // Ensure normal direction is the same for negative and positive iso-levels
    if (uniforms.invert == 1u) {
        normal = normal * -1.0;
    }

    // Apply normal matrix
    normal = uniforms.gridTransformAdjoint * normal;
    normalBuffer[vI] = vec4<f32>(normal, 0.0);
}
`;

/**
 * Alternative isosurface shader that outputs to textures instead of storage buffers.
 * This is useful for compatibility with the existing texture-based pipeline.
 */
export const isosurfaceToTexture_wgsl = /* wgsl */`
struct IsosurfaceUniforms {
    isoValue: f32,
    levels: f32,
    size: f32,
    count: f32,

    gridDim: vec3<f32>,
    invert: u32,

    gridTexDim: vec3<f32>,
    packedGroup: u32,

    gridDataDim: vec3<f32>,
    constantGroup: u32,

    gridTransform: mat4x4<f32>,
    gridTransformAdjoint: mat3x3<f32>,

    scale: vec2<f32>,
    axisOrder: u32,
    outputWidth: u32,
}

@group(0) @binding(0) var<uniform> uniforms: IsosurfaceUniforms;
@group(0) @binding(1) var pyramidTexture: texture_2d<i32>;
@group(0) @binding(2) var activeVoxelsBase: texture_2d<f32>;
@group(0) @binding(3) var volumeData: texture_2d<f32>;
@group(0) @binding(4) var triIndices: texture_2d<f32>;
@group(0) @binding(5) var volumeSampler: sampler;

// Output textures
@group(1) @binding(0) var vertexTexture: texture_storage_2d<rgba32float, write>;
@group(1) @binding(1) var groupTexture: texture_storage_2d<rgba8unorm, write>;
@group(1) @binding(2) var normalTexture: texture_storage_2d<rgba16float, write>;

// [Same helper functions as above, omitted for brevity]
// ... include all the helper functions from isosurface_wgsl ...

const c1 = vec3<f32>(1.0, 0.0, 0.0);
const c2 = vec3<f32>(1.0, 1.0, 0.0);
const c3 = vec3<f32>(0.0, 1.0, 0.0);
const c4 = vec3<f32>(0.0, 0.0, 1.0);
const c5 = vec3<f32>(1.0, 0.0, 1.0);
const c6 = vec3<f32>(1.0, 1.0, 1.0);
const c7 = vec3<f32>(0.0, 1.0, 1.0);

fn intDiv(a: f32, b: f32) -> f32 {
    return f32(i32(a) / i32(b));
}

fn intMod(a: f32, b: f32) -> f32 {
    return a - b * f32(i32(a) / i32(b));
}

fn ivec2Div(a: vec2<f32>, b: vec2<f32>) -> vec2<f32> {
    return vec2<f32>(
        f32(i32(a.x) / i32(b.x)),
        f32(i32(a.y) / i32(b.y))
    );
}

fn index3dFrom2d(coord: vec2<f32>) -> vec3<f32> {
    let gridTexPos = coord * uniforms.gridTexDim.xy;
    let columnRow = ivec2Div(gridTexPos, uniforms.gridDim.xy);
    let posXY = gridTexPos - columnRow * uniforms.gridDim.xy;
    let posZ = columnRow.y * intDiv(uniforms.gridTexDim.x, uniforms.gridDim.x) + columnRow.x;
    return vec3<f32>(posXY, posZ);
}

fn texture3dFrom2dNearest(pos: vec3<f32>, gridDim: vec3<f32>, texDim: vec2<f32>) -> vec4<f32> {
    let zSlice = floor(pos.z * gridDim.z + 0.5);
    let column = intDiv(intMod(zSlice * gridDim.x, texDim.x), gridDim.x);
    let row = intDiv(zSlice * gridDim.x, texDim.x);
    let coord = (vec2<f32>(column * gridDim.x, row * gridDim.y) + (pos.xy * gridDim.xy)) / (texDim / uniforms.scale);
    return textureSampleLevel(volumeData, volumeSampler, coord + 0.5 / (texDim / uniforms.scale), 0.0);
}

fn voxel(pos: vec3<f32>) -> vec4<f32> {
    let clampedPos = clamp(pos, vec3<f32>(0.0), uniforms.gridDim - vec3<f32>(1.0));
    return texture3dFrom2dNearest(clampedPos / uniforms.gridDim, uniforms.gridDim, uniforms.gridTexDim.xy);
}

fn voxelValuePadded(pos: vec3<f32>) -> f32 {
    let clampedPos = clamp(pos, vec3<f32>(0.0), uniforms.gridDim - vec3<f32>(2.0, 2.0, 1.0));
    let v = texture3dFrom2dNearest(clampedPos / uniforms.gridDim, uniforms.gridDim, uniforms.gridTexDim.xy);
    return v.r;
}

fn pyramidVoxel(pos: vec2<f32>) -> i32 {
    let texCoord = vec2<i32>(pos / (vec2<f32>(1.0, 0.5) * uniforms.size));
    return textureLoad(pyramidTexture, texCoord, 0).r;
}

fn baseVoxel(pos: vec2<f32>) -> vec4<f32> {
    let texCoord = vec2<i32>(pos / uniforms.size);
    return textureLoad(activeVoxelsBase, texCoord, 0);
}

fn packIntToRGB(value: f32) -> vec3<f32> {
    let v = u32(value);
    let r = f32(v & 0xFFu) / 255.0;
    let g = f32((v >> 8u) & 0xFFu) / 255.0;
    let b = f32((v >> 16u) & 0xFFu) / 255.0;
    return vec3<f32>(r, g, b);
}

fn getGroup(p: vec3<f32>) -> vec4<f32> {
    var group: f32;
    switch (uniforms.axisOrder) {
        case 0u: {
            group = p.z + p.y * uniforms.gridDataDim.z + p.x * uniforms.gridDataDim.z * uniforms.gridDataDim.y;
        }
        case 1u: {
            group = p.y + p.z * uniforms.gridDataDim.y + p.x * uniforms.gridDataDim.y * uniforms.gridDataDim.z;
        }
        case 2u: {
            group = p.z + p.x * uniforms.gridDataDim.z + p.y * uniforms.gridDataDim.z * uniforms.gridDataDim.x;
        }
        case 3u: {
            group = p.x + p.z * uniforms.gridDataDim.x + p.y * uniforms.gridDataDim.x * uniforms.gridDataDim.z;
        }
        case 4u: {
            group = p.y + p.x * uniforms.gridDataDim.y + p.z * uniforms.gridDataDim.y * uniforms.gridDataDim.x;
        }
        default: {
            group = p.x + p.y * uniforms.gridDataDim.x + p.z * uniforms.gridDataDim.x * uniforms.gridDataDim.y;
        }
    }
    if (group > 16777215.5) {
        return vec4<f32>(1.0, 1.0, 1.0, 1.0);
    }
    return vec4<f32>(packIntToRGB(group), 1.0);
}

fn idot4(a: vec4<i32>, b: vec4<i32>) -> i32 {
    return a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
}

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) globalId: vec3<u32>) {
    // Convert 2D dispatch to 1D index
    let vI = i32(globalId.x + globalId.y * uniforms.outputWidth);

    if (vI >= i32(uniforms.count)) {
        return;
    }

    // Output coordinates
    let outCoord = vec2<i32>(globalId.xy);

    var offset = vec2<i32>(i32(uniforms.size) - 2, 0);
    var start: i32 = 0;
    var starts = vec4<i32>(0);
    var ends = vec4<i32>(0);
    var diff: i32 = 2;
    var m = vec4<i32>(0);
    var position = vec2<i32>(0);
    let vI3 = vec3<i32>(vI, vI, vI);
    var mask = vec3<i32>(0);

    var relativePosition = vec2<i32>(0);
    var end: i32 = 0;
    var pos1 = vec2<i32>(0);
    var pos2 = vec2<i32>(0);
    var pos3 = vec2<i32>(0);
    var pos4 = vec2<i32>(0);

    // Traverse pyramid levels
    for (var i: i32 = 1; i < 14; i = i + 1) {
        if (f32(i) >= uniforms.levels) {
            break;
        }

        offset.x = offset.x - diff;
        diff = diff * 2;
        relativePosition = position + offset;

        end = start + pyramidVoxel(vec2<f32>(relativePosition));
        pos1 = relativePosition;
        starts.x = start;
        ends.x = end;
        pos2 = relativePosition + vec2<i32>(1, 0);
        starts.y = ends.x;
        ends.y = ends.x + pyramidVoxel(vec2<f32>(pos2));
        pos3 = relativePosition + vec2<i32>(0, 1);
        starts.z = ends.y;
        ends.z = ends.y + pyramidVoxel(vec2<f32>(pos3));
        pos4 = relativePosition + vec2<i32>(1, 1);
        starts.w = ends.z;

        mask = vec3<i32>(
            select(0, 1, vI3.x >= starts.x && vI3.x < ends.x),
            select(0, 1, vI3.y >= starts.y && vI3.y < ends.y),
            select(0, 1, vI3.z >= starts.z && vI3.z < ends.z)
        );
        m = vec4<i32>(mask, 1 - select(0, 1, mask.x != 0 || mask.y != 0 || mask.z != 0));

        relativePosition = m.x * pos1 + m.y * pos2 + m.z * pos3 + m.w * pos4;
        start = idot4(m, starts);
        position = 2 * (relativePosition - offset);
    }

    // Final base level
    end = start + i32(baseVoxel(vec2<f32>(position)).r * 255.0);
    pos1 = position;
    starts.x = start;
    ends.x = end;
    pos2 = position + vec2<i32>(1, 0);
    starts.y = ends.x;
    ends.y = ends.x + i32(baseVoxel(vec2<f32>(pos2)).r * 255.0);
    pos3 = position + vec2<i32>(0, 1);
    starts.z = ends.y;
    ends.z = ends.y + i32(baseVoxel(vec2<f32>(pos3)).r * 255.0);
    pos4 = position + vec2<i32>(1, 1);
    starts.w = ends.z;

    mask = vec3<i32>(
        select(0, 1, vI3.x >= starts.x && vI3.x < ends.x),
        select(0, 1, vI3.y >= starts.y && vI3.y < ends.y),
        select(0, 1, vI3.z >= starts.z && vI3.z < ends.z)
    );
    m = vec4<i32>(mask, 1 - select(0, 1, mask.x != 0 || mask.y != 0 || mask.z != 0));
    position = m.x * pos1 + m.y * pos2 + m.z * pos3 + m.w * pos4;

    let coord2d = (vec2<f32>(position) / uniforms.size) / uniforms.scale;
    let coord3d = floor(index3dFrom2d(coord2d) + vec3<f32>(0.5));
    let edgeIndex = floor(baseVoxel(vec2<f32>(position)).a * 255.0 + 0.5);

    var currentVertex = vI - idot4(m, starts);

    if (uniforms.invert == 1u) {
        let v2 = (currentVertex + 1) - 3 * ((currentVertex + 1) / 3);
        if (v2 == 1) {
            currentVertex = currentVertex + 2;
        } else if (v2 == 0) {
            currentVertex = currentVertex - 2;
        }
    }

    let mcIndex = 16 * i32(edgeIndex) + currentVertex;
    let mcCoord = vec2<i32>(mcIndex % 64, mcIndex / 64);
    let mcData = textureLoad(triIndices, mcCoord, 0);

    let m0 = vec4<f32>(floor(mcData.a * 255.0 + 0.5));

    let m1 = vec4<f32>(
        select(0.0, 1.0, m0.x == 0.0),
        select(0.0, 1.0, m0.x == 1.0),
        select(0.0, 1.0, m0.x == 2.0),
        select(0.0, 1.0, m0.x == 3.0)
    );
    let m2 = vec4<f32>(
        select(0.0, 1.0, m0.x == 4.0),
        select(0.0, 1.0, m0.x == 5.0),
        select(0.0, 1.0, m0.x == 6.0),
        select(0.0, 1.0, m0.x == 7.0)
    );
    let m3 = vec4<f32>(
        select(0.0, 1.0, m0.x == 8.0),
        select(0.0, 1.0, m0.x == 9.0),
        select(0.0, 1.0, m0.x == 10.0),
        select(0.0, 1.0, m0.x == 11.0)
    );

    let b0 = coord3d +
        m1.y * c1 + m1.z * c2 + m1.w * c3 +
        m2.x * c4 + m2.y * c5 + m2.z * c6 + m2.w * c7 +
        m3.y * c1 + m3.z * c2 + m3.w * c3;

    let b1 = coord3d +
        m1.x * c1 + m1.y * c2 + m1.z * c3 +
        m2.x * c5 + m2.y * c6 + m2.z * c7 + m2.w * c4 +
        m3.x * c4 + m3.y * c5 + m3.z * c6 + m3.w * c7;

    let d0 = voxel(b0);
    let d1 = voxel(b1);
    let v0 = d0.r;
    let v1 = d1.r;
    let t = (uniforms.isoValue - v0) / (v0 - v1);

    // Write vertex
    let vertexPos = (uniforms.gridTransform * vec4<f32>(b0 + t * (b0 - b1), 1.0)).xyz;
    textureStore(vertexTexture, outCoord, vec4<f32>(vertexPos, 1.0));

    // Write group
    var groupValue: vec4<f32>;
    if (uniforms.constantGroup == 1u) {
        if (uniforms.packedGroup == 1u) {
            groupValue = vec4<f32>(voxel(coord3d).rgb, 1.0);
        } else {
            groupValue = getGroup(coord3d);
        }
    } else {
        if (uniforms.packedGroup == 1u) {
            groupValue = vec4<f32>(select(d1.rgb, d0.rgb, t < 0.5), 1.0);
        } else {
            groupValue = getGroup(select(b1, b0, t < 0.5));
        }
    }
    textureStore(groupTexture, outCoord, groupValue);

    // Write normal
    var n0 = -normalize(vec3<f32>(
        voxelValuePadded(b0 - c1) - voxelValuePadded(b0 + c1),
        voxelValuePadded(b0 - c3) - voxelValuePadded(b0 + c3),
        voxelValuePadded(b0 - c4) - voxelValuePadded(b0 + c4)
    ));
    var n1 = -normalize(vec3<f32>(
        voxelValuePadded(b1 - c1) - voxelValuePadded(b1 + c1),
        voxelValuePadded(b1 - c3) - voxelValuePadded(b1 + c3),
        voxelValuePadded(b1 - c4) - voxelValuePadded(b1 + c4)
    ));

    var normal = -vec3<f32>(
        n0.x + t * (n0.x - n1.x),
        n0.y + t * (n0.y - n1.y),
        n0.z + t * (n0.z - n1.z)
    );

    if (uniforms.invert == 1u) {
        normal = normal * -1.0;
    }

    normal = uniforms.gridTransformAdjoint * normal;
    textureStore(normalTexture, outCoord, vec4<f32>(normal, 0.0));
}
`;
