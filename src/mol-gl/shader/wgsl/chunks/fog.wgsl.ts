/**
 * Copyright (c) 2025 mol* contributors, licensed under MIT, See LICENSE file for more info.
 *
 * @author Alexander Rose <alexander.rose@weirdbyte.de>
 */

/**
 * WGSL fog utilities.
 * Equivalent to the GLSL apply-fog.glsl chunk.
 */
export const fog_wgsl = /* wgsl */`
// Fog parameters structure
struct FogParams {
    enabled: bool,
    near: f32,
    far: f32,
    color: vec3<f32>,
    transparent_background: bool,
}

// Apply fog to a fragment color
// Returns the fogged color and the pre-fog alpha (useful for transparency)
fn apply_fog(
    color: vec4<f32>,
    fragment_depth: f32,
    near: f32,
    far: f32,
    is_ortho: f32,
    fog_params: FogParams
) -> vec4<f32> {
    var result = color;

    if (fog_params.enabled) {
        let view_z = depth_to_view_z(is_ortho, fragment_depth, near, far);
        let fog_factor = smoothstep(fog_params.near, fog_params.far, abs(view_z));
        let fog_alpha = (1.0 - fog_factor) * color.a;

        if (!fog_params.transparent_background) {
            if (color.a < 1.0) {
                // Transparent objects are blended with background color
                result.a = fog_alpha;
            } else {
                // Mix opaque objects with fog color
                result = vec4<f32>(mix(color.rgb, fog_params.color, fog_factor), color.a);
            }
        } else {
            // Pre-multiplied alpha expected for transparent background
            result = vec4<f32>(color.rgb * fog_alpha, fog_alpha);
        }
    } else if (fog_params.transparent_background) {
        // Pre-multiplied alpha expected for transparent background
        result = vec4<f32>(color.rgb * color.a, color.a);
    }

    return result;
}

// Simplified fog application (just returns fog factor)
fn compute_fog_factor(
    fragment_depth: f32,
    near: f32,
    far: f32,
    is_ortho: f32,
    fog_near: f32,
    fog_far: f32
) -> f32 {
    let view_z = depth_to_view_z(is_ortho, fragment_depth, near, far);
    return smoothstep(fog_near, fog_far, abs(view_z));
}

// Apply fog with DPOIT considerations
fn apply_fog_dpoit(
    color: vec4<f32>,
    fragment_depth: f32,
    near: f32,
    far: f32,
    is_ortho: f32,
    fog_params: FogParams,
    is_opaque: bool
) -> vec4<f32> {
    var result = color;

    if (fog_params.enabled) {
        let view_z = depth_to_view_z(is_ortho, fragment_depth, near, far);
        let fog_factor = smoothstep(fog_params.near, fog_params.far, abs(view_z));
        let fog_alpha = (1.0 - fog_factor) * color.a;

        if (!fog_params.transparent_background) {
            if (color.a < 1.0) {
                result.a = fog_alpha;
            } else {
                result = vec4<f32>(mix(color.rgb, fog_params.color, fog_factor), color.a);
            }
        } else {
            if (color.a < 1.0) {
                result.a = fog_alpha;
            } else if (is_opaque) {
                // Opaque objects need pre-multiplied alpha
                result = vec4<f32>(color.rgb * fog_alpha, fog_alpha);
            } else {
                result = vec4<f32>(color.rgb * fog_alpha, fog_alpha);
            }
        }
    } else if (fog_params.transparent_background && !is_opaque) {
        result = vec4<f32>(color.rgb * color.a, color.a);
    }

    return result;
}

// Depth to view Z conversion (needed for fog calculation)
fn depth_to_view_z(is_ortho: f32, linear_clip_z: f32, near: f32, far: f32) -> f32 {
    if (is_ortho == 1.0) {
        return orthographic_depth_to_view_z(linear_clip_z, near, far);
    } else {
        return perspective_depth_to_view_z(linear_clip_z, near, far);
    }
}

fn perspective_depth_to_view_z(inv_clip_z: f32, near: f32, far: f32) -> f32 {
    return (near * far) / ((far - near) * inv_clip_z - far);
}

fn orthographic_depth_to_view_z(linear_clip_z: f32, near: f32, far: f32) -> f32 {
    return linear_clip_z * (near - far) - near;
}
`;
