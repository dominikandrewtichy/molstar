/**
 * Copyright (c) 2025 mol* contributors, licensed under MIT, See LICENSE file for more info.
 *
 * @author Alexander Rose <alexander.rose@weirdbyte.de>
 *
 * Adapted from three.js (https://github.com/mrdoob/three.js/)
 * which is under the MIT License, Copyright (c) 2010-2021 three.js authors
 */

/**
 * WGSL lighting utilities.
 * Implements physically-based rendering (PBR) lighting model.
 * Equivalent to the GLSL apply-light-color.glsl chunk.
 */

export const lighting_structs_wgsl = /* wgsl */`
// Geometric context for lighting calculations
struct GeometricContext {
    position: vec3<f32>,
    normal: vec3<f32>,
    view_dir: vec3<f32>,
}

// Physical material properties
struct PhysicalMaterial {
    diffuse_color: vec3<f32>,
    roughness: f32,
    specular_color: vec3<f32>,
    specular_f90: f32,
}

// Incident light information
struct IncidentLight {
    direction: vec3<f32>,
    color: vec3<f32>,
}

// Reflected light accumulator
struct ReflectedLight {
    direct_diffuse: vec3<f32>,
    direct_specular: vec3<f32>,
    indirect_diffuse: vec3<f32>,
    indirect_specular: vec3<f32>,
}
`;

export const lighting_functions_wgsl = /* wgsl */`
// Constants
const PI: f32 = 3.14159265;
const RECIPROCAL_PI: f32 = 0.31830988618;

// Fresnel-Schlick approximation
fn fresnel_schlick(cos_theta: f32, f0: vec3<f32>, f90: f32) -> vec3<f32> {
    let pow5 = pow(1.0 - cos_theta, 5.0);
    return f0 + (vec3<f32>(f90) - f0) * pow5;
}

// GGX Normal Distribution Function
fn distribution_ggx(n_dot_h: f32, roughness: f32) -> f32 {
    let a = roughness * roughness;
    let a2 = a * a;
    let n_dot_h2 = n_dot_h * n_dot_h;
    let denom = n_dot_h2 * (a2 - 1.0) + 1.0;
    return a2 / (PI * denom * denom);
}

// Smith's geometry function (Schlick-GGX)
fn geometry_schlick_ggx(n_dot_v: f32, roughness: f32) -> f32 {
    let r = roughness + 1.0;
    let k = (r * r) / 8.0;
    return n_dot_v / (n_dot_v * (1.0 - k) + k);
}

// Smith's geometry function for both view and light directions
fn geometry_smith(n_dot_v: f32, n_dot_l: f32, roughness: f32) -> f32 {
    let ggx_v = geometry_schlick_ggx(n_dot_v, roughness);
    let ggx_l = geometry_schlick_ggx(n_dot_l, roughness);
    return ggx_v * ggx_l;
}

// GGX BRDF for specular reflection
fn brdf_ggx(
    light_dir: vec3<f32>,
    view_dir: vec3<f32>,
    normal: vec3<f32>,
    specular_color: vec3<f32>,
    specular_f90: f32,
    roughness: f32
) -> vec3<f32> {
    let half_dir = normalize(light_dir + view_dir);

    let n_dot_l = saturate_f32(dot(normal, light_dir));
    let n_dot_v = saturate_f32(dot(normal, view_dir));
    let n_dot_h = saturate_f32(dot(normal, half_dir));
    let v_dot_h = saturate_f32(dot(view_dir, half_dir));

    let f = fresnel_schlick(v_dot_h, specular_color, specular_f90);
    let d = distribution_ggx(n_dot_h, roughness);
    let g = geometry_smith(n_dot_v, n_dot_l, roughness);

    // Prevent division by zero
    let denom = 4.0 * n_dot_v * n_dot_l + 0.0001;
    return f * d * g / denom;
}

// Lambertian diffuse BRDF
fn brdf_lambert(diffuse_color: vec3<f32>) -> vec3<f32> {
    return diffuse_color * RECIPROCAL_PI;
}

// Direct lighting contribution (physical)
fn re_direct_physical(
    direct_light: IncidentLight,
    geometry: GeometricContext,
    material: PhysicalMaterial,
    reflected: ptr<function, ReflectedLight>
) {
    let n_dot_l = saturate_f32(dot(geometry.normal, direct_light.direction));
    let irradiance = direct_light.color * n_dot_l;

    // Diffuse
    (*reflected).direct_diffuse += irradiance * brdf_lambert(material.diffuse_color);

    // Specular
    (*reflected).direct_specular += irradiance * brdf_ggx(
        direct_light.direction,
        geometry.view_dir,
        geometry.normal,
        material.specular_color,
        material.specular_f90,
        material.roughness
    );
}

// Indirect diffuse lighting contribution
fn re_indirect_diffuse_physical(
    irradiance: vec3<f32>,
    geometry: GeometricContext,
    material: PhysicalMaterial,
    reflected: ptr<function, ReflectedLight>
) {
    (*reflected).indirect_diffuse += irradiance * brdf_lambert(material.diffuse_color);
}

// Indirect specular lighting contribution
fn re_indirect_specular_physical(
    radiance: vec3<f32>,
    ibl_irradiance: vec3<f32>,
    clearcoat_radiance: vec3<f32>,
    geometry: GeometricContext,
    material: PhysicalMaterial,
    reflected: ptr<function, ReflectedLight>
) {
    // Simplified IBL specular (no environment map)
    let n_dot_v = saturate_f32(dot(geometry.normal, geometry.view_dir));
    let fresnel = fresnel_schlick(n_dot_v, material.specular_color, material.specular_f90);
    (*reflected).indirect_specular += radiance * fresnel;
}

// Compute luminance of a color
fn luminance(c: vec3<f32>) -> f32 {
    let W = vec3<f32>(0.2125, 0.7154, 0.0721);
    return dot(c, W);
}

// Saturate helper
fn saturate_f32(a: f32) -> f32 {
    return clamp(a, 0.0, 1.0);
}
`;

export const apply_light_color_wgsl = /* wgsl */`
// Apply lighting to a material color
// Parameters:
//   material_color: The base material color (RGBA)
//   normal: Surface normal in view space
//   view_position: Fragment position in view space
//   light_direction: Direction to light source
//   light_color: Color of the light
//   ambient_color: Ambient light color
//   metalness: Material metalness (0-1)
//   roughness: Material roughness (0-1)
//   emissive: Emissive intensity
//   ignore_light: If true, skip lighting calculation
//   exposure: Exposure multiplier
fn apply_light_color(
    material_color: vec4<f32>,
    normal: vec3<f32>,
    view_position: vec3<f32>,
    light_direction: vec3<f32>,
    light_color: vec3<f32>,
    ambient_color: vec3<f32>,
    metalness: f32,
    roughness: f32,
    emissive: f32,
    ignore_light: bool,
    exposure: f32
) -> vec4<f32> {
    var out_color: vec4<f32>;

    if (ignore_light) {
        // No lighting, just use material color with emissive
        var rgb = material_color.rgb;
        rgb += rgb * emissive;
        rgb *= exposure;
        out_color = vec4<f32>(rgb, material_color.a);
    } else {
        // Set up geometry
        var geometry: GeometricContext;
        geometry.position = -view_position;
        geometry.normal = normal;
        geometry.view_dir = normalize(view_position);

        // Set up physical material
        var phys_material: PhysicalMaterial;
        let clamped_metalness = clamp(metalness, 0.0, 0.99);
        let clamped_roughness = clamp(roughness, 0.0525, 1.0);

        phys_material.diffuse_color = material_color.rgb * (1.0 - clamped_metalness);
        phys_material.roughness = clamped_roughness;
        phys_material.specular_color = mix(vec3<f32>(0.04), material_color.rgb, clamped_metalness);
        phys_material.specular_f90 = 1.0;

        // Initialize reflected light
        var reflected: ReflectedLight;
        reflected.direct_diffuse = vec3<f32>(0.0);
        reflected.direct_specular = vec3<f32>(0.0);
        reflected.indirect_diffuse = vec3<f32>(0.0);
        reflected.indirect_specular = vec3<f32>(0.0);

        // Direct lighting
        var direct_light: IncidentLight;
        direct_light.direction = light_direction;
        direct_light.color = light_color * PI; // * PI for punctual light

        re_direct_physical(direct_light, geometry, phys_material, &reflected);

        // Indirect diffuse (ambient)
        let irradiance = ambient_color * PI;
        re_indirect_diffuse_physical(irradiance, geometry, phys_material, &reflected);

        // Indirect specular (simplified, no environment map)
        let radiance = ambient_color * clamped_metalness;
        let ibl_irradiance = ambient_color * clamped_metalness;
        re_indirect_specular_physical(radiance, ibl_irradiance, vec3<f32>(0.0), geometry, phys_material, &reflected);

        // Combine all contributions
        var outgoing_light = reflected.direct_diffuse + reflected.indirect_diffuse +
                            reflected.direct_specular + reflected.indirect_specular;

        // Clamp to prevent artifacts
        outgoing_light = clamp(outgoing_light, vec3<f32>(0.01), vec3<f32>(0.99));

        // Add emissive
        outgoing_light += material_color.rgb * emissive;

        // Apply exposure
        outgoing_light *= exposure;

        out_color = vec4<f32>(outgoing_light, material_color.a);
    }

    return out_color;
}

// Simplified cel-shaded lighting
fn apply_cel_shaded_light(
    material_color: vec4<f32>,
    normal: vec3<f32>,
    view_position: vec3<f32>,
    light_direction: vec3<f32>,
    light_color: vec3<f32>,
    ambient_color: vec3<f32>,
    metalness: f32,
    roughness: f32,
    cel_steps: f32,
    exposure: f32
) -> vec4<f32> {
    let view_dir = normalize(view_position);
    let n_dot_l = saturate_f32(dot(normal, light_direction));

    // Calculate diffuse and specular intensities
    let clamped_metalness = clamp(metalness, 0.0, 0.99);
    let clamped_roughness = clamp(roughness, 0.05, 1.0);

    let diffuse = RECIPROCAL_PI * n_dot_l * (1.0 - clamped_metalness);

    // Simplified specular for cel shading
    let half_dir = normalize(light_direction + view_dir);
    let n_dot_h = saturate_f32(dot(normal, half_dir));
    let specular_intensity = pow(n_dot_h, 1.0 / (clamped_roughness * clamped_roughness + 0.001));
    let specular = luminance(saturate_f32(n_dot_l) * specular_intensity * vec3<f32>(0.04));

    // Quantize for cel shading
    var cel_intensity = diffuse + specular;
    cel_intensity = ceil(cel_intensity * cel_steps) / cel_steps;

    var outgoing_light = material_color.rgb * light_color * PI * cel_intensity;
    outgoing_light += material_color.rgb * (1.0 - clamped_metalness) * luminance(ambient_color);
    outgoing_light *= exposure;

    return vec4<f32>(outgoing_light, material_color.a);
}
`;

export const bump_mapping_wgsl = /* wgsl */`
// Simple fractal Brownian motion for procedural bump mapping
fn fbm(p: vec3<f32>) -> f32 {
    var value = 0.0;
    var amplitude = 0.5;
    var pos = p;

    for (var i = 0; i < 4; i++) {
        value += amplitude * simple_noise(pos);
        pos *= 2.0;
        amplitude *= 0.5;
    }

    return value;
}

// Simple 3D noise function
fn simple_noise(p: vec3<f32>) -> f32 {
    let i = floor(p);
    let f = fract(p);
    let u = f * f * (3.0 - 2.0 * f);

    return mix(
        mix(
            mix(hash3d(i + vec3<f32>(0.0, 0.0, 0.0)),
                hash3d(i + vec3<f32>(1.0, 0.0, 0.0)), u.x),
            mix(hash3d(i + vec3<f32>(0.0, 1.0, 0.0)),
                hash3d(i + vec3<f32>(1.0, 1.0, 0.0)), u.x), u.y),
        mix(
            mix(hash3d(i + vec3<f32>(0.0, 0.0, 1.0)),
                hash3d(i + vec3<f32>(1.0, 0.0, 1.0)), u.x),
            mix(hash3d(i + vec3<f32>(0.0, 1.0, 1.0)),
                hash3d(i + vec3<f32>(1.0, 1.0, 1.0)), u.x), u.y), u.z);
}

// Hash function for noise
fn hash3d(p: vec3<f32>) -> f32 {
    var p3 = fract(p * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

// Perturb normal based on height map
fn perturb_normal(
    view_pos: vec3<f32>,
    surf_norm: vec3<f32>,
    height: f32,
    scale: f32
) -> vec3<f32> {
    let dpdx = dpdx(view_pos);
    let dpdy = dpdy(view_pos);

    let hll = height;
    let hlr = height + dpdx(height);
    let hul = height + dpdy(height);

    let vx = dpdx;
    let vy = dpdy;

    let normal = surf_norm;
    let bump_factor = scale;

    // Calculate perturbed normal
    let sx = (hlr - hll) * bump_factor;
    let sy = (hul - hll) * bump_factor;

    let perturbed = normalize(normal + sx * cross(vy, normal) + sy * cross(normal, vx));
    return perturbed;
}
`;
