/**
 * Copyright (c) 2025 mol* contributors, licensed under MIT, See LICENSE file for more info.
 *
 * @author Alexander Rose <alexander.rose@weirdbyte.de>
 */

import { common_wgsl } from './chunks/common.wgsl';
import { frame_uniforms_wgsl, material_uniforms_wgsl, object_uniforms_wgsl } from './chunks/uniforms.wgsl';

/**
 * WGSL points shader for rendering point primitives.
 * Points are rendered as screen-aligned quads since WebGPU doesn't have
 * native point size support like WebGL.
 *
 * Point styles:
 *   - square: default, full quad
 *   - circle: discard fragments outside circular region
 *   - fuzzy: smooth falloff from center
 */

export const points_vert_wgsl = /* wgsl */`
${common_wgsl}

${frame_uniforms_wgsl}
${object_uniforms_wgsl}

// Points-specific uniforms
struct PointsUniforms {
    model_view: mat4x4<f32>,
    pixel_ratio: f32,
    point_size_attenuation: f32,
    model_scale: f32,
    _padding: f32,
    viewport: vec4<f32>,
    tex_dim: vec2<f32>,
    _padding2: vec2<f32>,
}

@group(2) @binding(1) var<uniform> points: PointsUniforms;

// Position and group texture
@group(2) @binding(2) var t_position_group: texture_2d<f32>;
@group(2) @binding(3) var s_position_group: sampler;

// Size texture (optional)
@group(2) @binding(4) var t_size: texture_2d<f32>;
@group(2) @binding(5) var s_size: sampler;

// Instance data
struct InstanceData {
    transform: mat4x4<f32>,
    instance_id: f32,
}

@group(2) @binding(6) var<storage, read> instances: array<InstanceData>;

// Vertex output
struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) v_point_coord: vec2<f32>,
    @location(1) v_model_position: vec3<f32>,
    @location(2) v_view_position: vec3<f32>,
    @location(3) v_instance_id: f32,
    @location(4) v_group: f32,
    @location(5) v_size: f32,
}

@vertex
fn main(
    @builtin(vertex_index) vertex_index: u32,
    @builtin(instance_index) instance_index: u32
) -> VertexOutput {
    var output: VertexOutput;

    // Calculate mapping for quad vertex (2 triangles = 6 vertices per point)
    let m = vertex_index % 6u;
    var mapping = vec2<f32>(1.0, 1.0); // vertices 2 and 5
    if (m == 0u) {
        mapping = vec2<f32>(-1.0, 1.0);
    } else if (m == 1u || m == 3u) {
        mapping = vec2<f32>(-1.0, -1.0);
    } else if (m == 4u) {
        mapping = vec2<f32>(1.0, -1.0);
    }

    // Convert mapping to point coord (0 to 1 range)
    output.v_point_coord = mapping * 0.5 + 0.5;

    // Get point data from texture
    let point_id = i32(vertex_index / 6u);
    let uv = vec2<f32>(
        f32(point_id % i32(points.tex_dim.x)) + 0.5,
        f32(point_id / i32(points.tex_dim.x)) + 0.5
    ) / points.tex_dim;

    let position_group = textureSampleLevel(t_position_group, s_position_group, uv, 0.0);
    let position = position_group.xyz;
    let group = position_group.w;

    // Get size from texture or use default
    let size_data = textureSampleLevel(t_size, s_size, uv, 0.0);
    var size = size_data.r * points.model_scale;
    if (size <= 0.0) {
        size = points.model_scale;
    }
    output.v_size = size;

    // Get instance data
    let instance = instances[instance_index];
    let instance_transform = instance.transform;

    // Transform position to world and view space
    let model_position = (object.model * instance_transform * vec4<f32>(position, 1.0)).xyz;
    output.v_model_position = model_position;

    let mv_position = points.model_view * instance_transform * vec4<f32>(position, 1.0);
    output.v_view_position = mv_position.xyz;

    // Calculate point size in pixels
    var point_size: f32;
    if (points.point_size_attenuation > 0.5) {
        // Size attenuation based on distance (perspective)
        point_size = size * points.pixel_ratio * ((points.viewport.w / 2.0) / -mv_position.z) * 5.0;
    } else {
        // Constant size
        point_size = size * points.pixel_ratio;
    }
    point_size = max(1.0, point_size);

    // Calculate clip position and offset by point size
    let clip_position = frame.projection * mv_position;

    // Convert point size to clip space offset
    let pixel_size = vec2<f32>(
        2.0 * point_size / points.viewport.z,
        2.0 * point_size / points.viewport.w
    );

    var final_position = clip_position;
    final_position.x += mapping.x * pixel_size.x * 0.5 * clip_position.w;
    final_position.y += mapping.y * pixel_size.y * 0.5 * clip_position.w;

    output.position = final_position;
    output.v_instance_id = instance.instance_id;
    output.v_group = group;

    return output;
}
`;

export const points_frag_color_wgsl = /* wgsl */`
${common_wgsl}

${frame_uniforms_wgsl}
${material_uniforms_wgsl}

// Points fragment uniforms
struct PointsFragUniforms {
    point_style: u32,  // 0 = square, 1 = circle, 2 = fuzzy
    _padding: vec3<u32>,
}

@group(2) @binding(0) var<uniform> points_frag: PointsFragUniforms;

// Fragment input
struct FragmentInput {
    @builtin(position) frag_coord: vec4<f32>,
    @location(0) v_point_coord: vec2<f32>,
    @location(1) v_model_position: vec3<f32>,
    @location(2) v_view_position: vec3<f32>,
    @location(3) v_instance_id: f32,
    @location(4) v_group: f32,
    @location(5) v_size: f32,
}

// Fragment output
struct FragmentOutput {
    @location(0) color: vec4<f32>,
}

const CENTER: vec2<f32> = vec2<f32>(0.5, 0.5);
const RADIUS: f32 = 0.5;

@fragment
fn main(input: FragmentInput) -> FragmentOutput {
    var output: FragmentOutput;

    let dist = distance(input.v_point_coord, CENTER);
    var alpha_multiplier = 1.0;

    // Point style handling
    if (points_frag.point_style == 1u) {
        // Circle style
        if (dist > RADIUS) {
            discard;
        }
    } else if (points_frag.point_style == 2u) {
        // Fuzzy style
        alpha_multiplier = 1.0 - smoothstep(0.0, RADIUS, dist);
        if (alpha_multiplier < 0.0001) {
            discard;
        }
    }
    // Style 0 (square) = no modification

    // Get base color
    var base_color = material.color;
    base_color.a *= alpha_multiplier;

    // Apply material alpha
    base_color.a *= material.alpha;

    output.color = base_color;

    return output;
}
`;

export const points_frag_pick_wgsl = /* wgsl */`
${common_wgsl}

${frame_uniforms_wgsl}

// Picking uniforms
struct PickingUniforms {
    object_id: u32,
    instance_granularity: u32,
    group_granularity: u32,
    _padding: u32,
}

@group(1) @binding(0) var<uniform> picking: PickingUniforms;

// Points fragment uniforms for picking
struct PointsFragUniforms {
    point_style: u32,
    _padding: vec3<u32>,
}

@group(2) @binding(0) var<uniform> points_frag: PointsFragUniforms;

// Fragment input
struct FragmentInput {
    @builtin(position) frag_coord: vec4<f32>,
    @location(0) v_point_coord: vec2<f32>,
    @location(1) v_model_position: vec3<f32>,
    @location(2) v_view_position: vec3<f32>,
    @location(3) v_instance_id: f32,
    @location(4) v_group: f32,
    @location(5) v_size: f32,
}

// Pick output - multiple render targets
struct PickOutput {
    @location(0) object: vec4<f32>,
    @location(1) instance: vec4<f32>,
    @location(2) group: vec4<f32>,
    @location(3) depth: vec4<f32>,
}

const CENTER: vec2<f32> = vec2<f32>(0.5, 0.5);
const RADIUS: f32 = 0.5;

@fragment
fn main(input: FragmentInput) -> PickOutput {
    var output: PickOutput;

    // Apply point style clipping
    if (points_frag.point_style == 1u || points_frag.point_style == 2u) {
        let dist = distance(input.v_point_coord, CENTER);
        if (dist > RADIUS) {
            discard;
        }
    }

    let fragment_depth = input.frag_coord.z;

    // Pack object ID
    output.object = vec4<f32>(pack_int_to_rgb(f32(picking.object_id)), 1.0);

    // Pack instance ID
    output.instance = vec4<f32>(pack_int_to_rgb(input.v_instance_id), 1.0);

    // Pack group
    output.group = vec4<f32>(pack_int_to_rgb(input.v_group), 1.0);

    // Pack depth
    output.depth = pack_depth_to_rgba(fragment_depth);

    return output;
}
`;

export const points_frag_depth_wgsl = /* wgsl */`
${common_wgsl}

${frame_uniforms_wgsl}

// Points fragment uniforms for depth
struct PointsFragUniforms {
    point_style: u32,
    _padding: vec3<u32>,
}

@group(2) @binding(0) var<uniform> points_frag: PointsFragUniforms;

// Fragment input
struct FragmentInput {
    @builtin(position) frag_coord: vec4<f32>,
    @location(0) v_point_coord: vec2<f32>,
    @location(1) v_model_position: vec3<f32>,
    @location(2) v_view_position: vec3<f32>,
    @location(3) v_instance_id: f32,
    @location(4) v_group: f32,
    @location(5) v_size: f32,
}

struct FragmentOutput {
    @location(0) depth: vec4<f32>,
}

const CENTER: vec2<f32> = vec2<f32>(0.5, 0.5);
const RADIUS: f32 = 0.5;

@fragment
fn main(input: FragmentInput) -> FragmentOutput {
    var output: FragmentOutput;

    // Apply point style clipping
    if (points_frag.point_style == 1u || points_frag.point_style == 2u) {
        let dist = distance(input.v_point_coord, CENTER);
        if (dist > RADIUS) {
            discard;
        }
    }

    let fragment_depth = input.frag_coord.z;
    output.depth = pack_depth_to_rgba(fragment_depth);

    return output;
}
`;

/**
 * Combined points shader module for different render variants.
 */
export const PointsShader = {
    vertex: points_vert_wgsl,
    fragment: {
        color: points_frag_color_wgsl,
        pick: points_frag_pick_wgsl,
        depth: points_frag_depth_wgsl,
    },
};
