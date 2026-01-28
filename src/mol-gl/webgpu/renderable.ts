/**
 * Copyright (c) 2025 mol* contributors, licensed under MIT, See LICENSE file for more info.
 *
 * @author Alexander Rose <alexander.rose@weirdbyte.de>
 */

import { ValueCell } from '../../mol-util/value-cell';
import { idFactory } from '../../mol-util/id-factory';
import { GPUContext, Buffer, Texture, BindGroup, RenderPipeline, RenderPassEncoder } from '../gpu';

const getNextRenderableId = idFactory();

/**
 * Render variants supported by WebGPU renderables.
 */
export type WebGPURenderVariant = 'color' | 'pick' | 'depth' | 'marking' | 'emissive' | 'tracing';

/**
 * State for a WebGPU renderable.
 */
export interface WebGPURenderableState {
    disposed: boolean;
    visible: boolean;
    alphaFactor: number;
    pickable: boolean;
    colorOnly: boolean;
    opaque: boolean;
    writeDepth: boolean;
}

/**
 * Transparency mode for WebGPU rendering.
 */
export type WebGPUTransparency = 'opaque' | 'blended' | 'wboit' | 'dpoit';

/**
 * Primitive topology types.
 */
export type WebGPUPrimitiveTopology = 'point-list' | 'line-list' | 'line-strip' | 'triangle-list' | 'triangle-strip';

/**
 * Base interface for WebGPU renderables.
 */
export interface WebGPURenderable<T extends WebGPURenderableValues = WebGPURenderableValues> {
    readonly id: number;
    readonly materialId: number;
    readonly values: T;
    readonly state: WebGPURenderableState;

    /**
     * Record draw commands into the given render pass encoder.
     */
    render(passEncoder: RenderPassEncoder, variant: WebGPURenderVariant, sharedBindGroup?: BindGroup): void;

    /**
     * Get the pipeline for a specific render variant.
     */
    getPipeline(variant: WebGPURenderVariant): RenderPipeline;

    /**
     * Update GPU resources when values change.
     */
    update(): void;

    /**
     * Set transparency mode.
     */
    setTransparency(transparency: WebGPUTransparency): void;

    /**
     * Get memory usage in bytes.
     */
    getByteCount(): number;

    /**
     * Release GPU resources.
     */
    dispose(): void;
}

/**
 * Base interface for renderable values with reactive ValueCells.
 */
export interface WebGPURenderableValues {
    [key: string]: ValueCell<any>;
}

/**
 * Descriptor for creating a WebGPU renderable.
 */
export interface WebGPURenderableDescriptor<T extends WebGPURenderableValues> {
    /** The GPU context */
    context: GPUContext;
    /** Material ID for sorting/batching */
    materialId: number;
    /** Primitive topology */
    topology: WebGPUPrimitiveTopology;
    /** Initial values */
    values: T;
    /** Initial state */
    state: WebGPURenderableState;
    /** Transparency mode */
    transparency: WebGPUTransparency;
    /** Vertex shader source (WGSL) */
    vertexShader: string;
    /** Fragment shader sources (WGSL) for each variant */
    fragmentShaders: Record<WebGPURenderVariant, string>;
    /** Vertex buffer layouts */
    vertexBufferLayouts: GPUVertexBufferLayout[];
    /** Bind group layout descriptors */
    bindGroupLayouts: GPUBindGroupLayoutDescriptor[];
}

/**
 * Vertex buffer layout descriptor for WebGPU.
 */
export interface GPUVertexBufferLayout {
    arrayStride: number;
    stepMode: 'vertex' | 'instance';
    attributes: GPUVertexAttribute[];
}

/**
 * Vertex attribute descriptor.
 */
export interface GPUVertexAttribute {
    format: GPUVertexFormat;
    offset: number;
    shaderLocation: number;
}

/**
 * Vertex format types (subset commonly used in Mol*).
 */
export type GPUVertexFormat =
    | 'float32' | 'float32x2' | 'float32x3' | 'float32x4'
    | 'sint32' | 'sint32x2' | 'sint32x3' | 'sint32x4'
    | 'uint32' | 'uint32x2' | 'uint32x3' | 'uint32x4';

/**
 * Bind group layout descriptor.
 */
export interface GPUBindGroupLayoutDescriptor {
    entries: GPUBindGroupLayoutEntry[];
}

/**
 * Bind group layout entry.
 */
export interface GPUBindGroupLayoutEntry {
    binding: number;
    visibility: number; // GPUShaderStage flags
    buffer?: { type: 'uniform' | 'storage' | 'read-only-storage' };
    sampler?: { type: 'filtering' | 'non-filtering' | 'comparison' };
    texture?: { sampleType: 'float' | 'unfilterable-float' | 'depth' | 'sint' | 'uint'; viewDimension?: '1d' | '2d' | '3d' | 'cube' | '2d-array' | 'cube-array' };
    storageTexture?: { access: 'write-only'; format: string; viewDimension?: '1d' | '2d' | '2d-array' | '3d' };
}

/**
 * GPU buffer with version tracking.
 */
export interface VersionedBuffer {
    buffer: Buffer;
    version: number;
}

/**
 * GPU texture with version tracking.
 */
export interface VersionedTexture {
    texture: Texture;
    version: number;
}

/**
 * Abstract base class for WebGPU renderables.
 * Provides common functionality for resource management and rendering.
 */
export abstract class WebGPURenderableBase<T extends WebGPURenderableValues> implements WebGPURenderable<T> {
    readonly id: number;
    readonly materialId: number;
    readonly values: T;
    readonly state: WebGPURenderableState;

    protected context: GPUContext;
    protected transparency: WebGPUTransparency;
    protected topology: WebGPUPrimitiveTopology;

    /** Cached pipelines for each render variant */
    protected pipelines: Map<WebGPURenderVariant, RenderPipeline> = new Map();

    /** Vertex buffers with version tracking */
    protected vertexBuffers: Map<string, VersionedBuffer> = new Map();

    /** Index buffer with version tracking */
    protected indexBuffer: VersionedBuffer | null = null;

    /** Uniform buffers with version tracking */
    protected uniformBuffers: Map<string, VersionedBuffer> = new Map();

    /** Textures with version tracking */
    protected textures: Map<string, VersionedTexture> = new Map();

    /** Bind groups for each group index */
    protected bindGroups: Map<number, BindGroup> = new Map();

    /** Whether bind groups need to be recreated */
    protected bindGroupsDirty = true;

    constructor(descriptor: WebGPURenderableDescriptor<T>) {
        this.id = getNextRenderableId();
        this.context = descriptor.context;
        this.materialId = descriptor.materialId;
        this.values = descriptor.values;
        this.state = descriptor.state;
        this.transparency = descriptor.transparency;
        this.topology = descriptor.topology;

        // Initialize resources
        this.createPipelines(descriptor);
    }

    /**
     * Create render pipelines for all variants.
     * Must be implemented by subclasses.
     */
    protected abstract createPipelines(descriptor: WebGPURenderableDescriptor<T>): void;

    /**
     * Create bind groups from current values.
     * Must be implemented by subclasses.
     */
    protected abstract createBindGroups(): void;

    /**
     * Upload changed values to GPU buffers.
     * Must be implemented by subclasses.
     */
    protected abstract uploadValues(): void;

    /**
     * Get the number of vertices/indices to draw.
     */
    protected abstract getDrawCount(): number;

    /**
     * Get the number of instances to draw.
     */
    protected abstract getInstanceCount(): number;

    render(passEncoder: RenderPassEncoder, variant: WebGPURenderVariant, sharedBindGroup?: BindGroup): void {
        if (this.state.disposed || !this.state.visible) return;

        const pipeline = this.pipelines.get(variant);
        if (!pipeline) return;

        // Update resources if needed
        if (this.bindGroupsDirty) {
            this.uploadValues();
            this.createBindGroups();
            this.bindGroupsDirty = false;
        }

        // Set pipeline
        passEncoder.setPipeline(pipeline);

        // Set bind groups
        if (sharedBindGroup) {
            passEncoder.setBindGroup(0, sharedBindGroup);
        }

        for (const [index, bindGroup] of this.bindGroups) {
            passEncoder.setBindGroup(index, bindGroup);
        }

        // Set vertex buffers
        let slot = 0;
        for (const [, vb] of this.vertexBuffers) {
            passEncoder.setVertexBuffer(slot++, vb.buffer);
        }

        // Draw
        const drawCount = this.getDrawCount();
        const instanceCount = this.getInstanceCount();

        if (this.indexBuffer) {
            passEncoder.setIndexBuffer(this.indexBuffer.buffer, 'uint32');
            passEncoder.drawIndexed(drawCount, instanceCount);
        } else {
            passEncoder.draw(drawCount, instanceCount);
        }
    }

    getPipeline(variant: WebGPURenderVariant): RenderPipeline {
        const pipeline = this.pipelines.get(variant);
        if (!pipeline) {
            throw new Error(`Pipeline for variant '${variant}' not found`);
        }
        return pipeline;
    }

    update(): void {
        // Check if any values have changed
        let needsUpdate = false;
        for (const key in this.values) {
            const cell = this.values[key];
            if (cell && cell.ref) {
                // Check vertex buffers
                const vb = this.vertexBuffers.get(key);
                if (vb && vb.version !== cell.ref.version) {
                    needsUpdate = true;
                    break;
                }

                // Check uniform buffers
                const ub = this.uniformBuffers.get(key);
                if (ub && ub.version !== cell.ref.version) {
                    needsUpdate = true;
                    break;
                }

                // Check textures
                const tex = this.textures.get(key);
                if (tex && tex.version !== cell.ref.version) {
                    needsUpdate = true;
                    break;
                }
            }
        }

        if (needsUpdate) {
            this.bindGroupsDirty = true;
        }
    }

    setTransparency(transparency: WebGPUTransparency): void {
        if (this.transparency !== transparency) {
            this.transparency = transparency;
            // Pipelines may need to be recreated for different blend states
            this.pipelines.clear();
        }
    }

    getByteCount(): number {
        let bytes = 0;

        for (const [, vb] of this.vertexBuffers) {
            bytes += vb.buffer.size;
        }

        if (this.indexBuffer) {
            bytes += this.indexBuffer.buffer.size;
        }

        for (const [, ub] of this.uniformBuffers) {
            bytes += ub.buffer.size;
        }

        // Add texture memory
        for (const [, tex] of this.textures) {
            bytes += tex.texture.getByteCount();
        }

        return bytes;
    }

    dispose(): void {
        this.state.disposed = true;

        // Destroy vertex buffers
        for (const [, vb] of this.vertexBuffers) {
            vb.buffer.destroy();
        }
        this.vertexBuffers.clear();

        // Destroy index buffer
        if (this.indexBuffer) {
            this.indexBuffer.buffer.destroy();
            this.indexBuffer = null;
        }

        // Destroy uniform buffers
        for (const [, ub] of this.uniformBuffers) {
            ub.buffer.destroy();
        }
        this.uniformBuffers.clear();

        // Destroy textures
        for (const [, tex] of this.textures) {
            tex.texture.destroy();
        }
        this.textures.clear();

        // Clear bind groups and pipelines
        this.bindGroups.clear();
        this.pipelines.clear();
    }
}

/**
 * Create default renderable state.
 */
export function createWebGPURenderableState(): WebGPURenderableState {
    return {
        disposed: false,
        visible: true,
        alphaFactor: 1,
        pickable: true,
        colorOnly: false,
        opaque: true,
        writeDepth: true,
    };
}

/**
 * Helper to convert attribute kind to WebGPU vertex format.
 */
export function attributeKindToVertexFormat(kind: string, itemSize: number): GPUVertexFormat {
    if (kind === 'float32') {
        switch (itemSize) {
            case 1: return 'float32';
            case 2: return 'float32x2';
            case 3: return 'float32x3';
            case 4: return 'float32x4';
        }
    } else if (kind === 'int32') {
        switch (itemSize) {
            case 1: return 'sint32';
            case 2: return 'sint32x2';
            case 3: return 'sint32x3';
            case 4: return 'sint32x4';
        }
    } else if (kind === 'uint32') {
        switch (itemSize) {
            case 1: return 'uint32';
            case 2: return 'uint32x2';
            case 3: return 'uint32x3';
            case 4: return 'uint32x4';
        }
    }

    throw new Error(`Unknown attribute kind '${kind}' with itemSize ${itemSize}`);
}

/**
 * Calculate array stride for a vertex format.
 */
export function vertexFormatToByteSize(format: GPUVertexFormat): number {
    const formatSizes: Record<GPUVertexFormat, number> = {
        'float32': 4, 'float32x2': 8, 'float32x3': 12, 'float32x4': 16,
        'sint32': 4, 'sint32x2': 8, 'sint32x3': 12, 'sint32x4': 16,
        'uint32': 4, 'uint32x2': 8, 'uint32x3': 12, 'uint32x4': 16,
    };
    return formatSizes[format];
}
