/**
 * Copyright (c) 2025 mol* contributors, licensed under MIT, See LICENSE file for more info.
 *
 * @author Alexander Rose <alexander.rose@weirdbyte.de>
 */

import { common_wgsl } from './chunks/common.wgsl';
import { frame_uniforms_wgsl, light_uniforms_wgsl, material_uniforms_wgsl, object_uniforms_wgsl } from './chunks/uniforms.wgsl';

/**
 * WGSL spheres shader for ray-cast impostor rendering.
 * Spheres are rendered as screen-aligned quads with ray-sphere intersection
 * computed in the fragment shader.
 */

export const spheres_vert_wgsl = /* wgsl */`
${common_wgsl}

${frame_uniforms_wgsl}
${object_uniforms_wgsl}

// Spheres-specific uniforms
struct SpheresUniforms {
    model_view: mat4x4<f32>,
    inv_projection: mat4x4<f32>,
    is_ortho: f32,
    is_asymmetric_projection: bool,
    model_scale: f32,
    _padding: f32,
    tex_dim: vec2<f32>,
    _padding2: vec2<f32>,
    // LOD parameters
    lod_near: f32,
    lod_far: f32,
    lod_fade: f32,
    lod_factor: f32,
    // Camera plane for LOD
    camera_plane: vec4<f32>,
}

@group(2) @binding(1) var<uniform> spheres: SpheresUniforms;

// Position and group texture
@group(2) @binding(2) var t_position_group: texture_2d<f32>;
@group(2) @binding(3) var s_position_group: sampler;

// Instance data
struct InstanceData {
    transform: mat4x4<f32>,
    instance_id: f32,
}

@group(2) @binding(4) var<storage, read> instances: array<InstanceData>;

// Vertex output
struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) v_radius: f32,
    @location(1) v_point: vec3<f32>,
    @location(2) v_point_view_position: vec3<f32>,
    @location(3) v_instance_id: f32,
    @location(4) v_group: f32,
    @location(5) v_model_position: vec3<f32>,
}

// Constant for quadratic projection
const D: mat4x4<f32> = mat4x4<f32>(
    vec4<f32>(1.0, 0.0, 0.0, 0.0),
    vec4<f32>(0.0, 1.0, 0.0, 0.0),
    vec4<f32>(0.0, 0.0, 1.0, 0.0),
    vec4<f32>(0.0, 0.0, 0.0, -1.0)
);

/**
 * Bounding rectangle of a clipped, perspective-projected 3D Sphere.
 * Michael Mara, Morgan McGuire. 2013
 *
 * Specialization by Arseny Kapoulkine, MIT License Copyright (c) 2018
 * https://github.com/zeux/niagara
 *
 * Only works for symmetric projections.
 */
fn sphere_projection(p: vec3<f32>, r: f32, mapping: vec2<f32>, clip_w: f32) -> vec2<f32> {
    let pr = p * r;
    let pzr2 = p.z * p.z - r * r;

    let vx = sqrt(p.x * p.x + pzr2);
    let minx = ((vx * p.x - pr.z) / (vx * p.z + pr.x)) * frame.projection[0][0];
    let maxx = ((vx * p.x + pr.z) / (vx * p.z - pr.x)) * frame.projection[0][0];

    let vy = sqrt(p.y * p.y + pzr2);
    let miny = ((vy * p.y - pr.z) / (vy * p.z + pr.y)) * frame.projection[1][1];
    let maxy = ((vy * p.y + pr.z) / (vy * p.z - pr.y)) * frame.projection[1][1];

    var result = vec2<f32>(maxx + minx, maxy + miny) * -0.5;
    result -= mapping * vec2<f32>(maxx - minx, maxy - miny) * 0.5;
    result *= clip_w;
    return result;
}

/**
 * Compute point size and center using the technique described in:
 * "GPU-Based Ray-Casting of Quadratic Surfaces" http://dl.acm.org/citation.cfm?id=2386396
 * by Christian Sigg, Tim Weyrich, Mario Botsch, Markus Gross.
 */
fn quadratic_projection(
    position: vec3<f32>,
    radius: f32,
    mapping: vec2<f32>,
    transform: mat4x4<f32>,
    clip_w: f32
) -> vec2<f32> {
    let T = mat4x4<f32>(
        vec4<f32>(radius, 0.0, 0.0, 0.0),
        vec4<f32>(0.0, radius, 0.0, 0.0),
        vec4<f32>(0.0, 0.0, radius, 0.0),
        vec4<f32>(position.x, position.y, position.z, 1.0)
    );

    let R = transpose(frame.projection * spheres.model_view * transform * T);

    var A = dot(R[3], D * R[3]);
    var B = -2.0 * dot(R[0], D * R[3]);
    var C = dot(R[0], D * R[0]);
    let xbc_0 = (-B - sqrt(B * B - 4.0 * A * C)) / (2.0 * A);
    let xbc_1 = (-B + sqrt(B * B - 4.0 * A * C)) / (2.0 * A);
    let sx = abs(xbc_0 - xbc_1) * 0.5;

    A = dot(R[3], D * R[3]);
    B = -2.0 * dot(R[1], D * R[3]);
    C = dot(R[1], D * R[1]);
    let ybc_0 = (-B - sqrt(B * B - 4.0 * A * C)) / (2.0 * A);
    let ybc_1 = (-B + sqrt(B * B - 4.0 * A * C)) / (2.0 * A);
    let sy = abs(ybc_0 - ybc_1) * 0.5;

    var result = vec2<f32>(0.5 * (xbc_0 + xbc_1), 0.5 * (ybc_0 + ybc_1));
    result -= mapping * vec2<f32>(sx, sy);
    result *= clip_w;
    return result;
}

@vertex
fn main(
    @builtin(vertex_index) vertex_index: u32,
    @builtin(instance_index) instance_index: u32
) -> VertexOutput {
    var output: VertexOutput;

    // Calculate mapping for quad vertex (2 triangles = 6 vertices per sphere)
    let m = vertex_index % 6u;
    var mapping = vec2<f32>(1.0, 1.0); // vertices 2 and 5
    if (m == 0u) {
        mapping = vec2<f32>(-1.0, 1.0);
    } else if (m == 1u || m == 3u) {
        mapping = vec2<f32>(-1.0, -1.0);
    } else if (m == 4u) {
        mapping = vec2<f32>(1.0, -1.0);
    }

    // Get sphere data from texture
    let vertex_id = i32(vertex_index / 6u);
    let uv = vec2<f32>(
        f32(vertex_id % i32(spheres.tex_dim.x)) + 0.5,
        f32(vertex_id / i32(spheres.tex_dim.x)) + 0.5
    ) / spheres.tex_dim;
    let position_group = textureSampleLevel(t_position_group, s_position_group, uv, 0.0);
    let position = position_group.xyz;
    let group = position_group.a;

    // Get instance data
    let instance = instances[instance_index];
    let instance_transform = instance.transform;

    // Calculate radius with size (assuming uniform size for now)
    var radius = spheres.model_scale;

    // Apply LOD
    let model_position = (object.model * instance_transform * vec4<f32>(position, 1.0)).xyz;
    output.v_model_position = model_position;

    if (spheres.lod_factor != 0.0 && (spheres.lod_near != 0.0 || spheres.lod_far != 0.0)) {
        if (spheres.model_scale != 1.0) {
            radius *= spheres.lod_factor;
        } else {
            let d = (dot(spheres.camera_plane.xyz, model_position) + spheres.camera_plane.w) / spheres.model_scale;
            let f = min(
                smoothstep(spheres.lod_near, spheres.lod_near + spheres.lod_fade, d),
                1.0 - smoothstep(spheres.lod_far - spheres.lod_fade, spheres.lod_far, d)
            ) * spheres.lod_factor;
            radius *= f;
        }
    }

    output.v_radius = radius;

    // Calculate positions
    let position4 = vec4<f32>(position, 1.0);
    let mv_position = spheres.model_view * instance_transform * position4;

    // Calculate clip position
    var clip_position = frame.projection * vec4<f32>(mv_position.xyz, 1.0);

    // Apply sphere projection for tight bounding quad
    if (spheres.is_ortho == 1.0) {
        // Orthographic: simple offset
        var mv_corner = vec4<f32>(mv_position.xyz, 1.0);
        mv_corner.x += mapping.x * radius;
        mv_corner.y += mapping.y * radius;
        clip_position = frame.projection * mv_corner;
    } else if (spheres.is_asymmetric_projection) {
        clip_position.x = quadratic_projection(position, radius / spheres.model_scale, mapping, instance_transform, clip_position.w).x;
        clip_position.y = quadratic_projection(position, radius / spheres.model_scale, mapping, instance_transform, clip_position.w).y;
    } else {
        let proj_xy = sphere_projection(mv_position.xyz, radius, mapping, clip_position.w);
        clip_position.x = proj_xy.x;
        clip_position.y = proj_xy.y;
    }

    // Calculate ray intersection helper values
    let v_point4 = spheres.inv_projection * clip_position;
    output.v_point = v_point4.xyz / v_point4.w;
    output.v_point_view_position = -mv_position.xyz / mv_position.w;

    // Avoid near-plane clipping
    if (clip_position.z < -clip_position.w) {
        var adjusted_mv = mv_position;
        adjusted_mv.z -= 2.0 * radius;
        clip_position.z = (frame.projection * vec4<f32>(adjusted_mv.xyz, 1.0)).z;
    }

    // LOD culling
    if (spheres.model_scale == 1.0) {
        if (spheres.lod_factor != 0.0 && (spheres.lod_near != 0.0 || spheres.lod_far != 0.0)) {
            let d = (dot(spheres.camera_plane.xyz, model_position) + spheres.camera_plane.w) / spheres.model_scale;
            if (d < spheres.lod_near || d > spheres.lod_far) {
                // Move out of clip space to discard
                clip_position.z = 2.0 * clip_position.w;
            }
        }
    }

    output.position = clip_position;
    output.v_instance_id = instance.instance_id;
    output.v_group = group;

    return output;
}
`;

export const spheres_frag_color_wgsl = /* wgsl */`
${common_wgsl}

${frame_uniforms_wgsl}
${light_uniforms_wgsl}
${material_uniforms_wgsl}

// Spheres fragment uniforms
struct SpheresFragUniforms {
    inv_view: mat4x4<f32>,
    is_ortho: f32,
    alpha_thickness: f32,
    model_scale: f32,
    double_sided: bool,
}

@group(2) @binding(0) var<uniform> spheres_frag: SpheresFragUniforms;

// Fragment input
struct FragmentInput {
    @builtin(position) frag_coord: vec4<f32>,
    @builtin(front_facing) front_facing: bool,
    @location(0) v_radius: f32,
    @location(1) v_point: vec3<f32>,
    @location(2) v_point_view_position: vec3<f32>,
    @location(3) v_instance_id: f32,
    @location(4) v_group: f32,
    @location(5) v_model_position: vec3<f32>,
}

// Fragment output
struct FragmentOutput {
    @location(0) color: vec4<f32>,
    @builtin(frag_depth) depth: f32,
}

// Ray-sphere intersection
// Returns (hit, camera_pos, camera_normal, interior, fragment_depth)
fn sphere_impostor(
    point_view_position: vec3<f32>,
    point: vec3<f32>,
    radius: f32,
    is_ortho: f32,
    inv_view: mat4x4<f32>,
    double_sided: bool,
    near: f32
) -> array<vec4<f32>, 2> {
    // Result: [0] = (hit, interior, fragment_depth, _), [1] = (camera_pos.xyz, _)
    // We'll encode camera_normal in a third output or use varyings

    let camera_sphere_pos = -point_view_position;

    let ray_origin = mix(vec3<f32>(0.0, 0.0, 0.0), point, is_ortho);
    let ray_direction = mix(normalize(point), vec3<f32>(0.0, 0.0, 1.0), is_ortho);
    let camera_sphere_dir = mix(camera_sphere_pos, ray_origin - camera_sphere_pos, is_ortho);

    let B = dot(ray_direction, camera_sphere_dir);
    let det = B * B + radius * radius - dot(camera_sphere_dir, camera_sphere_dir);

    if (det < 0.0) {
        // No hit
        return array<vec4<f32>, 2>(
            vec4<f32>(0.0, 0.0, -1.0, 0.0),
            vec4<f32>(0.0)
        );
    }

    let sqrt_det = sqrt(det);
    let pos_t = mix(B + sqrt_det, B - sqrt_det, is_ortho);
    let neg_t = mix(B - sqrt_det, B + sqrt_det, is_ortho);

    var camera_pos = ray_direction * neg_t + ray_origin;
    var fragment_depth = calc_depth(camera_pos, near, frame.far);

    if (fragment_depth > 0.0) {
        // Front face hit
        return array<vec4<f32>, 2>(
            vec4<f32>(1.0, 0.0, fragment_depth, 0.0),
            vec4<f32>(camera_pos, 0.0)
        );
    } else if (double_sided) {
        // Back face hit (interior)
        camera_pos = ray_direction * pos_t + ray_origin;
        fragment_depth = calc_depth(camera_pos, near, frame.far);

        if (fragment_depth > 0.0) {
            return array<vec4<f32>, 2>(
                vec4<f32>(1.0, 1.0, fragment_depth, 0.0),
                vec4<f32>(camera_pos, 0.0)
            );
        }
    }

    // No valid hit
    return array<vec4<f32>, 2>(
        vec4<f32>(0.0, 0.0, -1.0, 0.0),
        vec4<f32>(0.0)
    );
}

// Calculate fragment depth from camera position
fn calc_depth(camera_pos: vec3<f32>, near: f32, far: f32) -> f32 {
    // WebGPU uses [0, 1] depth range
    let clip_pos = frame.projection * vec4<f32>(camera_pos, 1.0);
    return clip_pos.z / clip_pos.w;
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

    // Perform ray-sphere intersection
    let result = sphere_impostor(
        input.v_point_view_position,
        input.v_point,
        input.v_radius,
        spheres_frag.is_ortho,
        spheres_frag.inv_view,
        spheres_frag.double_sided,
        frame.near
    );

    let hit = result[0].x > 0.5;
    let is_interior = result[0].y > 0.5;
    let fragment_depth = result[0].z;
    let camera_pos = result[1].xyz;

    if (!hit) {
        discard;
    }

    if (fragment_depth < 0.0 || fragment_depth > 1.0) {
        discard;
    }

    output.depth = fragment_depth;

    // Calculate normal
    let camera_sphere_pos = -input.v_point_view_position;
    var camera_normal = normalize(camera_pos - camera_sphere_pos);
    if (is_interior) {
        camera_normal = -camera_normal;
    }

    // Get model position
    let model_pos = (spheres_frag.inv_view * vec4<f32>(camera_pos, 1.0)).xyz;
    let view_position = camera_pos;

    // Normal in view space (flip for fragment shader convention)
    let normal = -camera_normal;

    // Get base color
    var base_color = material.color;

    // Apply interior color if needed
    if (is_interior) {
        base_color = mix(base_color, material.interior_color, material.interior_color.a);
    }

    // View direction
    let view_dir = normalize(-view_position);

    // Calculate lighting
    let lit_color = calculate_lighting(normal, view_dir, base_color.rgb);

    // Apply emissive
    let emissive_color = base_color.rgb * material.emissive;
    let final_color = lit_color + emissive_color;

    output.color = vec4<f32>(final_color, base_color.a * material.alpha);

    return output;
}
`;

export const spheres_frag_pick_wgsl = /* wgsl */`
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

// Spheres fragment uniforms for picking
struct SpheresFragUniforms {
    inv_view: mat4x4<f32>,
    is_ortho: f32,
    alpha_thickness: f32,
    model_scale: f32,
    double_sided: bool,
}

@group(2) @binding(0) var<uniform> spheres_frag: SpheresFragUniforms;

// Fragment input
struct FragmentInput {
    @builtin(position) frag_coord: vec4<f32>,
    @location(0) v_radius: f32,
    @location(1) v_point: vec3<f32>,
    @location(2) v_point_view_position: vec3<f32>,
    @location(3) v_instance_id: f32,
    @location(4) v_group: f32,
    @location(5) v_model_position: vec3<f32>,
}

// Pick output - multiple render targets
struct PickOutput {
    @location(0) object: vec4<f32>,
    @location(1) instance: vec4<f32>,
    @location(2) group: vec4<f32>,
    @location(3) depth: vec4<f32>,
    @builtin(frag_depth) frag_depth: f32,
}

// Simplified ray-sphere for picking (same as color but without lighting)
fn sphere_impostor_pick(
    point_view_position: vec3<f32>,
    point: vec3<f32>,
    radius: f32,
    is_ortho: f32,
    near: f32,
    far: f32
) -> vec2<f32> {
    // Returns (hit, fragment_depth)
    let camera_sphere_pos = -point_view_position;

    let ray_origin = mix(vec3<f32>(0.0, 0.0, 0.0), point, is_ortho);
    let ray_direction = mix(normalize(point), vec3<f32>(0.0, 0.0, 1.0), is_ortho);
    let camera_sphere_dir = mix(camera_sphere_pos, ray_origin - camera_sphere_pos, is_ortho);

    let B = dot(ray_direction, camera_sphere_dir);
    let det = B * B + radius * radius - dot(camera_sphere_dir, camera_sphere_dir);

    if (det < 0.0) {
        return vec2<f32>(0.0, -1.0);
    }

    let sqrt_det = sqrt(det);
    let neg_t = mix(B - sqrt_det, B + sqrt_det, is_ortho);

    let camera_pos = ray_direction * neg_t + ray_origin;
    let clip_pos = frame.projection * vec4<f32>(camera_pos, 1.0);
    let fragment_depth = clip_pos.z / clip_pos.w;

    if (fragment_depth > 0.0 && fragment_depth < 1.0) {
        return vec2<f32>(1.0, fragment_depth);
    }

    // Try back face
    let pos_t = mix(B + sqrt_det, B - sqrt_det, is_ortho);
    let camera_pos_back = ray_direction * pos_t + ray_origin;
    let clip_pos_back = frame.projection * vec4<f32>(camera_pos_back, 1.0);
    let fragment_depth_back = clip_pos_back.z / clip_pos_back.w;

    if (fragment_depth_back > 0.0 && fragment_depth_back < 1.0) {
        return vec2<f32>(1.0, fragment_depth_back);
    }

    return vec2<f32>(0.0, -1.0);
}

@fragment
fn main(input: FragmentInput) -> PickOutput {
    var output: PickOutput;

    // Perform ray-sphere intersection
    let result = sphere_impostor_pick(
        input.v_point_view_position,
        input.v_point,
        input.v_radius,
        spheres_frag.is_ortho,
        frame.near,
        frame.far
    );

    if (result.x < 0.5 || result.y < 0.0 || result.y > 1.0) {
        discard;
    }

    let fragment_depth = result.y;
    output.frag_depth = fragment_depth;

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

export const spheres_frag_depth_wgsl = /* wgsl */`
${common_wgsl}

${frame_uniforms_wgsl}

// Spheres fragment uniforms for depth
struct SpheresFragUniforms {
    inv_view: mat4x4<f32>,
    is_ortho: f32,
    alpha_thickness: f32,
    model_scale: f32,
    double_sided: bool,
}

@group(2) @binding(0) var<uniform> spheres_frag: SpheresFragUniforms;

// Fragment input
struct FragmentInput {
    @builtin(position) frag_coord: vec4<f32>,
    @location(0) v_radius: f32,
    @location(1) v_point: vec3<f32>,
    @location(2) v_point_view_position: vec3<f32>,
    @location(3) v_instance_id: f32,
    @location(4) v_group: f32,
    @location(5) v_model_position: vec3<f32>,
}

struct FragmentOutput {
    @location(0) depth: vec4<f32>,
    @builtin(frag_depth) frag_depth: f32,
}

@fragment
fn main(input: FragmentInput) -> FragmentOutput {
    var output: FragmentOutput;

    // Perform ray-sphere intersection (simplified)
    let camera_sphere_pos = -input.v_point_view_position;

    let ray_origin = mix(vec3<f32>(0.0, 0.0, 0.0), input.v_point, spheres_frag.is_ortho);
    let ray_direction = mix(normalize(input.v_point), vec3<f32>(0.0, 0.0, 1.0), spheres_frag.is_ortho);
    let camera_sphere_dir = mix(camera_sphere_pos, ray_origin - camera_sphere_pos, spheres_frag.is_ortho);

    let B = dot(ray_direction, camera_sphere_dir);
    let det = B * B + input.v_radius * input.v_radius - dot(camera_sphere_dir, camera_sphere_dir);

    if (det < 0.0) {
        discard;
    }

    let sqrt_det = sqrt(det);
    let neg_t = mix(B - sqrt_det, B + sqrt_det, spheres_frag.is_ortho);

    let camera_pos = ray_direction * neg_t + ray_origin;
    let clip_pos = frame.projection * vec4<f32>(camera_pos, 1.0);
    let fragment_depth = clip_pos.z / clip_pos.w;

    if (fragment_depth < 0.0 || fragment_depth > 1.0) {
        discard;
    }

    output.frag_depth = fragment_depth;
    output.depth = pack_depth_to_rgba(fragment_depth);

    return output;
}
`;

/**
 * Combined spheres shader module for different render variants.
 */
export const SpheresShader = {
    vertex: spheres_vert_wgsl,
    fragment: {
        color: spheres_frag_color_wgsl,
        pick: spheres_frag_pick_wgsl,
        depth: spheres_frag_depth_wgsl,
    },
};
