/**
 * Copyright (c) 2025 mol* contributors, licensed under MIT, See LICENSE file for more info.
 *
 * @author Alexander Rose <alexander.rose@weirdbyte.de>
 */

import { common_wgsl } from './chunks/common.wgsl';
import { frame_uniforms_wgsl, light_uniforms_wgsl, material_uniforms_wgsl, object_uniforms_wgsl } from './chunks/uniforms.wgsl';

/**
 * WGSL direct volume shader for raymarching volume rendering.
 * Renders volumetric data using ray-casting with transfer function and lighting.
 */

export const direct_volume_vert_wgsl = /* wgsl */`
${common_wgsl}

${frame_uniforms_wgsl}
${object_uniforms_wgsl}

// Direct volume uniforms
struct DirectVolumeVertUniforms {
    bbox_min: vec3<f32>,
    _padding1: f32,
    bbox_max: vec3<f32>,
    _padding2: f32,
    bbox_size: vec3<f32>,
    _padding3: f32,
    grid_dim: vec3<f32>,
    model_scale: f32,
    unit_to_cartn: mat4x4<f32>,
    invariant_bounding_sphere: vec4<f32>,
}

@group(2) @binding(1) var<uniform> volume: DirectVolumeVertUniforms;

// Instance data
struct InstanceData {
    transform: mat4x4<f32>,
    instance_id: f32,
}

@group(2) @binding(2) var<storage, read> instances: array<InstanceData>;

// Vertex input
struct VertexInput {
    @location(0) position: vec3<f32>,
    @builtin(instance_index) instance_index: u32,
}

// Vertex output
struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) v_model_position: vec3<f32>,
    @location(1) v_instance_id: f32,
    @location(2) v_bounding_sphere: vec4<f32>,
}

@vertex
fn main(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;

    // Get instance transform
    let instance = instances[input.instance_index];
    let instance_transform = instance.transform;

    // Calculate unit coordinate
    let unit_coord = vec4<f32>(input.position + vec3<f32>(0.5), 1.0);
    let mv_position = frame.view * object.model * instance_transform * volume.unit_to_cartn * unit_coord;

    // Model position
    output.v_model_position = (object.model * instance_transform * volume.unit_to_cartn * unit_coord).xyz;

    // Bounding sphere in model space
    output.v_bounding_sphere = vec4<f32>(
        (object.model * instance_transform * vec4<f32>(volume.invariant_bounding_sphere.xyz, 1.0)).xyz,
        volume.model_scale * volume.invariant_bounding_sphere.w
    );

    output.v_instance_id = instance.instance_id;

    // Calculate clip position
    output.position = frame.projection * mv_position;

    // Move z position to near clip plane (but not too close for precision)
    output.position.z = output.position.w - 0.01;

    return output;
}
`;

export const direct_volume_frag_color_wgsl = /* wgsl */`
${common_wgsl}

${frame_uniforms_wgsl}
${light_uniforms_wgsl}
${material_uniforms_wgsl}
${object_uniforms_wgsl}

// Direct volume fragment uniforms
struct DirectVolumeFragUniforms {
    bbox_min: vec3<f32>,
    _padding1: f32,
    bbox_max: vec3<f32>,
    _padding2: f32,
    bbox_size: vec3<f32>,
    _padding3: f32,
    grid_dim: vec3<f32>,
    max_steps: i32,
    cell_dim: vec3<f32>,
    step_scale: f32,
    jump_length: f32,
    transfer_scale: f32,
    model_scale: f32,
    use_lighting: i32,
    grid_tex_dim: vec3<f32>,
    grid_tex_type: i32, // 0 = 2D, 1 = 3D
    cartn_to_unit: mat4x4<f32>,
    unit_to_cartn: mat4x4<f32>,
}

@group(2) @binding(1) var<uniform> volume: DirectVolumeFragUniforms;

// Instance data
struct InstanceData {
    transform: mat4x4<f32>,
    instance_id: f32,
}

@group(2) @binding(2) var<storage, read> instances: array<InstanceData>;

// Textures
@group(2) @binding(3) var t_grid: texture_2d<f32>; // or texture_3d<f32> based on grid_tex_type
@group(2) @binding(4) var s_grid: sampler;
@group(2) @binding(5) var t_transfer: texture_2d<f32>;
@group(2) @binding(6) var s_transfer: sampler;
@group(2) @binding(7) var t_depth: texture_2d<f32>;
@group(2) @binding(8) var s_depth: sampler;

// Color texture (optional)
@group(2) @binding(9) var t_color: texture_2d<f32>;
@group(2) @binding(10) var s_color: sampler;

// Marker texture
@group(2) @binding(11) var t_marker: texture_2d<f32>;
@group(2) @binding(12) var s_marker: sampler;

// Fragment input
struct FragmentInput {
    @builtin(position) frag_coord: vec4<f32>,
    @builtin(front_facing) front_facing: bool,
    @location(0) v_model_position: vec3<f32>,
    @location(1) v_instance_id: f32,
    @location(2) v_bounding_sphere: vec4<f32>,
}

// Fragment output
struct FragmentOutput {
    @location(0) color: vec4<f32>,
}

// Sample volume data from 2D texture emulating 3D
fn sample_volume_2d(pos: vec3<f32>) -> vec4<f32> {
    // Adjust position for half-texel offset
    let adjusted_pos = pos + vec3<f32>(0.5, 0.5, 0.0) / volume.grid_dim;

    // Calculate 2D texture coordinates from 3D position
    let z = floor(adjusted_pos.z * volume.grid_dim.z);
    let columns = floor(volume.grid_tex_dim.x / volume.grid_dim.x);

    let col = z % columns;
    let row = floor(z / columns);

    let offset = vec2<f32>(col, row) * volume.grid_dim.xy;
    let uv = (adjusted_pos.xy * volume.grid_dim.xy + offset) / volume.grid_tex_dim.xy;

    return textureSample(t_grid, s_grid, uv);
}

// Linear interpolated volume sample
fn sample_volume(pos: vec3<f32>) -> vec4<f32> {
    return sample_volume_2d(pos);
}

// Nearest-neighbor volume sample for group data
fn sample_volume_nearest(pos: vec3<f32>) -> vec4<f32> {
    let grid_pos = floor(pos * volume.grid_dim + vec3<f32>(0.5));
    return sample_volume_2d(grid_pos / volume.grid_dim);
}

// Get transfer function value
fn transfer_function(value: f32) -> f32 {
    return textureSample(t_transfer, s_transfer, vec2<f32>(value, 0.0)).a;
}

// Calculate depth from view position
fn calc_depth(pos: vec3<f32>) -> f32 {
    let clip_zw = pos.z * frame.projection[2].zw + frame.projection[3].zw;
    return 0.5 + 0.5 * clip_zw.x / clip_zw.y;
}

// Get scene depth
fn get_depth(coords: vec2<f32>) -> f32 {
    let packed = textureSample(t_depth, s_depth, coords);
    return unpack_rgba_to_depth(packed);
}

// Transform with matrix and return xyz
fn v3m4(p: vec3<f32>, m: mat4x4<f32>) -> vec3<f32> {
    return (m * vec4<f32>(p, 1.0)).xyz;
}

// Calculate gradient using central differences
fn calc_gradient(pos: vec3<f32>, scale: vec3<f32>) -> vec3<f32> {
    let dx = vec3<f32>(scale.x, 0.0, 0.0);
    let dy = vec3<f32>(0.0, scale.y, 0.0);
    let dz = vec3<f32>(0.0, 0.0, scale.z);

    var gradient: vec3<f32>;
    gradient.x = sample_volume(pos - dx).a - sample_volume(pos + dx).a;
    gradient.y = sample_volume(pos - dy).a - sample_volume(pos + dy).a;
    gradient.z = sample_volume(pos - dz).a - sample_volume(pos + dz).a;

    return gradient;
}

// Main raymarching function
fn raymarch(
    start_loc: vec3<f32>,
    step: vec3<f32>,
    ray_dir: vec3<f32>,
    instance_transform: mat4x4<f32>,
    frag_coord: vec2<f32>,
    draw_buffer_size: vec2<f32>,
    bounding_sphere: vec4<f32>,
    instance_id: f32
) -> vec4<f32> {
    // Build matrices
    let model_view = frame.view * object.model;
    let normal_matrix = adjoint(model_view * instance_transform);
    let cartn_to_unit = volume.cartn_to_unit * inverse_mat4(instance_transform);
    let model_view_transform = model_view * instance_transform;

    let scale_vol = vec3<f32>(1.0) / volume.grid_dim;
    var pos = start_loc;
    var prev_value = -1.0;
    var value = 0.0;
    var src = vec4<f32>(0.0);
    var dst = vec4<f32>(0.0);

    let pos_min = vec3<f32>(0.0);
    let pos_max = vec3<f32>(1.0) - vec3<f32>(1.0) / volume.grid_dim;

    let grad_offset = 0.5;
    let dx = vec3<f32>(grad_offset * scale_vol.x, 0.0, 0.0);
    let dy = vec3<f32>(0.0, grad_offset * scale_vol.y, 0.0);
    let dz = vec3<f32>(0.0, 0.0, grad_offset * scale_vol.z);

    let max_dist = min(bounding_sphere.w * 2.0, frame.far - frame.near);
    let max_dist_sq = max_dist * max_dist;

    // Raymarching loop
    for (var i = 0; i < volume.max_steps; i++) {
        // Break when beyond bounding sphere or far plane
        let dist_vec = start_loc - pos;
        if (dot(dist_vec, dist_vec) > max_dist_sq) {
            break;
        }

        // Calculate unit position
        let unit_pos = v3m4(pos / volume.model_scale, cartn_to_unit);

        // Skip if outside grid
        if (unit_pos.x > pos_max.x || unit_pos.y > pos_max.y || unit_pos.z > pos_max.z ||
            unit_pos.x < pos_min.x || unit_pos.y < pos_min.y || unit_pos.z < pos_min.z) {
            prev_value = value;
            pos += step;
            continue;
        }

        // Sample volume
        let cell = sample_volume(unit_pos);
        value = cell.a;

        // Jump empty regions
        if (volume.jump_length > 0.0 && value < 0.01) {
            let next_pos = pos + ray_dir * volume.jump_length;
            let next_unit_pos = v3m4(next_pos / volume.model_scale, cartn_to_unit);
            let next_value = sample_volume(next_unit_pos).a;
            if (next_value < 0.01) {
                prev_value = next_value;
                pos = next_pos;
                continue;
            }
        }

        // Depth test
        let mv_position = model_view_transform * volume.unit_to_cartn * vec4<f32>(unit_pos * volume.grid_dim, 1.0);
        if (calc_depth(mv_position.xyz) > get_depth(frag_coord / draw_buffer_size)) {
            break;
        }

        // Get material color from transfer function
        var mat_color = vec4<f32>(material.color.rgb, transfer_function(value));

        // Apply lighting if enabled
        if (volume.use_lighting != 0 && mat_color.a >= 0.01) {
            // Compute gradient
            let gradient = calc_gradient(unit_pos, scale_vol * grad_offset);
            let normal = -normalize(normal_matrix * normalize(gradient));

            // Simple lighting
            let view_dir = normalize(-mv_position.xyz);
            let n_dot_l = max(dot(normal, light.light_direction), 0.0);

            let ambient = light.ambient * light.ambient_intensity;
            let diffuse = light.light_color * light.light_intensity * n_dot_l;

            mat_color = vec4<f32>(mat_color.rgb * (ambient + diffuse), mat_color.a);
        }

        // Apply alpha and transfer scale
        src = vec4<f32>(mat_color.rgb, mat_color.a * material.alpha * volume.transfer_scale);

        // Pre-multiply alpha
        src = vec4<f32>(src.rgb * src.a, src.a);

        // Blend
        dst = (1.0 - dst.a) * src + dst;

        // Early exit if opaque enough
        if (dst.a > 0.95) {
            break;
        }

        prev_value = value;
        pos += step;
    }

    return dst;
}

@fragment
fn main(input: FragmentInput) -> FragmentOutput {
    var output: FragmentOutput;

    // Discard front faces (we render the back faces of the volume box)
    if (input.front_facing) {
        discard;
    }

    // Get instance transform
    let instance_index = u32(input.v_instance_id);
    let instance = instances[instance_index];
    let instance_transform = instance.transform;

    // Calculate ray direction
    let is_ortho = frame.is_ortho;
    var ray_dir = mix(
        normalize(input.v_model_position - frame.camera_position),
        normalize(vec3<f32>(0.0, 0.0, -1.0) * mat3x3<f32>(frame.view[0].xyz, frame.view[1].xyz, frame.view[2].xyz)),
        is_ortho
    );

    let step = ray_dir * volume.step_scale * volume.model_scale;

    // Calculate start position
    let bounding_sphere_near = distance(input.v_bounding_sphere.xyz, frame.camera_position) - input.v_bounding_sphere.w;
    let d = max(frame.near, bounding_sphere_near) - mix(0.0, distance(input.v_model_position, frame.camera_position), is_ortho);
    let start = mix(frame.camera_position, input.v_model_position, is_ortho) + d * ray_dir;

    // Raymarch
    let result = raymarch(
        start,
        step,
        ray_dir,
        instance_transform,
        input.frag_coord.xy,
        frame.draw_buffer_size,
        input.v_bounding_sphere,
        input.v_instance_id
    );

    if (result.a < 0.001) {
        discard;
    }

    output.color = result;
    return output;
}
`;

export const direct_volume_frag_pick_wgsl = /* wgsl */`
${common_wgsl}

${frame_uniforms_wgsl}
${object_uniforms_wgsl}

// Picking uniforms
struct PickingUniforms {
    object_id: u32,
    instance_granularity: u32,
    group_granularity: u32,
    group_count: u32,
}

@group(1) @binding(0) var<uniform> picking: PickingUniforms;

// Direct volume fragment uniforms
struct DirectVolumeFragUniforms {
    bbox_min: vec3<f32>,
    _padding1: f32,
    bbox_max: vec3<f32>,
    _padding2: f32,
    bbox_size: vec3<f32>,
    _padding3: f32,
    grid_dim: vec3<f32>,
    max_steps: i32,
    cell_dim: vec3<f32>,
    step_scale: f32,
    jump_length: f32,
    transfer_scale: f32,
    model_scale: f32,
    use_lighting: i32,
    grid_tex_dim: vec3<f32>,
    grid_tex_type: i32,
    cartn_to_unit: mat4x4<f32>,
    unit_to_cartn: mat4x4<f32>,
}

@group(2) @binding(1) var<uniform> volume: DirectVolumeFragUniforms;

// Instance data
struct InstanceData {
    transform: mat4x4<f32>,
    instance_id: f32,
}

@group(2) @binding(2) var<storage, read> instances: array<InstanceData>;

// Textures
@group(2) @binding(3) var t_grid: texture_2d<f32>;
@group(2) @binding(4) var s_grid: sampler;
@group(2) @binding(5) var t_transfer: texture_2d<f32>;
@group(2) @binding(6) var s_transfer: sampler;

// Fragment input
struct FragmentInput {
    @builtin(position) frag_coord: vec4<f32>,
    @builtin(front_facing) front_facing: bool,
    @location(0) v_model_position: vec3<f32>,
    @location(1) v_instance_id: f32,
    @location(2) v_bounding_sphere: vec4<f32>,
}

// Pick output
struct PickOutput {
    @location(0) object: vec4<f32>,
    @location(1) instance: vec4<f32>,
    @location(2) group: vec4<f32>,
    @location(3) depth: vec4<f32>,
}

// Sample volume from 2D texture
fn sample_volume_2d(pos: vec3<f32>) -> vec4<f32> {
    let adjusted_pos = pos + vec3<f32>(0.5, 0.5, 0.0) / volume.grid_dim;
    let z = floor(adjusted_pos.z * volume.grid_dim.z);
    let columns = floor(volume.grid_tex_dim.x / volume.grid_dim.x);
    let col = z % columns;
    let row = floor(z / columns);
    let offset = vec2<f32>(col, row) * volume.grid_dim.xy;
    let uv = (adjusted_pos.xy * volume.grid_dim.xy + offset) / volume.grid_tex_dim.xy;
    return textureSample(t_grid, s_grid, uv);
}

fn transfer_function(value: f32) -> f32 {
    return textureSample(t_transfer, s_transfer, vec2<f32>(value, 0.0)).a;
}

fn v3m4(p: vec3<f32>, m: mat4x4<f32>) -> vec3<f32> {
    return (m * vec4<f32>(p, 1.0)).xyz;
}

@fragment
fn main(input: FragmentInput) -> PickOutput {
    var output: PickOutput;

    if (input.front_facing) {
        discard;
    }

    // For picking, we return the first voxel that has significant opacity
    let instance_index = u32(input.v_instance_id);
    let instance = instances[instance_index];
    let instance_transform = instance.transform;

    let cartn_to_unit = volume.cartn_to_unit * inverse_mat4(instance_transform);
    let unit_pos = v3m4(input.v_model_position / volume.model_scale, cartn_to_unit);

    // Check if inside grid
    let pos_min = vec3<f32>(0.0);
    let pos_max = vec3<f32>(1.0) - vec3<f32>(1.0) / volume.grid_dim;

    if (unit_pos.x > pos_max.x || unit_pos.y > pos_max.y || unit_pos.z > pos_max.z ||
        unit_pos.x < pos_min.x || unit_pos.y < pos_min.y || unit_pos.z < pos_min.z) {
        discard;
    }

    // Sample and check opacity
    let cell = sample_volume_2d(unit_pos);
    let alpha = transfer_function(cell.a);

    if (alpha < 0.01) {
        discard;
    }

    // Calculate group from grid position
    let g = floor(unit_pos * volume.grid_dim + vec3<f32>(0.5));
    let group = g.x + g.y * volume.grid_dim.x + g.z * volume.grid_dim.x * volume.grid_dim.y;

    // Pack outputs
    output.object = vec4<f32>(pack_int_to_rgb(f32(picking.object_id)), 1.0);
    output.instance = vec4<f32>(pack_int_to_rgb(input.v_instance_id), 1.0);
    output.group = vec4<f32>(pack_int_to_rgb(group), 1.0);
    output.depth = pack_depth_to_rgba(input.frag_coord.z);

    return output;
}
`;

export const direct_volume_frag_depth_wgsl = /* wgsl */`
${common_wgsl}

// Fragment input
struct FragmentInput {
    @builtin(position) frag_coord: vec4<f32>,
    @builtin(front_facing) front_facing: bool,
    @location(0) v_model_position: vec3<f32>,
    @location(1) v_instance_id: f32,
    @location(2) v_bounding_sphere: vec4<f32>,
}

struct FragmentOutput {
    @location(0) depth: vec4<f32>,
}

@fragment
fn main(input: FragmentInput) -> FragmentOutput {
    var output: FragmentOutput;

    if (input.front_facing) {
        discard;
    }

    // For depth pass, just output the depth of the volume bounding box
    output.depth = pack_depth_to_rgba(input.frag_coord.z);
    return output;
}
`;

/**
 * Combined direct volume shader module for different render variants.
 */
export const DirectVolumeShader = {
    vertex: direct_volume_vert_wgsl,
    fragment: {
        color: direct_volume_frag_color_wgsl,
        pick: direct_volume_frag_pick_wgsl,
        depth: direct_volume_frag_depth_wgsl,
    },
};
