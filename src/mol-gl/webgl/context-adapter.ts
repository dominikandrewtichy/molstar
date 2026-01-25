/**
 * Copyright (c) 2025 mol* contributors, licensed under MIT, See LICENSE file for more info.
 *
 * @author Alexander Rose <alexander.rose@weirdbyte.de>
 */

import { Subject } from 'rxjs';
import { now } from '../../mol-util/now';
import {
    GPUContext,
    GPUContextDescriptor,
    GPULimits,
    GPUStats,
    createGPUStats,
    WebGLBackedGPUContext,
} from '../gpu/context';
import { WebGLContext, createContext as createWebGLContextImpl } from './context';
import {
    Buffer,
    BufferDescriptor,
    BufferUsage,
    createBufferId,
} from '../gpu/buffer';
import {
    Texture,
    TextureDescriptor,
    TextureView,
    TextureViewDescriptor,
    Sampler,
    SamplerDescriptor,
    TextureFormat,
    TextureDimension,
    TextureViewDimension,
    createTextureId,
    getBytesPerPixel,
} from '../gpu/texture';
import {
    BindGroup,
    BindGroupDescriptor,
    BindGroupLayout,
    BindGroupLayoutDescriptor,
    PipelineLayout,
    PipelineLayoutDescriptor,
    createBindGroupId,
    createBindGroupLayoutId,
    createPipelineLayoutId,
    isBufferBinding,
    BufferBinding,
    BindGroupEntry,
} from '../gpu/bind-group';
import {
    RenderPipeline,
    RenderPipelineDescriptor,
    ComputePipeline,
    ComputePipelineDescriptor,
    ShaderModule,
    ShaderModuleDescriptor,
    createPipelineId,
    createShaderModuleId,
    VertexFormat,
    IndexFormat,
} from '../gpu/pipeline';
import {
    CommandEncoder,
    CommandBuffer,
    RenderPassDescriptor,
    RenderPassEncoder,
    ComputePassEncoder,
    ColorAttachment,
    RenderTarget,
    RenderTargetOptions,
} from '../gpu/render-pass';
import { GLRenderingContext, isWebGL2 } from './compat';
import { getGLContext } from './context';
import { createExtensions, WebGLExtensions } from './extensions';
import { createState, WebGLState } from './state';
import {
    RenderState,
    DepthStencilStateDescriptor,
    blendFactorToGL,
    blendOperationToGL,
    compareFunctionToGL,
    stencilOperationToGL,
    faceToGL,
} from '../gpu/render-state';
import {
    BlendFactor,
    BlendOperation,
    BlendState,
    CullMode,
    FrontFace,
    StencilOperation,
} from '../gpu/pipeline';
import { CompareFunction } from '../gpu/texture';

/**
 * WebGL-specific context options.
 */
export interface WebGLAdapterContextOptions {
    /** WebGL context attributes */
    contextAttributes?: WebGLContextAttributes;
    /** Prefer WebGL1 over WebGL2 */
    preferWebGl1?: boolean;
}

/**
 * Create a WebGL context that implements the GPUContext interface.
 */
export function createWebGLAdapterContext(
    descriptor: GPUContextDescriptor,
    options?: WebGLAdapterContextOptions
): GPUContext {
    const canvas = descriptor.canvas as HTMLCanvasElement;
    const gl = getGLContext(canvas, {
        ...options?.contextAttributes,
        preferWebGl1: options?.preferWebGl1,
    });

    if (!gl) {
        throw new Error('Failed to get WebGL context');
    }

    return new WebGLAdapterContext(gl, canvas, descriptor.pixelScale);
}

/**
 * WebGL implementation of GPUContext interface.
 */
class WebGLAdapterContext implements WebGLBackedGPUContext {
    readonly backend = 'webgl' as const;
    readonly canvas: HTMLCanvasElement | OffscreenCanvas;
    readonly limits: GPULimits;
    readonly stats: GPUStats;
    readonly contextRestored: Subject<now.Timestamp>;
    readonly namedTextures: { [name: string]: Texture } = Object.create(null);
    readonly namedRenderTargets: { [name: string]: RenderTarget } = Object.create(null);
    readonly state: RenderState;

    private _gl: GLRenderingContext;
    private _extensions: WebGLExtensions;
    private _webglState: WebGLState;
    private _pixelScale: number;
    private _isContextLost: boolean = false;
    private _currentTexture: WebGLAdapterTexture | null = null;
    private _renderTargets: Set<WebGLAdapterRenderTarget> = new Set();
    private _webglContext: WebGLContext | null = null;

    constructor(
        gl: GLRenderingContext,
        canvas: HTMLCanvasElement | OffscreenCanvas,
        pixelScale?: number
    ) {
        this._gl = gl;
        this.canvas = canvas;
        this._pixelScale = pixelScale ?? 1;

        this._extensions = createExtensions(gl);
        this._webglState = createState(gl, this._extensions);
        this.state = new WebGLAdapterRenderState(gl, this._webglState);
        this.limits = this._createLimits();
        this.stats = createGPUStats();
        this.contextRestored = new Subject<now.Timestamp>();
    }

    private _createLimits(): GPULimits {
        const gl = this._gl;
        const is2 = isWebGL2(gl);

        return {
            maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
            max3dTextureSize: is2 ? gl.getParameter((gl as WebGL2RenderingContext).MAX_3D_TEXTURE_SIZE) : 0,
            maxRenderbufferSize: gl.getParameter(gl.MAX_RENDERBUFFER_SIZE),
            maxDrawBuffers: this._extensions.drawBuffers ? gl.getParameter(this._extensions.drawBuffers.MAX_DRAW_BUFFERS) : 1,
            maxTextureImageUnits: gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS),
            maxVertexAttribs: gl.getParameter(gl.MAX_VERTEX_ATTRIBS),
            // WebGL doesn't have compute shaders
            maxComputeWorkgroupSizeX: 0,
            maxComputeWorkgroupSizeY: 0,
            maxComputeWorkgroupSizeZ: 0,
            maxComputeWorkgroupsPerDimension: 0,
            // WebGL has limited storage/uniform buffer support
            maxStorageBufferBindingSize: 0,
            maxUniformBufferBindingSize: is2 ? gl.getParameter((gl as WebGL2RenderingContext).MAX_UNIFORM_BLOCK_SIZE) : 0,
        };
    }

    get pixelRatio(): number {
        const dpr = (typeof window !== 'undefined') ? (window.devicePixelRatio || 1) : 1;
        return dpr * this._pixelScale;
    }

    get isContextLost(): boolean {
        return this._isContextLost || this._gl.isContextLost();
    }

    get gl(): GLRenderingContext {
        return this._gl;
    }

    get extensions(): WebGLExtensions {
        return this._extensions;
    }

    /**
     * Get the underlying WebGLState for internal use.
     * @deprecated Use GPUContext.state methods instead.
     */
    get webglState(): WebGLState {
        return this._webglState;
    }

    get preferredFormat(): TextureFormat {
        return 'rgba8unorm';
    }

    get isModernContext(): boolean {
        return isWebGL2(this._gl);
    }

    setContextLost(): void {
        this._isContextLost = true;
    }

    handleContextRestored(extraResets?: () => void): void {
        this._webglState.reset();
        // Forward to WebGLContext if it exists
        if (this._webglContext) {
            this._webglContext.handleContextRestored(extraResets);
        } else {
            extraResets?.();
        }
        this._isContextLost = false;
        this.contextRestored.next(now());
    }

    setPixelScale(value: number): void {
        this._pixelScale = value;
        if (this._webglContext) {
            this._webglContext.setPixelScale(value);
        }
    }

    /**
     * Get the underlying WebGLContext for backward compatibility.
     * This creates a WebGLContext wrapper on first access.
     * @deprecated Use GPUContext methods instead when possible.
     */
    getWebGLContext(): WebGLContext {
        if (!this._webglContext) {
            this._webglContext = createWebGLContextImpl(this._gl, { pixelScale: this._pixelScale });
        }
        return this._webglContext;
    }

    // Resource creation methods

    createBuffer(descriptor: BufferDescriptor): Buffer {
        this.stats.resourceCounts.buffer++;
        return new WebGLAdapterBuffer(this._gl, descriptor, this.stats);
    }

    createTexture(descriptor: TextureDescriptor): Texture {
        this.stats.resourceCounts.texture++;
        return new WebGLAdapterTexture(this._gl, descriptor, this.stats);
    }

    createTextureView(texture: Texture, descriptor?: TextureViewDescriptor): TextureView {
        return (texture as WebGLAdapterTexture).createView(descriptor);
    }

    createSampler(descriptor: SamplerDescriptor): Sampler {
        this.stats.resourceCounts.sampler++;
        return new WebGLAdapterSampler(this._gl, descriptor, this.stats);
    }

    createBindGroupLayout(descriptor: BindGroupLayoutDescriptor): BindGroupLayout {
        this.stats.resourceCounts.bindGroupLayout++;
        return new WebGLAdapterBindGroupLayout(descriptor, this.stats);
    }

    createBindGroup(descriptor: BindGroupDescriptor): BindGroup {
        this.stats.resourceCounts.bindGroup++;
        return new WebGLAdapterBindGroup(descriptor, this.stats);
    }

    createPipelineLayout(descriptor: PipelineLayoutDescriptor): PipelineLayout {
        this.stats.resourceCounts.pipelineLayout++;
        return new WebGLAdapterPipelineLayout(descriptor, this.stats);
    }

    createRenderPipeline(descriptor: RenderPipelineDescriptor): RenderPipeline {
        this.stats.resourceCounts.renderPipeline++;
        return new WebGLAdapterRenderPipeline(this._gl, this._extensions, descriptor, this.stats);
    }

    createComputePipeline(_descriptor: ComputePipelineDescriptor): ComputePipeline {
        throw new Error('Compute pipelines are not supported in WebGL');
    }

    createShaderModule(descriptor: ShaderModuleDescriptor): ShaderModule {
        this.stats.resourceCounts.shaderModule++;
        return new WebGLAdapterShaderModule(this._gl, descriptor, this.stats);
    }

    // Render target creation

    createRenderTarget(options: RenderTargetOptions): RenderTarget {
        const renderTarget = new WebGLAdapterRenderTarget(
            this._gl,
            this.stats,
            options.width,
            options.height,
            options.depth ?? true,
            options.type ?? 'uint8',
            options.filter ?? 'nearest',
            options.format ?? 'rgba'
        );
        this._renderTargets.add(renderTarget);

        // Wrap the render target to track destruction
        const wrappedTarget: RenderTarget = {
            id: renderTarget.id,
            texture: renderTarget.texture,
            getByteCount: () => renderTarget.getByteCount(),
            getWidth: () => renderTarget.getWidth(),
            getHeight: () => renderTarget.getHeight(),
            bind: () => renderTarget.bind(),
            setSize: (w, h) => renderTarget.setSize(w, h),
            reset: () => renderTarget.reset(),
            destroy: () => {
                renderTarget.destroy();
                this._renderTargets.delete(renderTarget);
            }
        };
        return wrappedTarget;
    }

    createDrawTarget(): RenderTarget {
        const gl = this._gl;
        return new WebGLAdapterDrawTarget(gl);
    }

    // Command encoding

    createCommandEncoder(): CommandEncoder {
        return new WebGLAdapterCommandEncoder(this._gl, this._webglState, this._extensions, this.stats);
    }

    submit(commandBuffers: CommandBuffer[]): void {
        // WebGL is immediate mode, so command buffers execute immediately during encoding
        // This method exists for API compatibility but is effectively a no-op
        for (const buffer of commandBuffers) {
            (buffer as WebGLAdapterCommandBuffer).execute();
        }
    }

    beginRenderPass(encoder: CommandEncoder, descriptor: RenderPassDescriptor): RenderPassEncoder {
        return (encoder as WebGLAdapterCommandEncoder).beginRenderPass(descriptor);
    }

    beginComputePass(_encoder: CommandEncoder): ComputePassEncoder {
        throw new Error('Compute passes are not supported in WebGL');
    }

    // Canvas management

    getCurrentTexture(): Texture {
        const gl = this._gl;
        if (!this._currentTexture || this._currentTexture.width !== gl.drawingBufferWidth || this._currentTexture.height !== gl.drawingBufferHeight) {
            this._currentTexture = new WebGLAdapterTexture(
                gl,
                {
                    size: [gl.drawingBufferWidth, gl.drawingBufferHeight, 1],
                    format: 'rgba8unorm',
                    usage: ['render-attachment'],
                },
                this.stats,
                true // isDrawingBuffer
            );
        }
        return this._currentTexture;
    }

    resize(width: number, height: number): void {
        if (this.canvas instanceof HTMLCanvasElement) {
            this.canvas.width = width;
            this.canvas.height = height;
        }
    }

    getDrawingBufferSize(): { width: number; height: number } {
        return {
            width: this._gl.drawingBufferWidth,
            height: this._gl.drawingBufferHeight,
        };
    }

    bindDrawingBuffer(): void {
        this._gl.bindFramebuffer(this._gl.FRAMEBUFFER, null);
    }

    // Utility methods

    clear(red: number, green: number, blue: number, alpha: number): void {
        const gl = this._gl;
        const drs = this.getDrawingBufferSize();
        this.bindDrawingBuffer();
        this._webglState.enable(gl.SCISSOR_TEST);
        this._webglState.depthMask(true);
        this._webglState.colorMask(true, true, true, true);
        this._webglState.clearColor(red, green, blue, alpha);
        this._webglState.viewport(0, 0, drs.width, drs.height);
        this._webglState.scissor(0, 0, drs.width, drs.height);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    }

    checkError(message?: string): void {
        const gl = this._gl;
        const error = gl.getError();
        if (error !== gl.NO_ERROR) {
            const errorDesc = this._getErrorDescription(error);
            console.log(`WebGL error: '${errorDesc}'${message ? ` (${message})` : ''}`);
        }
    }

    private _getErrorDescription(error: number): string {
        const gl = this._gl;
        switch (error) {
            case gl.NO_ERROR: return 'no error';
            case gl.INVALID_ENUM: return 'invalid enum';
            case gl.INVALID_VALUE: return 'invalid value';
            case gl.INVALID_OPERATION: return 'invalid operation';
            case gl.INVALID_FRAMEBUFFER_OPERATION: return 'invalid framebuffer operation';
            case gl.OUT_OF_MEMORY: return 'out of memory';
            case gl.CONTEXT_LOST_WEBGL: return 'context lost';
            default: return 'unknown error';
        }
    }

    // Synchronization

    async waitForGpuCommandsComplete(): Promise<void> {
        const gl = this._gl;
        if (isWebGL2(gl)) {
            return new Promise((resolve) => {
                const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
                if (!sync) {
                    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
                    resolve();
                    return;
                }
                const check = () => {
                    const status = gl.getSyncParameter(sync, gl.SYNC_STATUS);
                    if (status === gl.SIGNALED) {
                        gl.deleteSync(sync);
                        resolve();
                    } else {
                        setTimeout(check, 0);
                    }
                };
                check();
            });
        } else {
            // WebGL1 fallback: force synchronization with readPixels
            gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
            return Promise.resolve();
        }
    }

    waitForGpuCommandsCompleteSync(): void {
        const gl = this._gl;
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    }

    getFenceSync(): WebGLSync | null {
        const gl = this._gl;
        if (isWebGL2(gl)) {
            return gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
        }
        return null;
    }

    checkSyncStatus(sync: unknown): boolean {
        const gl = this._gl;
        if (!isWebGL2(gl) || !sync) return true;

        const glSync = sync as WebGLSync;
        if (gl.getSyncParameter(glSync, gl.SYNC_STATUS) === gl.SIGNALED) {
            gl.deleteSync(glSync);
            return true;
        }
        return false;
    }

    deleteSync(sync: unknown): void {
        const gl = this._gl;
        if (isWebGL2(gl) && sync) {
            gl.deleteSync(sync as WebGLSync);
        }
    }

    // Pixel reading

    readPixels(x: number, y: number, width: number, height: number, buffer: Uint8Array | Float32Array | Int32Array): void {
        const gl = this._gl;
        if (buffer instanceof Uint8Array) {
            gl.readPixels(x, y, width, height, gl.RGBA, gl.UNSIGNED_BYTE, buffer);
        } else if (buffer instanceof Float32Array) {
            gl.readPixels(x, y, width, height, gl.RGBA, gl.FLOAT, buffer);
        } else if (buffer instanceof Int32Array && isWebGL2(gl)) {
            gl.readPixels(x, y, width, height, (gl as WebGL2RenderingContext).RGBA_INTEGER, gl.INT, buffer);
        } else {
            throw new Error('Unsupported readPixels buffer type');
        }
    }

    // Lifecycle

    destroy(): void {
        this.contextRestored.complete();
        // Note: WebGL context destruction is handled by browser when canvas is removed
        this._gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
}

// WebGL Resource Wrapper Classes

class WebGLAdapterBuffer implements Buffer {
    readonly id: number;
    readonly size: number;
    readonly usage: BufferUsage[];

    private _gl: GLRenderingContext;
    private _buffer: WebGLBuffer | null;
    private _stats: GPUStats;
    private _destroyed = false;
    private _target: number;

    constructor(gl: GLRenderingContext, descriptor: BufferDescriptor, stats: GPUStats) {
        this.id = createBufferId();
        this._gl = gl;
        this.size = descriptor.size;
        this.usage = descriptor.usage;
        this._stats = stats;

        // Determine buffer target based on usage
        this._target = this._getTarget();

        this._buffer = gl.createBuffer();
        if (!this._buffer) {
            throw new Error('Failed to create WebGL buffer');
        }

        gl.bindBuffer(this._target, this._buffer);
        gl.bufferData(this._target, descriptor.size, this._getUsageHint(descriptor.updateHint));
        gl.bindBuffer(this._target, null);
    }

    private _getTarget(): number {
        const gl = this._gl;
        if (this.usage.includes('index')) {
            return gl.ELEMENT_ARRAY_BUFFER;
        } else if (this.usage.includes('uniform') && isWebGL2(gl)) {
            return (gl as WebGL2RenderingContext).UNIFORM_BUFFER;
        }
        return gl.ARRAY_BUFFER;
    }

    private _getUsageHint(hint?: string): number {
        const gl = this._gl;
        switch (hint) {
            case 'stream':
                return gl.STREAM_DRAW;
            case 'dynamic':
                return gl.DYNAMIC_DRAW;
            default:
                return gl.STATIC_DRAW;
        }
    }

    getGLBuffer(): WebGLBuffer | null {
        return this._buffer;
    }

    getTarget(): number {
        return this._target;
    }

    write(data: ArrayBufferView, bufferOffset?: number, dataOffset?: number, size?: number): void {
        const gl = this._gl;
        gl.bindBuffer(this._target, this._buffer);

        const offset = bufferOffset ?? 0;
        const srcOffset = dataOffset ?? 0;
        const byteSize = size !== undefined ? size * (data as any).BYTES_PER_ELEMENT : undefined;

        if (isWebGL2(gl) && srcOffset > 0) {
            (gl as WebGL2RenderingContext).bufferSubData(this._target, offset, data, srcOffset, byteSize !== undefined ? byteSize / (data as any).BYTES_PER_ELEMENT : undefined);
        } else {
            gl.bufferSubData(this._target, offset, data);
        }

        gl.bindBuffer(this._target, null);
    }

    async read(): Promise<ArrayBuffer> {
        const gl = this._gl;
        if (!isWebGL2(gl)) {
            throw new Error('Buffer read is not supported in WebGL1');
        }

        const gl2 = gl as WebGL2RenderingContext;
        const data = new ArrayBuffer(this.size);
        const view = new Uint8Array(data);

        gl2.bindBuffer(this._target, this._buffer);
        gl2.getBufferSubData(this._target, 0, view);
        gl2.bindBuffer(this._target, null);

        return data;
    }

    getByteCount(): number {
        return this.size;
    }

    reset(): void {
        // Re-create buffer after context loss
        const gl = this._gl;
        this._buffer = gl.createBuffer();
        if (this._buffer) {
            gl.bindBuffer(this._target, this._buffer);
            gl.bufferData(this._target, this.size, gl.STATIC_DRAW);
            gl.bindBuffer(this._target, null);
        }
    }

    destroy(): void {
        if (this._destroyed) return;
        this._gl.deleteBuffer(this._buffer);
        this._buffer = null;
        this._stats.resourceCounts.buffer--;
        this._destroyed = true;
    }
}

class WebGLAdapterTexture implements Texture {
    readonly id: number;
    readonly width: number;
    readonly height: number;
    readonly depth: number;
    readonly format: TextureFormat;
    readonly dimension: TextureDimension;
    readonly mipLevelCount: number;
    readonly sampleCount: number;

    private _gl: GLRenderingContext;
    private _texture: WebGLTexture | null;
    private _stats: GPUStats;
    private _destroyed = false;
    private _isDrawingBuffer: boolean;
    private _target: number;

    constructor(gl: GLRenderingContext, descriptor: TextureDescriptor, stats: GPUStats, isDrawingBuffer = false) {
        this.id = createTextureId();
        this._gl = gl;
        this.width = descriptor.size[0];
        this.height = descriptor.size[1];
        this.depth = descriptor.size[2] ?? 1;
        this.format = descriptor.format;
        this.dimension = descriptor.dimension ?? '2d';
        this.mipLevelCount = descriptor.mipLevelCount ?? 1;
        this.sampleCount = descriptor.sampleCount ?? 1;
        this._stats = stats;
        this._isDrawingBuffer = isDrawingBuffer;

        // Determine texture target
        this._target = this._getTarget();

        if (!isDrawingBuffer) {
            this._texture = gl.createTexture();
            if (!this._texture) {
                throw new Error('Failed to create WebGL texture');
            }
            this._initialize();
        } else {
            this._texture = null;
        }
    }

    private _getTarget(): number {
        const gl = this._gl;
        switch (this.dimension) {
            case '3d':
                if (isWebGL2(gl)) {
                    return (gl as WebGL2RenderingContext).TEXTURE_3D;
                }
                throw new Error('3D textures require WebGL2');
            case '2d':
            default:
                if (this.depth > 1 && isWebGL2(gl)) {
                    return (gl as WebGL2RenderingContext).TEXTURE_2D_ARRAY;
                }
                return gl.TEXTURE_2D;
        }
    }

    private _initialize(): void {
        const gl = this._gl;
        const { internalFormat, format, type } = this._getFormatInfo();

        gl.bindTexture(this._target, this._texture);

        if (this._target === gl.TEXTURE_2D) {
            gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, this.width, this.height, 0, format, type, null);
        } else if (isWebGL2(gl)) {
            const gl2 = gl as WebGL2RenderingContext;
            if (this._target === gl2.TEXTURE_3D) {
                gl2.texImage3D(gl2.TEXTURE_3D, 0, internalFormat, this.width, this.height, this.depth, 0, format, type, null);
            } else if (this._target === gl2.TEXTURE_2D_ARRAY) {
                gl2.texImage3D(gl2.TEXTURE_2D_ARRAY, 0, internalFormat, this.width, this.height, this.depth, 0, format, type, null);
            }
        }

        // Set default texture parameters
        gl.texParameteri(this._target, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(this._target, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(this._target, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(this._target, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

        gl.bindTexture(this._target, null);
    }

    private _getFormatInfo(): { internalFormat: number; format: number; type: number } {
        const gl = this._gl;
        const is2 = isWebGL2(gl);
        const gl2 = gl as WebGL2RenderingContext;

        switch (this.format) {
            case 'r8unorm':
                return is2
                    ? { internalFormat: gl2.R8, format: gl2.RED, type: gl.UNSIGNED_BYTE }
                    : { internalFormat: gl.LUMINANCE, format: gl.LUMINANCE, type: gl.UNSIGNED_BYTE };
            case 'rg8unorm':
                return is2
                    ? { internalFormat: gl2.RG8, format: gl2.RG, type: gl.UNSIGNED_BYTE }
                    : { internalFormat: gl.LUMINANCE_ALPHA, format: gl.LUMINANCE_ALPHA, type: gl.UNSIGNED_BYTE };
            case 'rgba8unorm':
            case 'rgba8unorm-srgb':
                return { internalFormat: is2 ? gl2.RGBA8 : gl.RGBA, format: gl.RGBA, type: gl.UNSIGNED_BYTE };
            case 'rgba16float':
                if (!is2) throw new Error('RGBA16F requires WebGL2');
                return { internalFormat: gl2.RGBA16F, format: gl.RGBA, type: gl2.HALF_FLOAT };
            case 'rgba32float':
                if (!is2) throw new Error('RGBA32F requires WebGL2');
                return { internalFormat: gl2.RGBA32F, format: gl.RGBA, type: gl.FLOAT };
            case 'r32float':
                if (!is2) throw new Error('R32F requires WebGL2');
                return { internalFormat: gl2.R32F, format: gl2.RED, type: gl.FLOAT };
            case 'r16float':
                if (!is2) throw new Error('R16F requires WebGL2');
                return { internalFormat: gl2.R16F, format: gl2.RED, type: gl2.HALF_FLOAT };
            case 'depth16unorm':
                return { internalFormat: is2 ? gl2.DEPTH_COMPONENT16 : gl.DEPTH_COMPONENT, format: gl.DEPTH_COMPONENT, type: gl.UNSIGNED_SHORT };
            case 'depth24plus':
                return is2
                    ? { internalFormat: gl2.DEPTH_COMPONENT24, format: gl.DEPTH_COMPONENT, type: gl.UNSIGNED_INT }
                    : { internalFormat: gl.DEPTH_COMPONENT, format: gl.DEPTH_COMPONENT, type: gl.UNSIGNED_INT };
            case 'depth32float':
                if (!is2) throw new Error('DEPTH32F requires WebGL2');
                return { internalFormat: gl2.DEPTH_COMPONENT32F, format: gl.DEPTH_COMPONENT, type: gl.FLOAT };
            case 'depth24plus-stencil8':
                if (!is2) throw new Error('DEPTH24_STENCIL8 requires WebGL2');
                return { internalFormat: gl2.DEPTH24_STENCIL8, format: gl2.DEPTH_STENCIL, type: gl2.UNSIGNED_INT_24_8 };
            default:
                return { internalFormat: is2 ? gl2.RGBA8 : gl.RGBA, format: gl.RGBA, type: gl.UNSIGNED_BYTE };
        }
    }

    getGLTexture(): WebGLTexture | null {
        return this._texture;
    }

    getTarget(): number {
        return this._target;
    }

    isDrawingBuffer(): boolean {
        return this._isDrawingBuffer;
    }

    write(
        data: ArrayBufferView,
        options?: {
            origin?: [number, number, number];
            size?: [number, number, number];
            mipLevel?: number;
            bytesPerRow?: number;
            rowsPerImage?: number;
        }
    ): void {
        if (this._isDrawingBuffer) return;

        const gl = this._gl;
        const origin = options?.origin ?? [0, 0, 0];
        const size = options?.size ?? [this.width, this.height, this.depth];
        const mipLevel = options?.mipLevel ?? 0;
        const { format, type } = this._getFormatInfo();

        gl.bindTexture(this._target, this._texture);

        if (this._target === gl.TEXTURE_2D) {
            gl.texSubImage2D(gl.TEXTURE_2D, mipLevel, origin[0], origin[1], size[0], size[1], format, type, data as ArrayBufferView<ArrayBuffer>);
        } else if (isWebGL2(gl)) {
            const gl2 = gl as WebGL2RenderingContext;
            gl2.texSubImage3D(this._target, mipLevel, origin[0], origin[1], origin[2], size[0], size[1], size[2], format, type, data as ArrayBufferView<ArrayBuffer>);
        }

        gl.bindTexture(this._target, null);
    }

    createView(descriptor?: TextureViewDescriptor): TextureView {
        return new WebGLAdapterTextureView(this, descriptor);
    }

    getByteCount(): number {
        return this.width * this.height * this.depth * getBytesPerPixel(this.format);
    }

    reset(): void {
        if (this._isDrawingBuffer) return;

        const gl = this._gl;
        this._texture = gl.createTexture();
        if (this._texture) {
            this._initialize();
        }
    }

    destroy(): void {
        if (this._destroyed || this._isDrawingBuffer) return;
        this._gl.deleteTexture(this._texture);
        this._texture = null;
        this._stats.resourceCounts.texture--;
        this._destroyed = true;
    }
}

class WebGLAdapterTextureView implements TextureView {
    readonly id: number;
    readonly texture: Texture;
    readonly format: TextureFormat;
    readonly dimension: TextureViewDimension;

    private _baseMipLevel: number;
    private _mipLevelCount: number;
    private _baseArrayLayer: number;
    private _arrayLayerCount: number;

    constructor(texture: Texture, descriptor?: TextureViewDescriptor) {
        this.id = createTextureId();
        this.texture = texture;
        this.format = descriptor?.format ?? texture.format;
        this.dimension = descriptor?.dimension ?? (texture.dimension === '3d' ? '3d' : '2d');
        this._baseMipLevel = descriptor?.baseMipLevel ?? 0;
        this._mipLevelCount = descriptor?.mipLevelCount ?? texture.mipLevelCount;
        this._baseArrayLayer = descriptor?.baseArrayLayer ?? 0;
        this._arrayLayerCount = descriptor?.arrayLayerCount ?? 1;
    }

    get baseMipLevel(): number {
        return this._baseMipLevel;
    }

    get mipLevelCount(): number {
        return this._mipLevelCount;
    }

    get baseArrayLayer(): number {
        return this._baseArrayLayer;
    }

    get arrayLayerCount(): number {
        return this._arrayLayerCount;
    }

    destroy(): void {
        // TextureView in WebGL doesn't have explicit resources to clean up
    }
}

class WebGLAdapterSampler implements Sampler {
    readonly id: number;

    private _gl: GLRenderingContext;
    private _sampler: WebGLSampler | null = null;
    private _stats: GPUStats;
    private _descriptor: SamplerDescriptor;

    constructor(gl: GLRenderingContext, descriptor: SamplerDescriptor, stats: GPUStats) {
        this.id = createTextureId();
        this._gl = gl;
        this._descriptor = descriptor;
        this._stats = stats;

        if (isWebGL2(gl)) {
            this._sampler = (gl as WebGL2RenderingContext).createSampler();
            if (this._sampler) {
                this._configureSampler(gl as WebGL2RenderingContext);
            }
        }
    }

    private _configureSampler(gl: WebGL2RenderingContext): void {
        if (!this._sampler) return;

        const d = this._descriptor;

        gl.samplerParameteri(this._sampler, gl.TEXTURE_WRAP_S, this._getAddressMode(d.addressModeU));
        gl.samplerParameteri(this._sampler, gl.TEXTURE_WRAP_T, this._getAddressMode(d.addressModeV));
        gl.samplerParameteri(this._sampler, gl.TEXTURE_WRAP_R, this._getAddressMode(d.addressModeW));
        gl.samplerParameteri(this._sampler, gl.TEXTURE_MAG_FILTER, this._getFilterMode(d.magFilter));
        gl.samplerParameteri(this._sampler, gl.TEXTURE_MIN_FILTER, this._getMinFilter(d.minFilter, d.mipmapFilter));

        if (d.lodMinClamp !== undefined) {
            gl.samplerParameterf(this._sampler, gl.TEXTURE_MIN_LOD, d.lodMinClamp);
        }
        if (d.lodMaxClamp !== undefined) {
            gl.samplerParameterf(this._sampler, gl.TEXTURE_MAX_LOD, d.lodMaxClamp);
        }
        if (d.compare) {
            gl.samplerParameteri(this._sampler, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
            gl.samplerParameteri(this._sampler, gl.TEXTURE_COMPARE_FUNC, this._getCompareFunction(d.compare));
        }
    }

    private _getAddressMode(mode?: string): number {
        const gl = this._gl;
        switch (mode) {
            case 'repeat':
                return gl.REPEAT;
            case 'mirror-repeat':
                return gl.MIRRORED_REPEAT;
            default:
                return gl.CLAMP_TO_EDGE;
        }
    }

    private _getFilterMode(mode?: string): number {
        const gl = this._gl;
        return mode === 'linear' ? gl.LINEAR : gl.NEAREST;
    }

    private _getMinFilter(minFilter?: string, mipmapFilter?: string): number {
        const gl = this._gl;
        if (minFilter === 'linear') {
            return mipmapFilter === 'linear' ? gl.LINEAR_MIPMAP_LINEAR : (mipmapFilter === 'nearest' ? gl.LINEAR_MIPMAP_NEAREST : gl.LINEAR);
        } else {
            return mipmapFilter === 'linear' ? gl.NEAREST_MIPMAP_LINEAR : (mipmapFilter === 'nearest' ? gl.NEAREST_MIPMAP_NEAREST : gl.NEAREST);
        }
    }

    private _getCompareFunction(compare: string): number {
        const gl = this._gl;
        switch (compare) {
            case 'never': return gl.NEVER;
            case 'less': return gl.LESS;
            case 'equal': return gl.EQUAL;
            case 'less-equal': return gl.LEQUAL;
            case 'greater': return gl.GREATER;
            case 'not-equal': return gl.NOTEQUAL;
            case 'greater-equal': return gl.GEQUAL;
            case 'always': return gl.ALWAYS;
            default: return gl.LESS;
        }
    }

    getGLSampler(): WebGLSampler | null {
        return this._sampler;
    }

    getDescriptor(): SamplerDescriptor {
        return this._descriptor;
    }

    destroy(): void {
        if (this._sampler && isWebGL2(this._gl)) {
            (this._gl as WebGL2RenderingContext).deleteSampler(this._sampler);
        }
        this._sampler = null;
        this._stats.resourceCounts.sampler--;
    }
}

class WebGLAdapterBindGroupLayout implements BindGroupLayout {
    readonly id: number;

    private _descriptor: BindGroupLayoutDescriptor;
    private _stats: GPUStats;

    constructor(descriptor: BindGroupLayoutDescriptor, stats: GPUStats) {
        this.id = createBindGroupLayoutId();
        this._descriptor = descriptor;
        this._stats = stats;
    }

    getDescriptor(): BindGroupLayoutDescriptor {
        return this._descriptor;
    }

    destroy(): void {
        this._stats.resourceCounts.bindGroupLayout--;
    }
}

class WebGLAdapterBindGroup implements BindGroup {
    readonly id: number;
    readonly layout: BindGroupLayout;

    private _entries: BindGroupEntry[];
    private _stats: GPUStats;

    constructor(descriptor: BindGroupDescriptor, stats: GPUStats) {
        this.id = createBindGroupId();
        this.layout = descriptor.layout;
        this._entries = descriptor.entries;
        this._stats = stats;
    }

    getEntries(): BindGroupEntry[] {
        return this._entries;
    }

    destroy(): void {
        this._stats.resourceCounts.bindGroup--;
    }
}

class WebGLAdapterPipelineLayout implements PipelineLayout {
    readonly id: number;
    readonly bindGroupLayouts: readonly BindGroupLayout[];

    private _stats: GPUStats;

    constructor(descriptor: PipelineLayoutDescriptor, stats: GPUStats) {
        this.id = createPipelineLayoutId();
        this.bindGroupLayouts = descriptor.bindGroupLayouts;
        this._stats = stats;
    }

    destroy(): void {
        this._stats.resourceCounts.pipelineLayout--;
    }
}

class WebGLAdapterShaderModule implements ShaderModule {
    readonly id: number;

    private _gl: GLRenderingContext;
    private _code: string;
    private _stats: GPUStats;
    private _vertexShader: WebGLShader | null = null;
    private _fragmentShader: WebGLShader | null = null;

    constructor(gl: GLRenderingContext, descriptor: ShaderModuleDescriptor, stats: GPUStats) {
        this.id = createShaderModuleId();
        this._gl = gl;
        this._code = descriptor.code;
        this._stats = stats;
    }

    getCode(): string {
        return this._code;
    }

    getVertexShader(entryPoint: string): WebGLShader | null {
        if (!this._vertexShader) {
            this._vertexShader = this._compileShader(this._gl.VERTEX_SHADER, entryPoint);
        }
        return this._vertexShader;
    }

    getFragmentShader(entryPoint: string): WebGLShader | null {
        if (!this._fragmentShader) {
            this._fragmentShader = this._compileShader(this._gl.FRAGMENT_SHADER, entryPoint);
        }
        return this._fragmentShader;
    }

    private _compileShader(type: number, _entryPoint: string): WebGLShader | null {
        const gl = this._gl;
        const shader = gl.createShader(type);
        if (!shader) return null;

        gl.shaderSource(shader, this._code);
        gl.compileShader(shader);

        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            console.error('Shader compile error:', gl.getShaderInfoLog(shader));
            gl.deleteShader(shader);
            return null;
        }

        return shader;
    }

    destroy(): void {
        const gl = this._gl;
        if (this._vertexShader) gl.deleteShader(this._vertexShader);
        if (this._fragmentShader) gl.deleteShader(this._fragmentShader);
        this._vertexShader = null;
        this._fragmentShader = null;
        this._stats.resourceCounts.shaderModule--;
    }
}

class WebGLAdapterRenderPipeline implements RenderPipeline {
    readonly id: number;

    private _gl: GLRenderingContext;
    private _program: WebGLProgram | null;
    private _descriptor: RenderPipelineDescriptor;
    private _stats: GPUStats;

    constructor(gl: GLRenderingContext, _extensions: WebGLExtensions, descriptor: RenderPipelineDescriptor, stats: GPUStats) {
        this.id = createPipelineId();
        this._gl = gl;
        this._descriptor = descriptor;
        this._stats = stats;

        this._program = this._createProgram();
    }

    private _createProgram(): WebGLProgram | null {
        const gl = this._gl;
        const program = gl.createProgram();
        if (!program) return null;

        const vertexModule = this._descriptor.vertex.module as WebGLAdapterShaderModule;
        const fragmentModule = this._descriptor.fragment?.module as WebGLAdapterShaderModule | undefined;

        const vertexShader = vertexModule.getVertexShader(this._descriptor.vertex.entryPoint);
        if (vertexShader) {
            gl.attachShader(program, vertexShader);
        }

        if (fragmentModule) {
            const fragmentShader = fragmentModule.getFragmentShader(this._descriptor.fragment!.entryPoint);
            if (fragmentShader) {
                gl.attachShader(program, fragmentShader);
            }
        }

        gl.linkProgram(program);

        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            console.error('Program link error:', gl.getProgramInfoLog(program));
            gl.deleteProgram(program);
            return null;
        }

        return program;
    }

    getGLProgram(): WebGLProgram | null {
        return this._program;
    }

    getDescriptor(): RenderPipelineDescriptor {
        return this._descriptor;
    }

    getBindGroupLayout(_index: number): BindGroupLayout {
        // WebGL doesn't have explicit bind group layouts
        throw new Error('getBindGroupLayout not supported in WebGL adapter');
    }

    destroy(): void {
        if (this._program) {
            this._gl.deleteProgram(this._program);
            this._program = null;
        }
        this._stats.resourceCounts.renderPipeline--;
    }
}

// Command encoding classes

class WebGLAdapterCommandEncoder implements CommandEncoder {
    private _gl: GLRenderingContext;
    private _state: WebGLState;
    private _extensions: WebGLExtensions;
    private _stats: GPUStats;
    private _commands: (() => void)[] = [];

    constructor(gl: GLRenderingContext, state: WebGLState, extensions: WebGLExtensions, stats: GPUStats) {
        this._gl = gl;
        this._state = state;
        this._extensions = extensions;
        this._stats = stats;
    }

    beginRenderPass(descriptor: RenderPassDescriptor): RenderPassEncoder {
        return new WebGLAdapterRenderPassEncoder(this._gl, this._state, this._extensions, descriptor, this._stats, this._commands);
    }

    beginComputePass(): ComputePassEncoder {
        throw new Error('Compute passes are not supported in WebGL');
    }

    copyBufferToBuffer(
        source: Buffer,
        sourceOffset: number,
        destination: Buffer,
        destinationOffset: number,
        size: number
    ): void {
        this._commands.push(() => {
            const gl = this._gl;
            if (!isWebGL2(gl)) {
                throw new Error('copyBufferToBuffer requires WebGL2');
            }

            const gl2 = gl as WebGL2RenderingContext;
            const srcBuffer = (source as WebGLAdapterBuffer).getGLBuffer();
            const dstBuffer = (destination as WebGLAdapterBuffer).getGLBuffer();

            gl2.bindBuffer(gl2.COPY_READ_BUFFER, srcBuffer);
            gl2.bindBuffer(gl2.COPY_WRITE_BUFFER, dstBuffer);
            gl2.copyBufferSubData(gl2.COPY_READ_BUFFER, gl2.COPY_WRITE_BUFFER, sourceOffset, destinationOffset, size);
            gl2.bindBuffer(gl2.COPY_READ_BUFFER, null);
            gl2.bindBuffer(gl2.COPY_WRITE_BUFFER, null);
        });
    }

    copyBufferToTexture(
        source: { buffer: Buffer; offset?: number; bytesPerRow?: number; rowsPerImage?: number },
        destination: { texture: TextureView; mipLevel?: number; origin?: [number, number, number] },
        copySize: [number, number, number]
    ): void {
        this._commands.push(() => {
            const gl = this._gl;
            if (!isWebGL2(gl)) {
                throw new Error('copyBufferToTexture requires WebGL2');
            }

            const gl2 = gl as WebGL2RenderingContext;
            const srcBuffer = (source.buffer as WebGLAdapterBuffer).getGLBuffer();
            const dstTexture = ((destination.texture as WebGLAdapterTextureView).texture as WebGLAdapterTexture);
            const origin = destination.origin ?? [0, 0, 0];

            gl2.bindBuffer(gl2.PIXEL_UNPACK_BUFFER, srcBuffer);
            gl.bindTexture(dstTexture.getTarget(), dstTexture.getGLTexture());

            if (dstTexture.getTarget() === gl.TEXTURE_2D) {
                gl2.texSubImage2D(gl.TEXTURE_2D, destination.mipLevel ?? 0, origin[0], origin[1], copySize[0], copySize[1], gl.RGBA, gl.UNSIGNED_BYTE, source.offset ?? 0);
            }

            gl2.bindBuffer(gl2.PIXEL_UNPACK_BUFFER, null);
            gl.bindTexture(dstTexture.getTarget(), null);
        });
    }

    copyTextureToBuffer(
        source: { texture: TextureView; mipLevel?: number; origin?: [number, number, number] },
        destination: { buffer: Buffer; offset?: number; bytesPerRow?: number; rowsPerImage?: number },
        copySize: [number, number, number]
    ): void {
        this._commands.push(() => {
            const gl = this._gl;
            if (!isWebGL2(gl)) {
                throw new Error('copyTextureToBuffer requires WebGL2');
            }

            const gl2 = gl as WebGL2RenderingContext;
            const srcTexture = ((source.texture as WebGLAdapterTextureView).texture as WebGLAdapterTexture);
            const dstBuffer = (destination.buffer as WebGLAdapterBuffer).getGLBuffer();
            const origin = source.origin ?? [0, 0, 0];

            // Create framebuffer to read from texture
            const fb = gl.createFramebuffer();
            gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, srcTexture.getGLTexture(), source.mipLevel ?? 0);

            gl2.bindBuffer(gl2.PIXEL_PACK_BUFFER, dstBuffer);
            gl.readPixels(origin[0], origin[1], copySize[0], copySize[1], gl.RGBA, gl.UNSIGNED_BYTE, destination.offset ?? 0);
            gl2.bindBuffer(gl2.PIXEL_PACK_BUFFER, null);

            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            gl.deleteFramebuffer(fb);
        });
    }

    copyTextureToTexture(
        source: { texture: TextureView; mipLevel?: number; origin?: [number, number, number] },
        destination: { texture: TextureView; mipLevel?: number; origin?: [number, number, number] },
        copySize: [number, number, number]
    ): void {
        this._commands.push(() => {
            const gl = this._gl;
            if (!isWebGL2(gl)) {
                throw new Error('copyTextureToTexture requires WebGL2');
            }

            const srcTexture = ((source.texture as WebGLAdapterTextureView).texture as WebGLAdapterTexture);
            const dstTexture = ((destination.texture as WebGLAdapterTextureView).texture as WebGLAdapterTexture);
            const srcOrigin = source.origin ?? [0, 0, 0];
            const dstOrigin = destination.origin ?? [0, 0, 0];

            // WebGL2 doesn't have copyImageSubData, so we use framebuffer blit
            // Create temporary framebuffers for reading and writing
            const readFb = gl.createFramebuffer();
            const writeFb = gl.createFramebuffer();

            gl.bindFramebuffer(gl.READ_FRAMEBUFFER, readFb);
            gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, srcTexture.getTarget(), srcTexture.getGLTexture(), source.mipLevel ?? 0);

            gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, writeFb);
            gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, dstTexture.getTarget(), dstTexture.getGLTexture(), destination.mipLevel ?? 0);

            (gl as WebGL2RenderingContext).blitFramebuffer(
                srcOrigin[0], srcOrigin[1], srcOrigin[0] + copySize[0], srcOrigin[1] + copySize[1],
                dstOrigin[0], dstOrigin[1], dstOrigin[0] + copySize[0], dstOrigin[1] + copySize[1],
                gl.COLOR_BUFFER_BIT,
                gl.NEAREST
            );

            gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
            gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
            gl.deleteFramebuffer(readFb);
            gl.deleteFramebuffer(writeFb);
        });
    }

    finish(): CommandBuffer {
        return new WebGLAdapterCommandBuffer(this._commands);
    }
}

class WebGLAdapterRenderPassEncoder implements RenderPassEncoder {
    private _gl: GLRenderingContext;
    private _stats: GPUStats;
    private _commands: (() => void)[];
    private _currentPipeline: WebGLAdapterRenderPipeline | null = null;
    private _framebuffer: WebGLFramebuffer | null = null;
    private _descriptor: RenderPassDescriptor;

    constructor(
        gl: GLRenderingContext,
        _state: WebGLState,
        _extensions: WebGLExtensions,
        descriptor: RenderPassDescriptor,
        stats: GPUStats,
        commands: (() => void)[]
    ) {
        this._gl = gl;
        this._descriptor = descriptor;
        this._stats = stats;
        this._commands = commands;

        this._setupRenderPass();
    }

    private _setupRenderPass(): void {
        const gl = this._gl;
        const descriptor = this._descriptor;

        // Check if we're rendering to the default framebuffer
        const colorAttachments = descriptor.colorAttachments.filter(a => a !== null) as ColorAttachment[];
        const isDefaultFramebuffer = colorAttachments.length > 0 &&
            ((colorAttachments[0].view as WebGLAdapterTextureView).texture as WebGLAdapterTexture).isDrawingBuffer();

        this._commands.push(() => {
            if (isDefaultFramebuffer) {
                gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            } else {
                this._framebuffer = gl.createFramebuffer();
                gl.bindFramebuffer(gl.FRAMEBUFFER, this._framebuffer);

                // Attach color attachments
                colorAttachments.forEach((attachment, i) => {
                    const texture = (attachment.view as WebGLAdapterTextureView).texture as WebGLAdapterTexture;
                    const attachmentPoint = isWebGL2(gl)
                        ? (gl as WebGL2RenderingContext).COLOR_ATTACHMENT0 + i
                        : gl.COLOR_ATTACHMENT0;

                    gl.framebufferTexture2D(gl.FRAMEBUFFER, attachmentPoint, gl.TEXTURE_2D, texture.getGLTexture(), 0);
                });

                // Attach depth/stencil
                if (descriptor.depthStencilAttachment) {
                    const depthTexture = (descriptor.depthStencilAttachment.view as WebGLAdapterTextureView).texture as WebGLAdapterTexture;
                    const format = depthTexture.format;

                    let attachmentPoint: number;
                    if (format.includes('stencil')) {
                        attachmentPoint = gl.DEPTH_STENCIL_ATTACHMENT;
                    } else {
                        attachmentPoint = gl.DEPTH_ATTACHMENT;
                    }

                    gl.framebufferTexture2D(gl.FRAMEBUFFER, attachmentPoint, gl.TEXTURE_2D, depthTexture.getGLTexture(), 0);
                }
            }

            // Handle clear operations
            let clearMask = 0;

            for (const attachment of colorAttachments) {
                if (attachment.loadOp === 'clear' && attachment.clearValue) {
                    gl.clearColor(attachment.clearValue[0], attachment.clearValue[1], attachment.clearValue[2], attachment.clearValue[3]);
                    clearMask |= gl.COLOR_BUFFER_BIT;
                }
            }

            if (descriptor.depthStencilAttachment) {
                if (descriptor.depthStencilAttachment.depthLoadOp === 'clear') {
                    gl.clearDepth(descriptor.depthStencilAttachment.depthClearValue ?? 1.0);
                    clearMask |= gl.DEPTH_BUFFER_BIT;
                }
                if (descriptor.depthStencilAttachment.stencilLoadOp === 'clear') {
                    gl.clearStencil(descriptor.depthStencilAttachment.stencilClearValue ?? 0);
                    clearMask |= gl.STENCIL_BUFFER_BIT;
                }
            }

            if (clearMask !== 0) {
                gl.clear(clearMask);
            }
        });
    }

    setPipeline(pipeline: RenderPipeline): void {
        this._currentPipeline = pipeline as WebGLAdapterRenderPipeline;

        this._commands.push(() => {
            const gl = this._gl;
            const program = this._currentPipeline!.getGLProgram();
            if (program) {
                gl.useProgram(program);
            }

            // Apply pipeline state
            const descriptor = this._currentPipeline!.getDescriptor();

            // Primitive state
            if (descriptor.primitive?.cullMode && descriptor.primitive.cullMode !== 'none') {
                gl.enable(gl.CULL_FACE);
                gl.cullFace(descriptor.primitive.cullMode === 'front' ? gl.FRONT : gl.BACK);
            } else {
                gl.disable(gl.CULL_FACE);
            }

            if (descriptor.primitive?.frontFace) {
                gl.frontFace(descriptor.primitive.frontFace === 'cw' ? gl.CW : gl.CCW);
            }

            // Depth/stencil state
            if (descriptor.depthStencil) {
                gl.enable(gl.DEPTH_TEST);
                gl.depthFunc(this._getCompareFunc(descriptor.depthStencil.depthCompare ?? 'less'));
                gl.depthMask(descriptor.depthStencil.depthWriteEnabled ?? true);
            } else {
                gl.disable(gl.DEPTH_TEST);
            }

            // Blend state from fragment targets
            if (descriptor.fragment?.targets[0]?.blend) {
                gl.enable(gl.BLEND);
                const blend = descriptor.fragment.targets[0].blend;
                gl.blendFuncSeparate(
                    this._getBlendFactor(blend.color?.srcFactor ?? 'one'),
                    this._getBlendFactor(blend.color?.dstFactor ?? 'zero'),
                    this._getBlendFactor(blend.alpha?.srcFactor ?? 'one'),
                    this._getBlendFactor(blend.alpha?.dstFactor ?? 'zero')
                );
                gl.blendEquationSeparate(
                    this._getBlendOp(blend.color?.operation ?? 'add'),
                    this._getBlendOp(blend.alpha?.operation ?? 'add')
                );
            } else {
                gl.disable(gl.BLEND);
            }
        });
    }

    private _getCompareFunc(compare: string): number {
        const gl = this._gl;
        switch (compare) {
            case 'never': return gl.NEVER;
            case 'less': return gl.LESS;
            case 'equal': return gl.EQUAL;
            case 'less-equal': return gl.LEQUAL;
            case 'greater': return gl.GREATER;
            case 'not-equal': return gl.NOTEQUAL;
            case 'greater-equal': return gl.GEQUAL;
            case 'always': return gl.ALWAYS;
            default: return gl.LESS;
        }
    }

    private _getBlendFactor(factor: string): number {
        const gl = this._gl;
        switch (factor) {
            case 'zero': return gl.ZERO;
            case 'one': return gl.ONE;
            case 'src': return gl.SRC_COLOR;
            case 'one-minus-src': return gl.ONE_MINUS_SRC_COLOR;
            case 'src-alpha': return gl.SRC_ALPHA;
            case 'one-minus-src-alpha': return gl.ONE_MINUS_SRC_ALPHA;
            case 'dst': return gl.DST_COLOR;
            case 'one-minus-dst': return gl.ONE_MINUS_DST_COLOR;
            case 'dst-alpha': return gl.DST_ALPHA;
            case 'one-minus-dst-alpha': return gl.ONE_MINUS_DST_ALPHA;
            case 'src-alpha-saturated': return gl.SRC_ALPHA_SATURATE;
            case 'constant': return gl.CONSTANT_COLOR;
            case 'one-minus-constant': return gl.ONE_MINUS_CONSTANT_COLOR;
            default: return gl.ONE;
        }
    }

    private _getBlendOp(op: string): number {
        const gl = this._gl;
        switch (op) {
            case 'add': return gl.FUNC_ADD;
            case 'subtract': return gl.FUNC_SUBTRACT;
            case 'reverse-subtract': return gl.FUNC_REVERSE_SUBTRACT;
            case 'min': return isWebGL2(gl) ? (gl as WebGL2RenderingContext).MIN : gl.FUNC_ADD;
            case 'max': return isWebGL2(gl) ? (gl as WebGL2RenderingContext).MAX : gl.FUNC_ADD;
            default: return gl.FUNC_ADD;
        }
    }

    setBindGroup(index: number, bindGroup: BindGroup, _dynamicOffsets?: number[]): void {
        this._commands.push(() => {
            const gl = this._gl;
            const entries = (bindGroup as WebGLAdapterBindGroup).getEntries();

            let textureUnit = 0;

            for (const entry of entries) {
                if (isBufferBinding(entry.resource)) {
                    const bufferBinding = entry.resource as BufferBinding;
                    const buffer = bufferBinding.buffer as WebGLAdapterBuffer;

                    if (buffer.usage.includes('uniform') && isWebGL2(gl)) {
                        const gl2 = gl as WebGL2RenderingContext;
                        gl2.bindBufferRange(
                            gl2.UNIFORM_BUFFER,
                            entry.binding,
                            buffer.getGLBuffer(),
                            bufferBinding.offset ?? 0,
                            bufferBinding.size ?? buffer.size
                        );
                    }
                } else if (entry.resource instanceof WebGLAdapterSampler) {
                    // Sampler binding handled with texture
                } else if (entry.resource instanceof WebGLAdapterTextureView) {
                    const textureView = entry.resource as WebGLAdapterTextureView;
                    const texture = textureView.texture as WebGLAdapterTexture;

                    gl.activeTexture(gl.TEXTURE0 + textureUnit);
                    gl.bindTexture(texture.getTarget(), texture.getGLTexture());

                    if (isWebGL2(gl)) {
                        // Find associated sampler
                        const samplerEntry = entries.find(e => e.binding === entry.binding + 1 && e.resource instanceof WebGLAdapterSampler);
                        if (samplerEntry) {
                            const sampler = samplerEntry.resource as WebGLAdapterSampler;
                            (gl as WebGL2RenderingContext).bindSampler(textureUnit, sampler.getGLSampler());
                        }
                    }

                    textureUnit++;
                }
            }
        });
    }

    setVertexBuffer(slot: number, buffer: Buffer, offset?: number, _size?: number): void {
        this._commands.push(() => {
            const gl = this._gl;
            const glBuffer = (buffer as WebGLAdapterBuffer).getGLBuffer();

            if (this._currentPipeline) {
                const descriptor = this._currentPipeline.getDescriptor();
                const bufferLayout = descriptor.vertex.buffers?.[slot];

                if (bufferLayout) {
                    gl.bindBuffer(gl.ARRAY_BUFFER, glBuffer);

                    for (const attr of bufferLayout.attributes) {
                        const { size, type, normalized } = this._getVertexFormatInfo(attr.format);
                        gl.enableVertexAttribArray(attr.shaderLocation);
                        gl.vertexAttribPointer(
                            attr.shaderLocation,
                            size,
                            type,
                            normalized,
                            bufferLayout.arrayStride,
                            (offset ?? 0) + attr.offset
                        );

                        if (bufferLayout.stepMode === 'instance' && isWebGL2(gl)) {
                            (gl as WebGL2RenderingContext).vertexAttribDivisor(attr.shaderLocation, 1);
                        }
                    }
                }
            }
        });
    }

    private _getVertexFormatInfo(format: VertexFormat): { size: number; type: number; normalized: boolean } {
        const gl = this._gl;

        const formatInfo: Record<string, { size: number; type: number; normalized: boolean }> = {
            'float32': { size: 1, type: gl.FLOAT, normalized: false },
            'float32x2': { size: 2, type: gl.FLOAT, normalized: false },
            'float32x3': { size: 3, type: gl.FLOAT, normalized: false },
            'float32x4': { size: 4, type: gl.FLOAT, normalized: false },
            'uint8x2': { size: 2, type: gl.UNSIGNED_BYTE, normalized: false },
            'uint8x4': { size: 4, type: gl.UNSIGNED_BYTE, normalized: false },
            'sint8x2': { size: 2, type: gl.BYTE, normalized: false },
            'sint8x4': { size: 4, type: gl.BYTE, normalized: false },
            'unorm8x2': { size: 2, type: gl.UNSIGNED_BYTE, normalized: true },
            'unorm8x4': { size: 4, type: gl.UNSIGNED_BYTE, normalized: true },
            'snorm8x2': { size: 2, type: gl.BYTE, normalized: true },
            'snorm8x4': { size: 4, type: gl.BYTE, normalized: true },
            'uint16x2': { size: 2, type: gl.UNSIGNED_SHORT, normalized: false },
            'uint16x4': { size: 4, type: gl.UNSIGNED_SHORT, normalized: false },
            'sint16x2': { size: 2, type: gl.SHORT, normalized: false },
            'sint16x4': { size: 4, type: gl.SHORT, normalized: false },
            'unorm16x2': { size: 2, type: gl.UNSIGNED_SHORT, normalized: true },
            'unorm16x4': { size: 4, type: gl.UNSIGNED_SHORT, normalized: true },
            'snorm16x2': { size: 2, type: gl.SHORT, normalized: true },
            'snorm16x4': { size: 4, type: gl.SHORT, normalized: true },
            'uint32': { size: 1, type: gl.UNSIGNED_INT, normalized: false },
            'uint32x2': { size: 2, type: gl.UNSIGNED_INT, normalized: false },
            'uint32x3': { size: 3, type: gl.UNSIGNED_INT, normalized: false },
            'uint32x4': { size: 4, type: gl.UNSIGNED_INT, normalized: false },
            'sint32': { size: 1, type: gl.INT, normalized: false },
            'sint32x2': { size: 2, type: gl.INT, normalized: false },
            'sint32x3': { size: 3, type: gl.INT, normalized: false },
            'sint32x4': { size: 4, type: gl.INT, normalized: false },
        };

        return formatInfo[format] ?? { size: 4, type: gl.FLOAT, normalized: false };
    }

    setIndexBuffer(buffer: Buffer, format: IndexFormat, offset?: number, _size?: number): void {
        this._commands.push(() => {
            const gl = this._gl;
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, (buffer as WebGLAdapterBuffer).getGLBuffer());
        });
    }

    setViewport(x: number, y: number, width: number, height: number, _minDepth: number, _maxDepth: number): void {
        this._commands.push(() => {
            this._gl.viewport(x, y, width, height);
        });
    }

    setScissorRect(x: number, y: number, width: number, height: number): void {
        this._commands.push(() => {
            const gl = this._gl;
            gl.enable(gl.SCISSOR_TEST);
            gl.scissor(x, y, width, height);
        });
    }

    setBlendConstant(color: [number, number, number, number]): void {
        this._commands.push(() => {
            this._gl.blendColor(color[0], color[1], color[2], color[3]);
        });
    }

    setStencilReference(reference: number): void {
        this._commands.push(() => {
            const gl = this._gl;
            // Stencil reference is set via glStencilFunc, which requires the compare function
            // This is a simplified version that uses the current compare function
            gl.stencilFunc(gl.ALWAYS, reference, 0xFF);
        });
    }

    draw(vertexCount: number, instanceCount?: number, firstVertex?: number, firstInstance?: number): void {
        this._commands.push(() => {
            const gl = this._gl;
            const topology = this._currentPipeline?.getDescriptor().primitive?.topology ?? 'triangle-list';
            const mode = this._getDrawMode(topology);

            if ((instanceCount ?? 1) > 1 && isWebGL2(gl)) {
                (gl as WebGL2RenderingContext).drawArraysInstanced(mode, firstVertex ?? 0, vertexCount, instanceCount ?? 1);
            } else {
                gl.drawArrays(mode, firstVertex ?? 0, vertexCount);
            }

            this._stats.drawCount++;
            this._stats.instanceCount += instanceCount ?? 1;
        });
    }

    drawIndexed(indexCount: number, instanceCount?: number, firstIndex?: number, baseVertex?: number, firstInstance?: number): void {
        this._commands.push(() => {
            const gl = this._gl;
            const topology = this._currentPipeline?.getDescriptor().primitive?.topology ?? 'triangle-list';
            const mode = this._getDrawMode(topology);

            if ((instanceCount ?? 1) > 1 && isWebGL2(gl)) {
                (gl as WebGL2RenderingContext).drawElementsInstanced(mode, indexCount, gl.UNSIGNED_INT, (firstIndex ?? 0) * 4, instanceCount ?? 1);
            } else {
                gl.drawElements(mode, indexCount, gl.UNSIGNED_INT, (firstIndex ?? 0) * 4);
            }

            this._stats.drawCount++;
            this._stats.instanceCount += instanceCount ?? 1;
            if ((instanceCount ?? 1) > 1) {
                this._stats.instancedDrawCount++;
            }
        });
    }

    private _getDrawMode(topology: string): number {
        const gl = this._gl;
        switch (topology) {
            case 'point-list': return gl.POINTS;
            case 'line-list': return gl.LINES;
            case 'line-strip': return gl.LINE_STRIP;
            case 'triangle-list': return gl.TRIANGLES;
            case 'triangle-strip': return gl.TRIANGLE_STRIP;
            default: return gl.TRIANGLES;
        }
    }

    drawIndirect(_indirectBuffer: Buffer, _indirectOffset: number): void {
        throw new Error('Indirect drawing is not supported in WebGL');
    }

    drawIndexedIndirect(_indirectBuffer: Buffer, _indirectOffset: number): void {
        throw new Error('Indirect drawing is not supported in WebGL');
    }

    end(): void {
        this._commands.push(() => {
            const gl = this._gl;

            // Cleanup framebuffer if we created one
            if (this._framebuffer) {
                gl.bindFramebuffer(gl.FRAMEBUFFER, null);
                gl.deleteFramebuffer(this._framebuffer);
                this._framebuffer = null;
            }

            // Disable scissor test
            gl.disable(gl.SCISSOR_TEST);
        });
    }
}

class WebGLAdapterCommandBuffer implements CommandBuffer {
    readonly label?: string;

    private _commands: (() => void)[];
    private _executed = false;

    constructor(commands: (() => void)[]) {
        this._commands = commands;
    }

    execute(): void {
        if (this._executed) return;

        for (const command of this._commands) {
            command();
        }

        this._executed = true;
    }
}

// Render Target Classes

let nextRenderTargetId = 0;

/**
 * WebGL render target for offscreen rendering.
 */
class WebGLAdapterRenderTarget implements RenderTarget {
    readonly id: number;

    private _gl: GLRenderingContext;
    private _width: number;
    private _height: number;
    private _depth: boolean;
    private _type: 'uint8' | 'float32' | 'fp16';
    private _filter: 'nearest' | 'linear';
    private _format: 'rgba' | 'alpha';
    private _glTexture: WebGLTexture | null = null;
    private _framebuffer: WebGLFramebuffer | null = null;
    private _depthRenderbuffer: WebGLRenderbuffer | null = null;
    private _textureView: TextureView | null = null;
    private _destroyed = false;

    constructor(
        gl: GLRenderingContext,
        _stats: GPUStats,
        width: number,
        height: number,
        depth: boolean,
        type: 'uint8' | 'float32' | 'fp16',
        filter: 'nearest' | 'linear',
        format: 'rgba' | 'alpha'
    ) {
        this.id = nextRenderTargetId++;
        this._gl = gl;
        this._width = width;
        this._height = height;
        this._depth = depth;
        this._type = type;
        this._filter = filter;
        this._format = format;

        this._initialize();
    }

    private _initialize(): void {
        const gl = this._gl;
        const is2 = isWebGL2(gl);

        // Create framebuffer
        this._framebuffer = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, this._framebuffer);

        // Create color texture
        this._glTexture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, this._glTexture);

        const { internalFormat, format, type } = this._getTextureFormatInfo();
        const filterMode = this._filter === 'linear' ? gl.LINEAR : gl.NEAREST;

        gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, this._width, this._height, 0, format, type, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filterMode);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filterMode);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this._glTexture, 0);

        // Create depth renderbuffer if needed
        if (this._depth) {
            this._depthRenderbuffer = gl.createRenderbuffer();
            gl.bindRenderbuffer(gl.RENDERBUFFER, this._depthRenderbuffer);

            const depthFormat = is2
                ? (gl as WebGL2RenderingContext).DEPTH_COMPONENT32F
                : gl.DEPTH_COMPONENT16;
            gl.renderbufferStorage(gl.RENDERBUFFER, depthFormat, this._width, this._height);
            gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this._depthRenderbuffer);
        }

        // Reset bindings
        gl.bindTexture(gl.TEXTURE_2D, null);
        gl.bindRenderbuffer(gl.RENDERBUFFER, null);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);

        // Create texture view wrapper for the RenderTarget interface
        const self = this;
        const wrapperTexture: Texture = {
            id: createTextureId(),
            width: this._width,
            height: this._height,
            depth: 1,
            format: this._getTextureFormat(),
            dimension: '2d' as const,
            mipLevelCount: 1,
            sampleCount: 1,
            write: () => {},
            getByteCount: () => self._width * self._height * 4,
            reset: () => self._initialize(),
            destroy: () => {},
            createView: () => self._textureView!,
        };

        this._textureView = new WebGLAdapterTextureView(wrapperTexture);
    }

    private _getTextureFormatInfo(): { internalFormat: number; format: number; type: number } {
        const gl = this._gl;
        const is2 = isWebGL2(gl);
        const gl2 = gl as WebGL2RenderingContext;

        if (this._format === 'alpha') {
            if (!is2) throw new Error('Alpha format requires WebGL2');
            return { internalFormat: gl2.R8, format: gl2.RED, type: gl.UNSIGNED_BYTE };
        }

        switch (this._type) {
            case 'fp16':
                if (!is2) throw new Error('FP16 requires WebGL2');
                return { internalFormat: gl2.RGBA16F, format: gl.RGBA, type: gl2.HALF_FLOAT };
            case 'float32':
                if (!is2) throw new Error('Float32 requires WebGL2');
                return { internalFormat: gl2.RGBA32F, format: gl.RGBA, type: gl.FLOAT };
            default:
                return { internalFormat: is2 ? gl2.RGBA8 : gl.RGBA, format: gl.RGBA, type: gl.UNSIGNED_BYTE };
        }
    }

    private _getTextureFormat(): TextureFormat {
        if (this._format === 'alpha') return 'r8unorm';
        switch (this._type) {
            case 'fp16': return 'rgba16float';
            case 'float32': return 'rgba32float';
            default: return 'rgba8unorm';
        }
    }

    get texture(): TextureView {
        return this._textureView!;
    }

    getByteCount(): number {
        const colorBytes = this._width * this._height * (this._type === 'float32' ? 16 : (this._type === 'fp16' ? 8 : 4));
        const depthBytes = this._depth ? this._width * this._height * 4 : 0;
        return colorBytes + depthBytes;
    }

    getWidth(): number {
        return this._width;
    }

    getHeight(): number {
        return this._height;
    }

    bind(): void {
        this._gl.bindFramebuffer(this._gl.FRAMEBUFFER, this._framebuffer);
    }

    setSize(width: number, height: number): void {
        if (this._width === width && this._height === height) return;

        this._width = width;
        this._height = height;

        const gl = this._gl;
        const is2 = isWebGL2(gl);
        const { internalFormat, format, type } = this._getTextureFormatInfo();

        gl.bindTexture(gl.TEXTURE_2D, this._glTexture);
        gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, width, height, 0, format, type, null);
        gl.bindTexture(gl.TEXTURE_2D, null);

        if (this._depthRenderbuffer) {
            gl.bindRenderbuffer(gl.RENDERBUFFER, this._depthRenderbuffer);
            const depthFormat = is2
                ? (gl as WebGL2RenderingContext).DEPTH_COMPONENT32F
                : gl.DEPTH_COMPONENT16;
            gl.renderbufferStorage(gl.RENDERBUFFER, depthFormat, width, height);
            gl.bindRenderbuffer(gl.RENDERBUFFER, null);
        }
    }

    reset(): void {
        this._initialize();
    }

    destroy(): void {
        if (this._destroyed) return;

        const gl = this._gl;
        if (this._glTexture) gl.deleteTexture(this._glTexture);
        if (this._framebuffer) gl.deleteFramebuffer(this._framebuffer);
        if (this._depthRenderbuffer) gl.deleteRenderbuffer(this._depthRenderbuffer);

        this._glTexture = null;
        this._framebuffer = null;
        this._depthRenderbuffer = null;
        this._destroyed = true;
    }
}

/**
 * WebGL draw target representing the default framebuffer (canvas).
 */
class WebGLAdapterDrawTarget implements RenderTarget {
    readonly id = -1;

    private _gl: GLRenderingContext;
    private _textureView: TextureView;

    constructor(gl: GLRenderingContext) {
        this._gl = gl;

        // Create a dummy texture view for the interface
        const self = this;
        const dummyTexture: Texture = {
            id: -1,
            width: gl.drawingBufferWidth,
            height: gl.drawingBufferHeight,
            depth: 1,
            format: 'rgba8unorm' as TextureFormat,
            dimension: '2d' as const,
            mipLevelCount: 1,
            sampleCount: 1,
            write: () => {},
            getByteCount: () => 0,
            reset: () => {},
            destroy: () => {},
            createView: () => self._textureView,
        };

        this._textureView = new WebGLAdapterTextureView(dummyTexture);
    }

    get texture(): TextureView {
        return this._textureView;
    }

    getByteCount(): number {
        return 0; // Drawing buffer memory is managed by the browser
    }

    getWidth(): number {
        return this._gl.drawingBufferWidth;
    }

    getHeight(): number {
        return this._gl.drawingBufferHeight;
    }

    bind(): void {
        this._gl.bindFramebuffer(this._gl.FRAMEBUFFER, null);
    }

    setSize(_width: number, _height: number): void {
        // Drawing buffer size is controlled by canvas dimensions, not this method
    }

    reset(): void {
        // Nothing to reset for the drawing buffer
    }

    destroy(): void {
        // Drawing buffer is managed by the browser
    }
}

/**
 * WebGL implementation of RenderState interface.
 * Wraps the existing WebGLState to provide abstract state management.
 */
class WebGLAdapterRenderState implements RenderState {
    currentProgramId: number = -1;
    currentMaterialId: number = -1;
    currentRenderItemId: number = -1;

    private _gl: GLRenderingContext;
    private _webglState: WebGLState;

    // Track current state for getters
    private _blendEnabled = false;
    private _depthTestEnabled = false;
    private _stencilTestEnabled = false;
    private _cullFaceEnabled = false;
    private _scissorTestEnabled = false;
    private _polygonOffsetFillEnabled = false;
    private _cullMode: CullMode = 'back';
    private _frontFace: FrontFace = 'ccw';

    // Blend state tracking
    private _blendSrcRGB: BlendFactor = 'one';
    private _blendDstRGB: BlendFactor = 'zero';
    private _blendSrcAlpha: BlendFactor = 'one';
    private _blendDstAlpha: BlendFactor = 'zero';
    private _blendOpRGB: BlendOperation = 'add';
    private _blendOpAlpha: BlendOperation = 'add';

    // Depth state tracking
    private _depthWriteEnabled = true;
    private _depthCompare: CompareFunction = 'less';

    constructor(gl: GLRenderingContext, state: WebGLState) {
        this._gl = gl;
        this._webglState = state;

        // Sync current IDs
        this.currentProgramId = state.currentProgramId;
        this.currentMaterialId = state.currentMaterialId;
        this.currentRenderItemId = state.currentRenderItemId;
    }

    // Feature enable/disable

    enableBlend(): void {
        this._webglState.enable(this._gl.BLEND);
        this._blendEnabled = true;
    }

    disableBlend(): void {
        this._webglState.disable(this._gl.BLEND);
        this._blendEnabled = false;
    }

    enableDepthTest(): void {
        this._webglState.enable(this._gl.DEPTH_TEST);
        this._depthTestEnabled = true;
    }

    disableDepthTest(): void {
        this._webglState.disable(this._gl.DEPTH_TEST);
        this._depthTestEnabled = false;
    }

    enableStencilTest(): void {
        this._webglState.enable(this._gl.STENCIL_TEST);
        this._stencilTestEnabled = true;
    }

    disableStencilTest(): void {
        this._webglState.disable(this._gl.STENCIL_TEST);
        this._stencilTestEnabled = false;
    }

    enableCullFace(): void {
        this._webglState.enable(this._gl.CULL_FACE);
        this._cullFaceEnabled = true;
    }

    disableCullFace(): void {
        this._webglState.disable(this._gl.CULL_FACE);
        this._cullFaceEnabled = false;
    }

    enableScissorTest(): void {
        this._webglState.enable(this._gl.SCISSOR_TEST);
        this._scissorTestEnabled = true;
    }

    disableScissorTest(): void {
        this._webglState.disable(this._gl.SCISSOR_TEST);
        this._scissorTestEnabled = false;
    }

    enablePolygonOffsetFill(): void {
        this._webglState.enable(this._gl.POLYGON_OFFSET_FILL);
        this._polygonOffsetFillEnabled = true;
    }

    disablePolygonOffsetFill(): void {
        this._webglState.disable(this._gl.POLYGON_OFFSET_FILL);
        this._polygonOffsetFillEnabled = false;
    }

    // Blend state

    blendFunc(src: BlendFactor, dst: BlendFactor): void {
        const gl = this._gl;
        this._webglState.blendFunc(blendFactorToGL(gl, src), blendFactorToGL(gl, dst));
        this._blendSrcRGB = this._blendSrcAlpha = src;
        this._blendDstRGB = this._blendDstAlpha = dst;
    }

    blendFuncSeparate(srcRGB: BlendFactor, dstRGB: BlendFactor, srcAlpha: BlendFactor, dstAlpha: BlendFactor): void {
        const gl = this._gl;
        this._webglState.blendFuncSeparate(
            blendFactorToGL(gl, srcRGB),
            blendFactorToGL(gl, dstRGB),
            blendFactorToGL(gl, srcAlpha),
            blendFactorToGL(gl, dstAlpha)
        );
        this._blendSrcRGB = srcRGB;
        this._blendDstRGB = dstRGB;
        this._blendSrcAlpha = srcAlpha;
        this._blendDstAlpha = dstAlpha;
    }

    blendEquation(mode: BlendOperation): void {
        const gl = this._gl;
        this._webglState.blendEquation(blendOperationToGL(gl, mode));
        this._blendOpRGB = this._blendOpAlpha = mode;
    }

    blendEquationSeparate(modeRGB: BlendOperation, modeAlpha: BlendOperation): void {
        const gl = this._gl;
        this._webglState.blendEquationSeparate(blendOperationToGL(gl, modeRGB), blendOperationToGL(gl, modeAlpha));
        this._blendOpRGB = modeRGB;
        this._blendOpAlpha = modeAlpha;
    }

    blendColor(red: number, green: number, blue: number, alpha: number): void {
        this._webglState.blendColor(red, green, blue, alpha);
    }

    // Depth state

    depthMask(flag: boolean): void {
        this._webglState.depthMask(flag);
        this._depthWriteEnabled = flag;
    }

    depthFunc(func: CompareFunction): void {
        const gl = this._gl;
        this._webglState.depthFunc(compareFunctionToGL(gl, func));
        this._depthCompare = func;
    }

    clearDepth(depth: number): void {
        this._webglState.clearDepth(depth);
    }

    // Stencil state

    stencilFunc(func: CompareFunction, ref: number, mask: number): void {
        const gl = this._gl;
        this._webglState.stencilFunc(compareFunctionToGL(gl, func), ref, mask);
    }

    stencilFuncSeparate(face: 'front' | 'back' | 'front-and-back', func: CompareFunction, ref: number, mask: number): void {
        const gl = this._gl;
        this._webglState.stencilFuncSeparate(faceToGL(gl, face), compareFunctionToGL(gl, func), ref, mask);
    }

    stencilMask(mask: number): void {
        this._webglState.stencilMask(mask);
    }

    stencilMaskSeparate(face: 'front' | 'back' | 'front-and-back', mask: number): void {
        const gl = this._gl;
        this._webglState.stencilMaskSeparate(faceToGL(gl, face), mask);
    }

    stencilOp(fail: StencilOperation, zfail: StencilOperation, zpass: StencilOperation): void {
        const gl = this._gl;
        this._webglState.stencilOp(
            stencilOperationToGL(gl, fail),
            stencilOperationToGL(gl, zfail),
            stencilOperationToGL(gl, zpass)
        );
    }

    stencilOpSeparate(face: 'front' | 'back' | 'front-and-back', fail: StencilOperation, zfail: StencilOperation, zpass: StencilOperation): void {
        const gl = this._gl;
        this._webglState.stencilOpSeparate(
            faceToGL(gl, face),
            stencilOperationToGL(gl, fail),
            stencilOperationToGL(gl, zfail),
            stencilOperationToGL(gl, zpass)
        );
    }

    // Rasterization state

    frontFace(mode: FrontFace): void {
        const gl = this._gl;
        this._webglState.frontFace(mode === 'ccw' ? gl.CCW : gl.CW);
        this._frontFace = mode;
    }

    cullFace(mode: CullMode): void {
        const gl = this._gl;
        if (mode === 'none') {
            this.disableCullFace();
        } else {
            this._webglState.cullFace(mode === 'front' ? gl.FRONT : gl.BACK);
        }
        this._cullMode = mode;
    }

    polygonOffset(factor: number, units: number): void {
        this._gl.polygonOffset(factor, units);
    }

    // Color state

    colorMask(red: boolean, green: boolean, blue: boolean, alpha: boolean): void {
        this._webglState.colorMask(red, green, blue, alpha);
    }

    clearColor(red: number, green: number, blue: number, alpha: number): void {
        this._webglState.clearColor(red, green, blue, alpha);
    }

    // Viewport and scissor

    viewport(x: number, y: number, width: number, height: number): void {
        this._webglState.viewport(x, y, width, height);
    }

    scissor(x: number, y: number, width: number, height: number): void {
        this._webglState.scissor(x, y, width, height);
    }

    // Vertex attribute state

    enableVertexAttrib(index: number): void {
        this._webglState.enableVertexAttrib(index);
    }

    clearVertexAttribsState(): void {
        this._webglState.clearVertexAttribsState();
    }

    disableUnusedVertexAttribs(): void {
        this._webglState.disableUnusedVertexAttribs();
    }

    // State snapshot (for WebGPU pipeline key generation)

    getBlendState(): BlendState | null {
        if (!this._blendEnabled) return null;

        return {
            color: {
                operation: this._blendOpRGB,
                srcFactor: this._blendSrcRGB,
                dstFactor: this._blendDstRGB,
            },
            alpha: {
                operation: this._blendOpAlpha,
                srcFactor: this._blendSrcAlpha,
                dstFactor: this._blendDstAlpha,
            },
        };
    }

    getDepthStencilState(): DepthStencilStateDescriptor | null {
        if (!this._depthTestEnabled) return null;

        return {
            depthWriteEnabled: this._depthWriteEnabled,
            depthCompare: this._depthCompare,
        };
    }

    getCullMode(): CullMode {
        return this._cullFaceEnabled ? this._cullMode : 'none';
    }

    getFrontFace(): FrontFace {
        return this._frontFace;
    }

    isBlendEnabled(): boolean {
        return this._blendEnabled;
    }

    isDepthTestEnabled(): boolean {
        return this._depthTestEnabled;
    }

    isStencilTestEnabled(): boolean {
        return this._stencilTestEnabled;
    }

    isScissorTestEnabled(): boolean {
        return this._scissorTestEnabled;
    }

    isPolygonOffsetFillEnabled(): boolean {
        return this._polygonOffsetFillEnabled;
    }

    // Reset state

    reset(): void {
        this._webglState.reset();

        this.currentProgramId = -1;
        this.currentMaterialId = -1;
        this.currentRenderItemId = -1;

        this._blendEnabled = false;
        this._depthTestEnabled = false;
        this._stencilTestEnabled = false;
        this._cullFaceEnabled = false;
        this._scissorTestEnabled = false;
        this._polygonOffsetFillEnabled = false;
        this._cullMode = 'back';
        this._frontFace = 'ccw';

        this._blendSrcRGB = this._blendSrcAlpha = 'one';
        this._blendDstRGB = this._blendDstAlpha = 'zero';
        this._blendOpRGB = this._blendOpAlpha = 'add';

        this._depthWriteEnabled = true;
        this._depthCompare = 'less';
    }
}
