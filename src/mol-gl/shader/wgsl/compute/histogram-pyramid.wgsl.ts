/**
 * Copyright (c) 2025-2026 mol* contributors, licensed under MIT, See LICENSE file for more info.
 *
 * @author Alexander Rose <alexander.rose@weirdbyte.de>
 */

/**
 * Compute shader for histogram pyramid reduction.
 *
 * Builds a pyramid by summing 2x2 blocks at each level.
 * This replaces the fragment shader-based approach in WebGL with a true compute shader.
 *
 * The reduction operates on a single level at a time:
 * - First pass: Reads from the input texture (active voxels), sums 2x2 blocks
 * - Subsequent passes: Reads from the previous level, sums 2x2 blocks
 */
export const histogramPyramidReduction_wgsl = /* wgsl */`
struct ReductionUniforms {
    size: f32,           // 2^(i+1) / maxSize where i is current iteration
    texSize: f32,        // Size of current level texture
    first: u32,          // 1 if first iteration (reading from input), 0 otherwise
    _pad: f32,
}

@group(0) @binding(0) var<uniform> uniforms: ReductionUniforms;
@group(0) @binding(1) var inputLevel: texture_2d<f32>;  // First iteration input (active voxels, normalized)
@group(0) @binding(2) var previousLevel: texture_2d<i32>;  // Previous pyramid level (integer values)
@group(0) @binding(3) var outputTexture: texture_storage_2d<r32sint, write>;

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) globalId: vec3<u32>) {
    let texSizeU = u32(uniforms.texSize);

    // Check bounds
    if (globalId.x >= texSizeU || globalId.y >= texSizeU) {
        return;
    }

    let k = 0.5 * uniforms.size;
    let position = floor(vec2<f32>(globalId.xy) / uniforms.texSize / uniforms.size) * uniforms.size;

    // Calculate sample positions
    let pos0 = vec2<i32>(position * uniforms.texSize);
    let pos1 = vec2<i32>((position + vec2<f32>(k, 0.0)) * uniforms.texSize);
    let pos2 = vec2<i32>((position + vec2<f32>(0.0, k)) * uniforms.texSize);
    let pos3 = vec2<i32>((position + vec2<f32>(k, k)) * uniforms.texSize);

    var sum: i32;

    if (uniforms.first == 1u) {
        // First iteration: read from normalized input texture
        // Input stores vertex count / 255.0 in the red channel
        let a = i32(textureLoad(inputLevel, pos0, 0).r * 255.0);
        let b = i32(textureLoad(inputLevel, pos1, 0).r * 255.0);
        let c = i32(textureLoad(inputLevel, pos2, 0).r * 255.0);
        let d = i32(textureLoad(inputLevel, pos3, 0).r * 255.0);
        sum = a + b + c + d;
    } else {
        // Subsequent iterations: read from previous integer level
        let a = textureLoad(previousLevel, pos0, 0).r;
        let b = textureLoad(previousLevel, pos1, 0).r;
        let c = textureLoad(previousLevel, pos2, 0).r;
        let d = textureLoad(previousLevel, pos3, 0).r;
        sum = a + b + c + d;
    }

    // Write the sum to the output texture
    textureStore(outputTexture, vec2<i32>(globalId.xy), vec4<i32>(sum, 0, 0, 0));
}
`;

/**
 * Compute shader for getting the sum from the top of the histogram pyramid.
 *
 * Simply reads the top-left pixel of the top level which contains the total count.
 */
export const histogramPyramidSum_wgsl = /* wgsl */`
@group(0) @binding(0) var pyramidTop: texture_2d<i32>;
@group(0) @binding(1) var<storage, read_write> result: array<i32>;

@compute @workgroup_size(1)
fn main() {
    // Read the sum from the center of the 1x1 top level
    let sum = textureLoad(pyramidTop, vec2<i32>(0, 0), 0).r;
    result[0] = sum;
}
`;

/**
 * Alternative reduction shader using storage buffers instead of textures.
 * More efficient for pure compute workloads, avoids texture sampling overhead.
 */
export const histogramPyramidReductionBuffer_wgsl = /* wgsl */`
struct ReductionUniforms {
    inputSize: u32,      // Width of input level
    outputSize: u32,     // Width of output level (inputSize / 2)
    inputOffset: u32,    // Offset in the pyramid buffer for input level
    outputOffset: u32,   // Offset in the pyramid buffer for output level
}

@group(0) @binding(0) var<uniform> uniforms: ReductionUniforms;
@group(0) @binding(1) var<storage, read> inputBuffer: array<u32>;
@group(0) @binding(2) var<storage, read_write> outputBuffer: array<u32>;

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) globalId: vec3<u32>) {
    // Check bounds
    if (globalId.x >= uniforms.outputSize || globalId.y >= uniforms.outputSize) {
        return;
    }

    // Calculate input coordinates (2x2 block)
    let inputX = globalId.x * 2u;
    let inputY = globalId.y * 2u;

    // Read 2x2 block from input
    let idx00 = uniforms.inputOffset + inputY * uniforms.inputSize + inputX;
    let idx10 = uniforms.inputOffset + inputY * uniforms.inputSize + inputX + 1u;
    let idx01 = uniforms.inputOffset + (inputY + 1u) * uniforms.inputSize + inputX;
    let idx11 = uniforms.inputOffset + (inputY + 1u) * uniforms.inputSize + inputX + 1u;

    let a = inputBuffer[idx00];
    let b = inputBuffer[idx10];
    let c = inputBuffer[idx01];
    let d = inputBuffer[idx11];

    // Write sum to output
    let outputIdx = uniforms.outputOffset + globalId.y * uniforms.outputSize + globalId.x;
    outputBuffer[outputIdx] = a + b + c + d;
}
`;

/**
 * Shader for building the complete histogram pyramid in a single dispatch.
 * Uses workgroup shared memory for efficient parallel reduction.
 *
 * This is more efficient than multi-pass reduction for small pyramids,
 * as it avoids multiple dispatches and memory transfers.
 */
export const histogramPyramidBuild_wgsl = /* wgsl */`
struct BuildUniforms {
    inputWidth: u32,
    inputHeight: u32,
    levels: u32,
    _pad: u32,
}

@group(0) @binding(0) var<uniform> uniforms: BuildUniforms;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(2) var<storage, read_write> pyramid: array<u32>;
@group(0) @binding(3) var<storage, read_write> totalCount: array<u32>;

var<workgroup> sharedData: array<u32, 1024>;  // 32x32 max workgroup

@compute @workgroup_size(16, 16)
fn main(
    @builtin(global_invocation_id) globalId: vec3<u32>,
    @builtin(local_invocation_id) localId: vec3<u32>,
    @builtin(workgroup_id) workgroupId: vec3<u32>
) {
    let localIdx = localId.y * 16u + localId.x;

    // Load input data into shared memory
    var value: u32 = 0u;
    if (globalId.x < uniforms.inputWidth && globalId.y < uniforms.inputHeight) {
        let sample = textureLoad(inputTexture, vec2<i32>(globalId.xy), 0);
        value = u32(sample.r * 255.0);
    }
    sharedData[localIdx] = value;

    workgroupBarrier();

    // Store level 0 (base level with full data)
    if (globalId.x < uniforms.inputWidth && globalId.y < uniforms.inputHeight) {
        let idx = globalId.y * uniforms.inputWidth + globalId.x;
        pyramid[idx] = value;
    }

    // Parallel reduction within workgroup
    var size = 8u;  // Half of 16
    var offset = uniforms.inputWidth * uniforms.inputHeight;

    for (var level = 1u; level < uniforms.levels; level = level + 1u) {
        if (localId.x < size && localId.y < size) {
            let idx00 = (localId.y * 2u) * 16u + (localId.x * 2u);
            let idx10 = (localId.y * 2u) * 16u + (localId.x * 2u + 1u);
            let idx01 = (localId.y * 2u + 1u) * 16u + (localId.x * 2u);
            let idx11 = (localId.y * 2u + 1u) * 16u + (localId.x * 2u + 1u);

            let sum = sharedData[idx00] + sharedData[idx10] + sharedData[idx01] + sharedData[idx11];
            sharedData[localId.y * 16u + localId.x] = sum;
        }

        workgroupBarrier();

        // Store this level
        let levelWidth = uniforms.inputWidth >> level;
        let gx = workgroupId.x * size + localId.x;
        let gy = workgroupId.y * size + localId.y;

        if (localId.x < size && localId.y < size && gx < levelWidth && gy < levelWidth) {
            let levelIdx = offset + gy * levelWidth + gx;
            pyramid[levelIdx] = sharedData[localId.y * 16u + localId.x];
        }

        offset = offset + levelWidth * levelWidth;
        size = size >> 1u;

        workgroupBarrier();
    }

    // Final sum
    if (localIdx == 0u) {
        atomicAdd(&totalCount[0], sharedData[0]);
    }
}
`;
