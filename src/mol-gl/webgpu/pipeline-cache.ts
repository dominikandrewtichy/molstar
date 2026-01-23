/**
 * Copyright (c) 2025 mol* contributors, licensed under MIT, See LICENSE file for more info.
 *
 * @author Alexander Rose <alexander.rose@weirdbyte.de>
 */

import { GPUContext } from '../gpu/context';
import {
    RenderPipeline,
    RenderPipelineDescriptor,
    ComputePipeline,
    ComputePipelineDescriptor,
    BlendState,
    DepthStencilState,
    CullMode,
} from '../gpu/pipeline';
import { TextureFormat } from '../gpu/texture';

/**
 * Render variant types used in Mol*.
 */
export type RenderVariant = 'color' | 'pick' | 'depth' | 'marking' | 'emissive' | 'tracing';

/**
 * Transparency modes.
 */
export type TransparencyMode = 'opaque' | 'blended' | 'wboit' | 'dpoit';

/**
 * Blend mode presets.
 */
export type BlendMode = 'none' | 'normal' | 'additive' | 'multiply';

/**
 * Pipeline key for caching.
 */
export interface PipelineKey {
    /** Shader identifier */
    shaderId: string;
    /** Render variant */
    variant: RenderVariant;
    /** Transparency mode */
    transparency: TransparencyMode;
    /** Cull mode */
    cullMode: CullMode;
    /** Depth testing enabled */
    depthTest: boolean;
    /** Depth writing enabled */
    depthWrite: boolean;
    /** Blend mode */
    blendMode: BlendMode;
    /** Color attachment format */
    colorFormat: TextureFormat;
    /** Depth attachment format */
    depthFormat: TextureFormat;
    /** MSAA sample count */
    sampleCount: number;
}

/**
 * Create a hash key from a pipeline key.
 */
function hashPipelineKey(key: PipelineKey): string {
    return JSON.stringify(key);
}

/**
 * Get blend state for a blend mode.
 */
export function getBlendState(mode: BlendMode): BlendState | undefined {
    switch (mode) {
        case 'none':
            return undefined;
        case 'normal':
            return {
                color: {
                    operation: 'add',
                    srcFactor: 'src-alpha',
                    dstFactor: 'one-minus-src-alpha',
                },
                alpha: {
                    operation: 'add',
                    srcFactor: 'one',
                    dstFactor: 'one-minus-src-alpha',
                },
            };
        case 'additive':
            return {
                color: {
                    operation: 'add',
                    srcFactor: 'src-alpha',
                    dstFactor: 'one',
                },
                alpha: {
                    operation: 'add',
                    srcFactor: 'one',
                    dstFactor: 'one',
                },
            };
        case 'multiply':
            return {
                color: {
                    operation: 'add',
                    srcFactor: 'dst',
                    dstFactor: 'zero',
                },
                alpha: {
                    operation: 'add',
                    srcFactor: 'dst-alpha',
                    dstFactor: 'zero',
                },
            };
    }
}

/**
 * Get depth stencil state for common configurations.
 */
export function getDepthStencilState(
    format: TextureFormat,
    depthTest: boolean,
    depthWrite: boolean
): DepthStencilState {
    return {
        format,
        depthWriteEnabled: depthWrite,
        depthCompare: depthTest ? 'less' : 'always',
    };
}

/**
 * Pipeline cache for managing render and compute pipelines.
 * Handles the pipeline permutation problem by caching pipelines based on state combinations.
 */
export class PipelineCache {
    private _context: GPUContext;
    private _renderPipelineCache = new Map<string, RenderPipeline>();
    private _computePipelineCache = new Map<string, ComputePipeline>();
    private _pipelineCreators = new Map<string, (key: PipelineKey) => RenderPipelineDescriptor>();

    constructor(context: GPUContext) {
        this._context = context;
    }

    /**
     * Register a pipeline creator for a shader.
     * The creator function receives a pipeline key and returns a full pipeline descriptor.
     */
    registerPipelineCreator(
        shaderId: string,
        creator: (key: PipelineKey) => RenderPipelineDescriptor
    ): void {
        this._pipelineCreators.set(shaderId, creator);
    }

    /**
     * Get or create a render pipeline for the given key.
     */
    getRenderPipeline(key: PipelineKey): RenderPipeline {
        const hash = hashPipelineKey(key);

        let pipeline = this._renderPipelineCache.get(hash);
        if (pipeline) {
            return pipeline;
        }

        // Create new pipeline
        const creator = this._pipelineCreators.get(key.shaderId);
        if (!creator) {
            throw new Error(`No pipeline creator registered for shader: ${key.shaderId}`);
        }

        const descriptor = creator(key);
        pipeline = this._context.createRenderPipeline(descriptor);
        this._renderPipelineCache.set(hash, pipeline);

        return pipeline;
    }

    /**
     * Get or create a compute pipeline.
     */
    getComputePipeline(id: string, descriptor: ComputePipelineDescriptor): ComputePipeline {
        let pipeline = this._computePipelineCache.get(id);
        if (pipeline) {
            return pipeline;
        }

        pipeline = this._context.createComputePipeline(descriptor);
        this._computePipelineCache.set(id, pipeline);

        return pipeline;
    }

    /**
     * Check if a render pipeline exists in the cache.
     */
    hasRenderPipeline(key: PipelineKey): boolean {
        return this._renderPipelineCache.has(hashPipelineKey(key));
    }

    /**
     * Check if a compute pipeline exists in the cache.
     */
    hasComputePipeline(id: string): boolean {
        return this._computePipelineCache.has(id);
    }

    /**
     * Remove a render pipeline from the cache.
     */
    removeRenderPipeline(key: PipelineKey): boolean {
        const hash = hashPipelineKey(key);
        const pipeline = this._renderPipelineCache.get(hash);
        if (pipeline) {
            pipeline.destroy();
            this._renderPipelineCache.delete(hash);
            return true;
        }
        return false;
    }

    /**
     * Remove a compute pipeline from the cache.
     */
    removeComputePipeline(id: string): boolean {
        const pipeline = this._computePipelineCache.get(id);
        if (pipeline) {
            pipeline.destroy();
            this._computePipelineCache.delete(id);
            return true;
        }
        return false;
    }

    /**
     * Clear all cached pipelines.
     */
    clear(): void {
        this._renderPipelineCache.forEach((pipeline) => {
            pipeline.destroy();
        });
        this._renderPipelineCache.clear();

        this._computePipelineCache.forEach((pipeline) => {
            pipeline.destroy();
        });
        this._computePipelineCache.clear();
    }

    /**
     * Get the number of cached render pipelines.
     */
    get renderPipelineCount(): number {
        return this._renderPipelineCache.size;
    }

    /**
     * Get the number of cached compute pipelines.
     */
    get computePipelineCount(): number {
        return this._computePipelineCache.size;
    }

    /**
     * Destroy the cache and all pipelines.
     */
    destroy(): void {
        this.clear();
        this._pipelineCreators.clear();
    }
}

/**
 * Pre-defined pipeline keys for common Mol* rendering configurations.
 */
export const CommonPipelineKeys = {
    /** Standard opaque mesh rendering */
    opaqueColor: (shaderId: string, colorFormat: TextureFormat, depthFormat: TextureFormat, sampleCount: number = 1): PipelineKey => ({
        shaderId,
        variant: 'color',
        transparency: 'opaque',
        cullMode: 'back',
        depthTest: true,
        depthWrite: true,
        blendMode: 'none',
        colorFormat,
        depthFormat,
        sampleCount,
    }),

    /** Transparent blended rendering */
    transparentBlended: (shaderId: string, colorFormat: TextureFormat, depthFormat: TextureFormat, sampleCount: number = 1): PipelineKey => ({
        shaderId,
        variant: 'color',
        transparency: 'blended',
        cullMode: 'none',
        depthTest: true,
        depthWrite: false,
        blendMode: 'normal',
        colorFormat,
        depthFormat,
        sampleCount,
    }),

    /** Pick pass rendering */
    pick: (shaderId: string, colorFormat: TextureFormat, depthFormat: TextureFormat, sampleCount: number = 1): PipelineKey => ({
        shaderId,
        variant: 'pick',
        transparency: 'opaque',
        cullMode: 'back',
        depthTest: true,
        depthWrite: true,
        blendMode: 'none',
        colorFormat,
        depthFormat,
        sampleCount,
    }),

    /** Depth pre-pass rendering */
    depth: (shaderId: string, depthFormat: TextureFormat, sampleCount: number = 1): PipelineKey => ({
        shaderId,
        variant: 'depth',
        transparency: 'opaque',
        cullMode: 'back',
        depthTest: true,
        depthWrite: true,
        blendMode: 'none',
        colorFormat: 'rgba8unorm', // Not used but required
        depthFormat,
        sampleCount,
    }),

    /** Marking/highlight pass rendering */
    marking: (shaderId: string, colorFormat: TextureFormat, depthFormat: TextureFormat, sampleCount: number = 1): PipelineKey => ({
        shaderId,
        variant: 'marking',
        transparency: 'blended',
        cullMode: 'back',
        depthTest: true,
        depthWrite: false,
        blendMode: 'normal',
        colorFormat,
        depthFormat,
        sampleCount,
    }),

    /** WBOIT accumulation pass */
    wboitAccum: (shaderId: string, colorFormat: TextureFormat, depthFormat: TextureFormat, sampleCount: number = 1): PipelineKey => ({
        shaderId,
        variant: 'color',
        transparency: 'wboit',
        cullMode: 'none',
        depthTest: true,
        depthWrite: false,
        blendMode: 'additive',
        colorFormat,
        depthFormat,
        sampleCount,
    }),
};
