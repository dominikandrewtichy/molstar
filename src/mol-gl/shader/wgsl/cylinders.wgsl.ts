/**
 * Copyright (c) 2025 mol* contributors, licensed under MIT, See LICENSE file for more info.
 *
 * @author Alexander Rose <alexander.rose@weirdbyte.de>
 */

import { common_wgsl } from './chunks/common.wgsl';
import { frame_uniforms_wgsl, light_uniforms_wgsl, material_uniforms_wgsl, object_uniforms_wgsl } from './chunks/uniforms.wgsl';

/**
 * WGSL cylinders shader for ray-cast impostor rendering.
 * Cylinders are rendered as screen-aligned boxes with ray-cylinder intersection
 * computed in the fragment shader.
 *
 * Cap modes (encoded in vCap):
 *   0.0 = no caps
 *   1.0 = top cap only
 *   2.0 = bottom cap only
 *   3.0 = both caps
 */

export const cylinders_vert_wgsl = /* wgsl */`
${common_wgsl}

${frame_uniforms_wgsl}
${object_uniforms_wgsl}

// Cylinders-specific uniforms
struct CylindersUniforms {
    model_view: mat4x4<f32>,
    is_ortho: f32,
    model_scale: f32,
    _padding: vec2<f32>,
    camera_dir: vec3<f32>,
    _padding2: f32,
    tex_dim: vec2<f32>,
    _padding3: vec2<f32>,
    // LOD parameters
    lod_near: f32,
    lod_far: f32,
    lod_fade: f32,
    lod_factor: f32,
    // Camera plane for LOD
    camera_plane: vec4<f32>,
}

@group(2) @binding(1) var<uniform> cylinders: CylindersUniforms;

// Start/end position texture
@group(2) @binding(2) var t_start_end: texture_2d<f32>;
@group(2) @binding(3) var s_start_end: sampler;

// Scale/cap/group texture
@group(2) @binding(4) var t_scale_cap_group: texture_2d<f32>;
@group(2) @binding(5) var s_scale_cap_group: sampler;

// Instance data
struct InstanceData {
    transform: mat4x4<f32>,
    instance_id: f32,
}

@group(2) @binding(6) var<storage, read> instances: array<InstanceData>;

// Vertex output
struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) v_start: vec3<f32>,
    @location(1) v_end: vec3<f32>,
    @location(2) v_size: f32,
    @location(3) v_cap: f32,
    @location(4) v_model_position: vec3<f32>,
    @location(5) v_view_position: vec3<f32>,
    @location(6) v_instance_id: f32,
    @location(7) v_group: f32,
}

// Mapping for cylinder bounding box vertices
// 8 vertices of the bounding box, with additional corner adjustments
fn get_mapping(vertex_id: u32) -> vec3<f32> {
    // 14 vertices for a triangle strip bounding box
    // Or use 36 vertices for triangles (6 faces * 2 triangles * 3 vertices)
    let idx = vertex_id % 36u;

    // Define the 8 corners of the bounding box
    // x: -1 or 1 (along cylinder axis direction)
    // y: -1 or 1 (perpendicular, left)
    // z: -1 or 1 (perpendicular, up)
    let corners = array<vec3<f32>, 8>(
        vec3<f32>(-1.0, -1.0, -1.0), // 0
        vec3<f32>( 1.0, -1.0, -1.0), // 1
        vec3<f32>(-1.0,  1.0, -1.0), // 2
        vec3<f32>( 1.0,  1.0, -1.0), // 3
        vec3<f32>(-1.0, -1.0,  1.0), // 4
        vec3<f32>( 1.0, -1.0,  1.0), // 5
        vec3<f32>(-1.0,  1.0,  1.0), // 6
        vec3<f32>( 1.0,  1.0,  1.0)  // 7
    );

    // 12 triangles * 3 vertices = 36 indices
    let indices = array<u32, 36>(
        // Front face
        0u, 1u, 2u, 2u, 1u, 3u,
        // Back face
        4u, 6u, 5u, 5u, 6u, 7u,
        // Left face
        0u, 2u, 4u, 4u, 2u, 6u,
        // Right face
        1u, 5u, 3u, 3u, 5u, 7u,
        // Bottom face
        0u, 4u, 1u, 1u, 4u, 5u,
        // Top face
        2u, 3u, 6u, 6u, 3u, 7u
    );

    return corners[indices[idx]];
}

@vertex
fn main(
    @builtin(vertex_index) vertex_index: u32,
    @builtin(instance_index) instance_index: u32
) -> VertexOutput {
    var output: VertexOutput;

    // Calculate cylinder index (36 vertices per cylinder)
    let cylinder_id = i32(vertex_index / 36u);
    let mapping = get_mapping(vertex_index);

    // Get cylinder data from textures
    let uv = vec2<f32>(
        f32(cylinder_id % i32(cylinders.tex_dim.x)) + 0.5,
        f32(cylinder_id / i32(cylinders.tex_dim.x)) + 0.5
    ) / cylinders.tex_dim;

    // Sample start and end positions (stored as two textures or packed)
    let start_data = textureSampleLevel(t_start_end, s_start_end, uv, 0.0);
    let scale_cap_group = textureSampleLevel(t_scale_cap_group, s_scale_cap_group, uv, 0.0);

    // Decode start/end (we might need a second texture for end)
    // For now, assume start_data.xyz = start, and we have end stored elsewhere
    // This might need adjustment based on actual data layout
    let local_start = start_data.xyz;
    let local_end = vec3<f32>(start_data.w, scale_cap_group.x, scale_cap_group.y); // Packed end position
    let scale = scale_cap_group.z;
    let cap = scale_cap_group.w;
    let group = f32(cylinder_id); // Or from another texture

    // Get instance data
    let instance = instances[instance_index];
    let instance_transform = instance.transform;
    let model_transform = object.model * instance_transform;

    // Transform start and end to world space
    let world_start = (model_transform * vec4<f32>(local_start, 1.0)).xyz;
    let world_end = (model_transform * vec4<f32>(local_end, 1.0)).xyz;

    output.v_start = world_start;
    output.v_end = world_end;
    output.v_cap = cap;

    // Calculate size
    let size = cylinders.model_scale * scale;
    output.v_size = size;

    // Calculate center and direction
    let center = (world_start + world_end) * 0.5;
    output.v_model_position = center;

    // Camera direction for billboard orientation
    let cam_dir = select(
        -normalize(center - frame.camera_position),
        cylinders.camera_dir,
        cylinders.is_ortho > 0.5
    );

    var dir = world_end - world_start;
    var axis_flip = 1.0;

    // Ensure cylinder direction is pointing towards camera
    if (dot(cam_dir, dir) < 0.0) {
        dir = -dir;
        axis_flip = -1.0;
    }

    // Build orthonormal basis
    let left = size * normalize(cross(cam_dir, dir));
    let up = size * normalize(cross(left, dir));

    // Move vertex from center to corner
    // mapping.x: along cylinder axis (-1 = start, +1 = end)
    // mapping.y: left/right
    // mapping.z: up/down
    var vertex_pos = center;
    vertex_pos += mapping.x * axis_flip * dir * 0.5;
    vertex_pos += mapping.y * left;
    vertex_pos += mapping.z * up;

    // Transform to view/clip space
    let mv_position = frame.view * vec4<f32>(vertex_pos, 1.0);
    output.v_view_position = mv_position.xyz;

    var clip_position = frame.projection * mv_position;

    // Avoid near-plane clipping
    if (clip_position.z < -clip_position.w) {
        var adjusted_mv = mv_position;
        adjusted_mv.z -= 2.0 * (length(dir) + size);
        clip_position.z = (frame.projection * adjusted_mv).z;
    }

    output.position = clip_position;
    output.v_instance_id = instance.instance_id;
    output.v_group = group;

    return output;
}
`;

export const cylinders_frag_color_wgsl = /* wgsl */`
${common_wgsl}

${frame_uniforms_wgsl}
${light_uniforms_wgsl}
${material_uniforms_wgsl}

// Cylinders fragment uniforms
struct CylindersFragUniforms {
    inv_view: mat4x4<f32>,
    is_ortho: f32,
    double_sided: f32,
    solid_interior: f32,
    near: f32,
    camera_dir: vec3<f32>,
    _padding: f32,
}

@group(2) @binding(0) var<uniform> cylinders_frag: CylindersFragUniforms;

// Fragment input
struct FragmentInput {
    @builtin(position) frag_coord: vec4<f32>,
    @builtin(front_facing) front_facing: bool,
    @location(0) v_start: vec3<f32>,
    @location(1) v_end: vec3<f32>,
    @location(2) v_size: f32,
    @location(3) v_cap: f32,
    @location(4) v_model_position: vec3<f32>,
    @location(5) v_view_position: vec3<f32>,
    @location(6) v_instance_id: f32,
    @location(7) v_group: f32,
}

// Fragment output
struct FragmentOutput {
    @location(0) color: vec4<f32>,
    @builtin(frag_depth) depth: f32,
}

/**
 * Ray-cylinder intersection.
 * Adapted from https://www.shadertoy.com/view/4lcSRn
 * The MIT License, Copyright 2016 Inigo Quilez
 *
 * Returns: (hit, interior, fragment_depth, _)
 *          camera_normal in separate output
 *          model_position, view_position in separate outputs
 */
struct CylinderHit {
    hit: bool,
    interior: bool,
    fragment_depth: f32,
    camera_normal: vec3<f32>,
    model_position: vec3<f32>,
    view_position: vec3<f32>,
}

fn cylinder_impostor(
    ray_origin: vec3<f32>,
    ray_dir: vec3<f32>,
    start: vec3<f32>,
    end: vec3<f32>,
    radius: f32,
    v_cap: f32,
    double_sided: bool,
    solid_interior: bool,
    near: f32
) -> CylinderHit {
    var result: CylinderHit;
    result.hit = false;
    result.interior = false;
    result.fragment_depth = -1.0;

    let ba = end - start;
    let oc = ray_origin - start;

    let baba = dot(ba, ba);
    let bard = dot(ba, ray_dir);
    let baoc = dot(ba, oc);

    let k2 = baba - bard * bard;
    let k1 = baba * dot(oc, ray_dir) - baoc * bard;
    let k0 = baba * dot(oc, oc) - baoc * baoc - radius * radius * baba;

    let h = k1 * k1 - k2 * k0;
    if (h < 0.0) {
        return result;
    }

    // Cap configuration
    // 0.0 = no caps, 1.0 = top cap, 2.0 = bottom cap, 3.0 = both caps
    var top_cap = (v_cap > 0.9 && v_cap < 1.1) || v_cap >= 2.9;
    var bottom_cap = (v_cap > 1.9 && v_cap < 2.1) || v_cap >= 2.9;

    var top_interior = false;
    var bottom_interior = false;

    if (solid_interior) {
        top_interior = !top_cap;
        bottom_interior = !bottom_cap;
        top_cap = true;
        bottom_cap = true;
    }

    let sqrt_h = sqrt(h);

    // Body outside
    var t = (-k1 - sqrt_h) / k2;
    var y = baoc + t * bard;

    if (y > 0.0 && y < baba) {
        result.interior = false;
        result.camera_normal = (oc + t * ray_dir - ba * y / baba) / radius;
        result.model_position = ray_origin + t * ray_dir;
        result.view_position = (frame.view * vec4<f32>(result.model_position, 1.0)).xyz;
        result.fragment_depth = calc_depth_webgpu(result.view_position);

        if (result.fragment_depth > 0.0 && result.fragment_depth < 1.0) {
            result.hit = true;
            return result;
        }
    }

    // Top cap (y < 0)
    if (top_cap && y < 0.0) {
        t = -baoc / bard;
        if (abs(k1 + k2 * t) < sqrt_h) {
            result.interior = top_interior;
            result.camera_normal = -ba / baba;
            result.model_position = ray_origin + t * ray_dir;
            result.view_position = (frame.view * vec4<f32>(result.model_position, 1.0)).xyz;
            result.fragment_depth = calc_depth_webgpu(result.view_position);

            if (result.fragment_depth > 0.0 && result.fragment_depth < 1.0) {
                if (solid_interior && result.interior) {
                    result.camera_normal = -ray_dir;
                }
                if (!result.interior || solid_interior) {
                    result.hit = true;
                    return result;
                }
            }
        }
    }

    // Bottom cap (y >= baba)
    if (bottom_cap && y >= baba) {
        t = (baba - baoc) / bard;
        if (abs(k1 + k2 * t) < sqrt_h) {
            result.interior = bottom_interior;
            result.camera_normal = ba / baba;
            result.model_position = ray_origin + t * ray_dir;
            result.view_position = (frame.view * vec4<f32>(result.model_position, 1.0)).xyz;
            result.fragment_depth = calc_depth_webgpu(result.view_position);

            if (result.fragment_depth > 0.0 && result.fragment_depth < 1.0) {
                if (solid_interior && result.interior) {
                    result.camera_normal = -ray_dir;
                }
                if (!result.interior || solid_interior) {
                    result.hit = true;
                    return result;
                }
            }
        }
    }

    // Interior hits (double-sided or solid interior)
    if (double_sided || solid_interior) {
        // Body inside
        t = (-k1 + sqrt_h) / k2;
        y = baoc + t * bard;

        if (y > 0.0 && y < baba) {
            result.interior = true;
            result.camera_normal = -(oc + t * ray_dir - ba * y / baba) / radius;
            result.model_position = ray_origin + t * ray_dir;
            result.view_position = (frame.view * vec4<f32>(result.model_position, 1.0)).xyz;
            result.fragment_depth = calc_depth_webgpu(result.view_position);

            if (result.fragment_depth > 0.0 && result.fragment_depth < 1.0) {
                if (solid_interior) {
                    result.fragment_depth = 0.0 + (0.0000002 / radius);
                    result.camera_normal = -ray_dir;
                    // Intersection with near plane
                    let camera_ray_origin = (frame.view * vec4<f32>(ray_origin, 1.0)).xyz;
                    let camera_ray_dir = (frame.view * vec4<f32>(ray_dir, 0.0)).xyz;
                    let near_t = -(near + camera_ray_origin.z) / camera_ray_dir.z;
                    result.view_position = camera_ray_origin + near_t * camera_ray_dir;
                    result.model_position = (cylinders_frag.inv_view * vec4<f32>(result.view_position, 1.0)).xyz;
                }
                result.hit = true;
                return result;
            }
        }

        // Interior top cap
        if (top_cap && y < 0.0) {
            t = -baoc / bard;
            let h_neg = -sqrt_h;
            if (abs(k1 + k2 * t) < -h_neg) {
                result.interior = true;
                result.camera_normal = ba / baba;
                result.model_position = ray_origin + t * ray_dir;
                result.view_position = (frame.view * vec4<f32>(result.model_position, 1.0)).xyz;
                result.fragment_depth = calc_depth_webgpu(result.view_position);

                if (result.fragment_depth > 0.0 && result.fragment_depth < 1.0) {
                    if (solid_interior) {
                        result.fragment_depth = 0.0 + (0.0000002 / radius);
                        result.camera_normal = -ray_dir;
                        let camera_ray_origin = (frame.view * vec4<f32>(ray_origin, 1.0)).xyz;
                        let camera_ray_dir = (frame.view * vec4<f32>(ray_dir, 0.0)).xyz;
                        let near_t = -(near + camera_ray_origin.z) / camera_ray_dir.z;
                        result.view_position = camera_ray_origin + near_t * camera_ray_dir;
                        result.model_position = (cylinders_frag.inv_view * vec4<f32>(result.view_position, 1.0)).xyz;
                    }
                    result.hit = true;
                    return result;
                }
            }
        }

        // Interior bottom cap
        if (bottom_cap && y >= baba) {
            t = (baba - baoc) / bard;
            let h_neg = -sqrt_h;
            if (abs(k1 + k2 * t) < -h_neg) {
                result.interior = true;
                result.camera_normal = -ba / baba;
                result.model_position = ray_origin + t * ray_dir;
                result.view_position = (frame.view * vec4<f32>(result.model_position, 1.0)).xyz;
                result.fragment_depth = calc_depth_webgpu(result.view_position);

                if (result.fragment_depth > 0.0 && result.fragment_depth < 1.0) {
                    if (solid_interior) {
                        result.fragment_depth = 0.0 + (0.0000002 / radius);
                        result.camera_normal = -ray_dir;
                        let camera_ray_origin = (frame.view * vec4<f32>(ray_origin, 1.0)).xyz;
                        let camera_ray_dir = (frame.view * vec4<f32>(ray_dir, 0.0)).xyz;
                        let near_t = -(near + camera_ray_origin.z) / camera_ray_dir.z;
                        result.view_position = camera_ray_origin + near_t * camera_ray_dir;
                        result.model_position = (cylinders_frag.inv_view * vec4<f32>(result.view_position, 1.0)).xyz;
                    }
                    result.hit = true;
                    return result;
                }
            }
        }
    }

    return result;
}

// Calculate depth in WebGPU clip space [0, 1]
fn calc_depth_webgpu(view_pos: vec3<f32>) -> f32 {
    let clip_pos = frame.projection * vec4<f32>(view_pos, 1.0);
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

    // Calculate ray origin and direction
    let ray_origin = input.v_model_position;
    let ray_dir = select(
        normalize(input.v_model_position - frame.camera_position),
        cylinders_frag.camera_dir,
        cylinders_frag.is_ortho > 0.5
    );

    // Perform ray-cylinder intersection
    let hit = cylinder_impostor(
        ray_origin,
        ray_dir,
        input.v_start,
        input.v_end,
        input.v_size,
        input.v_cap,
        cylinders_frag.double_sided > 0.5,
        cylinders_frag.solid_interior > 0.5,
        cylinders_frag.near
    );

    if (!hit.hit) {
        discard;
    }

    if (hit.fragment_depth < 0.0 || hit.fragment_depth > 1.0) {
        discard;
    }

    output.depth = hit.fragment_depth;

    // Calculate normal in view space
    let normal_matrix = mat3x3<f32>(
        frame.view[0].xyz,
        frame.view[1].xyz,
        frame.view[2].xyz
    );
    let normal = normalize(normal_matrix * (-normalize(hit.camera_normal)));

    // Get base color
    var base_color = material.color;

    // Apply interior color if needed
    if (hit.interior) {
        base_color = mix(base_color, material.interior_color, material.interior_color.a);
    }

    // View direction
    let view_dir = normalize(-hit.view_position);

    // Calculate lighting
    let lit_color = calculate_lighting(normal, view_dir, base_color.rgb);

    // Apply emissive
    let emissive_color = base_color.rgb * material.emissive;
    let final_color = lit_color + emissive_color;

    output.color = vec4<f32>(final_color, base_color.a * material.alpha);

    return output;
}
`;

export const cylinders_frag_pick_wgsl = /* wgsl */`
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

// Cylinders fragment uniforms for picking
struct CylindersFragUniforms {
    inv_view: mat4x4<f32>,
    is_ortho: f32,
    double_sided: f32,
    solid_interior: f32,
    near: f32,
    camera_dir: vec3<f32>,
    _padding: f32,
}

@group(2) @binding(0) var<uniform> cylinders_frag: CylindersFragUniforms;

// Fragment input
struct FragmentInput {
    @builtin(position) frag_coord: vec4<f32>,
    @location(0) v_start: vec3<f32>,
    @location(1) v_end: vec3<f32>,
    @location(2) v_size: f32,
    @location(3) v_cap: f32,
    @location(4) v_model_position: vec3<f32>,
    @location(5) v_view_position: vec3<f32>,
    @location(6) v_instance_id: f32,
    @location(7) v_group: f32,
}

// Pick output - multiple render targets
struct PickOutput {
    @location(0) object: vec4<f32>,
    @location(1) instance: vec4<f32>,
    @location(2) group: vec4<f32>,
    @location(3) depth: vec4<f32>,
    @builtin(frag_depth) frag_depth: f32,
}

// Simplified ray-cylinder for picking
fn cylinder_impostor_pick(
    ray_origin: vec3<f32>,
    ray_dir: vec3<f32>,
    start: vec3<f32>,
    end: vec3<f32>,
    radius: f32,
    v_cap: f32
) -> vec2<f32> {
    // Returns (hit, fragment_depth)
    let ba = end - start;
    let oc = ray_origin - start;

    let baba = dot(ba, ba);
    let bard = dot(ba, ray_dir);
    let baoc = dot(ba, oc);

    let k2 = baba - bard * bard;
    let k1 = baba * dot(oc, ray_dir) - baoc * bard;
    let k0 = baba * dot(oc, oc) - baoc * baoc - radius * radius * baba;

    let h = k1 * k1 - k2 * k0;
    if (h < 0.0) {
        return vec2<f32>(0.0, -1.0);
    }

    let top_cap = (v_cap > 0.9 && v_cap < 1.1) || v_cap >= 2.9;
    let bottom_cap = (v_cap > 1.9 && v_cap < 2.1) || v_cap >= 2.9;

    let sqrt_h = sqrt(h);

    // Body outside
    var t = (-k1 - sqrt_h) / k2;
    var y = baoc + t * bard;

    if (y > 0.0 && y < baba) {
        let model_position = ray_origin + t * ray_dir;
        let view_position = (frame.view * vec4<f32>(model_position, 1.0)).xyz;
        let clip_pos = frame.projection * vec4<f32>(view_position, 1.0);
        let fragment_depth = clip_pos.z / clip_pos.w;
        if (fragment_depth > 0.0 && fragment_depth < 1.0) {
            return vec2<f32>(1.0, fragment_depth);
        }
    }

    // Top cap
    if (top_cap && y < 0.0) {
        t = -baoc / bard;
        if (abs(k1 + k2 * t) < sqrt_h) {
            let model_position = ray_origin + t * ray_dir;
            let view_position = (frame.view * vec4<f32>(model_position, 1.0)).xyz;
            let clip_pos = frame.projection * vec4<f32>(view_position, 1.0);
            let fragment_depth = clip_pos.z / clip_pos.w;
            if (fragment_depth > 0.0 && fragment_depth < 1.0) {
                return vec2<f32>(1.0, fragment_depth);
            }
        }
    }

    // Bottom cap
    if (bottom_cap && y >= baba) {
        t = (baba - baoc) / bard;
        if (abs(k1 + k2 * t) < sqrt_h) {
            let model_position = ray_origin + t * ray_dir;
            let view_position = (frame.view * vec4<f32>(model_position, 1.0)).xyz;
            let clip_pos = frame.projection * vec4<f32>(view_position, 1.0);
            let fragment_depth = clip_pos.z / clip_pos.w;
            if (fragment_depth > 0.0 && fragment_depth < 1.0) {
                return vec2<f32>(1.0, fragment_depth);
            }
        }
    }

    // Body inside (for back faces)
    t = (-k1 + sqrt_h) / k2;
    y = baoc + t * bard;
    if (y > 0.0 && y < baba) {
        let model_position = ray_origin + t * ray_dir;
        let view_position = (frame.view * vec4<f32>(model_position, 1.0)).xyz;
        let clip_pos = frame.projection * vec4<f32>(view_position, 1.0);
        let fragment_depth = clip_pos.z / clip_pos.w;
        if (fragment_depth > 0.0 && fragment_depth < 1.0) {
            return vec2<f32>(1.0, fragment_depth);
        }
    }

    return vec2<f32>(0.0, -1.0);
}

@fragment
fn main(input: FragmentInput) -> PickOutput {
    var output: PickOutput;

    // Calculate ray
    let ray_origin = input.v_model_position;
    let ray_dir = select(
        normalize(input.v_model_position - frame.camera_position),
        cylinders_frag.camera_dir,
        cylinders_frag.is_ortho > 0.5
    );

    // Perform ray-cylinder intersection
    let result = cylinder_impostor_pick(
        ray_origin,
        ray_dir,
        input.v_start,
        input.v_end,
        input.v_size,
        input.v_cap
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

export const cylinders_frag_depth_wgsl = /* wgsl */`
${common_wgsl}

${frame_uniforms_wgsl}

// Cylinders fragment uniforms for depth
struct CylindersFragUniforms {
    inv_view: mat4x4<f32>,
    is_ortho: f32,
    double_sided: f32,
    solid_interior: f32,
    near: f32,
    camera_dir: vec3<f32>,
    _padding: f32,
}

@group(2) @binding(0) var<uniform> cylinders_frag: CylindersFragUniforms;

// Fragment input
struct FragmentInput {
    @builtin(position) frag_coord: vec4<f32>,
    @location(0) v_start: vec3<f32>,
    @location(1) v_end: vec3<f32>,
    @location(2) v_size: f32,
    @location(3) v_cap: f32,
    @location(4) v_model_position: vec3<f32>,
    @location(5) v_view_position: vec3<f32>,
    @location(6) v_instance_id: f32,
    @location(7) v_group: f32,
}

struct FragmentOutput {
    @location(0) depth: vec4<f32>,
    @builtin(frag_depth) frag_depth: f32,
}

@fragment
fn main(input: FragmentInput) -> FragmentOutput {
    var output: FragmentOutput;

    // Calculate ray
    let ray_origin = input.v_model_position;
    let ray_dir = select(
        normalize(input.v_model_position - frame.camera_position),
        cylinders_frag.camera_dir,
        cylinders_frag.is_ortho > 0.5
    );

    // Simplified ray-cylinder for depth only
    let ba = input.v_end - input.v_start;
    let oc = ray_origin - input.v_start;

    let baba = dot(ba, ba);
    let bard = dot(ba, ray_dir);
    let baoc = dot(ba, oc);

    let k2 = baba - bard * bard;
    let k1 = baba * dot(oc, ray_dir) - baoc * bard;
    let k0 = baba * dot(oc, oc) - baoc * baoc - input.v_size * input.v_size * baba;

    let h = k1 * k1 - k2 * k0;
    if (h < 0.0) {
        discard;
    }

    let sqrt_h = sqrt(h);

    // Body outside
    var t = (-k1 - sqrt_h) / k2;
    var y = baoc + t * bard;

    if (y > 0.0 && y < baba) {
        let model_position = ray_origin + t * ray_dir;
        let view_position = (frame.view * vec4<f32>(model_position, 1.0)).xyz;
        let clip_pos = frame.projection * vec4<f32>(view_position, 1.0);
        let fragment_depth = clip_pos.z / clip_pos.w;
        if (fragment_depth > 0.0 && fragment_depth < 1.0) {
            output.frag_depth = fragment_depth;
            output.depth = pack_depth_to_rgba(fragment_depth);
            return output;
        }
    }

    // Cap checks
    let top_cap = (input.v_cap > 0.9 && input.v_cap < 1.1) || input.v_cap >= 2.9;
    let bottom_cap = (input.v_cap > 1.9 && input.v_cap < 2.1) || input.v_cap >= 2.9;

    if (top_cap && y < 0.0) {
        t = -baoc / bard;
        if (abs(k1 + k2 * t) < sqrt_h) {
            let model_position = ray_origin + t * ray_dir;
            let view_position = (frame.view * vec4<f32>(model_position, 1.0)).xyz;
            let clip_pos = frame.projection * vec4<f32>(view_position, 1.0);
            let fragment_depth = clip_pos.z / clip_pos.w;
            if (fragment_depth > 0.0 && fragment_depth < 1.0) {
                output.frag_depth = fragment_depth;
                output.depth = pack_depth_to_rgba(fragment_depth);
                return output;
            }
        }
    }

    if (bottom_cap && y >= baba) {
        t = (baba - baoc) / bard;
        if (abs(k1 + k2 * t) < sqrt_h) {
            let model_position = ray_origin + t * ray_dir;
            let view_position = (frame.view * vec4<f32>(model_position, 1.0)).xyz;
            let clip_pos = frame.projection * vec4<f32>(view_position, 1.0);
            let fragment_depth = clip_pos.z / clip_pos.w;
            if (fragment_depth > 0.0 && fragment_depth < 1.0) {
                output.frag_depth = fragment_depth;
                output.depth = pack_depth_to_rgba(fragment_depth);
                return output;
            }
        }
    }

    discard;
}
`;

/**
 * Combined cylinders shader module for different render variants.
 */
export const CylindersShader = {
    vertex: cylinders_vert_wgsl,
    fragment: {
        color: cylinders_frag_color_wgsl,
        pick: cylinders_frag_pick_wgsl,
        depth: cylinders_frag_depth_wgsl,
    },
};
