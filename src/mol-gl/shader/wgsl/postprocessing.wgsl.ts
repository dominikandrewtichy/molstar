/**
 * Copyright (c) 2025 mol* contributors, licensed under MIT, See LICENSE file for more info.
 *
 * @author Alexander Rose <alexander.rose@weirdbyte.de>
 */

/**
 * WGSL post-processing shader for final compositing.
 * Combines color, SSAO, shadows, outlines, and transparency.
 */

export const postprocessing_common_wgsl = /* wgsl */`
// Common uniforms for post-processing
struct PostprocessingUniforms {
    texSize: vec2<f32>,
    near: f32,
    far: f32,
    fogNear: f32,
    fogFar: f32,
    fogColor: vec3<f32>,
    outlineColor: vec3<f32>,
    occlusionColor: vec3<f32>,
    occlusionOffset: vec2<f32>,
    transparentBackground: u32,
    orthographic: u32,
    outlineScale: i32,
    _padding: f32,
}

fn getViewZ(depth: f32, uniforms: PostprocessingUniforms) -> f32 {
    if (uniforms.orthographic == 1u) {
        return orthographicDepthToViewZ(depth, uniforms.near, uniforms.far);
    } else {
        return perspectiveDepthToViewZ(depth, uniforms.near, uniforms.far);
    }
}

fn orthographicDepthToViewZ(depth: f32, near: f32, far: f32) -> f32 {
    return depth * (near - far) - near;
}

fn perspectiveDepthToViewZ(depth: f32, near: f32, far: f32) -> f32 {
    return (near * far) / ((far - near) * depth - far);
}

fn isBackground(depth: f32) -> bool {
    return depth >= 1.0;
}

fn unpackRGToUnitInterval(rg: vec2<f32>) -> f32 {
    return rg.r + rg.g / 255.0;
}

fn packUnitIntervalToRG(value: f32) -> vec2<f32> {
    let r = floor(value * 255.0) / 255.0;
    let g = fract(value * 255.0);
    return vec2<f32>(r, g);
}
`;

export const postprocessing_wgsl = /* wgsl */`
${postprocessing_common_wgsl}

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
}

@group(0) @binding(0) var<uniform> uniforms: PostprocessingUniforms;
@group(0) @binding(1) var tColor: texture_2d<f32>;
@group(0) @binding(2) var tDepthOpaque: texture_2d<f32>;
@group(0) @binding(3) var tSsaoDepth: texture_2d<f32>;
@group(0) @binding(4) var tOutlines: texture_2d<f32>;
@group(0) @binding(5) var tShadows: texture_2d<f32>;
@group(0) @binding(6) var tTransparentColor: texture_2d<f32>;
@group(0) @binding(7) var tDepthTransparent: texture_2d<f32>;
@group(0) @binding(8) var tSsaoDepthTransparent: texture_2d<f32>;
@group(0) @binding(9) var texSampler: sampler;

@vertex
fn vs_main(
    @location(0) position: vec2<f32>,
    @location(1) uv: vec2<f32>
) -> VertexOutput {
    var output: VertexOutput;
    output.position = vec4<f32>(position, 0.0, 1.0);
    output.uv = uv;
    return output;
}

fn getDepthOpaque(coords: vec2<f32>) -> f32 {
    return textureSample(tDepthOpaque, texSampler, coords).r;
}

fn getDepthTransparent(coords: vec2<f32>) -> f32 {
    let packed = textureSample(tDepthTransparent, texSampler, coords);
    return unpackRGBAToDepthWithAlpha(packed).x;
}

fn unpackRGBAToDepthWithAlpha(rgba: vec4<f32>) -> vec2<f32> {
    let depth = rgba.r + rgba.g / 255.0 + rgba.b / 65025.0;
    let alpha = rgba.a;
    return vec2<f32>(depth, alpha);
}

fn getSsao(coords: vec2<f32>) -> f32 {
    let rawSsao = unpackRGToUnitInterval(textureSample(tSsaoDepth, texSampler, coords).xy);
    if (rawSsao > 0.999) {
        return 1.0;
    } else if (rawSsao > 0.001) {
        return rawSsao;
    }
    return 1.0;
}

fn getSsaoTransparent(coords: vec2<f32>) -> f32 {
    let rawSsao = unpackRGToUnitInterval(textureSample(tSsaoDepthTransparent, texSampler, coords).xy);
    if (rawSsao > 0.999) {
        return 1.0;
    } else if (rawSsao > 0.001) {
        return rawSsao;
    }
    return 1.0;
}

struct OutlineResult {
    hasOpaque: bool,
    hasTransparent: bool,
    opaqueDepth: f32,
    transparentDepth: f32,
    alpha: f32,
}

fn unpack2x4(value: f32) -> vec2<f32> {
    let v = floor(value * 255.0);
    let x = floor(v / 16.0) / 15.0;
    let y = (v - floor(v / 16.0) * 16.0) / 15.0;
    return vec2<f32>(x, y);
}

fn getOutline(coords: vec2<f32>, outlineScale: i32) -> OutlineResult {
    let invTexSize = 1.0 / uniforms.texSize;
    let squaredScale = outlineScale * outlineScale;

    var result: OutlineResult;
    result.hasOpaque = false;
    result.hasTransparent = false;
    result.opaqueDepth = 1.0;
    result.transparentDepth = 1.0;
    result.alpha = 0.0;

    for (var y = -outlineScale; y <= outlineScale; y++) {
        for (var x = -outlineScale; x <= outlineScale; x++) {
            if (x * x + y * y > squaredScale) {
                continue;
            }

            let sampleCoords = coords + vec2<f32>(f32(x), f32(y)) * invTexSize;
            let sampleOutlineCombined = textureSample(tOutlines, texSampler, sampleCoords);

            let sampleOpaqueDepth = unpackRGToUnitInterval(sampleOutlineCombined.gb);
            let sampleTransparentDepth = sampleOutlineCombined.a;
            let sampleFlagWithAlpha = unpack2x4(sampleOutlineCombined.r);

            let sampleFlag = sampleFlagWithAlpha.x;
            let sampleAlpha = clamp(sampleFlagWithAlpha.y * 0.5, 0.01, 1.0);

            // Check opaque outline (flag 0.25 or 0.75)
            if ((sampleFlag > 0.20 && sampleFlag < 0.30) || (sampleFlag > 0.70 && sampleFlag < 0.80)) {
                if (sampleOpaqueDepth < result.opaqueDepth) {
                    result.hasOpaque = true;
                    result.opaqueDepth = sampleOpaqueDepth;
                }
            }

            // Check transparent outline (flag 0.5 or 0.75)
            if ((sampleFlag > 0.45 && sampleFlag < 0.55) || (sampleFlag > 0.70 && sampleFlag < 0.80)) {
                if (sampleTransparentDepth < result.transparentDepth) {
                    result.hasTransparent = true;
                    result.transparentDepth = sampleTransparentDepth;
                    result.alpha = sampleAlpha;
                }
            }
        }
    }

    return result;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
    let coords = input.uv;
    var color = textureSample(tColor, texSampler, coords);

    let opaqueDepth = getDepthOpaque(coords);
    var blendTransparency = true;
    let transparentColor = textureSample(tTransparentColor, texSampler, coords);
    let transparentDepth = getDepthTransparent(coords);

    let isOpaqueBackground = isBackground(opaqueDepth);
    let viewDist = abs(getViewZ(opaqueDepth, uniforms));
    let fogFactor = smoothstep(uniforms.fogNear, uniforms.fogFar, viewDist);

    // Apply SSAO
    if (!isOpaqueBackground) {
        let occlusionFactor = getSsao(coords + uniforms.occlusionOffset);

        if (uniforms.transparentBackground == 0u) {
            color = vec4<f32>(
                mix(mix(uniforms.occlusionColor, uniforms.fogColor, fogFactor), color.rgb, occlusionFactor),
                color.a
            );
        } else {
            color = vec4<f32>(
                mix(uniforms.occlusionColor * (1.0 - fogFactor), color.rgb, occlusionFactor),
                color.a
            );
        }
    }

    // Apply transparent SSAO
    var blendedTransparentColor = transparentColor;
    if (!isBackground(transparentDepth)) {
        let viewDistTrans = abs(getViewZ(transparentDepth, uniforms));
        let fogFactorTrans = smoothstep(uniforms.fogNear, uniforms.fogFar, viewDistTrans);
        let occlusionFactorTrans = getSsaoTransparent(coords + uniforms.occlusionOffset);
        blendedTransparentColor = vec4<f32>(
            mix(uniforms.occlusionColor * (1.0 - fogFactorTrans), transparentColor.rgb, occlusionFactorTrans),
            transparentColor.a
        );
    }

    // Apply shadows
    if (!isOpaqueBackground) {
        let shadow = textureSample(tShadows, texSampler, coords);
        if (uniforms.transparentBackground == 0u) {
            color = vec4<f32>(
                mix(mix(vec3<f32>(0.0), uniforms.fogColor, fogFactor), color.rgb, shadow.a),
                color.a
            );
        } else {
            color = vec4<f32>(
                mix(vec3<f32>(0.0) * (1.0 - fogFactor), color.rgb, shadow.a),
                color.a
            );
        }
    }

    // Apply outlines
    let outline = getOutline(coords, uniforms.outlineScale);

    if (outline.hasOpaque) {
        let viewDistOutline = abs(getViewZ(outline.opaqueDepth, uniforms));
        let fogFactorOutline = smoothstep(uniforms.fogNear, uniforms.fogFar, viewDistOutline);
        if (uniforms.transparentBackground == 0u) {
            color = vec4<f32>(mix(uniforms.outlineColor, uniforms.fogColor, fogFactorOutline), 1.0);
        } else {
            color = vec4<f32>(mix(uniforms.outlineColor, vec3<f32>(0.0), fogFactorOutline), 1.0 - fogFactorOutline);
        }
    }

    if (outline.hasTransparent) {
        if (outline.hasOpaque && outline.opaqueDepth < outline.transparentDepth) {
            blendTransparency = false;
        } else {
            let finalOutlineAlpha = clamp(outline.alpha * 2.0, 0.0, 1.0);
            let viewDistOutlineTrans = abs(getViewZ(outline.transparentDepth, uniforms));
            let fogFactorOutlineTrans = smoothstep(uniforms.fogNear, uniforms.fogFar, viewDistOutlineTrans);
            let finalAlpha = max(blendedTransparentColor.a, finalOutlineAlpha * (1.0 - fogFactorOutlineTrans));
            blendedTransparentColor = vec4<f32>(uniforms.outlineColor * finalAlpha, finalAlpha);
        }
    }

    // Blend transparency
    if (blendTransparency) {
        let alpha = blendedTransparentColor.a;
        if (alpha > 0.0) {
            color = blendedTransparentColor + color * (1.0 - alpha);
        }
    }

    return color;
}
`;

export const postprocessing_simple_wgsl = /* wgsl */`
${postprocessing_common_wgsl}

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
}

@group(0) @binding(0) var<uniform> uniforms: PostprocessingUniforms;
@group(0) @binding(1) var tColor: texture_2d<f32>;
@group(0) @binding(2) var texSampler: sampler;

@vertex
fn vs_main(
    @location(0) position: vec2<f32>,
    @location(1) uv: vec2<f32>
) -> VertexOutput {
    var output: VertexOutput;
    output.position = vec4<f32>(position, 0.0, 1.0);
    output.uv = uv;
    return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
    return textureSample(tColor, texSampler, input.uv);
}
`;
