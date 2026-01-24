/**
 * Copyright (c) 2025 mol* contributors, licensed under MIT, See LICENSE file for more info.
 *
 * @author Alexander Rose <alexander.rose@weirdbyte.de>
 */

import { common_wgsl } from './chunks/common.wgsl';
import { frame_uniforms_wgsl, light_uniforms_wgsl, material_uniforms_wgsl, object_uniforms_wgsl } from './chunks/uniforms.wgsl';

/**
 * WGSL image shader for rendering 2D textured quads.
 * Supports various interpolation modes (nearest, catmulrom, mitchell, bspline).
 */

export const image_vert_wgsl = /* wgsl */`
${common_wgsl}

${frame_uniforms_wgsl}
${object_uniforms_wgsl}

// Vertex input
struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) uv: vec2<f32>,
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
    @location(0) v_uv: vec2<f32>,
    @location(1) v_view_position: vec3<f32>,
    @location(2) v_model_position: vec3<f32>,
    @location(3) v_instance_id: f32,
    @location(4) v_group: f32,
}

@vertex
fn main(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;

    // Get instance transform
    let instance = instances[input.instance_index];
    let instance_transform = instance.transform;

    // Model position
    let model_position = (object.model * instance_transform * vec4<f32>(input.position, 1.0)).xyz;
    output.v_model_position = model_position;

    // Model-view position
    let model_view = frame.view * object.model * instance_transform;
    let view_position = model_view * vec4<f32>(input.position, 1.0);
    output.v_view_position = view_position.xyz;

    // Final clip position
    output.position = frame.projection * view_position;

    output.v_uv = input.uv;
    output.v_instance_id = instance.instance_id;
    output.v_group = input.group;

    return output;
}
`;

export const image_frag_color_wgsl = /* wgsl */`
${common_wgsl}

${frame_uniforms_wgsl}
${light_uniforms_wgsl}
${material_uniforms_wgsl}

// Image-specific uniforms
struct ImageUniforms {
    image_tex_dim: vec2<f32>,
    iso_level: f32,
    use_cubic_interpolation: i32,
    // Trimming
    trim_type: i32,
    trim_center: vec3<f32>,
    trim_scale: vec3<f32>,
}

@group(2) @binding(1) var<uniform> image: ImageUniforms;

// Textures
@group(2) @binding(2) var t_image: texture_2d<f32>;
@group(2) @binding(3) var s_image: sampler;
@group(2) @binding(4) var t_group: texture_2d<f32>;
@group(2) @binding(5) var s_group: sampler;
@group(2) @binding(6) var t_value: texture_2d<f32>;
@group(2) @binding(7) var s_value: sampler;

// Marker texture
@group(2) @binding(8) var t_marker: texture_2d<f32>;
@group(2) @binding(9) var s_marker: sampler;

// Palette texture (optional)
@group(2) @binding(10) var t_palette: texture_2d<f32>;
@group(2) @binding(11) var s_palette: sampler;

// Fragment input
struct FragmentInput {
    @builtin(position) frag_coord: vec4<f32>,
    @builtin(front_facing) front_facing: bool,
    @location(0) v_uv: vec2<f32>,
    @location(1) v_view_position: vec3<f32>,
    @location(2) v_model_position: vec3<f32>,
    @location(3) v_instance_id: f32,
    @location(4) v_group: f32,
}

// Fragment output
struct FragmentOutput {
    @location(0) color: vec4<f32>,
}

// Cubic filter functions
// Catmull-Rom parameters: B=0, C=0.5
fn cubic_filter_catmulrom(x: f32) -> f32 {
    let B: f32 = 0.0;
    let C: f32 = 0.5;
    return cubic_filter_bc(x, B, C);
}

// Mitchell parameters: B=1/3, C=1/3
fn cubic_filter_mitchell(x: f32) -> f32 {
    let B: f32 = 0.333;
    let C: f32 = 0.333;
    return cubic_filter_bc(x, B, C);
}

// B-spline cubic filter
fn cubic_filter_bspline(x: f32) -> f32 {
    var f = abs(x);
    if (f >= 0.0 && f <= 1.0) {
        return (2.0 / 3.0) + (0.5) * (f * f * f) - (f * f);
    } else if (f > 1.0 && f <= 2.0) {
        return (1.0 / 6.0) * pow(2.0 - f, 3.0);
    }
    return 0.0;
}

// General BC cubic filter
fn cubic_filter_bc(x: f32, B: f32, C: f32) -> f32 {
    var f = abs(x);
    if (f < 1.0) {
        return ((12.0 - 9.0 * B - 6.0 * C) * (f * f * f) +
            (-18.0 + 12.0 * B + 6.0 * C) * (f * f) +
            (6.0 - 2.0 * B)) / 6.0;
    } else if (f >= 1.0 && f < 2.0) {
        return ((-B - 6.0 * C) * (f * f * f)
            + (6.0 * B + 30.0 * C) * (f * f) +
            (-(12.0 * B) - 48.0 * C) * f +
            8.0 * B + 24.0 * C) / 6.0;
    }
    return 0.0;
}

// Bicubic sampling
fn sample_bicubic(tex: texture_2d<f32>, samp: sampler, tex_coord: vec2<f32>, tex_dim: vec2<f32>) -> vec4<f32> {
    let texel_size = 1.0 / tex_dim;
    var adjusted_coord = tex_coord - texel_size / 2.0;
    var n_sum = vec4<f32>(0.0);
    var n_denom = 0.0;
    let cell = fract(adjusted_coord * tex_dim);

    for (var m = -1.0; m <= 2.0; m += 1.0) {
        for (var n = -1.0; n <= 2.0; n += 1.0) {
            let vec_data = textureSample(tex, samp, adjusted_coord + texel_size * vec2<f32>(m, n));
            let c = abs(cubic_filter_catmulrom(m - cell.x) * cubic_filter_catmulrom(-n + cell.y));
            n_sum += vec_data * c;
            n_denom += c;
        }
    }
    return n_sum / n_denom;
}

@fragment
fn main(input: FragmentInput) -> FragmentOutput {
    var output: FragmentOutput;

    // Sample the image texture
    var mat_color: vec4<f32>;
    if (image.use_cubic_interpolation != 0) {
        mat_color = sample_bicubic(t_image, s_image, input.v_uv, image.image_tex_dim);
    } else {
        mat_color = textureSample(t_image, s_image, input.v_uv);
    }

    // Apply iso-level if specified
    if (image.iso_level >= 0.0) {
        let value = textureSample(t_value, s_value, input.v_uv).r;
        if (value < image.iso_level) {
            discard;
        }
        mat_color.a = material.alpha;
    } else {
        if (mat_color.a == 0.0) {
            discard;
        }
        mat_color.a *= material.alpha;
    }

    // Get group from texture
    let packed_group = textureSample(t_group, s_group, input.v_uv).rgb;
    var group = -1.0;
    if (packed_group != vec3<f32>(0.0)) {
        group = unpack_rgb_to_int(packed_group);
    }

    // Apply material color
    let final_color = mat_color.rgb * material.color.rgb;

    output.color = vec4<f32>(final_color, mat_color.a);

    return output;
}
`;

export const image_frag_pick_wgsl = /* wgsl */`
${common_wgsl}

${frame_uniforms_wgsl}

// Picking uniforms
struct PickingUniforms {
    object_id: u32,
    instance_granularity: u32,
    group_granularity: u32,
    group_count: u32,
}

@group(1) @binding(0) var<uniform> picking: PickingUniforms;

// Image-specific uniforms
struct ImageUniforms {
    image_tex_dim: vec2<f32>,
    iso_level: f32,
    use_cubic_interpolation: i32,
    trim_type: i32,
    trim_center: vec3<f32>,
    trim_scale: vec3<f32>,
}

@group(2) @binding(1) var<uniform> image: ImageUniforms;

// Textures
@group(2) @binding(2) var t_image: texture_2d<f32>;
@group(2) @binding(3) var s_image: sampler;
@group(2) @binding(4) var t_group: texture_2d<f32>;
@group(2) @binding(5) var s_group: sampler;
@group(2) @binding(6) var t_value: texture_2d<f32>;
@group(2) @binding(7) var s_value: sampler;

// Fragment input
struct FragmentInput {
    @builtin(position) frag_coord: vec4<f32>,
    @location(0) v_uv: vec2<f32>,
    @location(1) v_view_position: vec3<f32>,
    @location(2) v_model_position: vec3<f32>,
    @location(3) v_instance_id: f32,
    @location(4) v_group: f32,
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

    // Check alpha
    let mat_color = textureSample(t_image, s_image, input.v_uv);

    if (image.iso_level >= 0.0) {
        let value = textureSample(t_value, s_value, input.v_uv).r;
        if (value < image.iso_level) {
            discard;
        }
    } else {
        if (mat_color.a == 0.0) {
            discard;
        }
    }

    // Get group from texture
    let packed_group = textureSample(t_group, s_group, input.v_uv).rgb;
    var group = -1.0;
    if (packed_group != vec3<f32>(0.0)) {
        group = unpack_rgb_to_int(packed_group);
    }

    if (group < 0.0) {
        discard;
    }

    // Pack object ID
    output.object = vec4<f32>(pack_int_to_rgb(f32(picking.object_id)), 1.0);

    // Pack instance ID
    output.instance = vec4<f32>(pack_int_to_rgb(input.v_instance_id), 1.0);

    // Pack group
    output.group = vec4<f32>(pack_int_to_rgb(group), 1.0);

    // Pack depth
    output.depth = pack_depth_to_rgba(input.frag_coord.z);

    return output;
}
`;

export const image_frag_depth_wgsl = /* wgsl */`
${common_wgsl}

// Image-specific uniforms
struct ImageUniforms {
    image_tex_dim: vec2<f32>,
    iso_level: f32,
    use_cubic_interpolation: i32,
    trim_type: i32,
    trim_center: vec3<f32>,
    trim_scale: vec3<f32>,
}

@group(2) @binding(1) var<uniform> image: ImageUniforms;

// Textures
@group(2) @binding(2) var t_image: texture_2d<f32>;
@group(2) @binding(3) var s_image: sampler;
@group(2) @binding(6) var t_value: texture_2d<f32>;
@group(2) @binding(7) var s_value: sampler;

// Fragment input
struct FragmentInput {
    @builtin(position) frag_coord: vec4<f32>,
    @location(0) v_uv: vec2<f32>,
    @location(1) v_view_position: vec3<f32>,
    @location(2) v_model_position: vec3<f32>,
    @location(3) v_instance_id: f32,
    @location(4) v_group: f32,
}

struct FragmentOutput {
    @location(0) depth: vec4<f32>,
}

@fragment
fn main(input: FragmentInput) -> FragmentOutput {
    var output: FragmentOutput;

    // Check alpha
    let mat_color = textureSample(t_image, s_image, input.v_uv);

    if (image.iso_level >= 0.0) {
        let value = textureSample(t_value, s_value, input.v_uv).r;
        if (value < image.iso_level) {
            discard;
        }
    } else {
        if (mat_color.a == 0.0) {
            discard;
        }
    }

    output.depth = pack_depth_to_rgba(input.frag_coord.z);
    return output;
}
`;

/**
 * Combined image shader module for different render variants.
 */
export const ImageShader = {
    vertex: image_vert_wgsl,
    fragment: {
        color: image_frag_color_wgsl,
        pick: image_frag_pick_wgsl,
        depth: image_frag_depth_wgsl,
    },
};
