/**
 * Copyright (c) 2025 mol* contributors, licensed under MIT, See LICENSE file for more info.
 *
 * @author Alexander Rose <alexander.rose@weirdbyte.de>
 */

/**
 * WGSL interior color utilities.
 * Handles interior/backface coloring for hollow rendering.
 * Equivalent to the GLSL apply-interior-color.glsl chunk.
 */

export const interior_params_wgsl = /* wgsl */`
// Interior color parameters
struct InteriorParams {
    // Interior color (RGBA, A controls mixing)
    color: vec4<f32>,

    // Interior substance (metalness, roughness, bumpiness)
    substance: vec4<f32>,

    // Interior color mode
    // 0 = off, 1 = uniform, 2 = darken, 3 = lighten
    mode: u32,

    // Darken/lighten factor
    factor: f32,
    _padding1: u32,
    _padding2: u32,
}
`;

export const interior_modes_wgsl = /* wgsl */`
// Interior color modes
const INTERIOR_MODE_OFF: u32 = 0u;
const INTERIOR_MODE_UNIFORM: u32 = 1u;
const INTERIOR_MODE_DARKEN: u32 = 2u;
const INTERIOR_MODE_LIGHTEN: u32 = 3u;
`;

export const apply_interior_color_wgsl = /* wgsl */`
// Apply interior color to a fragment
fn apply_interior_color(
    color: vec4<f32>,
    is_interior: bool,
    params: InteriorParams
) -> vec4<f32> {
    if (!is_interior || params.mode == INTERIOR_MODE_OFF) {
        return color;
    }

    var result = color;

    switch (params.mode) {
        case INTERIOR_MODE_UNIFORM: {
            // Mix with uniform interior color
            result.rgb = mix(result.rgb, params.color.rgb, params.color.a);
        }
        case INTERIOR_MODE_DARKEN: {
            // Darken the color
            result.rgb = result.rgb * (1.0 - params.factor);
        }
        case INTERIOR_MODE_LIGHTEN: {
            // Lighten the color
            result.rgb = result.rgb + (1.0 - result.rgb) * params.factor;
        }
        default: {}
    }

    return result;
}

// Get interior substance values (metalness, roughness, bumpiness)
fn get_interior_substance(
    base_metalness: f32,
    base_roughness: f32,
    base_bumpiness: f32,
    is_interior: bool,
    params: InteriorParams
) -> vec3<f32> {
    if (!is_interior || params.substance.a == 0.0) {
        return vec3<f32>(base_metalness, base_roughness, base_bumpiness);
    }

    return mix(
        vec3<f32>(base_metalness, base_roughness, base_bumpiness),
        params.substance.rgb,
        params.substance.a
    );
}

// Check if a fragment is on the interior (backface)
fn is_interior_fragment(front_facing: bool, double_sided: bool, flip_sided: bool) -> bool {
    var interior = !front_facing;

    if (double_sided) {
        // Double-sided: flip the interior status based on facing
        interior = !front_facing;
    }

    if (flip_sided) {
        interior = !interior;
    }

    return interior;
}

// Calculate normal for interior fragments
fn get_interior_normal(normal: vec3<f32>, is_interior: bool) -> vec3<f32> {
    if (is_interior) {
        return -normal;
    }
    return normal;
}
`;

export const xray_shading_wgsl = /* wgsl */`
// X-ray shading parameters
struct XrayParams {
    // X-ray mode: 0 = off, 1 = on, 2 = inverted
    mode: u32,
    // X-ray strength
    strength: f32,
    _padding1: u32,
    _padding2: u32,
}

// X-ray shading modes
const XRAY_MODE_OFF: u32 = 0u;
const XRAY_MODE_ON: u32 = 1u;
const XRAY_MODE_INVERTED: u32 = 2u;

// Apply x-ray shading effect
fn apply_xray_shading(
    alpha: f32,
    normal: vec3<f32>,
    view_dir: vec3<f32>,
    params: XrayParams
) -> f32 {
    if (params.mode == XRAY_MODE_OFF) {
        return alpha;
    }

    // Calculate fresnel-like effect based on view angle
    let n_dot_v = abs(dot(normalize(normal), normalize(view_dir)));

    var xray_factor: f32;
    if (params.mode == XRAY_MODE_INVERTED) {
        // Inverted: edges are more visible
        xray_factor = n_dot_v;
    } else {
        // Normal: faces perpendicular to view are more visible
        xray_factor = 1.0 - n_dot_v;
    }

    // Apply strength
    xray_factor = pow(xray_factor, 2.0) * params.strength;

    return alpha * xray_factor;
}
`;
