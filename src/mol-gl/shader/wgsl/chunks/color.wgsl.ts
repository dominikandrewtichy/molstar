/**
 * Copyright (c) 2025 mol* contributors, licensed under MIT, See LICENSE file for more info.
 *
 * @author Alexander Rose <alexander.rose@weirdbyte.de>
 */

/**
 * WGSL color utilities.
 * Handles color assignment from various sources (attribute, texture, volume).
 * Equivalent to the GLSL assign-color-varying.glsl chunk.
 */

export const color_types_wgsl = /* wgsl */`
// Color source types (used as constants/overrides)
const COLOR_TYPE_UNIFORM: u32 = 0u;
const COLOR_TYPE_ATTRIBUTE: u32 = 1u;
const COLOR_TYPE_INSTANCE: u32 = 2u;
const COLOR_TYPE_GROUP: u32 = 3u;
const COLOR_TYPE_GROUP_INSTANCE: u32 = 4u;
const COLOR_TYPE_VERTEX: u32 = 5u;
const COLOR_TYPE_VERTEX_INSTANCE: u32 = 6u;
const COLOR_TYPE_VOLUME: u32 = 7u;
const COLOR_TYPE_VOLUME_INSTANCE: u32 = 8u;
`;

export const color_params_wgsl = /* wgsl */`
// Color-related uniforms
struct ColorParams {
    // Uniform color (when using COLOR_TYPE_UNIFORM)
    uniform_color: vec4<f32>,

    // Texture dimensions for color lookup
    color_tex_dim: vec2<f32>,

    // Group count for groupInstance color type
    group_count: u32,

    // Vertex count for vertexInstance color type
    vertex_count: u32,

    // Color grid parameters for volume color
    color_grid_dim: vec3<f32>,
    _padding1: f32,

    // Grid transform: xyz = offset, w = scale
    color_grid_transform: vec4<f32>,

    // Model scale for volume color
    model_scale: f32,

    // Use palette lookup
    use_palette: bool,
    _padding2: u32,
    _padding3: u32,
}
`;

export const assign_color_wgsl = /* wgsl */`
// Assign color based on color type
// This function is called in the vertex shader to determine the color varying
fn assign_color(
    color_type: u32,
    // Attribute color (for COLOR_TYPE_ATTRIBUTE)
    attr_color: vec3<f32>,
    // Instance index
    instance: f32,
    // Group index
    group: f32,
    // Vertex ID
    vertex_id: i32,
    // Model position (for volume color)
    model_position: vec3<f32>,
    // Color texture and sampler
    color_texture: texture_2d<f32>,
    color_sampler: sampler,
    // Color grid texture (for volume color)
    color_grid: texture_2d<f32>,
    color_grid_sampler: sampler,
    // Parameters
    params: ColorParams
) -> vec3<f32> {
    var color: vec3<f32>;

    switch (color_type) {
        case COLOR_TYPE_ATTRIBUTE: {
            color = attr_color;
        }
        case COLOR_TYPE_INSTANCE: {
            color = read_from_texture_f(color_texture, color_sampler, instance, params.color_tex_dim).rgb;
        }
        case COLOR_TYPE_GROUP: {
            color = read_from_texture_f(color_texture, color_sampler, group, params.color_tex_dim).rgb;
        }
        case COLOR_TYPE_GROUP_INSTANCE: {
            let index = instance * f32(params.group_count) + group;
            color = read_from_texture_f(color_texture, color_sampler, index, params.color_tex_dim).rgb;
        }
        case COLOR_TYPE_VERTEX: {
            color = read_from_texture_i(color_texture, color_sampler, vertex_id, params.color_tex_dim).rgb;
        }
        case COLOR_TYPE_VERTEX_INSTANCE: {
            let index = i32(instance) * i32(params.vertex_count) + vertex_id;
            color = read_from_texture_i(color_texture, color_sampler, index, params.color_tex_dim).rgb;
        }
        case COLOR_TYPE_VOLUME: {
            let grid_pos = (params.color_grid_transform.w *
                          (model_position - params.color_grid_transform.xyz)) / params.color_grid_dim;
            color = texture_3d_from_2d_linear(
                color_grid, color_grid_sampler,
                grid_pos, params.color_grid_dim, params.color_tex_dim
            ).rgb;
        }
        case COLOR_TYPE_VOLUME_INSTANCE: {
            let scaled_pos = model_position / params.model_scale;
            let grid_pos = (params.color_grid_transform.w *
                          (scaled_pos - params.color_grid_transform.xyz)) / params.color_grid_dim;
            color = texture_3d_from_2d_linear(
                color_grid, color_grid_sampler,
                grid_pos, params.color_grid_dim, params.color_tex_dim
            ).rgb;
        }
        default: {
            // COLOR_TYPE_UNIFORM
            color = params.uniform_color.rgb;
        }
    }

    return color;
}

// Convert color to palette index (for palette lookup)
fn color_to_palette_v(color: vec3<f32>) -> f32 {
    let PALETTE_SCALE = 16777214.0; // (1 << 24) - 2
    return ((color.r * 256.0 * 256.0 * 255.0 + color.g * 256.0 * 255.0 + color.b * 255.0) - 1.0) / PALETTE_SCALE;
}

// Look up color from palette texture
fn palette_lookup(
    palette_v: f32,
    palette_texture: texture_2d<f32>,
    palette_sampler: sampler
) -> vec3<f32> {
    let uv = vec2<f32>(palette_v, 0.5);
    return textureSample(palette_texture, palette_sampler, uv).rgb;
}
`;

export const overpaint_wgsl = /* wgsl */`
// Overpaint parameters
struct OverpaintParams {
    tex_dim: vec2<f32>,
    strength: f32,
    _padding: f32,
    grid_dim: vec3<f32>,
    _padding2: f32,
    grid_transform: vec4<f32>,
}

// Assign overpaint color
fn assign_overpaint(
    overpaint_type: u32,
    instance: f32,
    group: f32,
    vertex_id: i32,
    model_position: vec3<f32>,
    model_scale: f32,
    group_count: u32,
    vertex_count: u32,
    base_color: vec3<f32>,
    overpaint_texture: texture_2d<f32>,
    overpaint_sampler: sampler,
    overpaint_grid: texture_2d<f32>,
    overpaint_grid_sampler: sampler,
    params: OverpaintParams
) -> vec4<f32> {
    var overpaint: vec4<f32>;

    switch (overpaint_type) {
        case COLOR_TYPE_INSTANCE: {
            overpaint = read_from_texture_f(overpaint_texture, overpaint_sampler, instance, params.tex_dim);
        }
        case COLOR_TYPE_GROUP_INSTANCE: {
            let index = instance * f32(group_count) + group;
            overpaint = read_from_texture_f(overpaint_texture, overpaint_sampler, index, params.tex_dim);
        }
        case COLOR_TYPE_VERTEX_INSTANCE: {
            let index = i32(instance) * i32(vertex_count) + vertex_id;
            overpaint = read_from_texture_i(overpaint_texture, overpaint_sampler, index, params.tex_dim);
        }
        case COLOR_TYPE_VOLUME_INSTANCE: {
            let scaled_pos = model_position / model_scale;
            let grid_pos = (params.grid_transform.w *
                          (scaled_pos - params.grid_transform.xyz)) / params.grid_dim;
            overpaint = texture_3d_from_2d_linear(
                overpaint_grid, overpaint_grid_sampler,
                grid_pos, params.grid_dim, params.tex_dim
            );
        }
        default: {
            overpaint = vec4<f32>(0.0);
        }
    }

    // Pre-mix to avoid darkening due to empty overpaint
    overpaint.rgb = mix(base_color, overpaint.rgb, overpaint.a);
    overpaint *= params.strength;

    return overpaint;
}

// Apply overpaint to a color
fn apply_overpaint(base_color: vec3<f32>, overpaint: vec4<f32>) -> vec3<f32> {
    return mix(base_color, overpaint.rgb, overpaint.a);
}
`;

export const emissive_wgsl = /* wgsl */`
// Emissive parameters
struct EmissiveParams {
    tex_dim: vec2<f32>,
    strength: f32,
    _padding: f32,
    grid_dim: vec3<f32>,
    _padding2: f32,
    grid_transform: vec4<f32>,
}

// Assign emissive value
fn assign_emissive(
    emissive_type: u32,
    instance: f32,
    group: f32,
    vertex_id: i32,
    model_position: vec3<f32>,
    model_scale: f32,
    group_count: u32,
    vertex_count: u32,
    emissive_texture: texture_2d<f32>,
    emissive_sampler: sampler,
    emissive_grid: texture_2d<f32>,
    emissive_grid_sampler: sampler,
    params: EmissiveParams
) -> f32 {
    var emissive: f32;

    switch (emissive_type) {
        case COLOR_TYPE_INSTANCE: {
            emissive = read_from_texture_f(emissive_texture, emissive_sampler, instance, params.tex_dim).a;
        }
        case COLOR_TYPE_GROUP_INSTANCE: {
            let index = instance * f32(group_count) + group;
            emissive = read_from_texture_f(emissive_texture, emissive_sampler, index, params.tex_dim).a;
        }
        case COLOR_TYPE_VERTEX_INSTANCE: {
            let index = i32(instance) * i32(vertex_count) + vertex_id;
            emissive = read_from_texture_i(emissive_texture, emissive_sampler, index, params.tex_dim).a;
        }
        case COLOR_TYPE_VOLUME_INSTANCE: {
            let scaled_pos = model_position / model_scale;
            let grid_pos = (params.grid_transform.w *
                          (scaled_pos - params.grid_transform.xyz)) / params.grid_dim;
            emissive = texture_3d_from_2d_linear(
                emissive_grid, emissive_grid_sampler,
                grid_pos, params.grid_dim, params.tex_dim
            ).a;
        }
        default: {
            emissive = 0.0;
        }
    }

    return emissive * params.strength;
}
`;

export const substance_wgsl = /* wgsl */`
// Substance parameters (metalness, roughness, bumpiness)
struct SubstanceParams {
    tex_dim: vec2<f32>,
    strength: f32,
    _padding: f32,
    grid_dim: vec3<f32>,
    _padding2: f32,
    grid_transform: vec4<f32>,
    // Default values
    default_metalness: f32,
    default_roughness: f32,
    default_bumpiness: f32,
    _padding3: f32,
}

// Assign substance values (metalness, roughness, bumpiness)
fn assign_substance(
    substance_type: u32,
    instance: f32,
    group: f32,
    vertex_id: i32,
    model_position: vec3<f32>,
    model_scale: f32,
    group_count: u32,
    vertex_count: u32,
    substance_texture: texture_2d<f32>,
    substance_sampler: sampler,
    substance_grid: texture_2d<f32>,
    substance_grid_sampler: sampler,
    params: SubstanceParams
) -> vec4<f32> {
    var substance: vec4<f32>;

    switch (substance_type) {
        case COLOR_TYPE_INSTANCE: {
            substance = read_from_texture_f(substance_texture, substance_sampler, instance, params.tex_dim);
        }
        case COLOR_TYPE_GROUP_INSTANCE: {
            let index = instance * f32(group_count) + group;
            substance = read_from_texture_f(substance_texture, substance_sampler, index, params.tex_dim);
        }
        case COLOR_TYPE_VERTEX_INSTANCE: {
            let index = i32(instance) * i32(vertex_count) + vertex_id;
            substance = read_from_texture_i(substance_texture, substance_sampler, index, params.tex_dim);
        }
        case COLOR_TYPE_VOLUME_INSTANCE: {
            let scaled_pos = model_position / model_scale;
            let grid_pos = (params.grid_transform.w *
                          (scaled_pos - params.grid_transform.xyz)) / params.grid_dim;
            substance = texture_3d_from_2d_linear(
                substance_grid, substance_grid_sampler,
                grid_pos, params.grid_dim, params.tex_dim
            );
        }
        default: {
            substance = vec4<f32>(0.0);
        }
    }

    // Pre-mix to avoid artifacts due to empty substance
    let defaults = vec3<f32>(params.default_metalness, params.default_roughness, params.default_bumpiness);
    substance.rgb = mix(defaults, substance.rgb, substance.a);
    substance *= params.strength;

    return substance;
}
`;

export const transparency_color_wgsl = /* wgsl */`
// Transparency parameters
struct TransparencyParams {
    tex_dim: vec2<f32>,
    strength: f32,
    _padding: f32,
    grid_dim: vec3<f32>,
    _padding2: f32,
    grid_transform: vec4<f32>,
}

// Assign transparency value
fn assign_transparency(
    transparency_type: u32,
    instance: f32,
    group: f32,
    vertex_id: i32,
    model_position: vec3<f32>,
    model_scale: f32,
    group_count: u32,
    vertex_count: u32,
    transparency_texture: texture_2d<f32>,
    transparency_sampler: sampler,
    transparency_grid: texture_2d<f32>,
    transparency_grid_sampler: sampler,
    params: TransparencyParams
) -> f32 {
    var transparency: f32;

    switch (transparency_type) {
        case COLOR_TYPE_INSTANCE: {
            transparency = read_from_texture_f(transparency_texture, transparency_sampler, instance, params.tex_dim).a;
        }
        case COLOR_TYPE_GROUP_INSTANCE: {
            let index = instance * f32(group_count) + group;
            transparency = read_from_texture_f(transparency_texture, transparency_sampler, index, params.tex_dim).a;
        }
        case COLOR_TYPE_VERTEX_INSTANCE: {
            let index = i32(instance) * i32(vertex_count) + vertex_id;
            transparency = read_from_texture_i(transparency_texture, transparency_sampler, index, params.tex_dim).a;
        }
        case COLOR_TYPE_VOLUME_INSTANCE: {
            let scaled_pos = model_position / model_scale;
            let grid_pos = (params.grid_transform.w *
                          (scaled_pos - params.grid_transform.xyz)) / params.grid_dim;
            transparency = texture_3d_from_2d_linear(
                transparency_grid, transparency_grid_sampler,
                grid_pos, params.grid_dim, params.tex_dim
            ).a;
        }
        default: {
            transparency = 0.0;
        }
    }

    return transparency * params.strength;
}
`;
