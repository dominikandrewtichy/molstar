/**
 * Copyright (c) 2025 mol* contributors, licensed under MIT, See LICENSE file for more info.
 *
 * @author Alexander Rose <alexander.rose@weirdbyte.de>
 */

import { Subject } from 'rxjs';
import { now } from '../../mol-util/now';
import { Buffer, BufferDescriptor } from './buffer';
import { Texture, TextureDescriptor, TextureView, TextureViewDescriptor, Sampler, SamplerDescriptor, TextureFormat } from './texture';
import { BindGroup, BindGroupDescriptor, BindGroupLayout, BindGroupLayoutDescriptor, PipelineLayout, PipelineLayoutDescriptor } from './bind-group';
import { RenderPipeline, RenderPipelineDescriptor, ComputePipeline, ComputePipelineDescriptor, ShaderModule, ShaderModuleDescriptor } from './pipeline';
import { CommandEncoder, CommandBuffer, RenderPassDescriptor, RenderPassEncoder, ComputePassEncoder, RenderTarget, RenderTargetOptions } from './render-pass';

export type GPUBackend = 'webgl' | 'webgpu';

export interface GPUContextDescriptor {
    canvas: HTMLCanvasElement | OffscreenCanvas;
    pixelScale?: number;
    preferredBackend?: GPUBackend | 'auto';
}

export interface GPULimits {
    readonly maxTextureSize: number;
    readonly max3dTextureSize: number;
    readonly maxRenderbufferSize: number;
    readonly maxDrawBuffers: number;
    readonly maxTextureImageUnits: number;
    readonly maxVertexAttribs: number;
    readonly maxComputeWorkgroupSizeX: number;
    readonly maxComputeWorkgroupSizeY: number;
    readonly maxComputeWorkgroupSizeZ: number;
    readonly maxComputeWorkgroupsPerDimension: number;
    readonly maxStorageBufferBindingSize: number;
    readonly maxUniformBufferBindingSize: number;
}

export interface GPUStats {
    resourceCounts: {
        buffer: number;
        texture: number;
        sampler: number;
        bindGroup: number;
        bindGroupLayout: number;
        pipelineLayout: number;
        renderPipeline: number;
        computePipeline: number;
        shaderModule: number;
    };
    drawCount: number;
    instanceCount: number;
    instancedDrawCount: number;
}

/**
 * Abstract GPU context interface that can be implemented by both WebGL and WebGPU backends.
 */
export interface GPUContext {
    readonly backend: GPUBackend;
    readonly canvas: HTMLCanvasElement | OffscreenCanvas;
    readonly pixelRatio: number;
    readonly limits: GPULimits;
    readonly stats: GPUStats;
    /** Preferred texture format for the canvas */
    readonly preferredFormat: TextureFormat;
    /** Whether this is a WebGL2 or WebGPU context (both support modern features) */
    readonly isModernContext: boolean;

    // Resource creation
    createBuffer(descriptor: BufferDescriptor): Buffer;
    createTexture(descriptor: TextureDescriptor): Texture;
    createTextureView(texture: Texture, descriptor?: TextureViewDescriptor): TextureView;
    createSampler(descriptor: SamplerDescriptor): Sampler;
    createBindGroupLayout(descriptor: BindGroupLayoutDescriptor): BindGroupLayout;
    createBindGroup(descriptor: BindGroupDescriptor): BindGroup;
    createPipelineLayout(descriptor: PipelineLayoutDescriptor): PipelineLayout;
    createRenderPipeline(descriptor: RenderPipelineDescriptor): RenderPipeline;
    createComputePipeline(descriptor: ComputePipelineDescriptor): ComputePipeline;
    createShaderModule(descriptor: ShaderModuleDescriptor): ShaderModule;

    // Render target creation (for Canvas3D integration)
    /**
     * Create a render target for offscreen rendering.
     * This creates a texture and framebuffer (or render pass) that can be rendered to.
     */
    createRenderTarget(options: RenderTargetOptions): RenderTarget;
    /**
     * Create a draw target that represents the main drawing buffer.
     * This is used for rendering to the canvas directly.
     */
    createDrawTarget(): RenderTarget;

    // Named resource caches (for Canvas3D integration)
    /** Cache for named textures, managed by consumers */
    readonly namedTextures: { [name: string]: Texture };
    /** Cache for named render targets, managed by consumers */
    readonly namedRenderTargets: { [name: string]: RenderTarget };

    // Command encoding
    createCommandEncoder(): CommandEncoder;
    submit(commandBuffers: CommandBuffer[]): void;

    // Render pass helpers
    beginRenderPass(encoder: CommandEncoder, descriptor: RenderPassDescriptor): RenderPassEncoder;
    beginComputePass(encoder: CommandEncoder): ComputePassEncoder;

    // Canvas management
    getCurrentTexture(): Texture;
    resize(width: number, height: number): void;
    getDrawingBufferSize(): { width: number; height: number };
    /** Bind the main drawing buffer for rendering */
    bindDrawingBuffer(): void;

    // Utility methods (for Canvas3D integration)
    /**
     * Clear the current drawing buffer with the specified color.
     * This also clears depth and stencil if available.
     */
    clear(red: number, green: number, blue: number, alpha: number): void;
    /**
     * Check for errors (debugging utility).
     * In WebGL this checks glGetError, in WebGPU this is a no-op (errors are reported via validation).
     */
    checkError(message?: string): void;

    // Synchronization
    waitForGpuCommandsComplete(): Promise<void>;
    /** Synchronous fence check - blocks until GPU commands complete */
    waitForGpuCommandsCompleteSync(): void;
    /** Create a fence sync object for async checking */
    getFenceSync(): unknown | null;
    /** Check if a fence sync has signaled */
    checkSyncStatus(sync: unknown): boolean;
    /** Delete a fence sync object */
    deleteSync(sync: unknown): void;

    // Pixel reading
    readPixels(x: number, y: number, width: number, height: number, buffer: Uint8Array | Float32Array | Int32Array): void;

    // Lifecycle
    readonly isContextLost: boolean;
    readonly contextRestored: Subject<now.Timestamp>;
    setContextLost(): void;
    handleContextRestored(extraResets?: () => void): void;

    setPixelScale(value: number): void;

    destroy(): void;
}

/**
 * Check if WebGPU is supported in the current environment.
 */
export function isWebGPUSupported(): boolean {
    return typeof navigator !== 'undefined' && 'gpu' in navigator;
}

/**
 * Check if WebGL2 is supported in the current environment.
 */
export function isWebGL2Supported(): boolean {
    if (typeof document === 'undefined') return false;
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2');
    return gl !== null;
}

/**
 * Determine the best available GPU backend.
 */
export function getBestAvailableBackend(): GPUBackend {
    if (isWebGPUSupported()) return 'webgpu';
    return 'webgl';
}

/**
 * Create stats object for tracking GPU resource usage.
 */
export function createGPUStats(): GPUStats {
    return {
        resourceCounts: {
            buffer: 0,
            texture: 0,
            sampler: 0,
            bindGroup: 0,
            bindGroupLayout: 0,
            pipelineLayout: 0,
            renderPipeline: 0,
            computePipeline: 0,
            shaderModule: 0,
        },
        drawCount: 0,
        instanceCount: 0,
        instancedDrawCount: 0,
    };
}

/**
 * Type guard to check if a GPUContext is backed by WebGL.
 * When true, the context can be cast to WebGLBackedGPUContext to access the underlying WebGLContext.
 */
export function isWebGLBackedContext(context: GPUContext): context is WebGLBackedGPUContext {
    return context.backend === 'webgl';
}

/**
 * Extended GPUContext interface for WebGL-backed contexts.
 * Provides access to the underlying WebGLContext for backward compatibility during migration.
 */
export interface WebGLBackedGPUContext extends GPUContext {
    readonly backend: 'webgl';

    /**
     * Get the underlying WebGLContext for backward compatibility.
     * This is useful during the migration period when some code still requires WebGLContext.
     * @deprecated Use GPUContext methods instead when possible.
     */
    getWebGLContext(): import('../webgl/context').WebGLContext;
}
