/**
 * Copyright (c) 2025 mol* contributors, licensed under MIT, See LICENSE file for more info.
 *
 * @author Alexander Rose <alexander.rose@weirdbyte.de>
 */

/**
 * WGSL marker utilities for highlighting and selection.
 * Equivalent to the GLSL assign-marker-varying.glsl and apply-marker-color.glsl chunks.
 */

export const marker_types_wgsl = /* wgsl */`
// Marker type constants
const MARKER_NONE: u32 = 0u;
const MARKER_HIGHLIGHT: u32 = 1u;
const MARKER_SELECT: u32 = 2u;
const MARKER_HIGHLIGHT_SELECT: u32 = 3u;

// Marker action constants (how marker affects color)
const MARKER_ACTION_HIGHLIGHT: u32 = 0u;  // Mix with highlight color
const MARKER_ACTION_SELECT: u32 = 1u;     // Mix with select color
const MARKER_ACTION_EDGE: u32 = 2u;       // Edge/outline effect
`;

export const marker_params_wgsl = /* wgsl */`
// Marker-related uniforms
struct MarkerParams {
    // Marker texture dimensions
    tex_dim: vec2<f32>,

    // Average marker value (for edge detection)
    marker_average: f32,

    // Marker granularity (group/instance level)
    granularity: u32,

    // Highlight color
    highlight_color: vec4<f32>,

    // Select color
    select_color: vec4<f32>,

    // Edge settings
    edge_strength: f32,
    edge_scale: f32,

    // Marker priority (which takes precedence)
    highlight_strength: f32,
    select_strength: f32,
}
`;

export const assign_marker_wgsl = /* wgsl */`
// Assign marker value from texture
// Returns marker value (0 = none, 1 = highlight, 2 = select, 3 = both)
fn assign_marker(
    instance: f32,
    group: f32,
    group_count: u32,
    marker_texture: texture_2d<f32>,
    marker_sampler: sampler,
    params: MarkerParams
) -> f32 {
    // Calculate texture index based on granularity
    let index = instance * f32(group_count) + group;
    let marker_value = read_from_texture_f(marker_texture, marker_sampler, index, params.tex_dim).a;

    // Convert from normalized [0, 1] to marker type
    // 0.0 = none, ~0.33 = highlight, ~0.66 = select, 1.0 = both
    return floor(marker_value * 3.0 + 0.5);
}

// Check if marker indicates highlighting
fn is_highlighted(marker: f32) -> bool {
    let m = u32(marker);
    return m == MARKER_HIGHLIGHT || m == MARKER_HIGHLIGHT_SELECT;
}

// Check if marker indicates selection
fn is_selected(marker: f32) -> bool {
    let m = u32(marker);
    return m == MARKER_SELECT || m == MARKER_HIGHLIGHT_SELECT;
}
`;

export const apply_marker_color_wgsl = /* wgsl */`
// Apply marker effect to fragment color
fn apply_marker_color(
    color: vec4<f32>,
    marker: f32,
    params: MarkerParams,
    apply_highlight: bool,
    apply_select: bool
) -> vec4<f32> {
    var result = color;
    let m = u32(marker);

    if (m == MARKER_NONE) {
        return result;
    }

    // Apply highlight
    if (apply_highlight && (m == MARKER_HIGHLIGHT || m == MARKER_HIGHLIGHT_SELECT)) {
        let strength = params.highlight_strength * params.highlight_color.a;
        result.rgb = mix(result.rgb, params.highlight_color.rgb, strength);
    }

    // Apply select
    if (apply_select && (m == MARKER_SELECT || m == MARKER_HIGHLIGHT_SELECT)) {
        let strength = params.select_strength * params.select_color.a;
        result.rgb = mix(result.rgb, params.select_color.rgb, strength);
    }

    return result;
}

// Apply marker edge effect (outline/silhouette)
fn apply_marker_edge(
    color: vec4<f32>,
    marker: f32,
    marker_neighbors: vec4<f32>,  // Left, Right, Top, Bottom neighbor markers
    params: MarkerParams
) -> vec4<f32> {
    if (marker == 0.0) {
        return color;
    }

    // Calculate edge factor based on neighboring markers
    let edge = abs(marker - marker_neighbors.x) +
               abs(marker - marker_neighbors.y) +
               abs(marker - marker_neighbors.z) +
               abs(marker - marker_neighbors.w);

    let edge_factor = clamp(edge * params.edge_scale, 0.0, 1.0) * params.edge_strength;

    // Determine edge color based on marker type
    var edge_color: vec3<f32>;
    let m = u32(marker);
    if (m == MARKER_HIGHLIGHT || m == MARKER_HIGHLIGHT_SELECT) {
        edge_color = params.highlight_color.rgb;
    } else {
        edge_color = params.select_color.rgb;
    }

    var result = color;
    result.rgb = mix(result.rgb, edge_color, edge_factor);
    return result;
}

// Sample marker from texture at fragment coordinates
fn sample_marker_neighbors(
    frag_coord: vec2<f32>,
    marker_texture: texture_2d<f32>,
    marker_sampler: sampler,
    pixel_size: vec2<f32>
) -> vec4<f32> {
    // Sample in screen space using offsets
    let left = textureSample(marker_texture, marker_sampler, frag_coord - vec2<f32>(pixel_size.x, 0.0)).a;
    let right = textureSample(marker_texture, marker_sampler, frag_coord + vec2<f32>(pixel_size.x, 0.0)).a;
    let top = textureSample(marker_texture, marker_sampler, frag_coord - vec2<f32>(0.0, pixel_size.y)).a;
    let bottom = textureSample(marker_texture, marker_sampler, frag_coord + vec2<f32>(0.0, pixel_size.y)).a;

    // Convert to marker values
    return vec4<f32>(
        floor(left * 3.0 + 0.5),
        floor(right * 3.0 + 0.5),
        floor(top * 3.0 + 0.5),
        floor(bottom * 3.0 + 0.5)
    );
}

// Simplified marker color for marking render variant
fn get_marker_only_color(marker: f32, params: MarkerParams) -> vec4<f32> {
    let m = u32(marker);

    if (m == MARKER_HIGHLIGHT_SELECT) {
        // Blend both colors
        return mix(params.highlight_color, params.select_color, 0.5);
    } else if (m == MARKER_HIGHLIGHT) {
        return params.highlight_color;
    } else if (m == MARKER_SELECT) {
        return params.select_color;
    }

    // No marker - return transparent
    return vec4<f32>(0.0);
}
`;
