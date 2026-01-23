/**
 * Copyright (c) 2025 mol* contributors, licensed under MIT, See LICENSE file for more info.
 *
 * @author Alexander Rose <alexander.rose@weirdbyte.de>
 *
 * WGSL port of WebGL lines shader, heavily based on code by WestLangley from
 * https://github.com/WestLangley/three.js/blob/af28b2fb706ac109771ecad0a7447fad90ab3210/examples/js/lines/LineMaterial.js
 */

import { common_wgsl } from './chunks/common.wgsl';
import { frame_uniforms_wgsl, material_uniforms_wgsl, object_uniforms_wgsl } from './chunks/uniforms.wgsl';

/**
 * WGSL lines shader for rendering line primitives with width.
 * Lines are rendered as screen-space quads with proper width calculation
 * in NDC space, similar to fat/wide lines.
 *
 * Each line segment is rendered as a quad (2 triangles = 6 vertices),
 * with vertices expanded perpendicular to the line direction in screen space.
 */

export const lines_vert_wgsl = /* wgsl */`
${common_wgsl}

${frame_uniforms_wgsl}
${object_uniforms_wgsl}

// Lines-specific uniforms
struct LinesUniforms {
    model_view: mat4x4<f32>,
    pixel_ratio: f32,
    line_size_attenuation: f32,
    model_scale: f32,
    _padding: f32,
    viewport: vec4<f32>,
    tex_dim: vec2<f32>,
    _padding2: vec2<f32>,
}

@group(2) @binding(1) var<uniform> lines: LinesUniforms;

// Start position texture
@group(2) @binding(2) var t_start: texture_2d<f32>;
@group(2) @binding(3) var s_start: sampler;

// End position texture
@group(2) @binding(4) var t_end: texture_2d<f32>;
@group(2) @binding(5) var s_end: sampler;

// Size/group texture
@group(2) @binding(6) var t_size_group: texture_2d<f32>;
@group(2) @binding(7) var s_size_group: sampler;

// Instance data
struct InstanceData {
    transform: mat4x4<f32>,
    instance_id: f32,
}

@group(2) @binding(8) var<storage, read> instances: array<InstanceData>;

// Vertex output
struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) v_model_position: vec3<f32>,
    @location(1) v_view_position: vec3<f32>,
    @location(2) v_instance_id: f32,
    @location(3) v_group: f32,
}

// Trim segment so it terminates between the camera plane and the near plane
fn trim_segment(start: vec4<f32>, end: ptr<function, vec4<f32>>) {
    // Conservative estimate of the near plane
    let a = frame.projection[2][2]; // 3rd entry in 3rd column
    let b = frame.projection[3][2]; // 3rd entry in 4th column
    let near_estimate = -0.5 * b / a;
    let alpha = (near_estimate - start.z) / ((*end).z - start.z);
    (*end) = vec4<f32>(mix(start.xyz, (*end).xyz, alpha), (*end).w);
}

@vertex
fn main(
    @builtin(vertex_index) vertex_index: u32,
    @builtin(instance_index) instance_index: u32
) -> VertexOutput {
    var output: VertexOutput;

    let aspect = lines.viewport.z / lines.viewport.w;

    // Calculate vertex within quad (6 vertices per line segment = 2 triangles)
    let v = vertex_index % 6u;

    // Mapping: x = perpendicular offset (-1 or 1), y = start(0) or end(1)
    var mapping: vec2<f32>;
    if (v == 0u) {
        mapping = vec2<f32>(-1.0, 0.0); // start, left
    } else if (v == 1u || v == 3u) {
        mapping = vec2<f32>(1.0, 0.0);  // start, right
    } else if (v == 2u || v == 4u) {
        mapping = vec2<f32>(-1.0, 1.0); // end, left
    } else { // v == 5u
        mapping = vec2<f32>(1.0, 1.0);  // end, right
    }

    // Get line data from textures
    let line_id = i32(vertex_index / 6u);
    let uv = vec2<f32>(
        f32(line_id % i32(lines.tex_dim.x)) + 0.5,
        f32(line_id / i32(lines.tex_dim.x)) + 0.5
    ) / lines.tex_dim;

    let start_data = textureSampleLevel(t_start, s_start, uv, 0.0);
    let end_data = textureSampleLevel(t_end, s_end, uv, 0.0);
    let size_group = textureSampleLevel(t_size_group, s_size_group, uv, 0.0);

    let line_start = start_data.xyz;
    let line_end = end_data.xyz;
    var size = size_group.r * lines.model_scale;
    if (size <= 0.0) {
        size = lines.model_scale;
    }
    let group = size_group.g;

    // Get instance data
    let instance = instances[instance_index];
    let instance_transform = instance.transform;
    let model_view = lines.model_view * instance_transform;

    // Transform to camera space
    var start_view = model_view * vec4<f32>(line_start, 1.0);
    var end_view = model_view * vec4<f32>(line_end, 1.0);

    // Assign position based on mapping
    let position = select(line_start, line_end, mapping.y > 0.5);
    let position4 = vec4<f32>(position, 1.0);
    let mv_position = model_view * position4;
    output.v_view_position = mv_position.xyz;
    output.v_model_position = (object.model * instance_transform * position4).xyz;

    // Handle perspective projection edge cases
    // Check if this is a perspective projection (4th entry in 3rd column == -1)
    let perspective = (frame.projection[2][3] == -1.0);
    if (perspective) {
        if (start_view.z < 0.0 && end_view.z >= 0.0) {
            trim_segment(start_view, &end_view);
        } else if (end_view.z < 0.0 && start_view.z >= 0.0) {
            trim_segment(end_view, &start_view);
        }
    }

    // Transform to clip space
    let clip_start = frame.projection * start_view;
    let clip_end = frame.projection * end_view;

    // Transform to NDC space
    let ndc_start = clip_start.xy / clip_start.w;
    let ndc_end = clip_end.xy / clip_end.w;

    // Direction in NDC space
    var dir = ndc_end - ndc_start;

    // Account for clip-space aspect ratio
    dir.x *= aspect;
    dir = normalize(dir);

    // Perpendicular offset
    var offset = vec2<f32>(dir.y, -dir.x);

    // Undo aspect ratio adjustment
    dir.x /= aspect;
    offset.x /= aspect;

    // Apply sign based on mapping
    offset *= mapping.x;

    // Calculate line width
    var linewidth: f32;
    if (lines.line_size_attenuation > 0.5) {
        // Size attenuation based on distance
        linewidth = size * lines.pixel_ratio * ((lines.viewport.w / 2.0) / -start_view.z) * 5.0;
    } else {
        // Constant size
        linewidth = size * lines.pixel_ratio;
    }
    linewidth = max(1.0, linewidth);

    // Adjust for line width
    offset *= linewidth;

    // Adjust for clip-space to screen-space conversion
    offset /= lines.viewport.w;

    // Select appropriate clip position based on start/end
    var clip = select(clip_start, clip_end, mapping.y > 0.5);

    // Convert offset back to clip space and apply
    offset *= clip.w;
    clip.x += offset.x;
    clip.y += offset.y;

    output.position = clip;
    output.v_instance_id = instance.instance_id;
    output.v_group = group;

    return output;
}
`;

export const lines_frag_color_wgsl = /* wgsl */`
${common_wgsl}

${frame_uniforms_wgsl}
${material_uniforms_wgsl}

// Fragment input
struct FragmentInput {
    @builtin(position) frag_coord: vec4<f32>,
    @location(0) v_model_position: vec3<f32>,
    @location(1) v_view_position: vec3<f32>,
    @location(2) v_instance_id: f32,
    @location(3) v_group: f32,
}

// Fragment output
struct FragmentOutput {
    @location(0) color: vec4<f32>,
}

@fragment
fn main(input: FragmentInput) -> FragmentOutput {
    var output: FragmentOutput;

    // Get base color
    var base_color = material.color;

    // Apply material alpha
    base_color.a *= material.alpha;

    output.color = base_color;

    return output;
}
`;

export const lines_frag_pick_wgsl = /* wgsl */`
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

// Fragment input
struct FragmentInput {
    @builtin(position) frag_coord: vec4<f32>,
    @location(0) v_model_position: vec3<f32>,
    @location(1) v_view_position: vec3<f32>,
    @location(2) v_instance_id: f32,
    @location(3) v_group: f32,
}

// Pick output - multiple render targets
struct PickOutput {
    @location(0) object: vec4<f32>,
    @location(1) instance: vec4<f32>,
    @location(2) group: vec4<f32>,
    @location(3) depth: vec4<f32>,
}

@fragment
fn main(input: FragmentInput) -> PickOutput {
    var output: PickOutput;

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

export const lines_frag_depth_wgsl = /* wgsl */`
${common_wgsl}

${frame_uniforms_wgsl}

// Fragment input
struct FragmentInput {
    @builtin(position) frag_coord: vec4<f32>,
    @location(0) v_model_position: vec3<f32>,
    @location(1) v_view_position: vec3<f32>,
    @location(2) v_instance_id: f32,
    @location(3) v_group: f32,
}

struct FragmentOutput {
    @location(0) depth: vec4<f32>,
}

@fragment
fn main(input: FragmentInput) -> FragmentOutput {
    var output: FragmentOutput;

    let fragment_depth = input.frag_coord.z;
    output.depth = pack_depth_to_rgba(fragment_depth);

    return output;
}
`;

/**
 * Combined lines shader module for different render variants.
 */
export const LinesShader = {
    vertex: lines_vert_wgsl,
    fragment: {
        color: lines_frag_color_wgsl,
        pick: lines_frag_pick_wgsl,
        depth: lines_frag_depth_wgsl,
    },
};
