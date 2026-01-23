/**
 * Copyright (c) 2025 mol* contributors, licensed under MIT, See LICENSE file for more info.
 *
 * @author Alexander Rose <alexander.rose@weirdbyte.de>
 */

/**
 * WGSL clipping utilities.
 * Handles clipping planes and clipping objects.
 * Equivalent to the GLSL common-clip.glsl, clip-instance.glsl, and clip-pixel.glsl chunks.
 */

export const clipping_types_wgsl = /* wgsl */`
// Clipping object types
const CLIP_TYPE_NONE: u32 = 0u;
const CLIP_TYPE_PLANE: u32 = 1u;
const CLIP_TYPE_SPHERE: u32 = 2u;
const CLIP_TYPE_CUBE: u32 = 3u;
const CLIP_TYPE_CYLINDER: u32 = 4u;
const CLIP_TYPE_INFINITE_CYLINDER: u32 = 5u;

// Clipping modes
const CLIP_MODE_INTERSECTION: u32 = 0u;  // Inside all objects
const CLIP_MODE_UNION: u32 = 1u;          // Inside any object
`;

export const clipping_structs_wgsl = /* wgsl */`
// Clipping object definition
struct ClipObject {
    // Type of clipping object
    object_type: u32,
    // Invert the clip test
    invert: u32,
    _padding1: u32,
    _padding2: u32,

    // Position/center of the object
    position: vec3<f32>,
    _padding3: f32,

    // Rotation quaternion
    rotation: vec4<f32>,

    // Scale/dimensions
    scale: vec3<f32>,
    _padding4: f32,
}

// Clipping parameters
struct ClipParams {
    // Number of active clip objects
    object_count: u32,
    // Clipping mode (intersection vs union)
    mode: u32,
    _padding1: u32,
    _padding2: u32,
}
`;

export const clipping_functions_wgsl = /* wgsl */`
// Rotate a point by a quaternion
fn rotate_by_quat(v: vec3<f32>, q: vec4<f32>) -> vec3<f32> {
    let t = 2.0 * cross(q.xyz, v);
    return v + q.w * t + cross(q.xyz, t);
}

// Inverse rotate a point by a quaternion
fn inverse_rotate_by_quat(v: vec3<f32>, q: vec4<f32>) -> vec3<f32> {
    // Conjugate of quaternion
    let q_conj = vec4<f32>(-q.xyz, q.w);
    return rotate_by_quat(v, q_conj);
}

// Test if a point is inside a plane (half-space)
fn inside_plane(point: vec3<f32>, plane_pos: vec3<f32>, plane_normal: vec3<f32>) -> bool {
    return dot(point - plane_pos, plane_normal) <= 0.0;
}

// Test if a point is inside a sphere
fn inside_sphere(point: vec3<f32>, center: vec3<f32>, radius: f32) -> bool {
    let d = point - center;
    return dot(d, d) <= radius * radius;
}

// Test if a point is inside an axis-aligned box (before rotation)
fn inside_box(local_point: vec3<f32>, half_extents: vec3<f32>) -> bool {
    let abs_point = abs(local_point);
    return abs_point.x <= half_extents.x &&
           abs_point.y <= half_extents.y &&
           abs_point.z <= half_extents.z;
}

// Test if a point is inside a cylinder (along Y axis, before rotation)
fn inside_cylinder(local_point: vec3<f32>, radius: f32, half_height: f32) -> bool {
    let xz_dist = local_point.x * local_point.x + local_point.z * local_point.z;
    return xz_dist <= radius * radius && abs(local_point.y) <= half_height;
}

// Test if a point is inside an infinite cylinder (along Y axis, before rotation)
fn inside_infinite_cylinder(local_point: vec3<f32>, radius: f32) -> bool {
    let xz_dist = local_point.x * local_point.x + local_point.z * local_point.z;
    return xz_dist <= radius * radius;
}

// Test a single clip object
fn test_clip_object(point: vec3<f32>, obj: ClipObject) -> bool {
    var inside: bool;

    switch (obj.object_type) {
        case CLIP_TYPE_PLANE: {
            // Plane normal is +Y in local space, rotated by quaternion
            let normal = rotate_by_quat(vec3<f32>(0.0, 1.0, 0.0), obj.rotation);
            inside = inside_plane(point, obj.position, normal);
        }
        case CLIP_TYPE_SPHERE: {
            inside = inside_sphere(point, obj.position, obj.scale.x);
        }
        case CLIP_TYPE_CUBE: {
            let local_point = inverse_rotate_by_quat(point - obj.position, obj.rotation);
            inside = inside_box(local_point, obj.scale);
        }
        case CLIP_TYPE_CYLINDER: {
            let local_point = inverse_rotate_by_quat(point - obj.position, obj.rotation);
            inside = inside_cylinder(local_point, obj.scale.x, obj.scale.y);
        }
        case CLIP_TYPE_INFINITE_CYLINDER: {
            let local_point = inverse_rotate_by_quat(point - obj.position, obj.rotation);
            inside = inside_infinite_cylinder(local_point, obj.scale.x);
        }
        default: {
            inside = true;
        }
    }

    // Apply invert
    if (obj.invert != 0u) {
        inside = !inside;
    }

    return inside;
}

// Test all clip objects (returns true if point should be clipped/discarded)
fn clip_test(
    point: vec3<f32>,
    clip_objects: array<ClipObject, 8>,  // Assuming max 8 clip objects
    params: ClipParams
) -> bool {
    if (params.object_count == 0u) {
        return false;  // No clipping
    }

    if (params.mode == CLIP_MODE_INTERSECTION) {
        // Point must be inside ALL objects to NOT be clipped
        for (var i = 0u; i < params.object_count; i++) {
            if (!test_clip_object(point, clip_objects[i])) {
                return true;  // Outside at least one object, clip it
            }
        }
        return false;  // Inside all objects
    } else {
        // CLIP_MODE_UNION: Point must be inside ANY object to NOT be clipped
        for (var i = 0u; i < params.object_count; i++) {
            if (test_clip_object(point, clip_objects[i])) {
                return false;  // Inside at least one object, don't clip
            }
        }
        return true;  // Outside all objects, clip it
    }
}
`;

export const clip_instance_wgsl = /* wgsl */`
// Clip at instance level (in vertex shader)
// Returns true if the entire instance should be culled
fn clip_instance(
    bbox_min: vec3<f32>,
    bbox_max: vec3<f32>,
    clip_objects: array<ClipObject, 8>,
    params: ClipParams
) -> bool {
    if (params.object_count == 0u) {
        return false;
    }

    // Test bounding box corners
    let corners = array<vec3<f32>, 8>(
        vec3<f32>(bbox_min.x, bbox_min.y, bbox_min.z),
        vec3<f32>(bbox_max.x, bbox_min.y, bbox_min.z),
        vec3<f32>(bbox_min.x, bbox_max.y, bbox_min.z),
        vec3<f32>(bbox_max.x, bbox_max.y, bbox_min.z),
        vec3<f32>(bbox_min.x, bbox_min.y, bbox_max.z),
        vec3<f32>(bbox_max.x, bbox_min.y, bbox_max.z),
        vec3<f32>(bbox_min.x, bbox_max.y, bbox_max.z),
        vec3<f32>(bbox_max.x, bbox_max.y, bbox_max.z)
    );

    if (params.mode == CLIP_MODE_INTERSECTION) {
        // If ALL corners are clipped, cull the instance
        var all_clipped = true;
        for (var i = 0u; i < 8u; i++) {
            if (!clip_test(corners[i], clip_objects, params)) {
                all_clipped = false;
                break;
            }
        }
        return all_clipped;
    } else {
        // CLIP_MODE_UNION: If ANY corner is not clipped, keep the instance
        for (var i = 0u; i < 8u; i++) {
            if (!clip_test(corners[i], clip_objects, params)) {
                return false;
            }
        }
        return true;
    }
}
`;

export const clip_pixel_wgsl = /* wgsl */`
// Clip at pixel level (in fragment shader)
// Returns true if the fragment should be discarded
fn clip_pixel(
    model_position: vec3<f32>,
    clip_objects: array<ClipObject, 8>,
    params: ClipParams
) -> bool {
    return clip_test(model_position, clip_objects, params);
}

// Clip with interior handling
// Returns (should_discard, is_at_clip_boundary)
fn clip_pixel_with_interior(
    model_position: vec3<f32>,
    clip_objects: array<ClipObject, 8>,
    params: ClipParams,
    epsilon: f32
) -> vec2<bool> {
    let clipped = clip_test(model_position, clip_objects, params);

    if (clipped) {
        return vec2<bool>(true, false);
    }

    // Check if we're near the clip boundary (for interior coloring)
    var near_boundary = false;

    for (var i = 0u; i < params.object_count; i++) {
        let obj = clip_objects[i];

        // Test with small offset to detect boundary
        var test_point = model_position;

        switch (obj.object_type) {
            case CLIP_TYPE_PLANE: {
                let normal = rotate_by_quat(vec3<f32>(0.0, 1.0, 0.0), obj.rotation);
                let dist = abs(dot(model_position - obj.position, normal));
                if (dist < epsilon) {
                    near_boundary = true;
                }
            }
            case CLIP_TYPE_SPHERE: {
                let d = model_position - obj.position;
                let dist = abs(length(d) - obj.scale.x);
                if (dist < epsilon) {
                    near_boundary = true;
                }
            }
            default: {
                // For other types, use a simple offset test
                let offset_point = model_position + vec3<f32>(epsilon);
                if (test_clip_object(offset_point, obj) != test_clip_object(model_position, obj)) {
                    near_boundary = true;
                }
            }
        }

        if (near_boundary) {
            break;
        }
    }

    return vec2<bool>(false, near_boundary);
}
`;
