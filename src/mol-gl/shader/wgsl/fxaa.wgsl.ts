/**
 * Copyright (c) 2025 mol* contributors, licensed under MIT, See LICENSE file for more info.
 *
 * @author Alexander Rose <alexander.rose@weirdbyte.de>
 */

/**
 * WGSL FXAA (Fast Approximate Anti-Aliasing) shader.
 * Adapted from https://github.com/kosua20/Rendu (MIT License Copyright (c) 2017 Simon Rodriguez)
 */

export const fxaa_wgsl = /* wgsl */`
struct FxaaUniforms {
    texSizeInv: vec2<f32>,
    edgeThresholdMin: f32,    // Minimum edge threshold (default: 0.0312)
    edgeThresholdMax: f32,    // Maximum edge threshold (default: 0.125)
    subpixelQuality: f32,     // Subpixel quality (default: 0.75)
    iterations: i32,          // Edge search iterations (default: 12)
    _padding: vec2<f32>,
}

@group(0) @binding(0) var<uniform> uniforms: FxaaUniforms;
@group(0) @binding(1) var tColor: texture_2d<f32>;
@group(0) @binding(2) var colorSampler: sampler;

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

fn quality(q: i32) -> f32 {
    if (q < 5) {
        return 1.0;
    } else if (q == 5) {
        return 1.5;
    } else if (q < 10) {
        return 2.0;
    } else if (q < 11) {
        return 4.0;
    } else {
        return 8.0;
    }
}

fn rgb2luma(rgb: vec3<f32>) -> f32 {
    return sqrt(dot(rgb, vec3<f32>(0.299, 0.587, 0.114)));
}

fn sampleLuma(uv: vec2<f32>) -> f32 {
    return rgb2luma(textureSample(tColor, colorSampler, uv).rgb);
}

fn sampleLumaOffset(uv: vec2<f32>, uOffset: f32, vOffset: f32) -> f32 {
    let offsetUv = uv + uniforms.texSizeInv * vec2<f32>(uOffset, vOffset);
    return sampleLuma(offsetUv);
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
    let coords = input.uv;
    let inverseScreenSize = uniforms.texSizeInv;

    let colorCenter = textureSample(tColor, colorSampler, coords);

    // Luma at the current fragment
    let lumaCenter = rgb2luma(colorCenter.rgb);

    // Luma at the four direct neighbours of the current fragment
    let lumaDown = sampleLumaOffset(coords, 0.0, -1.0);
    let lumaUp = sampleLumaOffset(coords, 0.0, 1.0);
    let lumaLeft = sampleLumaOffset(coords, -1.0, 0.0);
    let lumaRight = sampleLumaOffset(coords, 1.0, 0.0);

    // Find the maximum and minimum luma around the current fragment
    let lumaMin = min(lumaCenter, min(min(lumaDown, lumaUp), min(lumaLeft, lumaRight)));
    let lumaMax = max(lumaCenter, max(max(lumaDown, lumaUp), max(lumaLeft, lumaRight)));

    // Compute the delta
    let lumaRange = lumaMax - lumaMin;

    // If the luma variation is lower than a threshold (or if we are in a really dark area),
    // we are not on an edge, don't perform any AA
    if (lumaRange < max(uniforms.edgeThresholdMin, lumaMax * uniforms.edgeThresholdMax)) {
        return colorCenter;
    }

    // Query the 4 remaining corners lumas
    let lumaDownLeft = sampleLumaOffset(coords, -1.0, -1.0);
    let lumaUpRight = sampleLumaOffset(coords, 1.0, 1.0);
    let lumaUpLeft = sampleLumaOffset(coords, -1.0, 1.0);
    let lumaDownRight = sampleLumaOffset(coords, 1.0, -1.0);

    // Combine the four edges lumas
    let lumaDownUp = lumaDown + lumaUp;
    let lumaLeftRight = lumaLeft + lumaRight;

    // Same for corners
    let lumaLeftCorners = lumaDownLeft + lumaUpLeft;
    let lumaDownCorners = lumaDownLeft + lumaDownRight;
    let lumaRightCorners = lumaDownRight + lumaUpRight;
    let lumaUpCorners = lumaUpRight + lumaUpLeft;

    // Compute an estimation of the gradient along the horizontal and vertical axis
    let edgeHorizontal = abs(-2.0 * lumaLeft + lumaLeftCorners) + abs(-2.0 * lumaCenter + lumaDownUp) * 2.0 + abs(-2.0 * lumaRight + lumaRightCorners);
    let edgeVertical = abs(-2.0 * lumaUp + lumaUpCorners) + abs(-2.0 * lumaCenter + lumaLeftRight) * 2.0 + abs(-2.0 * lumaDown + lumaDownCorners);

    // Is the local edge horizontal or vertical?
    let isHorizontal = (edgeHorizontal >= edgeVertical);

    // Choose the step size (one pixel) accordingly
    var stepLength: f32;
    if (isHorizontal) {
        stepLength = inverseScreenSize.y;
    } else {
        stepLength = inverseScreenSize.x;
    }

    // Select the two neighboring texels lumas in the opposite direction to the local edge
    var luma1: f32;
    var luma2: f32;
    if (isHorizontal) {
        luma1 = lumaDown;
        luma2 = lumaUp;
    } else {
        luma1 = lumaLeft;
        luma2 = lumaRight;
    }

    // Compute gradients in this direction
    let gradient1 = luma1 - lumaCenter;
    let gradient2 = luma2 - lumaCenter;

    // Which direction is the steepest?
    let is1Steepest = abs(gradient1) >= abs(gradient2);

    // Gradient in the corresponding direction, normalized
    let gradientScaled = 0.25 * max(abs(gradient1), abs(gradient2));

    // Average luma in the correct direction
    var lumaLocalAverage: f32;
    if (is1Steepest) {
        // Switch the direction
        stepLength = -stepLength;
        lumaLocalAverage = 0.5 * (luma1 + lumaCenter);
    } else {
        lumaLocalAverage = 0.5 * (luma2 + lumaCenter);
    }

    // Shift UV in the correct direction by half a pixel
    var currentUv = coords;
    if (isHorizontal) {
        currentUv.y += stepLength * 0.5;
    } else {
        currentUv.x += stepLength * 0.5;
    }

    // Compute offset (for each iteration step) in the right direction
    var offset: vec2<f32>;
    if (isHorizontal) {
        offset = vec2<f32>(inverseScreenSize.x, 0.0);
    } else {
        offset = vec2<f32>(0.0, inverseScreenSize.y);
    }

    // Compute UVs to explore on each side of the edge, orthogonally
    var uv1 = currentUv - offset * quality(0);
    var uv2 = currentUv + offset * quality(0);

    // Read the lumas at both current extremities of the exploration segment,
    // and compute the delta wrt to the local average luma
    var lumaEnd1 = sampleLuma(uv1) - lumaLocalAverage;
    var lumaEnd2 = sampleLuma(uv2) - lumaLocalAverage;

    // If the luma deltas at the current extremities is larger than the local gradient,
    // we have reached the side of the edge
    var reached1 = abs(lumaEnd1) >= gradientScaled;
    var reached2 = abs(lumaEnd2) >= gradientScaled;
    var reachedBoth = reached1 && reached2;

    // If the side is not reached, we continue to explore in this direction
    if (!reached1) {
        uv1 -= offset * quality(1);
    }
    if (!reached2) {
        uv2 += offset * quality(1);
    }

    // If both sides have not been reached, continue to explore
    if (!reachedBoth) {
        for (var i: i32 = 2; i < uniforms.iterations; i++) {
            // If needed, read luma in 1st direction, compute delta
            if (!reached1) {
                lumaEnd1 = sampleLuma(uv1) - lumaLocalAverage;
            }
            // If needed, read luma in opposite direction, compute delta
            if (!reached2) {
                lumaEnd2 = sampleLuma(uv2) - lumaLocalAverage;
            }
            // If the luma deltas at the current extremities is larger than the local gradient,
            // we have reached the side of the edge
            reached1 = abs(lumaEnd1) >= gradientScaled;
            reached2 = abs(lumaEnd2) >= gradientScaled;
            reachedBoth = reached1 && reached2;

            // If the side is not reached, we continue to explore in this direction
            if (!reached1) {
                uv1 -= offset * quality(i);
            }
            if (!reached2) {
                uv2 += offset * quality(i);
            }

            // If both sides have been reached, stop the exploration
            if (reachedBoth) {
                break;
            }
        }
    }

    // Compute the distances to each side edge of the edge
    var distance1: f32;
    var distance2: f32;
    if (isHorizontal) {
        distance1 = coords.x - uv1.x;
        distance2 = uv2.x - coords.x;
    } else {
        distance1 = coords.y - uv1.y;
        distance2 = uv2.y - coords.y;
    }

    // In which direction is the side of the edge closer?
    let isDirection1 = distance1 < distance2;
    let distanceFinal = min(distance1, distance2);

    // Thickness of the edge
    let edgeThickness = (distance1 + distance2);

    // Is the luma at center smaller than the local average?
    let isLumaCenterSmaller = lumaCenter < lumaLocalAverage;

    // If the luma at center is smaller than at its neighbour,
    // the delta luma at each end should be positive (same variation)
    let correctVariation1 = (lumaEnd1 < 0.0) != isLumaCenterSmaller;
    let correctVariation2 = (lumaEnd2 < 0.0) != isLumaCenterSmaller;

    // Only keep the result in the direction of the closer side of the edge
    var correctVariation: bool;
    if (isDirection1) {
        correctVariation = correctVariation1;
    } else {
        correctVariation = correctVariation2;
    }

    // UV offset: read in the direction of the closest side of the edge
    let pixelOffset = -distanceFinal / edgeThickness + 0.5;

    // If the luma variation is incorrect, do not offset
    var finalOffset: f32;
    if (correctVariation) {
        finalOffset = pixelOffset;
    } else {
        finalOffset = 0.0;
    }

    // Sub-pixel shifting
    // Full weighted average of the luma over the 3x3 neighborhood
    let lumaAverage = (1.0 / 12.0) * (2.0 * (lumaDownUp + lumaLeftRight) + lumaLeftCorners + lumaRightCorners);
    // Ratio of the delta between the global average and the center luma,
    // over the luma range in the 3x3 neighborhood
    let subPixelOffset1 = clamp(abs(lumaAverage - lumaCenter) / lumaRange, 0.0, 1.0);
    let subPixelOffset2 = (-2.0 * subPixelOffset1 + 3.0) * subPixelOffset1 * subPixelOffset1;
    // Compute a sub-pixel offset based on this delta
    let subPixelOffsetFinal = subPixelOffset2 * subPixelOffset2 * uniforms.subpixelQuality;

    // Pick the biggest of the two offsets
    finalOffset = max(finalOffset, subPixelOffsetFinal);

    // Compute the final UV coordinates
    var finalUv = coords;
    if (isHorizontal) {
        finalUv.y += finalOffset * stepLength;
    } else {
        finalUv.x += finalOffset * stepLength;
    }

    // Read the color at the new UV coordinates, and use it
    return textureSample(tColor, colorSampler, finalUv);
}
`;
