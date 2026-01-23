/**
 * Copyright (c) 2025 mol* contributors, licensed under MIT, See LICENSE file for more info.
 *
 * @author Alexander Rose <alexander.rose@weirdbyte.de>
 */

/**
 * Common uniform structures for WGSL shaders.
 * These are organized into bind groups:
 * - Group 0: Per-frame uniforms (camera, lighting, time)
 * - Group 1: Per-material uniforms (colors, textures)
 * - Group 2: Per-object uniforms (transforms, IDs)
 */

export const frame_uniforms_wgsl = /* wgsl */`
// Per-frame uniforms (bind group 0)
struct FrameUniforms {
    // Camera matrices
    view: mat4x4<f32>,
    projection: mat4x4<f32>,
    view_projection: mat4x4<f32>,
    inv_view: mat4x4<f32>,
    inv_projection: mat4x4<f32>,
    inv_view_projection: mat4x4<f32>,

    // Camera properties
    camera_position: vec3<f32>,
    near: f32,
    far: f32,
    is_ortho: f32,
    fov_factor: f32,
    pixel_ratio: f32,

    // Viewport
    viewport: vec4<f32>, // x, y, width, height
    draw_buffer_size: vec2<f32>,

    // Time
    time: f32,
    _padding: f32,
}

@group(0) @binding(0) var<uniform> frame: FrameUniforms;
`;

export const light_uniforms_wgsl = /* wgsl */`
// Lighting uniforms (part of bind group 0)
struct LightUniforms {
    ambient: vec3<f32>,
    ambient_intensity: f32,

    light_direction: vec3<f32>,
    light_intensity: f32,

    light_color: vec3<f32>,
    _padding1: f32,

    // Additional light settings
    shininess: f32,
    metalness: f32,
    roughness: f32,
    reflectivity: f32,
}

@group(0) @binding(1) var<uniform> light: LightUniforms;
`;

export const material_uniforms_wgsl = /* wgsl */`
// Per-material uniforms (bind group 1)
struct MaterialUniforms {
    // Base color
    color: vec4<f32>,

    // Interior color (for hollow rendering)
    interior_color: vec4<f32>,

    // Material properties
    alpha: f32,
    metalness: f32,
    roughness: f32,
    emissive: f32,

    // Marker color for highlighting/selection
    marker_color: vec4<f32>,

    // Rendering flags
    double_sided: i32,
    flip_sided: i32,
    flat_shaded: i32,
    _padding: i32,
}

@group(1) @binding(0) var<uniform> material: MaterialUniforms;
`;

export const object_uniforms_wgsl = /* wgsl */`
// Per-object uniforms (bind group 2)
struct ObjectUniforms {
    // Transform matrices
    model: mat4x4<f32>,
    model_view: mat4x4<f32>,
    model_view_projection: mat4x4<f32>,
    inv_model_view: mat4x4<f32>,

    // Object identification
    object_id: u32,
    instance_id: u32,
    _padding1: u32,
    _padding2: u32,

    // Bounding box (for clipping)
    bbox_min: vec3<f32>,
    _padding3: f32,
    bbox_max: vec3<f32>,
    _padding4: f32,
}

@group(2) @binding(0) var<uniform> object: ObjectUniforms;
`;

export const picking_uniforms_wgsl = /* wgsl */`
// Picking uniforms (bind group 1 in pick variant)
struct PickingUniforms {
    object_id: u32,
    instance_granularity: u32,
    group_granularity: u32,
    _padding: u32,
}

@group(1) @binding(0) var<uniform> picking: PickingUniforms;
`;
