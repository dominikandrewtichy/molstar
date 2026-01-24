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
import { CommandEncoder, CommandBuffer, RenderPassDescriptor, RenderPassEncoder, ComputePassEncoder } from './render-pass';

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

    // Synchronization
    waitForGpuCommandsComplete(): Promise<void>;

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
