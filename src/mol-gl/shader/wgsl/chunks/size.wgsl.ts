/**
 * Copyright (c) 2025 mol* contributors, licensed under MIT, See LICENSE file for more info.
 *
 * @author Alexander Rose <alexander.rose@weirdbyte.de>
 */

/**
 * WGSL size utilities.
 * Handles size assignment from various sources (attribute, texture, etc.).
 * Equivalent to the GLSL assign-size.glsl and size-vert-params.glsl chunks.
 */

export const size_types_wgsl = /* wgsl */`
// Size source types
const SIZE_TYPE_UNIFORM: u32 = 0u;
const SIZE_TYPE_ATTRIBUTE: u32 = 1u;
const SIZE_TYPE_INSTANCE: u32 = 2u;
const SIZE_TYPE_GROUP: u32 = 3u;
const SIZE_TYPE_GROUP_INSTANCE: u32 = 4u;
`;

export const size_params_wgsl = /* wgsl */`
// Size-related uniforms
struct SizeParams {
    // Uniform size value
    uniform_size: f32,

    // Size factor (multiplier)
    size_factor: f32,

    // Texture dimensions for size lookup
    size_tex_dim: vec2<f32>,

    // Group count for groupInstance size type
    group_count: u32,

    // Physical size mode (size in world units vs screen pixels)
    physical_size: bool,
    _padding1: u32,
    _padding2: u32,
}
`;

export const assign_size_wgsl = /* wgsl */`
// Assign size based on size type
fn assign_size(
    size_type: u32,
    // Attribute size (for SIZE_TYPE_ATTRIBUTE)
    attr_size: f32,
    // Instance index
    instance: f32,
    // Group index
    group: f32,
    // Size texture and sampler
    size_texture: texture_2d<f32>,
    size_sampler: sampler,
    // Parameters
    params: SizeParams
) -> f32 {
    var size: f32;

    switch (size_type) {
        case SIZE_TYPE_ATTRIBUTE: {
            size = attr_size;
        }
        case SIZE_TYPE_INSTANCE: {
            size = read_from_texture_f(size_texture, size_sampler, instance, params.size_tex_dim).r;
        }
        case SIZE_TYPE_GROUP: {
            size = read_from_texture_f(size_texture, size_sampler, group, params.size_tex_dim).r;
        }
        case SIZE_TYPE_GROUP_INSTANCE: {
            let index = instance * f32(params.group_count) + group;
            size = read_from_texture_f(size_texture, size_sampler, index, params.size_tex_dim).r;
        }
        default: {
            // SIZE_TYPE_UNIFORM
            size = params.uniform_size;
        }
    }

    return size * params.size_factor;
}

// Calculate screen-space size from world-space size
fn world_to_screen_size(
    world_size: f32,
    view_position: vec3<f32>,
    viewport_height: f32,
    fov_factor: f32,
    is_ortho: f32
) -> f32 {
    if (is_ortho == 1.0) {
        // Orthographic: size is constant in screen space
        return world_size * viewport_height * fov_factor;
    } else {
        // Perspective: size decreases with distance
        let distance = length(view_position);
        return world_size * viewport_height * fov_factor / distance;
    }
}

// Calculate world-space size from screen-space size
fn screen_to_world_size(
    screen_size: f32,
    view_position: vec3<f32>,
    viewport_height: f32,
    fov_factor: f32,
    is_ortho: f32
) -> f32 {
    if (is_ortho == 1.0) {
        return screen_size / (viewport_height * fov_factor);
    } else {
        let distance = length(view_position);
        return screen_size * distance / (viewport_height * fov_factor);
    }
}
`;

export const lod_wgsl = /* wgsl */`
// Level of Detail (LOD) parameters
struct LodParams {
    // LOD near distance (start fading)
    near: f32,
    // LOD far distance (fully faded)
    far: f32,
    // Fade distance (transition zone)
    fade_distance: f32,
    // LOD factor
    factor: f32,
}

// Calculate LOD factor based on distance
fn calculate_lod_factor(
    distance: f32,
    params: LodParams
) -> f32 {
    if (params.factor == 0.0 || (params.near == 0.0 && params.far == 0.0)) {
        return 1.0;
    }

    let fade_in = smoothstep(params.near, params.near + params.fade_distance, distance);
    let fade_out = 1.0 - smoothstep(params.far - params.fade_distance, params.far, distance);
    return min(fade_in, fade_out) * params.factor;
}

// Check if LOD should cull the object
fn lod_should_cull(
    distance: f32,
    params: LodParams
) -> bool {
    if (params.factor == 0.0) {
        return false;
    }

    return distance < params.near || distance > params.far;
}

// Apply LOD to size
fn apply_lod_to_size(
    size: f32,
    model_position: vec3<f32>,
    camera_plane: vec4<f32>,
    model_scale: f32,
    params: LodParams
) -> f32 {
    if (params.factor == 0.0) {
        return size;
    }

    if (model_scale != 1.0) {
        // When model is scaled, just apply factor directly
        return size * params.factor;
    }

    // Calculate distance from camera plane
    let distance = (dot(camera_plane.xyz, model_position) + camera_plane.w) / model_scale;
    let lod_factor = calculate_lod_factor(distance, params);

    return size * lod_factor;
}
`;
