/**
 * Copyright (c) 2025 mol* contributors, licensed under MIT, See LICENSE file for more info.
 *
 * @author Alexander Rose <alexander.rose@weirdbyte.de>
 */

/**
 * WGSL Outline detection shader for WebGPU.
 * Uses depth discontinuity detection to find edges.
 */

export const outlines_wgsl = /* wgsl */`
struct OutlineUniforms {
    texSize: vec2<f32>,
    near: f32,
    far: f32,
    invProjection: mat4x4<f32>,
    outlineThreshold: f32,
    orthographic: u32,
    includeTransparent: u32,
    _padding: f32,
}

@group(0) @binding(0) var<uniform> uniforms: OutlineUniforms;
@group(0) @binding(1) var tDepthOpaque: texture_2d<f32>;
@group(0) @binding(2) var tDepthTransparent: texture_2d<f32>;
@group(0) @binding(3) var depthSampler: sampler;

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

fn perspectiveDepthToViewZ(depth: f32) -> f32 {
    return (uniforms.near * uniforms.far) / ((uniforms.far - uniforms.near) * depth - uniforms.far);
}

fn orthographicDepthToViewZ(depth: f32) -> f32 {
    return depth * (uniforms.near - uniforms.far) - uniforms.near;
}

fn getViewZ(depth: f32) -> f32 {
    if (uniforms.orthographic == 1u) {
        return orthographicDepthToViewZ(depth);
    } else {
        return perspectiveDepthToViewZ(depth);
    }
}

fn isBackground(depth: f32) -> bool {
    return depth >= 1.0;
}

fn screenSpaceToViewSpace(ssPos: vec3<f32>) -> vec3<f32> {
    var p = vec4<f32>(ssPos * 2.0 - 1.0, 1.0);
    p = uniforms.invProjection * p;
    return p.xyz / p.w;
}

fn getPixelSize(coords: vec2<f32>, depth: f32) -> f32 {
    let invTexSize = 1.0 / uniforms.texSize;
    let viewPos0 = screenSpaceToViewSpace(vec3<f32>(coords, depth));
    let viewPos1 = screenSpaceToViewSpace(vec3<f32>(coords + vec2<f32>(1.0, 0.0) * invTexSize, depth));
    return distance(viewPos0, viewPos1);
}

fn getDepthOpaque(coords: vec2<f32>) -> f32 {
    return textureSample(tDepthOpaque, depthSampler, coords).r;
}

fn getDepthTransparentWithAlpha(coords: vec2<f32>) -> vec2<f32> {
    if (uniforms.includeTransparent == 0u) {
        return vec2<f32>(1.0, 0.0);
    }
    let sample = textureSample(tDepthTransparent, depthSampler, coords);
    // Unpack RGBA to depth with alpha
    let depth = sample.r + sample.g / 255.0 + sample.b / 65025.0;
    let alpha = sample.a;
    return vec2<f32>(depth, alpha);
}

fn packUnitIntervalToRG(v: f32) -> vec2<f32> {
    var enc: vec2<f32>;
    enc = vec2<f32>(fract(v * 256.0), v);
    enc.y -= enc.x * (1.0 / 256.0);
    enc *= 256.0 / 255.0;
    return enc;
}

fn pack2x4(v: vec2<f32>) -> f32 {
    let clamped = clamp(v, vec2<f32>(0.0), vec2<f32>(1.0));
    let scaled = floor(clamped * 15.0 + 0.5); // round to 0-15
    let c = scaled.x + scaled.y * 16.0;
    return c / 255.0;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
    let backgroundViewZ = 2.0 * uniforms.far;
    let coords = input.uv;
    let invTexSize = 1.0 / uniforms.texSize;

    // Sample self depth (opaque)
    let selfDepthOpaque = getDepthOpaque(coords);
    var selfViewZOpaque: f32;
    if (isBackground(selfDepthOpaque)) {
        selfViewZOpaque = backgroundViewZ;
    } else {
        selfViewZOpaque = getViewZ(selfDepthOpaque);
    }
    let pixelSizeOpaque = getPixelSize(coords, selfDepthOpaque) * uniforms.outlineThreshold;

    // Sample self depth (transparent)
    let selfDepthTransparentWithAlpha = getDepthTransparentWithAlpha(coords);
    let selfDepthTransparent = selfDepthTransparentWithAlpha.x;
    var selfViewZTransparent: f32;
    if (isBackground(selfDepthTransparent)) {
        selfViewZTransparent = backgroundViewZ;
    } else {
        selfViewZTransparent = getViewZ(selfDepthTransparent);
    }
    let pixelSizeTransparent = getPixelSize(coords, selfDepthTransparent) * uniforms.outlineThreshold;

    var bestOpaqueDepth = 1.0;
    var bestTransparentDepth = 1.0;
    var bestTransparentAlpha = 0.0;

    var opaqueOutlineFlag = 0.0;
    var transparentOutlineFlag = 0.0;

    // Sample 3x3 neighborhood for edge detection
    for (var y = -1; y <= 1; y++) {
        for (var x = -1; x <= 1; x++) {
            let sampleCoords = coords + vec2<f32>(f32(x), f32(y)) * invTexSize;

            // Opaque outline detection
            let sampleDepthOpaque = getDepthOpaque(sampleCoords);
            var sampleViewZOpaque: f32;
            if (isBackground(sampleDepthOpaque)) {
                sampleViewZOpaque = backgroundViewZ;
            } else {
                sampleViewZOpaque = getViewZ(sampleDepthOpaque);
            }

            if (abs(selfViewZOpaque - sampleViewZOpaque) > pixelSizeOpaque &&
                selfDepthOpaque > sampleDepthOpaque &&
                sampleDepthOpaque <= bestOpaqueDepth) {
                bestOpaqueDepth = sampleDepthOpaque;
                opaqueOutlineFlag = 1.0;
            }

            // Transparent outline detection
            let sampleDepthTransparentWithAlpha = getDepthTransparentWithAlpha(sampleCoords);
            let sampleDepthTransparent = sampleDepthTransparentWithAlpha.x;
            let sampleAlphaTransparent = sampleDepthTransparentWithAlpha.y;
            var sampleViewZTransparent: f32;
            if (isBackground(sampleDepthTransparent)) {
                sampleViewZTransparent = backgroundViewZ;
            } else {
                sampleViewZTransparent = getViewZ(sampleDepthTransparent);
            }

            if (abs(selfViewZTransparent - sampleViewZTransparent) > pixelSizeTransparent &&
                selfDepthTransparent > sampleDepthTransparent &&
                sampleDepthTransparent <= bestTransparentDepth) {
                bestTransparentDepth = sampleDepthTransparent;
                bestTransparentAlpha = sampleAlphaTransparent;
                transparentOutlineFlag = 1.0;
            }
        }
    }

    // Curvature veto - reject outlines on curved surfaces
    let kCurvatureGate = 0.75;
    let dx = vec2<f32>(invTexSize.x, 0.0);
    let dy = vec2<f32>(0.0, invTexSize.y);

    // Opaque curvature check
    if (opaqueOutlineFlag > 0.0 && !isBackground(selfDepthOpaque)) {
        let dL = getDepthOpaque(coords - dx);
        let dR = getDepthOpaque(coords + dx);
        let dU = getDepthOpaque(coords + dy);
        let dD = getDepthOpaque(coords - dy);

        var vzL: f32; var vzR: f32; var vzU: f32; var vzD: f32;
        if (isBackground(dL)) { vzL = backgroundViewZ; } else { vzL = getViewZ(dL); }
        if (isBackground(dR)) { vzR = backgroundViewZ; } else { vzR = getViewZ(dR); }
        if (isBackground(dU)) { vzU = backgroundViewZ; } else { vzU = getViewZ(dU); }
        if (isBackground(dD)) { vzD = backgroundViewZ; } else { vzD = getViewZ(dD); }

        let ddx = abs(vzL + vzR - 2.0 * selfViewZOpaque);
        let ddy = abs(vzU + vzD - 2.0 * selfViewZOpaque);
        let curvOpaque = max(ddx, ddy);

        if (curvOpaque < pixelSizeOpaque * kCurvatureGate) {
            opaqueOutlineFlag = 0.0;
            bestOpaqueDepth = 1.0;
        }
    }

    // Transparent curvature check
    if (transparentOutlineFlag > 0.0 && !isBackground(selfDepthTransparent)) {
        let daL = getDepthTransparentWithAlpha(coords - dx);
        let daR = getDepthTransparentWithAlpha(coords + dx);
        let daU = getDepthTransparentWithAlpha(coords + dy);
        let daD = getDepthTransparentWithAlpha(coords - dy);

        var vzL: f32; var vzR: f32; var vzU: f32; var vzD: f32;
        if (isBackground(daL.x)) { vzL = backgroundViewZ; } else { vzL = getViewZ(daL.x); }
        if (isBackground(daR.x)) { vzR = backgroundViewZ; } else { vzR = getViewZ(daR.x); }
        if (isBackground(daU.x)) { vzU = backgroundViewZ; } else { vzU = getViewZ(daU.x); }
        if (isBackground(daD.x)) { vzD = backgroundViewZ; } else { vzD = getViewZ(daD.x); }

        let ddx = abs(vzL + vzR - 2.0 * selfViewZTransparent);
        let ddy = abs(vzU + vzD - 2.0 * selfViewZTransparent);
        let curvTransparent = max(ddx, ddy);

        if (curvTransparent < pixelSizeTransparent * kCurvatureGate) {
            transparentOutlineFlag = 0.0;
            bestTransparentDepth = 1.0;
            bestTransparentAlpha = 0.0;
        }
    }

    // If both outlines exist, prefer opaque if it's in front
    if (transparentOutlineFlag > 0.0 && bestOpaqueDepth < 1.0 && bestTransparentDepth > bestOpaqueDepth) {
        transparentOutlineFlag = 0.0;
        bestTransparentAlpha = 0.0;
    }

    // Pack output
    var depthPacked: vec2<f32>;
    var outlineTypeFlag = 0.0;

    if (opaqueOutlineFlag > 0.0 && transparentOutlineFlag > 0.0) {
        outlineTypeFlag = 0.75; // Both
        depthPacked = packUnitIntervalToRG(bestOpaqueDepth);
    } else if (transparentOutlineFlag > 0.0) {
        outlineTypeFlag = 0.5;  // Transparent only
        depthPacked = packUnitIntervalToRG(bestTransparentDepth);
    } else if (opaqueOutlineFlag > 0.0) {
        outlineTypeFlag = 0.25; // Opaque only
        depthPacked = packUnitIntervalToRG(bestOpaqueDepth);
    } else {
        depthPacked = vec2<f32>(0.0);
    }

    // Clamp alpha to [0, 0.5] range for better precision, then scale
    let alpha = clamp(bestTransparentAlpha, 0.0, 0.5) * 2.0;
    let packedFlagWithAlpha = pack2x4(vec2<f32>(outlineTypeFlag, alpha));

    return vec4<f32>(packedFlagWithAlpha, depthPacked.x, depthPacked.y, bestTransparentDepth);
}
`;
