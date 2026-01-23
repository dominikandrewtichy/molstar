/**
 * Copyright (c) 2025 mol* contributors, licensed under MIT, See LICENSE file for more info.
 *
 * @author Alexander Rose <alexander.rose@weirdbyte.de>
 */

import { common_wgsl } from './chunks/common.wgsl';
import { frame_uniforms_wgsl, material_uniforms_wgsl, object_uniforms_wgsl } from './chunks/uniforms.wgsl';

/**
 * WGSL text shader for SDF (Signed Distance Field) text rendering.
 * Text is rendered as screen-aligned quads with SDF-based alpha testing
 * in the fragment shader for crisp edges at any scale.
 *
 * Features:
 *   - SDF-based text rendering
 *   - Border/outline support
 *   - Background plane support
 *   - Billboard orientation (always facing camera)
 */

export const text_vert_wgsl = /* wgsl */`
${common_wgsl}

${frame_uniforms_wgsl}
${object_uniforms_wgsl}

// Text-specific uniforms
struct TextUniforms {
    model_view: mat4x4<f32>,
    model_view_eye: mat4x4<f32>,
    inv_model_view_eye: mat4x4<f32>,
    inv_head_rotation: mat4x4<f32>,
    offset: vec3<f32>,        // x, y, z offsets
    model_scale: f32,
    pixel_ratio: f32,
    is_ortho: f32,
    has_head_rotation: f32,
    has_eye_camera: f32,
    viewport: vec4<f32>,
    tex_dim: vec2<f32>,
    _padding: vec2<f32>,
}

@group(2) @binding(1) var<uniform> text: TextUniforms;

// Position texture (xyz = position, w = depth)
@group(2) @binding(2) var t_position: texture_2d<f32>;
@group(2) @binding(3) var s_position: sampler;

// Mapping/texcoord texture (xy = mapping, zw = texcoord)
@group(2) @binding(4) var t_mapping_texcoord: texture_2d<f32>;
@group(2) @binding(5) var s_mapping_texcoord: sampler;

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
    @location(0) v_tex_coord: vec2<f32>,
    @location(1) v_model_position: vec3<f32>,
    @location(2) v_view_position: vec3<f32>,
    @location(3) v_instance_id: f32,
    @location(4) v_group: f32,
}

@vertex
fn main(
    @builtin(vertex_index) vertex_index: u32,
    @builtin(instance_index) instance_index: u32
) -> VertexOutput {
    var output: VertexOutput;

    // Get text glyph index (6 vertices per glyph quad)
    let glyph_id = i32(vertex_index / 6u);
    let uv = vec2<f32>(
        f32(glyph_id % i32(text.tex_dim.x)) + 0.5,
        f32(glyph_id / i32(text.tex_dim.x)) + 0.5
    ) / text.tex_dim;

    // Sample textures
    let position_depth = textureSampleLevel(t_position, s_position, uv, 0.0);
    let mapping_texcoord = textureSampleLevel(t_mapping_texcoord, s_mapping_texcoord, uv, 0.0);
    let size_group = textureSampleLevel(t_size_group, s_size_group, uv, 0.0);

    let glyph_position = position_depth.xyz;
    let depth = position_depth.w;
    let mapping = mapping_texcoord.xy;
    let tex_coord = mapping_texcoord.zw;
    var size = size_group.r * text.model_scale;
    if (size <= 0.0) {
        size = text.model_scale;
    }
    let group = size_group.g;

    output.v_tex_coord = tex_coord;
    output.v_group = group;

    // Get instance data
    let instance = instances[instance_index];
    let instance_transform = instance.transform;
    output.v_instance_id = instance.instance_id;

    let scale = text.model_scale;

    // Calculate offsets
    let offset_x = text.offset.x * scale;
    let offset_y = text.offset.y * scale;
    let offset_z = (text.offset.z + depth * 0.95) * scale;

    // Transform position
    let position4 = vec4<f32>(glyph_position, 1.0);

    var mv_position: vec4<f32>;
    if (text.has_eye_camera > 0.5) {
        mv_position = text.model_view_eye * instance_transform * position4;
    } else {
        mv_position = text.model_view * instance_transform * position4;
    }

    // Model position for clipping
    output.v_model_position = (object.model * instance_transform * position4).xyz;

    // Create billboard corner
    var mv_corner = vec4<f32>(mv_position.xyz, 1.0);

    // Handle background plane (indicated by texcoord.x == 10.0)
    var adjusted_offset_z = offset_z;
    if (tex_coord.x == 10.0) {
        // Move background plane slightly behind text to avoid z-fighting
        let clip_pos = frame.projection * mv_corner;
        adjusted_offset_z -= 0.001 * distance(frame.camera_position, clip_pos.xyz);
    }

    // Calculate corner offset
    var corner_offset = vec3<f32>(0.0);
    corner_offset.x = mapping.x * size * scale + offset_x;
    corner_offset.y = mapping.y * size * scale + offset_y;

    // Apply head rotation if present
    if (text.has_head_rotation > 0.5) {
        mv_corner = vec4<f32>(mv_corner.xyz + (text.inv_head_rotation * vec4<f32>(corner_offset, 1.0)).xyz, 1.0);
    } else {
        mv_corner = vec4<f32>(mv_corner.xyz + corner_offset, 1.0);
    }

    // Apply depth offset
    if (text.has_eye_camera < 0.5) {
        if (text.is_ortho > 0.5) {
            mv_corner.z += adjusted_offset_z;
        } else {
            mv_corner = vec4<f32>(mv_corner.xyz + normalize(-mv_corner.xyz) * adjusted_offset_z, 1.0);
        }
    }

    // Handle eye camera transformation
    if (text.has_eye_camera > 0.5) {
        mv_corner = text.model_view * text.inv_model_view_eye * mv_corner;
    }

    // Project to clip space
    output.position = frame.projection * mv_corner;
    output.v_view_position = -mv_corner.xyz;

    return output;
}
`;

export const text_frag_color_wgsl = /* wgsl */`
${common_wgsl}

${frame_uniforms_wgsl}
${material_uniforms_wgsl}

// Text fragment uniforms
struct TextFragUniforms {
    border_color: vec3<f32>,
    border_width: f32,
    background_color: vec3<f32>,
    background_opacity: f32,
}

@group(2) @binding(0) var<uniform> text_frag: TextFragUniforms;

// Font atlas texture
@group(2) @binding(9) var t_font: texture_2d<f32>;
@group(2) @binding(10) var s_font: sampler;

// Fragment input
struct FragmentInput {
    @builtin(position) frag_coord: vec4<f32>,
    @location(0) v_tex_coord: vec2<f32>,
    @location(1) v_model_position: vec3<f32>,
    @location(2) v_view_position: vec3<f32>,
    @location(3) v_instance_id: f32,
    @location(4) v_group: f32,
}

// Fragment output
struct FragmentOutput {
    @location(0) color: vec4<f32>,
}

@fragment
fn main(input: FragmentInput) -> FragmentOutput {
    var output: FragmentOutput;

    // Get base color from material
    var final_color = material.color;

    if (input.v_tex_coord.x > 1.0) {
        // Background plane
        final_color = vec4<f32>(
            text_frag.background_color,
            text_frag.background_opacity * material.color.a
        );
    } else {
        // Text rendering with SDF
        // Retrieve signed distance from font atlas
        let sdf = textureSample(t_font, s_font, input.v_tex_coord).a + text_frag.border_width;

        // Discard fragments outside the glyph
        if (sdf < 0.5) {
            discard;
        }

        // Apply border color if within border region
        let t = 0.5 + text_frag.border_width;
        if (text_frag.border_width > 0.0 && sdf < t) {
            final_color = vec4<f32>(text_frag.border_color, final_color.a);
        }
    }

    // Apply material alpha
    final_color.a *= material.alpha;

    output.color = final_color;

    return output;
}
`;

export const text_frag_pick_wgsl = /* wgsl */`
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

// Text fragment uniforms for picking
struct TextFragUniforms {
    border_color: vec3<f32>,
    border_width: f32,
    background_color: vec3<f32>,
    background_opacity: f32,
}

@group(2) @binding(0) var<uniform> text_frag: TextFragUniforms;

// Font atlas texture
@group(2) @binding(9) var t_font: texture_2d<f32>;
@group(2) @binding(10) var s_font: sampler;

// Fragment input
struct FragmentInput {
    @builtin(position) frag_coord: vec4<f32>,
    @location(0) v_tex_coord: vec2<f32>,
    @location(1) v_model_position: vec3<f32>,
    @location(2) v_view_position: vec3<f32>,
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

    // Apply SDF discard for text (not background)
    if (input.v_tex_coord.x <= 1.0) {
        let sdf = textureSample(t_font, s_font, input.v_tex_coord).a + text_frag.border_width;
        if (sdf < 0.5) {
            discard;
        }
    }

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

export const text_frag_depth_wgsl = /* wgsl */`
${common_wgsl}

${frame_uniforms_wgsl}

// Text fragment uniforms for depth
struct TextFragUniforms {
    border_color: vec3<f32>,
    border_width: f32,
    background_color: vec3<f32>,
    background_opacity: f32,
}

@group(2) @binding(0) var<uniform> text_frag: TextFragUniforms;

// Font atlas texture
@group(2) @binding(9) var t_font: texture_2d<f32>;
@group(2) @binding(10) var s_font: sampler;

// Fragment input
struct FragmentInput {
    @builtin(position) frag_coord: vec4<f32>,
    @location(0) v_tex_coord: vec2<f32>,
    @location(1) v_model_position: vec3<f32>,
    @location(2) v_view_position: vec3<f32>,
    @location(3) v_instance_id: f32,
    @location(4) v_group: f32,
}

struct FragmentOutput {
    @location(0) depth: vec4<f32>,
}

@fragment
fn main(input: FragmentInput) -> FragmentOutput {
    var output: FragmentOutput;

    // Apply SDF discard for text (not background)
    if (input.v_tex_coord.x <= 1.0) {
        let sdf = textureSample(t_font, s_font, input.v_tex_coord).a + text_frag.border_width;
        if (sdf < 0.5) {
            discard;
        }
    }

    let fragment_depth = input.frag_coord.z;
    output.depth = pack_depth_to_rgba(fragment_depth);

    return output;
}
`;

/**
 * Combined text shader module for different render variants.
 */
export const TextShader = {
    vertex: text_vert_wgsl,
    fragment: {
        color: text_frag_color_wgsl,
        pick: text_frag_pick_wgsl,
        depth: text_frag_depth_wgsl,
    },
};
