/**
 * Copyright (c) 2025 mol* contributors, licensed under MIT, See LICENSE file for more info.
 *
 * @author Alexander Rose <alexander.rose@weirdbyte.de>
 */

// Shader module management
export * from './shader-module';

// Shader chunks - Core utilities
export * from './chunks/common.wgsl';
export * from './chunks/uniforms.wgsl';
export * from './chunks/read-from-texture.wgsl';

// Shader chunks - Lighting and shading
export * from './chunks/lighting.wgsl';
export * from './chunks/fog.wgsl';
export * from './chunks/interior.wgsl';

// Shader chunks - Color and appearance
export * from './chunks/color.wgsl';
export * from './chunks/marker.wgsl';
export * from './chunks/size.wgsl';

// Shader chunks - Transparency (OIT)
export * from './chunks/transparency.wgsl';

// Shader chunks - Clipping
export * from './chunks/clipping.wgsl';

// Shaders
export * from './mesh.wgsl';
export * from './spheres.wgsl';
export * from './cylinders.wgsl';
export * from './points.wgsl';
export * from './lines.wgsl';
export * from './text.wgsl';
