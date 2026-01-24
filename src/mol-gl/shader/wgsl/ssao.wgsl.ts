/**
 * Copyright (c) 2025 mol* contributors, licensed under MIT, See LICENSE file for more info.
 *
 * @author Alexander Rose <alexander.rose@weirdbyte.de>
 */

/**
 * WGSL SSAO (Screen Space Ambient Occlusion) shader.
 * Implements hemisphere sampling based ambient occlusion with multi-scale support.
 */

export const ssao_wgsl = /* wgsl */`
// Constants
const PI: f32 = 3.14159265;
const MAX_SAMPLES: u32 = 64u;

// Uniforms
struct SsaoUniforms {
    texSize: vec2<f32>,
    bounds: vec4<f32>,
    projection: mat4x4<f32>,
    invProjection: mat4x4<f32>,
    radius: f32,
    bias: f32,
    near: f32,
    far: f32,
    orthographic: u32,
    transparencyFlag: u32,
    nSamples: u32,
    _padding: f32,
}

// Multi-scale level uniforms (optional)
struct SsaoLevelUniforms {
    levelRadius: array<f32, 4>,
    levelBias: array<f32, 4>,
    nearThreshold: f32,
    farThreshold: f32,
    nLevels: u32,
    _padding: f32,
}

@group(0) @binding(0) var<uniform> uniforms: SsaoUniforms;
@group(0) @binding(1) var<storage, read> samples: array<vec3<f32>>;
@group(0) @binding(2) var tDepth: texture_2d<f32>;
@group(0) @binding(3) var tDepthHalf: texture_2d<f32>;
@group(0) @binding(4) var tDepthQuarter: texture_2d<f32>;
@group(0) @binding(5) var depthSampler: sampler;

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
}

// Full-screen quad vertex shader
@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
    // Generate full-screen triangle vertices
    let x = f32((vertexIndex & 1u) << 2u) - 1.0;
    let y = f32((vertexIndex & 2u) << 1u) - 1.0;

    var output: VertexOutput;
    output.position = vec4<f32>(x, y, 0.0, 1.0);
    output.uv = vec2<f32>((x + 1.0) * 0.5, (y + 1.0) * 0.5);
    return output;
}

// Utility functions

fn smootherstep(edge0: f32, edge1: f32, x_in: f32) -> f32 {
    let x = clamp((x_in - edge0) / (edge1 - edge0), 0.0, 1.0);
    return x * x * x * (x * (x * 6.0 - 15.0) + 10.0);
}

fn noise(coords: vec2<f32>) -> f32 {
    let a = 12.9898;
    let b = 78.233;
    let c = 43758.5453;
    let dt = dot(coords, vec2<f32>(a, b));
    let sn = dt % PI;
    return abs(fract(sin(sn) * c));
}

fn getNoiseVec2(coords: vec2<f32>) -> vec2<f32> {
    return vec2<f32>(noise(coords), noise(coords + vec2<f32>(PI, 2.71828)));
}

fn isBackground(depth: f32) -> bool {
    return depth >= 1.0;
}

fn isOutsideBounds(coords: vec2<f32>) -> bool {
    return coords.x < uniforms.bounds.x || coords.x > uniforms.bounds.z ||
           coords.y < uniforms.bounds.y || coords.y > uniforms.bounds.w;
}

fn screenSpaceToViewSpace(ssPos: vec3<f32>) -> vec3<f32> {
    var p = vec4<f32>(ssPos * 2.0 - 1.0, 1.0);
    p = uniforms.invProjection * p;
    return p.xyz / p.w;
}

fn getDepth(coords: vec2<f32>) -> f32 {
    return textureSample(tDepth, depthSampler, coords).r;
}

// Get depth from appropriate mip level based on distance
fn getMappedDepth(coords: vec2<f32>, selfCoords: vec2<f32>) -> f32 {
    let d = distance(coords, selfCoords);
    let quarterThreshold = 0.1;
    let halfThreshold = 0.05;

    if (d > quarterThreshold) {
        return textureSample(tDepthQuarter, depthSampler, coords).r;
    } else if (d > halfThreshold) {
        return textureSample(tDepthHalf, depthSampler, coords).r;
    } else {
        return textureSample(tDepth, depthSampler, coords).r;
    }
}

// Reconstruct view-space normal from depth buffer
// Adapted from https://gist.github.com/bgolus/a07ed65602c009d5e2f753826e8078a0
fn viewNormalAtPixelPosition(vpos: vec2<f32>) -> vec3<f32> {
    let invTexSize = 1.0 / uniforms.texSize;

    // Current pixel's depth
    let c = getDepth(vpos);

    // Get current pixel's view space position
    let viewSpacePos_c = screenSpaceToViewSpace(vec3<f32>(vpos, c));

    // Get view space position at 1 pixel offsets in each major direction
    let viewSpacePos_l = screenSpaceToViewSpace(vec3<f32>(vpos + vec2<f32>(-1.0, 0.0) * invTexSize, getDepth(vpos + vec2<f32>(-1.0, 0.0) * invTexSize)));
    let viewSpacePos_r = screenSpaceToViewSpace(vec3<f32>(vpos + vec2<f32>(1.0, 0.0) * invTexSize, getDepth(vpos + vec2<f32>(1.0, 0.0) * invTexSize)));
    let viewSpacePos_d = screenSpaceToViewSpace(vec3<f32>(vpos + vec2<f32>(0.0, -1.0) * invTexSize, getDepth(vpos + vec2<f32>(0.0, -1.0) * invTexSize)));
    let viewSpacePos_u = screenSpaceToViewSpace(vec3<f32>(vpos + vec2<f32>(0.0, 1.0) * invTexSize, getDepth(vpos + vec2<f32>(0.0, 1.0) * invTexSize)));

    // Get the difference between the current and each offset position
    let l = viewSpacePos_c - viewSpacePos_l;
    let r = viewSpacePos_r - viewSpacePos_c;
    let d = viewSpacePos_c - viewSpacePos_d;
    let u = viewSpacePos_u - viewSpacePos_c;

    // Get depth values at 1 & 2 pixels offsets from current along the horizontal axis
    let H = vec4<f32>(
        getDepth(vpos + vec2<f32>(-1.0, 0.0) * invTexSize),
        getDepth(vpos + vec2<f32>(1.0, 0.0) * invTexSize),
        getDepth(vpos + vec2<f32>(-2.0, 0.0) * invTexSize),
        getDepth(vpos + vec2<f32>(2.0, 0.0) * invTexSize)
    );

    // Get depth values at 1 & 2 pixels offsets from current along the vertical axis
    let V = vec4<f32>(
        getDepth(vpos + vec2<f32>(0.0, -1.0) * invTexSize),
        getDepth(vpos + vec2<f32>(0.0, 1.0) * invTexSize),
        getDepth(vpos + vec2<f32>(0.0, -2.0) * invTexSize),
        getDepth(vpos + vec2<f32>(0.0, 2.0) * invTexSize)
    );

    // Current pixel's depth difference from slope of offset depth samples
    let he = abs((2.0 * H.xy - H.zw) - c);
    let ve = abs((2.0 * V.xy - V.zw) - c);

    // Pick horizontal and vertical diff with the smallest depth difference from slopes
    var hDeriv: vec3<f32>;
    var vDeriv: vec3<f32>;
    if (he.x < he.y) {
        hDeriv = l;
    } else {
        hDeriv = r;
    }
    if (ve.x < ve.y) {
        vDeriv = d;
    } else {
        vDeriv = u;
    }

    // Get view space normal from the cross product of the best derivatives
    let viewNormal = normalize(cross(hDeriv, vDeriv));

    return viewNormal;
}

fn getPixelSize(coords: vec2<f32>, depth: f32) -> f32 {
    let invTexSize = 1.0 / uniforms.texSize;
    let viewPos0 = screenSpaceToViewSpace(vec3<f32>(coords, depth));
    let viewPos1 = screenSpaceToViewSpace(vec3<f32>(coords + vec2<f32>(1.0, 0.0) * invTexSize, depth));
    return distance(viewPos0, viewPos1);
}

// Pack/unpack utilities
fn packUnitIntervalToRG(v: f32) -> vec2<f32> {
    var enc: vec2<f32>;
    enc = vec2<f32>(fract(v * 256.0), v);
    enc.y -= enc.x * (1.0 / 256.0);
    enc *= 256.0 / 255.0;
    return enc;
}

// Main SSAO fragment shader
@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
    let selfCoords = input.uv;
    let selfDepth = getDepth(selfCoords);
    let selfPackedDepth = packUnitIntervalToRG(selfDepth);

    // Skip background pixels
    if (isBackground(selfDepth)) {
        return vec4<f32>(packUnitIntervalToRG(1.0), selfPackedDepth);
    }

    // Get view space normal and position
    let selfViewNormal = viewNormalAtPixelPosition(selfCoords);
    let selfViewPos = screenSpaceToViewSpace(vec3<f32>(selfCoords, selfDepth));

    // Create random rotation matrix using noise
    let randomVec = normalize(vec3<f32>(getNoiseVec2(selfCoords) * 2.0 - 1.0, 0.0));
    let tangent = normalize(randomVec - selfViewNormal * dot(randomVec, selfViewNormal));
    let bitangent = cross(selfViewNormal, tangent);
    let TBN = mat3x3<f32>(tangent, bitangent, selfViewNormal);

    var occlusion: f32 = 0.0;
    var validSamples: f32 = 0.0;

    // Sample hemisphere
    let nSamples = min(uniforms.nSamples, MAX_SAMPLES);
    for (var i: u32 = 0u; i < nSamples; i++) {
        // Get sample position in view space
        let sampleDir = samples[i];
        var sampleViewPos = TBN * sampleDir;
        sampleViewPos = selfViewPos + sampleViewPos * uniforms.radius;

        // Project sample position to screen space
        var offset = vec4<f32>(sampleViewPos, 1.0);
        offset = uniforms.projection * offset;
        offset = vec4<f32>(offset.xyz / offset.w, offset.w);
        let sampleCoords = offset.xyz * 0.5 + 0.5;

        // Skip samples outside bounds
        if (isOutsideBounds(sampleCoords.xy)) {
            continue;
        }

        validSamples += 1.0;

        // Get sample depth from depth buffer
        let sampleDepth = getMappedDepth(sampleCoords.xy, selfCoords);

        if (!isBackground(sampleDepth)) {
            // Convert to view space Z
            let sampleViewZ = screenSpaceToViewSpace(vec3<f32>(sampleCoords.xy, sampleDepth)).z;

            // Range check with smooth falloff
            let rangeCheck = smootherstep(0.0, 1.0, uniforms.radius / abs(selfViewPos.z - sampleViewZ));

            // Occlusion test - is the sample occluded?
            let sampleOcclusion = select(0.0, 1.0, sampleViewPos.z + 0.025 <= sampleViewZ) * rangeCheck;

            occlusion += sampleOcclusion;
        }
    }

    // Average occlusion
    if (validSamples > 0.0) {
        occlusion /= validSamples;
    }

    // Apply bias and invert (1.0 = no occlusion, 0.0 = full occlusion)
    occlusion = 1.0 - (uniforms.bias * occlusion);

    // Pack occlusion and depth into output
    let packedOcclusion = packUnitIntervalToRG(clamp(occlusion, 0.01, 1.0));

    return vec4<f32>(packedOcclusion, selfPackedDepth);
}
`;

/**
 * SSAO blur shader for smoothing the SSAO result.
 * Uses a bilateral filter to preserve edges.
 */
export const ssao_blur_wgsl = /* wgsl */`
struct BlurUniforms {
    texSize: vec2<f32>,
    direction: vec2<f32>, // (1,0) for horizontal, (0,1) for vertical
    kernelRadius: i32,
    _padding: f32,
}

@group(0) @binding(0) var<uniform> uniforms: BlurUniforms;
@group(0) @binding(1) var tSsao: texture_2d<f32>;
@group(0) @binding(2) var ssaoSampler: sampler;

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
}

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
    let x = f32((vertexIndex & 1u) << 2u) - 1.0;
    let y = f32((vertexIndex & 2u) << 1u) - 1.0;

    var output: VertexOutput;
    output.position = vec4<f32>(x, y, 0.0, 1.0);
    output.uv = vec2<f32>((x + 1.0) * 0.5, (y + 1.0) * 0.5);
    return output;
}

fn unpackRGToUnitInterval(rg: vec2<f32>) -> f32 {
    return rg.r + rg.g / 255.0;
}

fn packUnitIntervalToRG(v: f32) -> vec2<f32> {
    var enc: vec2<f32>;
    enc = vec2<f32>(fract(v * 256.0), v);
    enc.y -= enc.x * (1.0 / 256.0);
    enc *= 256.0 / 255.0;
    return enc;
}

// Gaussian weight function
fn gaussian(x: f32, sigma: f32) -> f32 {
    return exp(-(x * x) / (2.0 * sigma * sigma));
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
    let invTexSize = 1.0 / uniforms.texSize;
    let centerSample = textureSample(tSsao, ssaoSampler, input.uv);
    let centerOcclusion = unpackRGToUnitInterval(centerSample.rg);
    let centerDepth = unpackRGToUnitInterval(centerSample.ba);

    var result: f32 = centerOcclusion;
    var totalWeight: f32 = 1.0;

    let sigma = f32(uniforms.kernelRadius) * 0.5;
    let depthSigma = 0.01; // Depth threshold for edge preservation

    // Bilateral blur
    for (var i: i32 = -uniforms.kernelRadius; i <= uniforms.kernelRadius; i++) {
        if (i == 0) {
            continue;
        }

        let offset = vec2<f32>(f32(i)) * uniforms.direction * invTexSize;
        let samplePos = input.uv + offset;
        let sample = textureSample(tSsao, ssaoSampler, samplePos);
        let sampleOcclusion = unpackRGToUnitInterval(sample.rg);
        let sampleDepth = unpackRGToUnitInterval(sample.ba);

        // Spatial weight (Gaussian)
        let spatialWeight = gaussian(f32(i), sigma);

        // Range weight (depth similarity)
        let depthDiff = abs(centerDepth - sampleDepth);
        let rangeWeight = gaussian(depthDiff, depthSigma);

        // Combined weight
        let weight = spatialWeight * rangeWeight;

        result += sampleOcclusion * weight;
        totalWeight += weight;
    }

    result /= totalWeight;

    return vec4<f32>(packUnitIntervalToRG(result), centerSample.ba);
}
`;
