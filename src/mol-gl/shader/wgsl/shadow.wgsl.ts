/**
 * Copyright (c) 2025 mol* contributors, licensed under MIT, See LICENSE file for more info.
 *
 * @author Alexander Rose <alexander.rose@weirdbyte.de>
 *
 * WGSL shadow mapping shader.
 * Implements screen-space shadow calculation for directional lights.
 */

/**
 * Screen-space shadow calculation shader.
 * Computes shadows by sampling depth from the light's perspective.
 */
export const shadow_wgsl = /* wgsl */`
// Shadow uniforms
struct ShadowUniforms {
    lightViewProj: mat4x4<f32>,
    lightDirection: vec3<f32>,
    intensity: f32,
    bias: f32,
    texSize: vec2<f32>,
    _padding: vec2<f32>,
}

@group(0) @binding(0) var<uniform> uniforms: ShadowUniforms;
@group(0) @binding(1) var tDepth: texture_2d<f32>;
@group(0) @binding(2) var texSampler: sampler;

// Simple vertex shader for full-screen pass
struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
}

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
    var output: VertexOutput;
    
    // Generate a full-screen triangle
    let x = f32(vertexIndex % 2u) * 2.0 - 1.0; // 0 -> -1, 1 -> 1
    let y = f32(vertexIndex / 2u) * 2.0 - 1.0; // 0 -> -1, 1 -> 1
    
    output.position = vec4<f32>(x, y, 0.0, 1.0);
    output.uv = vec2<f32>((x + 1.0) * 0.5, (-y + 1.0) * 0.5);
    
    return output;
}

// Screen space to view space
fn screenToViewSpace(uv: vec2<f32>, depth: f32, invProj: mat4x4<f32>) -> vec3<f32> {
    let ndc = vec4<f32>(uv * 2.0 - 1.0, depth, 1.0);
    let viewPos = invProj * ndc;
    return viewPos.xyz / viewPos.w;
}

// Sample shadow with PCF
fn sampleShadow(shadowCoord: vec3<f32>, bias: f32) -> f32 {
    // For now, simple hard shadow
    // In a full implementation, this would sample from a shadow map
    // For screen-space shadows, we calculate occlusion based on depth differences
    return 1.0;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
    let coords = input.uv;
    
    // Sample scene depth
    let sceneDepth = textureSample(tDepth, texSampler, coords).r;
    
    // Background check
    if (sceneDepth >= 1.0) {
        return vec4<f32>(1.0, 1.0, 1.0, 1.0); // No shadow on background
    }
    
    // Screen-space shadow approximation
    // This is a simplified shadow calculation for screen-space effects
    
    var shadow = 1.0;
    let intensity = uniforms.intensity;
    
    // Sample neighboring pixels for soft shadow effect
    let texelSize = 1.0 / uniforms.texSize;
    
    // Simple screen-space ambient occlusion-style shadow
    // Sample depth in a small neighborhood
    var occlusion = 0.0;
    let sampleRadius = 2.0;
    let sampleCount = 8.0;
    
    for (var i = 0.0; i < sampleCount; i = i + 1.0) {
        let angle = i * 2.39996; // Golden angle
        let radius = (i + 1.0) / sampleCount * sampleRadius;
        
        let offset = vec2<f32>(
            cos(angle) * radius * texelSize.x,
            sin(angle) * radius * texelSize.y
        );
        
        let sampleCoord = coords + offset;
        let sampleDepth = textureSample(tDepth, texSampler, sampleCoord).r;
        
        // If neighbor is significantly closer, we're in shadow
        let depthDiff = sceneDepth - sampleDepth;
        if (depthDiff > uniforms.bias && depthDiff < 0.1) {
            occlusion = occlusion + 1.0;
        }
    }
    
    occlusion = occlusion / sampleCount;
    shadow = 1.0 - occlusion * intensity;
    
    // Output shadow value (alpha channel used for shadow intensity)
    return vec4<f32>(shadow, shadow, shadow, shadow);
}
`;

/**
 * Simple hard shadow shader variant.
 * Used when soft shadows are disabled.
 */
export const shadow_hard_wgsl = /* wgsl */`
struct ShadowUniforms {
    lightViewProj: mat4x4<f32>,
    lightDirection: vec3<f32>,
    intensity: f32,
    bias: f32,
    texSize: vec2<f32>,
    _padding: vec2<f32>,
}

@group(0) @binding(0) var<uniform> uniforms: ShadowUniforms;
@group(0) @binding(1) var tDepth: texture_2d<f32>;
@group(0) @binding(2) var texSampler: sampler;

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
}

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
    var output: VertexOutput;
    let x = f32(vertexIndex % 2u) * 2.0 - 1.0;
    let y = f32(vertexIndex / 2u) * 2.0 - 1.0;
    output.position = vec4<f32>(x, y, 0.0, 1.0);
    output.uv = vec2<f32>((x + 1.0) * 0.5, (-y + 1.0) * 0.5);
    return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
    let sceneDepth = textureSample(tDepth, texSampler, input.uv).r;
    
    if (sceneDepth >= 1.0) {
        return vec4<f32>(1.0);
    }
    
    // Simple hard shadow - just pass through for now
    // In a full implementation, this would compare with shadow map
    return vec4<f32>(1.0);
}
`;
