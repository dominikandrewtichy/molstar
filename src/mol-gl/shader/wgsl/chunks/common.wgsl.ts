/**
 * Copyright (c) 2025 mol* contributors, licensed under MIT, See LICENSE file for more info.
 *
 * @author Alexander Rose <alexander.rose@weirdbyte.de>
 */

/**
 * Common WGSL utilities and constants.
 * Equivalent to the GLSL common.glsl chunk.
 */
export const common_wgsl = /* wgsl */`
// Constants
const PI: f32 = 3.14159265;
const RECIPROCAL_PI: f32 = 0.31830988618;
const EPSILON: f32 = 1e-6;
const ONE_MINUS_EPSILON: f32 = 1.0 - 1e-6;
const TWO_PI: f32 = 6.2831853;
const HALF_PI: f32 = 1.570796325;

const PALETTE_SCALE: f32 = 16777214.0; // (1 << 24) - 2

// Utility functions

fn saturate_f32(a: f32) -> f32 {
    return clamp(a, 0.0, 1.0);
}

fn saturate_vec3(a: vec3<f32>) -> vec3<f32> {
    return clamp(a, vec3<f32>(0.0), vec3<f32>(1.0));
}

fn saturate_vec4(a: vec4<f32>) -> vec4<f32> {
    return clamp(a, vec4<f32>(0.0), vec4<f32>(1.0));
}

fn int_div(a: f32, b: f32) -> f32 {
    return f32(i32(a) / i32(b));
}

fn int_mod(a: f32, b: f32) -> f32 {
    return a - b * f32(i32(a) / i32(b));
}

fn pow2(x: f32) -> f32 {
    return x * x;
}

// Color packing/unpacking

fn pack_int_to_rgb(value_in: f32) -> vec3<f32> {
    var value = clamp(round(value_in), 0.0, 16777216.0 - 1.0) + 1.0;
    var c = vec3<f32>(0.0);
    c.z = value % 256.0;
    value = floor(value / 256.0);
    c.y = value % 256.0;
    value = floor(value / 256.0);
    c.x = value % 256.0;
    return c / 255.0;
}

fn unpack_rgb_to_int(rgb: vec3<f32>) -> f32 {
    return (floor(rgb.r * 255.0 + 0.5) * 256.0 * 256.0 + floor(rgb.g * 255.0 + 0.5) * 256.0 + floor(rgb.b * 255.0 + 0.5)) - 1.0;
}

fn pack_unit_interval_to_rg(v: f32) -> vec2<f32> {
    var enc: vec2<f32>;
    enc = vec2<f32>(fract(v * 256.0), v);
    enc.y -= enc.x * (1.0 / 256.0);
    enc *= 256.0 / 255.0;
    return enc;
}

fn unpack_rg_to_unit_interval(enc: vec2<f32>) -> f32 {
    return dot(enc, vec2<f32>(255.0 / (256.0 * 256.0), 255.0 / 256.0));
}

fn pack_2x4(v: vec2<f32>) -> f32 {
    let clamped_v = clamp(v, vec2<f32>(0.0), vec2<f32>(1.0));
    let scaled_v = floor(clamped_v * 15.0 + 0.5); // round to 0–15
    let c = scaled_v.x + scaled_v.y * 16.0;
    return c / 255.0;
}

fn unpack_2x4(f: f32) -> vec2<f32> {
    let c = floor(f * 255.0 + 0.5);
    let lo = c % 16.0;
    let hi = floor(c / 16.0);
    return vec2<f32>(lo, hi) / 15.0;
}

// Depth packing/unpacking

const PackUpscale: f32 = 256.0 / 255.0;
const UnpackDownscale: f32 = 255.0 / 256.0;
const PackFactors: vec3<f32> = vec3<f32>(256.0 * 256.0 * 256.0, 256.0 * 256.0, 256.0);
const ShiftRight8: f32 = 1.0 / 256.0;

fn pack_depth_to_rgba(v: f32) -> vec4<f32> {
    var r = vec4<f32>(fract(v * PackFactors), v);
    r.y -= r.x * ShiftRight8;
    r.z -= r.y * ShiftRight8;
    r.w -= r.z * ShiftRight8;
    return r * PackUpscale;
}

fn unpack_rgba_to_depth(v: vec4<f32>) -> f32 {
    let UnpackFactors = UnpackDownscale / vec4<f32>(PackFactors, 1.0);
    return dot(v, UnpackFactors);
}

// Screen space utilities

fn screen_space_to_view_space(ss_pos: vec3<f32>, inv_projection: mat4x4<f32>) -> vec3<f32> {
    var p = vec4<f32>(ss_pos * 2.0 - 1.0, 1.0);
    p = inv_projection * p;
    return p.xyz / p.w;
}

fn linearize_depth(depth: f32, near: f32, far: f32) -> f32 {
    return (2.0 * near) / (far + near - depth * (far - near));
}

fn perspective_depth_to_view_z(inv_clip_z: f32, near: f32, far: f32) -> f32 {
    return (near * far) / ((far - near) * inv_clip_z - far);
}

fn orthographic_depth_to_view_z(linear_clip_z: f32, near: f32, far: f32) -> f32 {
    return linear_clip_z * (near - far) - near;
}

fn depth_to_view_z(is_ortho: f32, linear_clip_z: f32, near: f32, far: f32) -> f32 {
    if (is_ortho == 1.0) {
        return orthographic_depth_to_view_z(linear_clip_z, near, far);
    } else {
        return perspective_depth_to_view_z(linear_clip_z, near, far);
    }
}

// Normal transformation using adjoint matrix
fn adjoint(m: mat4x4<f32>) -> mat3x3<f32> {
    return mat3x3<f32>(
        cross(m[1].xyz, m[2].xyz),
        cross(m[2].xyz, m[0].xyz),
        cross(m[0].xyz, m[1].xyz)
    );
}

// Color space conversion

fn srgb_to_linear(c: vec4<f32>) -> vec4<f32> {
    let cutoff = vec3<f32>(0.04045);
    let linear_low = c.rgb * 0.0773993808;
    let linear_high = pow(c.rgb * 0.9478672986 + vec3<f32>(0.0521327014), vec3<f32>(2.4));
    let result = select(linear_high, linear_low, c.rgb <= cutoff);
    return vec4<f32>(result, c.a);
}

fn linear_to_srgb(c: vec4<f32>) -> vec4<f32> {
    let cutoff = vec3<f32>(0.0031308);
    let srgb_low = c.rgb * 12.92;
    let srgb_high = pow(c.rgb, vec3<f32>(0.41666)) * 1.055 - vec3<f32>(0.055);
    let result = select(srgb_high, srgb_low, c.rgb <= cutoff);
    return vec4<f32>(result, c.a);
}

fn luminance(c: vec3<f32>) -> f32 {
    // https://www.w3.org/TR/WCAG21/#dfn-relative-luminance
    let W = vec3<f32>(0.2125, 0.7154, 0.0721);
    return dot(c, W);
}
`;
