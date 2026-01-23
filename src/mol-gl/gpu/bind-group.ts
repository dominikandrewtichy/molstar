/**
 * Copyright (c) 2025 mol* contributors, licensed under MIT, See LICENSE file for more info.
 *
 * @author Alexander Rose <alexander.rose@weirdbyte.de>
 */

import { idFactory } from '../../mol-util/id-factory';
import { Buffer } from './buffer';
import { Sampler, TextureSampleType, TextureView, TextureViewDimension } from './texture';

const getNextBindGroupId = idFactory();
const getNextBindGroupLayoutId = idFactory();
const getNextPipelineLayoutId = idFactory();

/**
 * Shader stage visibility flags.
 */
export type ShaderStage = 'vertex' | 'fragment' | 'compute';

/**
 * Buffer binding type.
 */
export type BufferBindingType = 'uniform' | 'storage' | 'read-only-storage';

/**
 * Sampler binding type.
 */
export type SamplerBindingType = 'filtering' | 'non-filtering' | 'comparison';

/**
 * Storage texture access mode.
 */
export type StorageTextureAccess = 'write-only' | 'read-only' | 'read-write';

/**
 * Buffer binding layout entry.
 */
export interface BufferBindingLayoutEntry {
    type: BufferBindingType;
    /** If true, buffer binding requires a dynamic offset */
    hasDynamicOffset?: boolean;
    /** Minimum binding size in bytes */
    minBindingSize?: number;
}

/**
 * Sampler binding layout entry.
 */
export interface SamplerBindingLayoutEntry {
    type: SamplerBindingType;
}

/**
 * Texture binding layout entry.
 */
export interface TextureBindingLayoutEntry {
    sampleType?: TextureSampleType;
    viewDimension?: TextureViewDimension;
    multisampled?: boolean;
}

/**
 * Storage texture binding layout entry.
 */
export interface StorageTextureBindingLayoutEntry {
    access?: StorageTextureAccess;
    format: string;
    viewDimension?: TextureViewDimension;
}

/**
 * Bind group layout entry.
 */
export interface BindGroupLayoutEntry {
    /** Binding number */
    binding: number;
    /** Shader stages that can access this binding */
    visibility: ShaderStage[];
    /** Buffer binding layout (mutually exclusive with sampler, texture, storageTexture) */
    buffer?: BufferBindingLayoutEntry;
    /** Sampler binding layout */
    sampler?: SamplerBindingLayoutEntry;
    /** Texture binding layout */
    texture?: TextureBindingLayoutEntry;
    /** Storage texture binding layout */
    storageTexture?: StorageTextureBindingLayoutEntry;
}

/**
 * Descriptor for creating a bind group layout.
 */
export interface BindGroupLayoutDescriptor {
    /** Entries in the bind group layout */
    entries: BindGroupLayoutEntry[];
    /** Optional label for debugging */
    label?: string;
}

/**
 * Abstract bind group layout interface.
 */
export interface BindGroupLayout {
    readonly id: number;

    /**
     * Destroy the bind group layout.
     */
    destroy(): void;
}

/**
 * Buffer binding in a bind group.
 */
export interface BufferBinding {
    buffer: Buffer;
    /** Offset in bytes from the start of the buffer */
    offset?: number;
    /** Size in bytes to bind (default: buffer.size - offset) */
    size?: number;
}

/**
 * Bind group entry.
 */
export interface BindGroupEntry {
    /** Binding number (must match layout) */
    binding: number;
    /** Resource to bind (buffer, sampler, or texture view) */
    resource: BufferBinding | Sampler | TextureView;
}

/**
 * Descriptor for creating a bind group.
 */
export interface BindGroupDescriptor {
    /** Layout that this bind group conforms to */
    layout: BindGroupLayout;
    /** Entries in the bind group */
    entries: BindGroupEntry[];
    /** Optional label for debugging */
    label?: string;
}

/**
 * Abstract bind group interface.
 */
export interface BindGroup {
    readonly id: number;
    readonly layout: BindGroupLayout;

    /**
     * Destroy the bind group.
     */
    destroy(): void;
}

/**
 * Descriptor for creating a pipeline layout.
 */
export interface PipelineLayoutDescriptor {
    /** Bind group layouts */
    bindGroupLayouts: BindGroupLayout[];
    /** Optional label for debugging */
    label?: string;
}

/**
 * Abstract pipeline layout interface.
 */
export interface PipelineLayout {
    readonly id: number;
    readonly bindGroupLayouts: readonly BindGroupLayout[];

    /**
     * Destroy the pipeline layout.
     */
    destroy(): void;
}

/**
 * Create a new bind group ID.
 */
export function createBindGroupId(): number {
    return getNextBindGroupId();
}

/**
 * Create a new bind group layout ID.
 */
export function createBindGroupLayoutId(): number {
    return getNextBindGroupLayoutId();
}

/**
 * Create a new pipeline layout ID.
 */
export function createPipelineLayoutId(): number {
    return getNextPipelineLayoutId();
}

/**
 * Check if a bind group entry is a buffer binding.
 */
export function isBufferBinding(entry: BufferBinding | Sampler | TextureView): entry is BufferBinding {
    return 'buffer' in entry;
}

/**
 * Convert shader stages to visibility mask.
 */
export function shaderStagesToMask(stages: ShaderStage[]): number {
    let mask = 0;
    for (const stage of stages) {
        switch (stage) {
            case 'vertex':
                mask |= 1;
                break;
            case 'fragment':
                mask |= 2;
                break;
            case 'compute':
                mask |= 4;
                break;
        }
    }
    return mask;
}
