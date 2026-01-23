/**
 * Copyright (c) 2025 mol* contributors, licensed under MIT, See LICENSE file for more info.
 *
 * @author Alexander Rose <alexander.rose@weirdbyte.de>
 */

/**
 * WGSL texture reading utilities.
 * Equivalent to the GLSL read-from-texture.glsl chunk.
 *
 * These functions read values from a texture using a linear index,
 * which is useful for storing per-instance or per-vertex data in textures.
 */
export const read_from_texture_wgsl = /* wgsl */`
// Read a texel from a texture using a linear index (float version)
fn read_from_texture_f(tex: texture_2d<f32>, tex_sampler: sampler, index: f32, dim: vec2<f32>) -> vec4<f32> {
    let x = index % dim.x;
    let y = floor(index / dim.x);
    let uv = (vec2<f32>(x, y) + 0.5) / dim;
    return textureSample(tex, tex_sampler, uv);
}

// Read a texel from a texture using a linear index (integer version)
fn read_from_texture_i(tex: texture_2d<f32>, tex_sampler: sampler, index: i32, dim: vec2<f32>) -> vec4<f32> {
    let x = index % i32(dim.x);
    let y = index / i32(dim.x);
    let uv = (vec2<f32>(f32(x), f32(y)) + 0.5) / dim;
    return textureSample(tex, tex_sampler, uv);
}

// Read a texel from a texture using a linear index (unsigned integer version)
fn read_from_texture_u(tex: texture_2d<f32>, tex_sampler: sampler, index: u32, dim: vec2<f32>) -> vec4<f32> {
    let x = index % u32(dim.x);
    let y = index / u32(dim.x);
    let uv = (vec2<f32>(f32(x), f32(y)) + 0.5) / dim;
    return textureSample(tex, tex_sampler, uv);
}

// Texel fetch without sampler (exact pixel read)
fn texel_fetch_2d(tex: texture_2d<f32>, coord: vec2<i32>, level: i32) -> vec4<f32> {
    return textureLoad(tex, coord, level);
}

// Texel fetch from storage texture
fn texel_fetch_storage(tex: texture_storage_2d<rgba32float, read>, coord: vec2<i32>) -> vec4<f32> {
    return textureLoad(tex, coord);
}
`;

/**
 * 3D texture sampling from a 2D texture (emulated 3D texture).
 * Used when actual 3D textures are not available or for compatibility.
 */
export const texture3d_from_2d_wgsl = /* wgsl */`
// Sample a 3D texture stored as a 2D texture (nearest neighbor)
fn texture_3d_from_2d_nearest(
    tex: texture_2d<f32>,
    tex_sampler: sampler,
    pos: vec3<f32>,
    grid_dim: vec3<f32>,
    tex_dim: vec2<f32>
) -> vec4<f32> {
    let pos_clamped = clamp(pos, vec3<f32>(0.0), vec3<f32>(1.0));
    let pos_scaled = pos_clamped * (grid_dim - 1.0);
    let pos_floored = floor(pos_scaled + 0.5);

    let z = pos_floored.z;
    let columns = floor(tex_dim.x / grid_dim.x);
    let column = z % columns;
    let row = floor(z / columns);

    let uv = (vec2<f32>(
        column * grid_dim.x + pos_floored.x,
        row * grid_dim.y + pos_floored.y
    ) + 0.5) / tex_dim;

    return textureSample(tex, tex_sampler, uv);
}

// Sample a 3D texture stored as a 2D texture (trilinear interpolation)
fn texture_3d_from_2d_linear(
    tex: texture_2d<f32>,
    tex_sampler: sampler,
    pos: vec3<f32>,
    grid_dim: vec3<f32>,
    tex_dim: vec2<f32>
) -> vec4<f32> {
    let pos_clamped = clamp(pos, vec3<f32>(0.0), vec3<f32>(1.0));
    let pos_scaled = pos_clamped * (grid_dim - 1.0);
    let pos_floored = floor(pos_scaled);
    let frac = pos_scaled - pos_floored;

    let columns = floor(tex_dim.x / grid_dim.x);

    // Sample 8 corners for trilinear interpolation
    var values: array<vec4<f32>, 8>;

    for (var i = 0u; i < 8u; i++) {
        let offset = vec3<f32>(
            f32((i >> 0u) & 1u),
            f32((i >> 1u) & 1u),
            f32((i >> 2u) & 1u)
        );
        let sample_pos = min(pos_floored + offset, grid_dim - 1.0);

        let z = sample_pos.z;
        let column = z % columns;
        let row = floor(z / columns);

        let uv = (vec2<f32>(
            column * grid_dim.x + sample_pos.x,
            row * grid_dim.y + sample_pos.y
        ) + 0.5) / tex_dim;

        values[i] = textureSample(tex, tex_sampler, uv);
    }

    // Trilinear interpolation
    let c00 = mix(values[0], values[1], frac.x);
    let c01 = mix(values[2], values[3], frac.x);
    let c10 = mix(values[4], values[5], frac.x);
    let c11 = mix(values[6], values[7], frac.x);

    let c0 = mix(c00, c01, frac.y);
    let c1 = mix(c10, c11, frac.y);

    return mix(c0, c1, frac.z);
}

// Sample from a 1D lookup stored in a 2D texture (trilinear for 3D position)
fn texture_3d_from_1d_trilinear(
    tex: texture_2d<f32>,
    tex_sampler: sampler,
    pos: vec3<f32>,
    grid_dim: vec3<f32>,
    tex_dim: vec2<f32>
) -> vec4<f32> {
    let pos_clamped = clamp(pos, vec3<f32>(0.0), vec3<f32>(1.0));
    let pos_scaled = pos_clamped * (grid_dim - 1.0);
    let pos_floored = floor(pos_scaled);
    let frac = pos_scaled - pos_floored;

    // Sample 8 corners
    var values: array<vec4<f32>, 8>;

    for (var i = 0u; i < 8u; i++) {
        let offset = vec3<f32>(
            f32((i >> 0u) & 1u),
            f32((i >> 1u) & 1u),
            f32((i >> 2u) & 1u)
        );
        let sample_pos = min(pos_floored + offset, grid_dim - 1.0);

        // Convert 3D position to 1D index
        let index = sample_pos.x + sample_pos.y * grid_dim.x + sample_pos.z * grid_dim.x * grid_dim.y;

        // Convert 1D index to 2D UV
        let x = index % tex_dim.x;
        let y = floor(index / tex_dim.x);
        let uv = (vec2<f32>(x, y) + 0.5) / tex_dim;

        values[i] = textureSample(tex, tex_sampler, uv);
    }

    // Trilinear interpolation
    let c00 = mix(values[0], values[1], frac.x);
    let c01 = mix(values[2], values[3], frac.x);
    let c10 = mix(values[4], values[5], frac.x);
    let c11 = mix(values[6], values[7], frac.x);

    let c0 = mix(c00, c01, frac.y);
    let c1 = mix(c10, c11, frac.y);

    return mix(c0, c1, frac.z);
}
`;
