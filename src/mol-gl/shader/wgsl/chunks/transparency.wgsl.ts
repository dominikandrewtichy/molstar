/**
 * Copyright (c) 2025 mol* contributors, licensed under MIT, See LICENSE file for more info.
 *
 * @author Alexander Rose <alexander.rose@weirdbyte.de>
 * @author Aron Samuel Kovacs <aron.kovacs@mail.muni.cz>
 */

/**
 * WGSL transparency utilities for Order-Independent Transparency (OIT).
 * Implements both WBOIT (Weighted Blended OIT) and DPOIT (Depth Peeling OIT).
 * Equivalent to the GLSL wboit-write.glsl and dpoit-write.glsl chunks.
 */

export const transparency_constants_wgsl = /* wgsl */`
// Render mask constants
const MASK_ALL: i32 = 0;
const MASK_OPAQUE: i32 = 1;
const MASK_TRANSPARENT: i32 = 2;

// Maximum depth for DPOIT
const MAX_DPOIT_DEPTH: f32 = 99999.0;
`;

export const wboit_wgsl = /* wgsl */`
// Weighted Blended Order-Independent Transparency (WBOIT)
// Based on Morgan McGuire and Louis Bavoil's paper:
// "Weighted Blended Order-Independent Transparency"

// WBOIT output structure for dual render targets
struct WboitOutput {
    // Accumulation buffer (RGBA): RGB = weighted color * alpha, A = alpha accumulation
    accum: vec4<f32>,
    // Revealage buffer (R): product of (1 - alpha)
    reveal: f32,
}

// Compute WBOIT weight based on depth and alpha
fn wboit_weight(alpha: f32, depth: f32) -> f32 {
    // Weight function that prioritizes closer, more opaque fragments
    // clamp(pow(min(1.0, alpha * 10.0) + 0.01, 3.0) * 1e8 *
    //       pow(1.0 - depth * 0.9, 3.0), 1e-2, 3e3)
    let alpha_factor = pow(min(1.0, alpha * 10.0) + 0.01, 3.0);
    let depth_factor = pow(1.0 - depth * 0.9, 3.0);
    return clamp(alpha_factor * 1e8 * depth_factor, 0.01, 3000.0);
}

// Write to WBOIT buffers
fn wboit_write(
    frag_color: vec4<f32>,
    fragment_depth: f32,
    pre_fog_alpha: f32,
    opaque_depth: f32,
    render_mask: i32,
    is_interior: bool,
    transparent_backfaces_off: bool,
    transparent_background: bool
) -> WboitOutput {
    var output: WboitOutput;
    output.accum = vec4<f32>(0.0);
    output.reveal = 1.0;

    if (render_mask == MASK_OPAQUE) {
        // Opaque pass: discard transparent fragments
        if (pre_fog_alpha < 1.0) {
            // Signal discard
            output.accum = vec4<f32>(-1.0);
            return output;
        }
        output.accum = frag_color;
        output.reveal = 0.0;
    } else if (render_mask == MASK_TRANSPARENT) {
        // Transparent pass: only render fragments behind opaque geometry
        if (pre_fog_alpha != 1.0 && fragment_depth < opaque_depth) {
            // Check backface culling for transparent
            if (transparent_backfaces_off && is_interior) {
                output.accum = vec4<f32>(-1.0); // Signal discard
                return output;
            }

            let alpha = frag_color.a;
            let weight = wboit_weight(alpha, fragment_depth);

            // Accumulation buffer: premultiplied color weighted
            output.accum = vec4<f32>(frag_color.rgb * alpha * weight, alpha);

            // Revealage buffer: weighted alpha for compositing
            // Extra alpha is to handle pre-multiplied alpha
            let reveal_alpha = select(alpha, 1.0, transparent_background);
            output.reveal = reveal_alpha * alpha * weight;
        } else {
            // Fragment is in front of opaque geometry or fully opaque
            output.accum = vec4<f32>(-1.0); // Signal discard
        }
    }

    return output;
}

// Composite WBOIT result in final pass
fn wboit_composite(accum: vec4<f32>, reveal: f32) -> vec4<f32> {
    // Avoid division by zero
    let epsilon = 0.00001;

    // accum.a contains sum of alpha * weight
    // reveal contains product of (1 - alpha) approximated as sum of alpha * weight
    let avg_color = accum.rgb / max(accum.a, epsilon);
    let alpha = 1.0 - reveal;

    return vec4<f32>(avg_color * alpha, alpha);
}
`;

export const dpoit_wgsl = /* wgsl */`
// Depth Peeling Order-Independent Transparency (DPOIT)
// Adapted from Tarek Sherif's implementation
// The MIT License, Copyright 2017 Tarek Sherif, Shuai Shao

// DPOIT output structure for multiple render targets
struct DpoitOutput {
    // Front color accumulation
    front_color: vec4<f32>,
    // Back color for current peel
    back_color: vec4<f32>,
    // Depth buffer (RG): R = -near depth, G = far depth
    depth: vec2<f32>,
}

// DPOIT uniforms needed for depth peeling
struct DpoitParams {
    // Previous pass depth (RG): R = -near, G = far
    last_depth: vec2<f32>,
    // Previous pass front color
    last_front_color: vec4<f32>,
}

// Process a fragment for DPOIT
fn dpoit_write(
    frag_color: vec4<f32>,
    fragment_depth: f32,
    pre_fog_alpha: f32,
    opaque_depth: f32,
    render_mask: i32,
    is_interior: bool,
    transparent_backfaces_off: bool,
    dpoit_params: DpoitParams
) -> DpoitOutput {
    var output: DpoitOutput;
    output.front_color = dpoit_params.last_front_color;
    output.back_color = vec4<f32>(0.0);
    output.depth = vec2<f32>(-MAX_DPOIT_DEPTH, -MAX_DPOIT_DEPTH);

    if (render_mask == MASK_OPAQUE) {
        // Opaque pass: discard transparent fragments
        if (pre_fog_alpha < 1.0) {
            output.front_color = vec4<f32>(-1.0); // Signal discard
            return output;
        }
        output.front_color = frag_color;
    } else if (render_mask == MASK_TRANSPARENT) {
        // Transparent pass
        if (pre_fog_alpha != 1.0 && fragment_depth < opaque_depth) {
            // Check backface culling
            if (transparent_backfaces_off && is_interior) {
                output.front_color = vec4<f32>(-1.0); // Signal discard
                return output;
            }

            let nearest_depth = -dpoit_params.last_depth.x;
            let furthest_depth = dpoit_params.last_depth.y;
            let alpha_multiplier = 1.0 - dpoit_params.last_front_color.a;

            // Skip this depth since it's been peeled
            if (fragment_depth < nearest_depth || fragment_depth > furthest_depth) {
                return output;
            }

            // This needs to be peeled in a future pass
            if (fragment_depth > nearest_depth && fragment_depth < furthest_depth) {
                output.depth = vec2<f32>(-fragment_depth, fragment_depth);
                return output;
            }

            // Write to front or back buffer
            if (fragment_depth == nearest_depth) {
                // Front buffer: accumulate color
                output.front_color.rgb = dpoit_params.last_front_color.rgb +
                                        frag_color.rgb * frag_color.a * alpha_multiplier;
                output.front_color.a = 1.0 - alpha_multiplier * (1.0 - frag_color.a);
            } else {
                // Back buffer: this layer
                output.back_color = frag_color;
            }
        } else {
            output.front_color = vec4<f32>(-1.0); // Signal discard
        }
    }

    return output;
}

// Composite DPOIT layers in final pass
fn dpoit_composite(
    front_color: vec4<f32>,
    back_color: vec4<f32>,
    background_color: vec4<f32>
) -> vec4<f32> {
    // Back-to-front compositing
    var result = background_color;

    // Blend back color
    result.rgb = result.rgb * (1.0 - back_color.a) + back_color.rgb * back_color.a;
    result.a = result.a * (1.0 - back_color.a) + back_color.a;

    // Blend front color (already accumulated)
    let front_alpha = front_color.a;
    result.rgb = result.rgb * (1.0 - front_alpha) + front_color.rgb;
    result.a = result.a * (1.0 - front_alpha) + front_alpha;

    return result;
}

// Initialize DPOIT for first pass
fn dpoit_init_depth() -> vec2<f32> {
    return vec2<f32>(-MAX_DPOIT_DEPTH, -MAX_DPOIT_DEPTH);
}

fn dpoit_init_front_color() -> vec4<f32> {
    return vec4<f32>(0.0, 0.0, 0.0, 0.0);
}
`;

export const transparency_utils_wgsl = /* wgsl */`
// Utility functions for transparency handling

// Check if a fragment should be discarded based on transparency
fn should_discard_transparent(
    alpha: f32,
    threshold: f32,
    is_picking: bool
) -> bool {
    if (is_picking) {
        // More strict alpha test for picking
        return alpha < 0.5;
    }
    return alpha < threshold;
}

// Apply alpha from transparency texture/attribute
fn apply_transparency(
    base_alpha: f32,
    transparency_value: f32,
    transparency_strength: f32
) -> f32 {
    return base_alpha * (1.0 - transparency_value * transparency_strength);
}

// Check if rendering in transparent pass based on alpha
fn is_transparent_fragment(alpha: f32) -> bool {
    return alpha < 1.0;
}

// Get depth from depth texture for OIT comparison
fn get_opaque_depth(
    depth_texture: texture_2d<f32>,
    depth_sampler: sampler,
    screen_uv: vec2<f32>
) -> f32 {
    return textureSample(depth_texture, depth_sampler, screen_uv).r;
}
`;
