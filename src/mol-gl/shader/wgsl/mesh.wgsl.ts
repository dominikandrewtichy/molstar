/**
 * Copyright (c) 2025 mol* contributors, licensed under MIT, See LICENSE file for more info.
 *
 * @author Alexander Rose <alexander.rose@weirdbyte.de>
 */

import { common_wgsl } from './chunks/common.wgsl';
import { frame_uniforms_wgsl, light_uniforms_wgsl, material_uniforms_wgsl, object_uniforms_wgsl } from './chunks/uniforms.wgsl';

/**
 * WGSL mesh shader for standard mesh rendering.
 * This is a proof-of-concept shader demonstrating the WGSL migration pattern.
 */

export const mesh_vert_wgsl = /* wgsl */`
${common_wgsl}

${frame_uniforms_wgsl}
${object_uniforms_wgsl}

// Vertex input
struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) group: f32,
    @builtin(instance_index) instance_index: u32,
    @builtin(vertex_index) vertex_index: u32,
}

// Instance data (per-instance attributes)
struct InstanceData {
    transform: mat4x4<f32>,
    instance_id: f32,
}

@group(2) @binding(1) var<storage, read> instances: array<InstanceData>;

// Vertex output
struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) v_normal: vec3<f32>,
    @location(1) v_view_position: vec3<f32>,
    @location(2) v_instance_id: f32,
    @location(3) v_group: f32,
}

@vertex
fn main(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;

    // Get instance transform
    let instance = instances[input.instance_index];
    let instance_transform = instance.transform;

    // World position
    let world_position = instance_transform * vec4<f32>(input.position, 1.0);

    // Model-view position
    let model_view = frame.view * object.model * instance_transform;
    let view_position = model_view * vec4<f32>(input.position, 1.0);

    // Final clip position
    output.position = frame.projection * view_position;

    // Transform normal using adjoint matrix for correct non-uniform scaling
    let normal_matrix = adjoint(model_view);
    var transformed_normal = normalize(normal_matrix * normalize(input.normal));

    output.v_normal = transformed_normal;
    output.v_view_position = view_position.xyz;
    output.v_instance_id = instance.instance_id;
    output.v_group = input.group;

    return output;
}
`;

export const mesh_frag_color_wgsl = /* wgsl */`
${common_wgsl}

${frame_uniforms_wgsl}
${light_uniforms_wgsl}
${material_uniforms_wgsl}

// Fragment input
struct FragmentInput {
    @builtin(position) frag_coord: vec4<f32>,
    @builtin(front_facing) front_facing: bool,
    @location(0) v_normal: vec3<f32>,
    @location(1) v_view_position: vec3<f32>,
    @location(2) v_instance_id: f32,
    @location(3) v_group: f32,
}

// Fragment output
struct FragmentOutput {
    @location(0) color: vec4<f32>,
}

// Lighting calculation
fn calculate_lighting(normal: vec3<f32>, view_dir: vec3<f32>, base_color: vec3<f32>) -> vec3<f32> {
    // Ambient
    let ambient = light.ambient * light.ambient_intensity * base_color;

    // Diffuse (Lambertian)
    let n_dot_l = max(dot(normal, light.light_direction), 0.0);
    let diffuse = light.light_color * light.light_intensity * n_dot_l * base_color;

    // Specular (Blinn-Phong)
    let half_dir = normalize(light.light_direction + view_dir);
    let n_dot_h = max(dot(normal, half_dir), 0.0);
    let spec_intensity = pow(n_dot_h, light.shininess);
    let specular = light.light_color * light.light_intensity * spec_intensity * light.reflectivity;

    return ambient + diffuse + specular;
}

@fragment
fn main(input: FragmentInput) -> FragmentOutput {
    var output: FragmentOutput;

    // Determine if this is an interior face
    let is_interior = !input.front_facing;

    // Calculate normal (flip for interior or if double-sided)
    var normal = -normalize(input.v_normal);
    if (material.double_sided != 0) {
        if (input.front_facing) {
            normal = -normal;
        }
    }
    if (material.flip_sided != 0) {
        normal = -normal;
    }

    // Flat shading: use derivatives to compute face normal
    if (material.flat_shaded != 0) {
        let fdx = dpdx(input.v_view_position);
        let fdy = dpdy(input.v_view_position);
        normal = -normalize(cross(fdx, fdy));
    }

    // Get base color
    var base_color = material.color;

    // Apply interior color if needed
    if (is_interior) {
        base_color = mix(base_color, material.interior_color, material.interior_color.a);
    }

    // View direction
    let view_dir = normalize(-input.v_view_position);

    // Calculate lighting
    let lit_color = calculate_lighting(normal, view_dir, base_color.rgb);

    // Apply emissive
    let emissive_color = base_color.rgb * material.emissive;
    let final_color = lit_color + emissive_color;

    output.color = vec4<f32>(final_color, base_color.a * material.alpha);

    return output;
}
`;

export const mesh_frag_pick_wgsl = /* wgsl */`
${common_wgsl}

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
    @location(0) v_normal: vec3<f32>,
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

    // Pack object ID
    output.object = vec4<f32>(pack_int_to_rgb(f32(picking.object_id)), 1.0);

    // Pack instance ID
    let instance_id = u32(input.v_instance_id);
    output.instance = vec4<f32>(pack_int_to_rgb(f32(instance_id)), 1.0);

    // Pack group
    output.group = vec4<f32>(pack_int_to_rgb(input.v_group), 1.0);

    // Pack depth
    output.depth = pack_depth_to_rgba(input.frag_coord.z);

    return output;
}
`;

export const mesh_frag_depth_wgsl = /* wgsl */`
// Depth-only fragment shader
struct FragmentInput {
    @builtin(position) frag_coord: vec4<f32>,
}

struct FragmentOutput {
    @location(0) depth: vec4<f32>,
}

const PackUpscale: f32 = 256.0 / 255.0;
const PackFactors: vec3<f32> = vec3<f32>(256.0 * 256.0 * 256.0, 256.0 * 256.0, 256.0);
const ShiftRight8: f32 = 1.0 / 256.0;

fn pack_depth_to_rgba(v: f32) -> vec4<f32> {
    var r = vec4<f32>(fract(v * PackFactors), v);
    r.y -= r.x * ShiftRight8;
    r.z -= r.y * ShiftRight8;
    r.w -= r.z * ShiftRight8;
    return r * PackUpscale;
}

@fragment
fn main(input: FragmentInput) -> FragmentOutput {
    var output: FragmentOutput;
    output.depth = pack_depth_to_rgba(input.frag_coord.z);
    return output;
}
`;

/**
 * Combined mesh shader module for different render variants.
 */
export const MeshShader = {
    vertex: mesh_vert_wgsl,
    fragment: {
        color: mesh_frag_color_wgsl,
        pick: mesh_frag_pick_wgsl,
        depth: mesh_frag_depth_wgsl,
    },
};
