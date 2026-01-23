/**
 * Copyright (c) 2025 mol* contributors, licensed under MIT, See LICENSE file for more info.
 *
 * @author Alexander Rose <alexander.rose@weirdbyte.de>
 */

import { idFactory } from '../../mol-util/id-factory';

const getNextTextureId = idFactory();

/**
 * Texture formats supported by both WebGL and WebGPU.
 */
export type TextureFormat =
    // 8-bit formats
    | 'r8unorm'
    | 'r8snorm'
    | 'r8uint'
    | 'r8sint'
    // 16-bit formats
    | 'r16uint'
    | 'r16sint'
    | 'r16float'
    | 'rg8unorm'
    | 'rg8snorm'
    | 'rg8uint'
    | 'rg8sint'
    // 32-bit formats
    | 'r32uint'
    | 'r32sint'
    | 'r32float'
    | 'rg16uint'
    | 'rg16sint'
    | 'rg16float'
    | 'rgba8unorm'
    | 'rgba8snorm'
    | 'rgba8uint'
    | 'rgba8sint'
    // 64-bit formats
    | 'rg32uint'
    | 'rg32sint'
    | 'rg32float'
    | 'rgba16uint'
    | 'rgba16sint'
    | 'rgba16float'
    // 128-bit formats
    | 'rgba32uint'
    | 'rgba32sint'
    | 'rgba32float'
    // Depth/stencil formats
    | 'depth16unorm'
    | 'depth24plus'
    | 'depth24plus-stencil8'
    | 'depth32float'
    | 'depth32float-stencil8';

/**
 * Texture dimension.
 */
export type TextureDimension = '1d' | '2d' | '3d';

/**
 * Texture view dimension.
 */
export type TextureViewDimension = '1d' | '2d' | '2d-array' | 'cube' | 'cube-array' | '3d';

/**
 * Texture usage flags.
 */
export type TextureUsage =
    | 'copy-src'
    | 'copy-dst'
    | 'texture-binding'
    | 'storage-binding'
    | 'render-attachment';

/**
 * Texture sample type.
 */
export type TextureSampleType = 'float' | 'unfilterable-float' | 'depth' | 'sint' | 'uint';

/**
 * Descriptor for creating a texture.
 */
export interface TextureDescriptor {
    /** Size of the texture [width, height, depthOrArrayLayers] */
    size: [number, number, number?];
    /** Format of the texture */
    format: TextureFormat;
    /** Dimension of the texture */
    dimension?: TextureDimension;
    /** Number of mip levels */
    mipLevelCount?: number;
    /** Sample count for MSAA */
    sampleCount?: number;
    /** Usage flags */
    usage: TextureUsage[];
    /** Optional label for debugging */
    label?: string;
}

/**
 * Descriptor for creating a texture view.
 */
export interface TextureViewDescriptor {
    /** Format of the view (defaults to texture format) */
    format?: TextureFormat;
    /** Dimension of the view */
    dimension?: TextureViewDimension;
    /** Base mip level */
    baseMipLevel?: number;
    /** Number of mip levels to include */
    mipLevelCount?: number;
    /** Base array layer */
    baseArrayLayer?: number;
    /** Number of array layers to include */
    arrayLayerCount?: number;
    /** Optional label for debugging */
    label?: string;
}

/**
 * Abstract texture interface.
 */
export interface Texture {
    readonly id: number;
    readonly width: number;
    readonly height: number;
    readonly depth: number;
    readonly format: TextureFormat;
    readonly dimension: TextureDimension;
    readonly mipLevelCount: number;
    readonly sampleCount: number;

    /**
     * Write data to the texture.
     */
    write(
        data: ArrayBufferView,
        options?: {
            origin?: [number, number, number];
            size?: [number, number, number];
            mipLevel?: number;
            bytesPerRow?: number;
            rowsPerImage?: number;
        }
    ): void;

    /**
     * Create a view of this texture.
     */
    createView(descriptor?: TextureViewDescriptor): TextureView;

    /**
     * Get byte count of the texture.
     */
    getByteCount(): number;

    /**
     * Reset the texture after context loss.
     */
    reset(): void;

    /**
     * Destroy the texture and release GPU resources.
     */
    destroy(): void;
}

/**
 * Abstract texture view interface.
 */
export interface TextureView {
    readonly id: number;
    readonly texture: Texture;
    readonly format: TextureFormat;
    readonly dimension: TextureViewDimension;

    /**
     * Destroy the texture view.
     */
    destroy(): void;
}

/**
 * Address mode for texture sampling.
 */
export type AddressMode = 'clamp-to-edge' | 'repeat' | 'mirror-repeat';

/**
 * Filter mode for texture sampling.
 */
export type FilterMode = 'nearest' | 'linear';

/**
 * Mipmap filter mode.
 */
export type MipmapFilterMode = 'nearest' | 'linear';

/**
 * Compare function for depth textures.
 */
export type CompareFunction = 'never' | 'less' | 'equal' | 'less-equal' | 'greater' | 'not-equal' | 'greater-equal' | 'always';

/**
 * Descriptor for creating a sampler.
 */
export interface SamplerDescriptor {
    /** Address mode for U coordinate */
    addressModeU?: AddressMode;
    /** Address mode for V coordinate */
    addressModeV?: AddressMode;
    /** Address mode for W coordinate */
    addressModeW?: AddressMode;
    /** Magnification filter */
    magFilter?: FilterMode;
    /** Minification filter */
    minFilter?: FilterMode;
    /** Mipmap filter */
    mipmapFilter?: MipmapFilterMode;
    /** LOD clamp minimum */
    lodMinClamp?: number;
    /** LOD clamp maximum */
    lodMaxClamp?: number;
    /** Compare function for depth textures */
    compare?: CompareFunction;
    /** Maximum anisotropy */
    maxAnisotropy?: number;
    /** Optional label for debugging */
    label?: string;
}

/**
 * Abstract sampler interface.
 */
export interface Sampler {
    readonly id: number;

    /**
     * Destroy the sampler.
     */
    destroy(): void;
}

/**
 * Create a new texture ID.
 */
export function createTextureId(): number {
    return getNextTextureId();
}

/**
 * Check if a format is a depth format.
 */
export function isDepthFormat(format: TextureFormat): boolean {
    return format.startsWith('depth');
}

/**
 * Check if a format is a stencil format.
 */
export function isStencilFormat(format: TextureFormat): boolean {
    return format.includes('stencil');
}

/**
 * Get bytes per pixel for a texture format.
 */
export function getBytesPerPixel(format: TextureFormat): number {
    switch (format) {
        case 'r8unorm':
        case 'r8snorm':
        case 'r8uint':
        case 'r8sint':
            return 1;
        case 'r16uint':
        case 'r16sint':
        case 'r16float':
        case 'rg8unorm':
        case 'rg8snorm':
        case 'rg8uint':
        case 'rg8sint':
        case 'depth16unorm':
            return 2;
        case 'r32uint':
        case 'r32sint':
        case 'r32float':
        case 'rg16uint':
        case 'rg16sint':
        case 'rg16float':
        case 'rgba8unorm':
        case 'rgba8snorm':
        case 'rgba8uint':
        case 'rgba8sint':
        case 'depth24plus':
        case 'depth32float':
            return 4;
        case 'depth24plus-stencil8':
            return 4;
        case 'rg32uint':
        case 'rg32sint':
        case 'rg32float':
        case 'rgba16uint':
        case 'rgba16sint':
        case 'rgba16float':
        case 'depth32float-stencil8':
            return 8;
        case 'rgba32uint':
        case 'rgba32sint':
        case 'rgba32float':
            return 16;
    }
}
