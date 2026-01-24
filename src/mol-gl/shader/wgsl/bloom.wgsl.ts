/**
 * Copyright (c) 2025 mol* contributors, licensed under MIT, See LICENSE file for more info.
 *
 * @author Alexander Rose <alexander.rose@weirdbyte.de>
 */

/**
 * WGSL Bloom shaders for WebGPU.
 * Implements luminosity extraction, Gaussian blur, and mip-pyramid composite.
 */

// Common vertex shader for full-screen passes
export const bloom_vertex_wgsl = /* wgsl */`
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
`;

/**
 * Luminosity extraction shader - extracts bright pixels for bloom effect.
 */
export const bloom_luminosity_wgsl = /* wgsl */`
struct LuminosityUniforms {
    texSizeInv: vec2<f32>,
    defaultColor: vec3<f32>,
    defaultOpacity: f32,
    luminosityThreshold: f32,
    smoothWidth: f32,
    mode: u32,  // 0 = luminosity, 1 = emissive
    _padding: f32,
}

@group(0) @binding(0) var<uniform> uniforms: LuminosityUniforms;
@group(0) @binding(1) var tColor: texture_2d<f32>;
@group(0) @binding(2) var tEmissive: texture_2d<f32>;
@group(0) @binding(3) var tDepth: texture_2d<f32>;
@group(0) @binding(4) var texSampler: sampler;

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

fn isBackground(depth: f32) -> bool {
    return depth >= 1.0;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
    let coords = input.uv;
    let texel = textureSample(tColor, texSampler, coords);
    let emissive = textureSample(tEmissive, texSampler, coords).a;
    let depth = textureSample(tDepth, texSampler, coords).r;

    // Skip background pixels
    if (isBackground(depth)) {
        return vec4<f32>(0.0, 0.0, 0.0, 0.0);
    }

    let outputColor = vec4<f32>(uniforms.defaultColor, uniforms.defaultOpacity);

    if (uniforms.mode == 0u) {
        // Luminosity mode - extract bright pixels based on threshold
        let luma = vec3<f32>(0.299, 0.587, 0.114);
        let v = dot(texel.xyz, luma);
        let alpha = smoothstep(uniforms.luminosityThreshold, uniforms.luminosityThreshold + uniforms.smoothWidth, v);
        return mix(outputColor, texel, alpha);
    } else {
        // Emissive mode - use pre-computed emissive values
        return mix(outputColor, texel, emissive);
    }
}
`;

/**
 * Gaussian blur shader - separable blur for bloom pyramid.
 */
export const bloom_blur_wgsl = /* wgsl */`
const MAX_KERNEL_RADIUS: u32 = 25u;

struct BlurUniforms {
    texSizeInv: vec2<f32>,
    direction: vec2<f32>,
    kernelRadius: u32,
    _padding: vec3<f32>,
}

@group(0) @binding(0) var<uniform> uniforms: BlurUniforms;
@group(0) @binding(1) var<storage, read> gaussianCoefficients: array<f32>;
@group(0) @binding(2) var tInput: texture_2d<f32>;
@group(0) @binding(3) var texSampler: sampler;

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

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
    let coords = input.uv;

    var weightSum = gaussianCoefficients[0];
    var diffuseSum = textureSample(tInput, texSampler, coords) * weightSum;

    let kernelRadius = min(uniforms.kernelRadius, MAX_KERNEL_RADIUS);
    for (var i: u32 = 1u; i < kernelRadius; i++) {
        let x = f32(i);
        let w = gaussianCoefficients[i];
        let offset = uniforms.direction * uniforms.texSizeInv * x;

        let sample1 = textureSample(tInput, texSampler, coords + offset);
        let sample2 = textureSample(tInput, texSampler, coords - offset);

        diffuseSum += (sample1 + sample2) * w;
        weightSum += 2.0 * w;
    }

    return diffuseSum / weightSum;
}
`;

/**
 * Bloom composite shader - combines multiple blur mip levels.
 */
export const bloom_composite_wgsl = /* wgsl */`
struct CompositeUniforms {
    texSizeInv: vec2<f32>,
    bloomStrength: f32,
    bloomRadius: f32,
    bloomFactors: array<f32, 5>,
    bloomTints: array<vec4<f32>, 5>,  // Using vec4 for alignment, .rgb is used
}

@group(0) @binding(0) var<uniform> uniforms: CompositeUniforms;
@group(0) @binding(1) var tBlur1: texture_2d<f32>;
@group(0) @binding(2) var tBlur2: texture_2d<f32>;
@group(0) @binding(3) var tBlur3: texture_2d<f32>;
@group(0) @binding(4) var tBlur4: texture_2d<f32>;
@group(0) @binding(5) var tBlur5: texture_2d<f32>;
@group(0) @binding(6) var texSampler: sampler;

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

fn lerpBloomFactor(factor: f32) -> f32 {
    let mirrorFactor = 1.2 - factor;
    return mix(factor, mirrorFactor, uniforms.bloomRadius);
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
    let coords = input.uv;

    let blur1 = textureSample(tBlur1, texSampler, coords);
    let blur2 = textureSample(tBlur2, texSampler, coords);
    let blur3 = textureSample(tBlur3, texSampler, coords);
    let blur4 = textureSample(tBlur4, texSampler, coords);
    let blur5 = textureSample(tBlur5, texSampler, coords);

    let result = uniforms.bloomStrength * (
        lerpBloomFactor(uniforms.bloomFactors[0]) * vec4<f32>(uniforms.bloomTints[0].rgb, 1.0) * blur1 +
        lerpBloomFactor(uniforms.bloomFactors[1]) * vec4<f32>(uniforms.bloomTints[1].rgb, 1.0) * blur2 +
        lerpBloomFactor(uniforms.bloomFactors[2]) * vec4<f32>(uniforms.bloomTints[2].rgb, 1.0) * blur3 +
        lerpBloomFactor(uniforms.bloomFactors[3]) * vec4<f32>(uniforms.bloomTints[3].rgb, 1.0) * blur4 +
        lerpBloomFactor(uniforms.bloomFactors[4]) * vec4<f32>(uniforms.bloomTints[4].rgb, 1.0) * blur5
    );

    return result;
}
`;

/**
 * Simple bloom additive blend shader - combines bloom with original color.
 */
export const bloom_blend_wgsl = /* wgsl */`
struct BlendUniforms {
    texSizeInv: vec2<f32>,
    _padding: vec2<f32>,
}

@group(0) @binding(0) var<uniform> uniforms: BlendUniforms;
@group(0) @binding(1) var tColor: texture_2d<f32>;
@group(0) @binding(2) var tBloom: texture_2d<f32>;
@group(0) @binding(3) var texSampler: sampler;

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

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
    let coords = input.uv;

    let color = textureSample(tColor, texSampler, coords);
    let bloom = textureSample(tBloom, texSampler, coords);

    // Additive blend
    return vec4<f32>(color.rgb + bloom.rgb, color.a);
}
`;
