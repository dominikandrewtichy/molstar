/**
 * Copyright (c) 2025 mol* contributors, licensed under MIT, See LICENSE file for more info.
 *
 * @author Alexander Rose <alexander.rose@weirdbyte.de>
 */

/// <reference path="./webgpu-types.d.ts" />

import { Subject } from 'rxjs';
import { now } from '../../mol-util/now';
import {
    GPUContext,
    GPUContextDescriptor,
    GPULimits,
    GPUStats,
    createGPUStats,
} from '../gpu/context';
import {
    Buffer,
    BufferDescriptor,
    createBufferId,
} from '../gpu/buffer';
import {
    Texture,
    TextureDescriptor,
    TextureView,
    TextureViewDescriptor,
    Sampler,
    SamplerDescriptor,
    createTextureId,
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
    shaderStagesToMask,
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
} from '../gpu/pipeline';
import {
    CommandEncoder,
    CommandBuffer,
    RenderPassDescriptor,
    RenderPassEncoder,
    ComputePassEncoder,
    RenderTarget,
    RenderTargetOptions,
} from '../gpu/render-pass';
import {
    RenderState,
    BlendFactor,
    BlendOperation,
    BlendState,
    CullMode,
    FrontFace,
    StencilOperation,
    CompareFunction,
    DepthStencilStateDescriptor,
} from '../gpu/render-state';

/**
 * WebGPU-specific context options.
 */
export interface WebGPUContextOptions {
    /** Power preference for adapter selection */
    powerPreference?: GPUPowerPreference;
    /** Required features */
    requiredFeatures?: GPUFeatureName[];
    /** Required limits */
    requiredLimits?: Record<string, number>;
}

/**
 * Create a WebGPU context asynchronously.
 */
export async function createWebGPUContext(
    descriptor: GPUContextDescriptor,
    options?: WebGPUContextOptions
): Promise<GPUContext> {
    if (!navigator.gpu) {
        throw new Error('WebGPU is not supported in this browser');
    }

    const adapter = await navigator.gpu.requestAdapter({
        powerPreference: options?.powerPreference ?? 'high-performance',
    });

    if (!adapter) {
        throw new Error('Failed to get WebGPU adapter');
    }

    const device = await adapter.requestDevice({
        requiredFeatures: options?.requiredFeatures as Iterable<GPUFeatureName> | undefined,
        requiredLimits: options?.requiredLimits,
    });

    const canvas = descriptor.canvas;
    const gpuContext = canvas.getContext('webgpu');

    if (!gpuContext) {
        throw new Error('Failed to get WebGPU context from canvas');
    }

    const preferredFormat = navigator.gpu.getPreferredCanvasFormat();

    gpuContext.configure({
        device,
        format: preferredFormat,
        alphaMode: 'premultiplied',
    });

    return new WebGPUContext(device, gpuContext, canvas, adapter, preferredFormat, descriptor.pixelScale);
}

/**
 * WebGPU implementation of GPUContext.
 */
class WebGPUContext implements GPUContext {
    readonly backend = 'webgpu' as const;
    readonly canvas: HTMLCanvasElement | OffscreenCanvas;
    readonly limits: GPULimits;
    readonly stats: GPUStats;
    readonly contextRestored: Subject<now.Timestamp>;
    readonly namedTextures: { [name: string]: Texture } = Object.create(null);
    readonly namedRenderTargets: { [name: string]: RenderTarget } = Object.create(null);
    readonly state: RenderState;

    private _device: GPUDevice;
    private _gpuContext: GPUCanvasContext;
    private _adapter: GPUAdapter;
    private _preferredFormat: GPUTextureFormat;
    private _pixelScale: number;
    private _isContextLost: boolean = false;
    private _currentTexture: WebGPUTexture | null = null;
    private _renderTargets: Set<WebGPURenderTarget> = new Set();

    constructor(
        device: GPUDevice,
        gpuContext: GPUCanvasContext,
        canvas: HTMLCanvasElement | OffscreenCanvas,
        adapter: GPUAdapter,
        preferredFormat: GPUTextureFormat,
        pixelScale?: number
    ) {
        this._device = device;
        this._gpuContext = gpuContext;
        this.canvas = canvas;
        this._adapter = adapter;
        this._preferredFormat = preferredFormat;
        this._pixelScale = pixelScale ?? 1;

        this.limits = this._createLimits();
        this.stats = createGPUStats();
        this.contextRestored = new Subject<now.Timestamp>();
        this.state = new WebGPURenderState();

        // Handle device loss
        device.lost.then((info) => {
            console.error('WebGPU device lost:', info.message);
            this._isContextLost = true;
        });
    }

    private _createLimits(): GPULimits {
        const limits = this._device.limits;
        return {
            maxTextureSize: limits.maxTextureDimension2D,
            max3dTextureSize: limits.maxTextureDimension3D,
            maxRenderbufferSize: limits.maxTextureDimension2D,
            maxDrawBuffers: limits.maxColorAttachments,
            maxTextureImageUnits: limits.maxSampledTexturesPerShaderStage,
            maxVertexAttribs: limits.maxVertexAttributes,
            maxComputeWorkgroupSizeX: limits.maxComputeWorkgroupSizeX,
            maxComputeWorkgroupSizeY: limits.maxComputeWorkgroupSizeY,
            maxComputeWorkgroupSizeZ: limits.maxComputeWorkgroupSizeZ,
            maxComputeWorkgroupsPerDimension: limits.maxComputeWorkgroupsPerDimension,
            maxStorageBufferBindingSize: limits.maxStorageBufferBindingSize,
            maxUniformBufferBindingSize: limits.maxUniformBufferBindingSize,
        };
    }

    get pixelRatio(): number {
        const dpr = (typeof window !== 'undefined') ? (window.devicePixelRatio || 1) : 1;
        return dpr * this._pixelScale;
    }

    get isContextLost(): boolean {
        return this._isContextLost;
    }

    get adapter(): GPUAdapter {
        return this._adapter;
    }

    get preferredFormat(): import('../gpu/texture').TextureFormat {
        return this._preferredFormat as import('../gpu/texture').TextureFormat;
    }

    get isModernContext(): boolean {
        return true; // WebGPU is always "modern"
    }

    setContextLost(): void {
        this._isContextLost = true;
    }

    handleContextRestored(extraResets?: () => void): void {
        // WebGPU context restoration is more complex and requires re-requesting device
        extraResets?.();
        this._isContextLost = false;
        this.contextRestored.next(now());
    }

    setPixelScale(value: number): void {
        this._pixelScale = value;
    }

    // Resource creation methods

    createBuffer(descriptor: BufferDescriptor): Buffer {
        const gpuUsage = this._convertBufferUsage(descriptor.usage);
        const gpuBuffer = this._device.createBuffer({
            size: descriptor.size,
            usage: gpuUsage,
            mappedAtCreation: descriptor.mappedAtCreation,
            label: descriptor.label,
        });

        this.stats.resourceCounts.buffer++;
        return new WebGPUBuffer(this._device, gpuBuffer, descriptor, this.stats);
    }

    createTexture(descriptor: TextureDescriptor): Texture {
        const [width, height, depthOrArrayLayers] = descriptor.size;
        const gpuTexture = this._device.createTexture({
            size: { width, height, depthOrArrayLayers: depthOrArrayLayers ?? 1 },
            format: this._convertTextureFormat(descriptor.format),
            dimension: descriptor.dimension ?? '2d',
            mipLevelCount: descriptor.mipLevelCount ?? 1,
            sampleCount: descriptor.sampleCount ?? 1,
            usage: this._convertTextureUsage(descriptor.usage),
            label: descriptor.label,
        });

        this.stats.resourceCounts.texture++;
        return new WebGPUTexture(this._device, gpuTexture, descriptor, this.stats);
    }

    createTextureView(texture: Texture, descriptor?: TextureViewDescriptor): TextureView {
        const webgpuTexture = texture as WebGPUTexture;
        return webgpuTexture.createView(descriptor);
    }

    createSampler(descriptor: SamplerDescriptor): Sampler {
        const gpuSampler = this._device.createSampler({
            addressModeU: descriptor.addressModeU ?? 'clamp-to-edge',
            addressModeV: descriptor.addressModeV ?? 'clamp-to-edge',
            addressModeW: descriptor.addressModeW ?? 'clamp-to-edge',
            magFilter: descriptor.magFilter ?? 'nearest',
            minFilter: descriptor.minFilter ?? 'nearest',
            mipmapFilter: descriptor.mipmapFilter ?? 'nearest',
            lodMinClamp: descriptor.lodMinClamp ?? 0,
            lodMaxClamp: descriptor.lodMaxClamp ?? 32,
            compare: descriptor.compare as GPUCompareFunction | undefined,
            maxAnisotropy: descriptor.maxAnisotropy ?? 1,
            label: descriptor.label,
        });

        this.stats.resourceCounts.sampler++;
        return new WebGPUSampler(gpuSampler, this.stats);
    }

    createBindGroupLayout(descriptor: BindGroupLayoutDescriptor): BindGroupLayout {
        const entries: GPUBindGroupLayoutEntry[] = descriptor.entries.map(entry => {
            const gpuEntry: GPUBindGroupLayoutEntry = {
                binding: entry.binding,
                visibility: shaderStagesToMask(entry.visibility),
            };

            if (entry.buffer) {
                gpuEntry.buffer = {
                    type: entry.buffer.type as GPUBufferBindingType,
                    hasDynamicOffset: entry.buffer.hasDynamicOffset,
                    minBindingSize: entry.buffer.minBindingSize,
                };
            }
            if (entry.sampler) {
                gpuEntry.sampler = {
                    type: entry.sampler.type as GPUSamplerBindingType,
                };
            }
            if (entry.texture) {
                gpuEntry.texture = {
                    sampleType: entry.texture.sampleType as GPUTextureSampleType,
                    viewDimension: entry.texture.viewDimension as GPUTextureViewDimension,
                    multisampled: entry.texture.multisampled,
                };
            }
            if (entry.storageTexture) {
                gpuEntry.storageTexture = {
                    access: entry.storageTexture.access as GPUStorageTextureAccess,
                    format: entry.storageTexture.format as GPUTextureFormat,
                    viewDimension: entry.storageTexture.viewDimension as GPUTextureViewDimension,
                };
            }

            return gpuEntry;
        });

        const gpuLayout = this._device.createBindGroupLayout({
            entries,
            label: descriptor.label,
        });

        this.stats.resourceCounts.bindGroupLayout++;
        return new WebGPUBindGroupLayout(gpuLayout, this.stats);
    }

    createBindGroup(descriptor: BindGroupDescriptor): BindGroup {
        const entries: GPUBindGroupEntry[] = descriptor.entries.map(entry => {
            let resource: GPUBindingResource;

            if (isBufferBinding(entry.resource)) {
                const bufferBinding = entry.resource;
                resource = {
                    buffer: (bufferBinding.buffer as WebGPUBuffer).getGPUBuffer(),
                    offset: bufferBinding.offset ?? 0,
                    size: bufferBinding.size,
                };
            } else if (entry.resource instanceof WebGPUSampler) {
                resource = entry.resource.getGPUSampler();
            } else if (entry.resource instanceof WebGPUTextureView) {
                resource = entry.resource.getGPUTextureView();
            } else {
                throw new Error('Unknown bind group entry resource type');
            }

            return {
                binding: entry.binding,
                resource,
            };
        });

        const gpuBindGroup = this._device.createBindGroup({
            layout: (descriptor.layout as WebGPUBindGroupLayout).getGPUBindGroupLayout(),
            entries,
            label: descriptor.label,
        });

        this.stats.resourceCounts.bindGroup++;
        return new WebGPUBindGroup(gpuBindGroup, descriptor.layout, this.stats);
    }

    createPipelineLayout(descriptor: PipelineLayoutDescriptor): PipelineLayout {
        const gpuLayout = this._device.createPipelineLayout({
            bindGroupLayouts: descriptor.bindGroupLayouts.map(
                layout => (layout as WebGPUBindGroupLayout).getGPUBindGroupLayout()
            ),
            label: descriptor.label,
        });

        this.stats.resourceCounts.pipelineLayout++;
        return new WebGPUPipelineLayout(gpuLayout, descriptor.bindGroupLayouts, this.stats);
    }

    createRenderPipeline(descriptor: RenderPipelineDescriptor): RenderPipeline {
        const vertexModule = descriptor.vertex.module as WebGPUShaderModule;
        const fragmentModule = descriptor.fragment?.module as WebGPUShaderModule | undefined;

        const gpuDescriptor: GPURenderPipelineDescriptor = {
            layout: descriptor.layout === 'auto'
                ? 'auto'
                : (descriptor.layout as WebGPUPipelineLayout).getGPUPipelineLayout(),
            vertex: {
                module: vertexModule.getGPUShaderModule(),
                entryPoint: descriptor.vertex.entryPoint,
                buffers: descriptor.vertex.buffers?.map(buffer => ({
                    arrayStride: buffer.arrayStride,
                    stepMode: buffer.stepMode ?? 'vertex',
                    attributes: buffer.attributes.map(attr => ({
                        shaderLocation: attr.shaderLocation,
                        format: attr.format as GPUVertexFormat,
                        offset: attr.offset,
                    })),
                })),
                constants: descriptor.vertex.constants,
            },
            primitive: descriptor.primitive ? {
                topology: descriptor.primitive.topology as GPUPrimitiveTopology,
                stripIndexFormat: descriptor.primitive.stripIndexFormat as GPUIndexFormat | undefined,
                frontFace: descriptor.primitive.frontFace as GPUFrontFace,
                cullMode: descriptor.primitive.cullMode as GPUCullMode,
                unclippedDepth: descriptor.primitive.unclippedDepth,
            } : undefined,
            depthStencil: descriptor.depthStencil ? {
                format: this._convertTextureFormat(descriptor.depthStencil.format),
                depthWriteEnabled: descriptor.depthStencil.depthWriteEnabled ?? true,
                depthCompare: (descriptor.depthStencil.depthCompare ?? 'less') as GPUCompareFunction,
                stencilFront: descriptor.depthStencil.stencilFront as GPUStencilFaceState,
                stencilBack: descriptor.depthStencil.stencilBack as GPUStencilFaceState,
                stencilReadMask: descriptor.depthStencil.stencilReadMask,
                stencilWriteMask: descriptor.depthStencil.stencilWriteMask,
                depthBias: descriptor.depthStencil.depthBias,
                depthBiasSlopeScale: descriptor.depthStencil.depthBiasSlopeScale,
                depthBiasClamp: descriptor.depthStencil.depthBiasClamp,
            } : undefined,
            multisample: descriptor.multisample ? {
                count: descriptor.multisample.count ?? 1,
                mask: descriptor.multisample.mask ?? 0xFFFFFFFF,
                alphaToCoverageEnabled: descriptor.multisample.alphaToCoverageEnabled ?? false,
            } : undefined,
            label: descriptor.label,
        };

        if (descriptor.fragment && fragmentModule) {
            gpuDescriptor.fragment = {
                module: fragmentModule.getGPUShaderModule(),
                entryPoint: descriptor.fragment.entryPoint,
                targets: descriptor.fragment.targets.map(target => ({
                    format: this._convertTextureFormat(target.format),
                    blend: target.blend ? {
                        color: {
                            operation: (target.blend.color?.operation ?? 'add') as GPUBlendOperation,
                            srcFactor: (target.blend.color?.srcFactor ?? 'one') as GPUBlendFactor,
                            dstFactor: (target.blend.color?.dstFactor ?? 'zero') as GPUBlendFactor,
                        },
                        alpha: {
                            operation: (target.blend.alpha?.operation ?? 'add') as GPUBlendOperation,
                            srcFactor: (target.blend.alpha?.srcFactor ?? 'one') as GPUBlendFactor,
                            dstFactor: (target.blend.alpha?.dstFactor ?? 'zero') as GPUBlendFactor,
                        },
                    } : undefined,
                    writeMask: target.writeMask ?? 0xF,
                })),
                constants: descriptor.fragment.constants,
            };
        }

        const gpuPipeline = this._device.createRenderPipeline(gpuDescriptor);

        this.stats.resourceCounts.renderPipeline++;
        return new WebGPURenderPipeline(gpuPipeline, this._device, this.stats);
    }

    createComputePipeline(descriptor: ComputePipelineDescriptor): ComputePipeline {
        const computeModule = descriptor.compute.module as WebGPUShaderModule;

        const gpuPipeline = this._device.createComputePipeline({
            layout: descriptor.layout === 'auto'
                ? 'auto'
                : (descriptor.layout as WebGPUPipelineLayout).getGPUPipelineLayout(),
            compute: {
                module: computeModule.getGPUShaderModule(),
                entryPoint: descriptor.compute.entryPoint,
                constants: descriptor.compute.constants,
            },
            label: descriptor.label,
        });

        this.stats.resourceCounts.computePipeline++;
        return new WebGPUComputePipeline(gpuPipeline, this._device, this.stats);
    }

    createShaderModule(descriptor: ShaderModuleDescriptor): ShaderModule {
        const gpuModule = this._device.createShaderModule({
            code: descriptor.code,
            label: descriptor.label,
        });

        this.stats.resourceCounts.shaderModule++;
        return new WebGPUShaderModule(gpuModule, this.stats);
    }

    // Render target creation

    createRenderTarget(options: RenderTargetOptions): RenderTarget {
        const renderTarget = new WebGPURenderTarget(
            this._device,
            this.stats,
            options.width,
            options.height,
            options.depth ?? true,
            options.type ?? 'uint8',
            options.filter ?? 'nearest',
            options.format ?? 'rgba'
        );
        this._renderTargets.add(renderTarget);

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
        return new WebGPUDrawTarget(this._gpuContext, this._device);
    }

    // Command encoding

    createCommandEncoder(): CommandEncoder {
        const gpuEncoder = this._device.createCommandEncoder();
        return new WebGPUCommandEncoder(gpuEncoder, this.stats);
    }

    submit(commandBuffers: CommandBuffer[]): void {
        const gpuBuffers = commandBuffers.map(
            buffer => (buffer as WebGPUCommandBuffer).getGPUCommandBuffer()
        );
        this._device.queue.submit(gpuBuffers);
    }

    beginRenderPass(encoder: CommandEncoder, descriptor: RenderPassDescriptor): RenderPassEncoder {
        return (encoder as WebGPUCommandEncoder).beginRenderPass(descriptor);
    }

    beginComputePass(encoder: CommandEncoder): ComputePassEncoder {
        return (encoder as WebGPUCommandEncoder).beginComputePass();
    }

    // Canvas management

    getCurrentTexture(): Texture {
        const gpuTexture = this._gpuContext.getCurrentTexture();

        // Always create a new wrapper because the swap chain texture is invalid after the frame
        this._currentTexture = new WebGPUTexture(
            this._device,
            gpuTexture,
            {
                size: [gpuTexture.width, gpuTexture.height, 1],
                format: this._preferredFormat as import('../gpu/texture').TextureFormat,
                usage: ['render-attachment'],
            },
            this.stats,
            true // isSwapChainTexture
        );

        return this._currentTexture;
    }

    resize(width: number, height: number): void {
        if (this.canvas instanceof HTMLCanvasElement) {
            this.canvas.width = width;
            this.canvas.height = height;
        }
        // OffscreenCanvas resize is handled differently
    }

    getDrawingBufferSize(): { width: number; height: number } {
        const texture = this._gpuContext.getCurrentTexture();
        return { width: texture.width, height: texture.height };
    }

    bindDrawingBuffer(): void {
        // WebGPU doesn't have a concept of "binding" the drawing buffer
        // This is handled via render pass descriptors instead
        // This method exists for API compatibility
    }

    // Utility methods

    clear(red: number, green: number, blue: number, alpha: number): void {
        // In WebGPU, clearing is done via render passes with loadOp: 'clear'
        // Create a simple clear pass
        const texture = this._gpuContext.getCurrentTexture();
        const encoder = this._device.createCommandEncoder();
        const pass = encoder.beginRenderPass({
            colorAttachments: [{
                view: texture.createView(),
                clearValue: { r: red, g: green, b: blue, a: alpha },
                loadOp: 'clear',
                storeOp: 'store',
            }],
        });
        pass.end();
        this._device.queue.submit([encoder.finish()]);
    }

    checkError(_message?: string): void {
        // WebGPU reports errors via validation, not via polling like WebGL
        // Errors are handled through device.pushErrorScope/popErrorScope
        // This method exists for API compatibility
    }

    // Synchronization

    async waitForGpuCommandsComplete(): Promise<void> {
        // WebGPU doesn't have a direct equivalent, but we can submit an empty command buffer
        // and wait for the queue to be idle
        await this._device.queue.onSubmittedWorkDone();
    }

    waitForGpuCommandsCompleteSync(): void {
        // WebGPU doesn't support synchronous waiting
        // This is a no-op; callers should use the async version
        console.warn('WebGPU does not support synchronous GPU waiting. Use waitForGpuCommandsComplete() instead.');
    }

    getFenceSync(): unknown | null {
        // WebGPU doesn't have explicit fence sync objects like WebGL2
        // Synchronization is handled via queue.onSubmittedWorkDone()
        return null;
    }

    checkSyncStatus(_sync: unknown): boolean {
        // WebGPU doesn't have explicit sync objects
        return true;
    }

    deleteSync(_sync: unknown): void {
        // WebGPU doesn't have explicit sync objects to delete
    }

    // Pixel reading

    readPixels(x: number, y: number, width: number, height: number, buffer: Uint8Array | Float32Array | Int32Array): void {
        // WebGPU requires async buffer mapping for pixel reading
        // This is a simplified synchronous stub - real implementation needs async pattern
        console.warn('WebGPU readPixels requires async buffer mapping - use readPixelsAsync instead');
    }

    /**
     * Async version of readPixels for WebGPU.
     */
    async readPixelsAsync(
        source: Texture,
        x: number,
        y: number,
        width: number,
        height: number
    ): Promise<Uint8Array> {
        const bytesPerPixel = 4; // Assuming RGBA8
        const bytesPerRow = Math.ceil(width * bytesPerPixel / 256) * 256; // Must be aligned to 256
        const bufferSize = bytesPerRow * height;

        const readBuffer = this._device.createBuffer({
            size: bufferSize,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });

        const encoder = this._device.createCommandEncoder();
        encoder.copyTextureToBuffer(
            { texture: (source as WebGPUTexture).getGPUTexture(), origin: { x, y, z: 0 } },
            { buffer: readBuffer, bytesPerRow, rowsPerImage: height },
            { width, height, depthOrArrayLayers: 1 }
        );
        this._device.queue.submit([encoder.finish()]);

        await readBuffer.mapAsync(GPUMapMode.READ);
        const data = new Uint8Array(readBuffer.getMappedRange()).slice();
        readBuffer.unmap();
        readBuffer.destroy();

        return data;
    }

    // Lifecycle

    destroy(): void {
        this._gpuContext.unconfigure();
        this._device.destroy();
        this.contextRestored.complete();
    }

    // Helper methods for format conversion

    private _convertBufferUsage(usage: import('../gpu/buffer').BufferUsage[]): GPUBufferUsageFlags {
        let flags = 0;
        for (const u of usage) {
            switch (u) {
                case 'vertex': flags |= GPUBufferUsage.VERTEX; break;
                case 'index': flags |= GPUBufferUsage.INDEX; break;
                case 'uniform': flags |= GPUBufferUsage.UNIFORM; break;
                case 'storage': flags |= GPUBufferUsage.STORAGE; break;
                case 'copy-src': flags |= GPUBufferUsage.COPY_SRC; break;
                case 'copy-dst': flags |= GPUBufferUsage.COPY_DST; break;
                case 'indirect': flags |= GPUBufferUsage.INDIRECT; break;
                case 'query-resolve': flags |= GPUBufferUsage.QUERY_RESOLVE; break;
            }
        }
        return flags;
    }

    private _convertTextureUsage(usage: import('../gpu/texture').TextureUsage[]): GPUTextureUsageFlags {
        let flags = 0;
        for (const u of usage) {
            switch (u) {
                case 'copy-src': flags |= GPUTextureUsage.COPY_SRC; break;
                case 'copy-dst': flags |= GPUTextureUsage.COPY_DST; break;
                case 'texture-binding': flags |= GPUTextureUsage.TEXTURE_BINDING; break;
                case 'storage-binding': flags |= GPUTextureUsage.STORAGE_BINDING; break;
                case 'render-attachment': flags |= GPUTextureUsage.RENDER_ATTACHMENT; break;
            }
        }
        return flags;
    }

    private _convertTextureFormat(format: import('../gpu/texture').TextureFormat): GPUTextureFormat {
        // Direct mapping for most formats
        return format as GPUTextureFormat;
    }
}

// WebGPU resource wrapper classes

class WebGPUBuffer implements Buffer {
    readonly id: number;
    readonly size: number;
    readonly usage: import('../gpu/buffer').BufferUsage[];

    private _device: GPUDevice;
    private _buffer: GPUBuffer;
    private _stats: GPUStats;
    private _destroyed = false;

    constructor(device: GPUDevice, buffer: GPUBuffer, descriptor: BufferDescriptor, stats: GPUStats) {
        this.id = createBufferId();
        this._device = device;
        this._buffer = buffer;
        this.size = descriptor.size;
        this.usage = descriptor.usage;
        this._stats = stats;
    }

    getGPUBuffer(): GPUBuffer {
        return this._buffer;
    }

    write(data: ArrayBufferView, bufferOffset?: number, dataOffset?: number, size?: number): void {
        this._device.queue.writeBuffer(
            this._buffer,
            bufferOffset ?? 0,
            data.buffer as ArrayBuffer,
            (dataOffset ?? 0) * (data as any).BYTES_PER_ELEMENT + data.byteOffset,
            size !== undefined ? size * (data as any).BYTES_PER_ELEMENT : undefined
        );
    }

    async read(): Promise<ArrayBuffer> {
        // Create a staging buffer for reading
        const stagingBuffer = this._device.createBuffer({
            size: this.size,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });

        const encoder = this._device.createCommandEncoder();
        encoder.copyBufferToBuffer(this._buffer, 0, stagingBuffer, 0, this.size);
        this._device.queue.submit([encoder.finish()]);

        await stagingBuffer.mapAsync(GPUMapMode.READ);
        const data = stagingBuffer.getMappedRange().slice(0);
        stagingBuffer.unmap();
        stagingBuffer.destroy();

        return data;
    }

    getByteCount(): number {
        return this.size;
    }

    reset(): void {
        // WebGPU buffers cannot be reset - would need to recreate
    }

    destroy(): void {
        if (this._destroyed) return;
        this._buffer.destroy();
        this._stats.resourceCounts.buffer--;
        this._destroyed = true;
    }
}

class WebGPUTexture implements Texture {
    readonly id: number;
    readonly width: number;
    readonly height: number;
    readonly depth: number;
    readonly format: import('../gpu/texture').TextureFormat;
    readonly dimension: import('../gpu/texture').TextureDimension;
    readonly mipLevelCount: number;
    readonly sampleCount: number;

    private _device: GPUDevice;
    private _texture: GPUTexture;
    private _stats: GPUStats;
    private _destroyed = false;
    private _isSwapChainTexture: boolean;

    constructor(
        device: GPUDevice,
        texture: GPUTexture,
        descriptor: TextureDescriptor,
        stats: GPUStats,
        isSwapChainTexture = false
    ) {
        this.id = createTextureId();
        this._device = device;
        this._texture = texture;
        this.width = descriptor.size[0];
        this.height = descriptor.size[1];
        this.depth = descriptor.size[2] ?? 1;
        this.format = descriptor.format;
        this.dimension = descriptor.dimension ?? '2d';
        this.mipLevelCount = descriptor.mipLevelCount ?? 1;
        this.sampleCount = descriptor.sampleCount ?? 1;
        this._stats = stats;
        this._isSwapChainTexture = isSwapChainTexture;
    }

    getGPUTexture(): GPUTexture {
        return this._texture;
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
        const origin = options?.origin ?? [0, 0, 0];
        const size = options?.size ?? [this.width, this.height, this.depth];

        this._device.queue.writeTexture(
            {
                texture: this._texture,
                mipLevel: options?.mipLevel ?? 0,
                origin: { x: origin[0], y: origin[1], z: origin[2] },
            },
            data as ArrayBufferView<ArrayBuffer>,
            {
                bytesPerRow: options?.bytesPerRow,
                rowsPerImage: options?.rowsPerImage,
            },
            { width: size[0], height: size[1], depthOrArrayLayers: size[2] }
        );
    }

    createView(descriptor?: TextureViewDescriptor): TextureView {
        const gpuView = this._texture.createView({
            format: descriptor?.format as GPUTextureFormat | undefined,
            dimension: descriptor?.dimension as GPUTextureViewDimension | undefined,
            baseMipLevel: descriptor?.baseMipLevel,
            mipLevelCount: descriptor?.mipLevelCount,
            baseArrayLayer: descriptor?.baseArrayLayer,
            arrayLayerCount: descriptor?.arrayLayerCount,
            label: descriptor?.label,
        });

        return new WebGPUTextureView(gpuView, this, descriptor);
    }

    getByteCount(): number {
        const bytesPerPixel = this._getBytesPerPixel();
        return this.width * this.height * this.depth * bytesPerPixel;
    }

    private _getBytesPerPixel(): number {
        // Simplified - would need full format table
        switch (this.format) {
            case 'r8unorm':
            case 'r8snorm':
            case 'r8uint':
            case 'r8sint':
                return 1;
            case 'rg8unorm':
            case 'rg8snorm':
            case 'r16float':
                return 2;
            case 'rgba8unorm':
            case 'rgba8snorm':
            case 'r32float':
            case 'depth32float':
                return 4;
            case 'rgba16float':
            case 'rg32float':
                return 8;
            case 'rgba32float':
                return 16;
            default:
                return 4;
        }
    }

    reset(): void {
        // WebGPU textures cannot be reset - would need to recreate
    }

    destroy(): void {
        if (this._destroyed || this._isSwapChainTexture) return;
        this._texture.destroy();
        this._stats.resourceCounts.texture--;
        this._destroyed = true;
    }
}

class WebGPUTextureView implements TextureView {
    readonly id: number;
    readonly texture: Texture;
    readonly format: import('../gpu/texture').TextureFormat;
    readonly dimension: import('../gpu/texture').TextureViewDimension;

    private _view: GPUTextureView;

    constructor(view: GPUTextureView, texture: Texture, descriptor?: TextureViewDescriptor) {
        this.id = createTextureId();
        this._view = view;
        this.texture = texture;
        this.format = descriptor?.format ?? texture.format;
        this.dimension = descriptor?.dimension ?? (texture.dimension === '3d' ? '3d' : '2d');
    }

    getGPUTextureView(): GPUTextureView {
        return this._view;
    }

    destroy(): void {
        // GPUTextureView doesn't have a destroy method
    }
}

class WebGPUSampler implements Sampler {
    readonly id: number;
    private _sampler: GPUSampler;
    private _stats: GPUStats;

    constructor(sampler: GPUSampler, stats: GPUStats) {
        this.id = createTextureId();
        this._sampler = sampler;
        this._stats = stats;
    }

    getGPUSampler(): GPUSampler {
        return this._sampler;
    }

    destroy(): void {
        this._stats.resourceCounts.sampler--;
    }
}

class WebGPUBindGroupLayout implements BindGroupLayout {
    readonly id: number;
    private _layout: GPUBindGroupLayout;
    private _stats: GPUStats;

    constructor(layout: GPUBindGroupLayout, stats: GPUStats) {
        this.id = createBindGroupLayoutId();
        this._layout = layout;
        this._stats = stats;
    }

    getGPUBindGroupLayout(): GPUBindGroupLayout {
        return this._layout;
    }

    destroy(): void {
        this._stats.resourceCounts.bindGroupLayout--;
    }
}

class WebGPUBindGroup implements BindGroup {
    readonly id: number;
    readonly layout: BindGroupLayout;
    private _bindGroup: GPUBindGroup;
    private _stats: GPUStats;

    constructor(bindGroup: GPUBindGroup, layout: BindGroupLayout, stats: GPUStats) {
        this.id = createBindGroupId();
        this._bindGroup = bindGroup;
        this.layout = layout;
        this._stats = stats;
    }

    getGPUBindGroup(): GPUBindGroup {
        return this._bindGroup;
    }

    destroy(): void {
        this._stats.resourceCounts.bindGroup--;
    }
}

class WebGPUPipelineLayout implements PipelineLayout {
    readonly id: number;
    readonly bindGroupLayouts: readonly BindGroupLayout[];
    private _layout: GPUPipelineLayout;
    private _stats: GPUStats;

    constructor(layout: GPUPipelineLayout, bindGroupLayouts: BindGroupLayout[], stats: GPUStats) {
        this.id = createPipelineLayoutId();
        this._layout = layout;
        this.bindGroupLayouts = bindGroupLayouts;
        this._stats = stats;
    }

    getGPUPipelineLayout(): GPUPipelineLayout {
        return this._layout;
    }

    destroy(): void {
        this._stats.resourceCounts.pipelineLayout--;
    }
}

class WebGPUShaderModule implements ShaderModule {
    readonly id: number;
    private _module: GPUShaderModule;
    private _stats: GPUStats;

    constructor(module: GPUShaderModule, stats: GPUStats) {
        this.id = createShaderModuleId();
        this._module = module;
        this._stats = stats;
    }

    getGPUShaderModule(): GPUShaderModule {
        return this._module;
    }

    destroy(): void {
        this._stats.resourceCounts.shaderModule--;
    }
}

class WebGPURenderPipeline implements RenderPipeline {
    readonly id: number;
    private _pipeline: GPURenderPipeline;
    private _device: GPUDevice;
    private _stats: GPUStats;

    constructor(pipeline: GPURenderPipeline, device: GPUDevice, stats: GPUStats) {
        this.id = createPipelineId();
        this._pipeline = pipeline;
        this._device = device;
        this._stats = stats;
    }

    getGPURenderPipeline(): GPURenderPipeline {
        return this._pipeline;
    }

    getBindGroupLayout(index: number): BindGroupLayout {
        const gpuLayout = this._pipeline.getBindGroupLayout(index);
        return new WebGPUBindGroupLayout(gpuLayout, this._stats);
    }

    getDevice(): GPUDevice {
        return this._device;
    }

    destroy(): void {
        this._stats.resourceCounts.renderPipeline--;
    }
}

class WebGPUComputePipeline implements ComputePipeline {
    readonly id: number;
    private _pipeline: GPUComputePipeline;
    private _device: GPUDevice;
    private _stats: GPUStats;

    constructor(pipeline: GPUComputePipeline, device: GPUDevice, stats: GPUStats) {
        this.id = createPipelineId();
        this._pipeline = pipeline;
        this._device = device;
        this._stats = stats;
    }

    getGPUComputePipeline(): GPUComputePipeline {
        return this._pipeline;
    }

    getBindGroupLayout(index: number): BindGroupLayout {
        const gpuLayout = this._pipeline.getBindGroupLayout(index);
        return new WebGPUBindGroupLayout(gpuLayout, this._stats);
    }

    getDevice(): GPUDevice {
        return this._device;
    }

    destroy(): void {
        this._stats.resourceCounts.computePipeline--;
    }
}

class WebGPUCommandEncoder implements CommandEncoder {
    private _encoder: GPUCommandEncoder;
    private _stats: GPUStats;

    constructor(encoder: GPUCommandEncoder, stats: GPUStats) {
        this._encoder = encoder;
        this._stats = stats;
    }

    beginRenderPass(descriptor: RenderPassDescriptor): RenderPassEncoder {
        const colorAttachments: GPURenderPassColorAttachment[] = descriptor.colorAttachments
            .filter((a): a is import('../gpu/render-pass').ColorAttachment => a !== null)
            .map(attachment => ({
                view: (attachment.view as WebGPUTextureView).getGPUTextureView(),
                resolveTarget: attachment.resolveTarget
                    ? (attachment.resolveTarget as WebGPUTextureView).getGPUTextureView()
                    : undefined,
                clearValue: attachment.clearValue
                    ? { r: attachment.clearValue[0], g: attachment.clearValue[1], b: attachment.clearValue[2], a: attachment.clearValue[3] }
                    : undefined,
                loadOp: attachment.loadOp as GPULoadOp,
                storeOp: attachment.storeOp as GPUStoreOp,
            }));

        const gpuDescriptor: GPURenderPassDescriptor = {
            colorAttachments,
            label: descriptor.label,
        };

        if (descriptor.depthStencilAttachment) {
            gpuDescriptor.depthStencilAttachment = {
                view: (descriptor.depthStencilAttachment.view as WebGPUTextureView).getGPUTextureView(),
                depthClearValue: descriptor.depthStencilAttachment.depthClearValue ?? 1.0,
                depthLoadOp: descriptor.depthStencilAttachment.depthLoadOp as GPULoadOp,
                depthStoreOp: descriptor.depthStencilAttachment.depthStoreOp as GPUStoreOp,
                depthReadOnly: descriptor.depthStencilAttachment.depthReadOnly,
                stencilClearValue: descriptor.depthStencilAttachment.stencilClearValue,
                stencilLoadOp: descriptor.depthStencilAttachment.stencilLoadOp as GPULoadOp | undefined,
                stencilStoreOp: descriptor.depthStencilAttachment.stencilStoreOp as GPUStoreOp | undefined,
                stencilReadOnly: descriptor.depthStencilAttachment.stencilReadOnly,
            };
        }

        const pass = this._encoder.beginRenderPass(gpuDescriptor);
        return new WebGPURenderPassEncoder(pass, this._stats);
    }

    beginComputePass(): ComputePassEncoder {
        const pass = this._encoder.beginComputePass();
        return new WebGPUComputePassEncoder(pass);
    }

    copyBufferToBuffer(
        source: Buffer,
        sourceOffset: number,
        destination: Buffer,
        destinationOffset: number,
        size: number
    ): void {
        this._encoder.copyBufferToBuffer(
            (source as WebGPUBuffer).getGPUBuffer(),
            sourceOffset,
            (destination as WebGPUBuffer).getGPUBuffer(),
            destinationOffset,
            size
        );
    }

    copyBufferToTexture(
        source: { buffer: Buffer; offset?: number; bytesPerRow?: number; rowsPerImage?: number },
        destination: { texture: TextureView; mipLevel?: number; origin?: [number, number, number] },
        copySize: [number, number, number]
    ): void {
        const origin = destination.origin ?? [0, 0, 0];
        this._encoder.copyBufferToTexture(
            {
                buffer: (source.buffer as WebGPUBuffer).getGPUBuffer(),
                offset: source.offset ?? 0,
                bytesPerRow: source.bytesPerRow,
                rowsPerImage: source.rowsPerImage,
            },
            {
                texture: ((destination.texture as WebGPUTextureView).texture as WebGPUTexture).getGPUTexture(),
                mipLevel: destination.mipLevel ?? 0,
                origin: { x: origin[0], y: origin[1], z: origin[2] },
            },
            { width: copySize[0], height: copySize[1], depthOrArrayLayers: copySize[2] }
        );
    }

    copyTextureToBuffer(
        source: { texture: TextureView; mipLevel?: number; origin?: [number, number, number] },
        destination: { buffer: Buffer; offset?: number; bytesPerRow?: number; rowsPerImage?: number },
        copySize: [number, number, number]
    ): void {
        const origin = source.origin ?? [0, 0, 0];
        this._encoder.copyTextureToBuffer(
            {
                texture: ((source.texture as WebGPUTextureView).texture as WebGPUTexture).getGPUTexture(),
                mipLevel: source.mipLevel ?? 0,
                origin: { x: origin[0], y: origin[1], z: origin[2] },
            },
            {
                buffer: (destination.buffer as WebGPUBuffer).getGPUBuffer(),
                offset: destination.offset ?? 0,
                bytesPerRow: destination.bytesPerRow,
                rowsPerImage: destination.rowsPerImage,
            },
            { width: copySize[0], height: copySize[1], depthOrArrayLayers: copySize[2] }
        );
    }

    copyTextureToTexture(
        source: { texture: TextureView; mipLevel?: number; origin?: [number, number, number] },
        destination: { texture: TextureView; mipLevel?: number; origin?: [number, number, number] },
        copySize: [number, number, number]
    ): void {
        const srcOrigin = source.origin ?? [0, 0, 0];
        const dstOrigin = destination.origin ?? [0, 0, 0];
        this._encoder.copyTextureToTexture(
            {
                texture: ((source.texture as WebGPUTextureView).texture as WebGPUTexture).getGPUTexture(),
                mipLevel: source.mipLevel ?? 0,
                origin: { x: srcOrigin[0], y: srcOrigin[1], z: srcOrigin[2] },
            },
            {
                texture: ((destination.texture as WebGPUTextureView).texture as WebGPUTexture).getGPUTexture(),
                mipLevel: destination.mipLevel ?? 0,
                origin: { x: dstOrigin[0], y: dstOrigin[1], z: dstOrigin[2] },
            },
            { width: copySize[0], height: copySize[1], depthOrArrayLayers: copySize[2] }
        );
    }

    finish(): CommandBuffer {
        return new WebGPUCommandBuffer(this._encoder.finish());
    }
}

class WebGPURenderPassEncoder implements RenderPassEncoder {
    private _pass: GPURenderPassEncoder;
    private _stats: GPUStats;

    constructor(pass: GPURenderPassEncoder, stats: GPUStats) {
        this._pass = pass;
        this._stats = stats;
    }

    setPipeline(pipeline: RenderPipeline): void {
        this._pass.setPipeline((pipeline as WebGPURenderPipeline).getGPURenderPipeline());
    }

    setBindGroup(index: number, bindGroup: BindGroup, dynamicOffsets?: number[]): void {
        this._pass.setBindGroup(
            index,
            (bindGroup as WebGPUBindGroup).getGPUBindGroup(),
            dynamicOffsets
        );
    }

    setVertexBuffer(slot: number, buffer: Buffer, offset?: number, size?: number): void {
        this._pass.setVertexBuffer(slot, (buffer as WebGPUBuffer).getGPUBuffer(), offset, size);
    }

    setIndexBuffer(buffer: Buffer, format: import('../gpu/pipeline').IndexFormat, offset?: number, size?: number): void {
        this._pass.setIndexBuffer(
            (buffer as WebGPUBuffer).getGPUBuffer(),
            format as GPUIndexFormat,
            offset,
            size
        );
    }

    setViewport(x: number, y: number, width: number, height: number, minDepth: number, maxDepth: number): void {
        this._pass.setViewport(x, y, width, height, minDepth, maxDepth);
    }

    setScissorRect(x: number, y: number, width: number, height: number): void {
        this._pass.setScissorRect(x, y, width, height);
    }

    setBlendConstant(color: [number, number, number, number]): void {
        this._pass.setBlendConstant({ r: color[0], g: color[1], b: color[2], a: color[3] });
    }

    setStencilReference(reference: number): void {
        this._pass.setStencilReference(reference);
    }

    draw(vertexCount: number, instanceCount?: number, firstVertex?: number, firstInstance?: number): void {
        this._pass.draw(vertexCount, instanceCount ?? 1, firstVertex ?? 0, firstInstance ?? 0);
        this._stats.drawCount++;
        this._stats.instanceCount += instanceCount ?? 1;
    }

    drawIndexed(indexCount: number, instanceCount?: number, firstIndex?: number, baseVertex?: number, firstInstance?: number): void {
        this._pass.drawIndexed(indexCount, instanceCount ?? 1, firstIndex ?? 0, baseVertex ?? 0, firstInstance ?? 0);
        this._stats.drawCount++;
        this._stats.instanceCount += instanceCount ?? 1;
        if ((instanceCount ?? 1) > 1) {
            this._stats.instancedDrawCount++;
        }
    }

    drawIndirect(indirectBuffer: Buffer, indirectOffset: number): void {
        this._pass.drawIndirect((indirectBuffer as WebGPUBuffer).getGPUBuffer(), indirectOffset);
        this._stats.drawCount++;
    }

    drawIndexedIndirect(indirectBuffer: Buffer, indirectOffset: number): void {
        this._pass.drawIndexedIndirect((indirectBuffer as WebGPUBuffer).getGPUBuffer(), indirectOffset);
        this._stats.drawCount++;
    }

    end(): void {
        this._pass.end();
    }
}

class WebGPUComputePassEncoder implements ComputePassEncoder {
    private _pass: GPUComputePassEncoder;

    constructor(pass: GPUComputePassEncoder) {
        this._pass = pass;
    }

    setPipeline(pipeline: ComputePipeline): void {
        this._pass.setPipeline((pipeline as WebGPUComputePipeline).getGPUComputePipeline());
    }

    setBindGroup(index: number, bindGroup: BindGroup, dynamicOffsets?: number[]): void {
        this._pass.setBindGroup(
            index,
            (bindGroup as WebGPUBindGroup).getGPUBindGroup(),
            dynamicOffsets
        );
    }

    dispatchWorkgroups(workgroupCountX: number, workgroupCountY?: number, workgroupCountZ?: number): void {
        this._pass.dispatchWorkgroups(workgroupCountX, workgroupCountY ?? 1, workgroupCountZ ?? 1);
    }

    dispatchWorkgroupsIndirect(indirectBuffer: Buffer, indirectOffset: number): void {
        this._pass.dispatchWorkgroupsIndirect(
            (indirectBuffer as WebGPUBuffer).getGPUBuffer(),
            indirectOffset
        );
    }

    end(): void {
        this._pass.end();
    }
}

class WebGPUCommandBuffer implements CommandBuffer {
    readonly label?: string;
    private _buffer: GPUCommandBuffer;

    constructor(buffer: GPUCommandBuffer) {
        this._buffer = buffer;
        this.label = buffer.label;
    }

    getGPUCommandBuffer(): GPUCommandBuffer {
        return this._buffer;
    }
}

// Render Target Classes

let nextRenderTargetId = 0;

/**
 * WebGPU render target for offscreen rendering.
 */
class WebGPURenderTarget implements RenderTarget {
    readonly id: number;

    private _device: GPUDevice;
    private _width: number;
    private _height: number;
    private _depth: boolean;
    private _type: 'uint8' | 'float32' | 'fp16';
    private _format: 'rgba' | 'alpha';
    private _colorTexture: GPUTexture | null = null;
    private _depthTexture: GPUTexture | null = null;
    private _textureView: TextureView | null = null;
    private _destroyed = false;

    constructor(
        device: GPUDevice,
        _stats: GPUStats,
        width: number,
        height: number,
        depth: boolean,
        type: 'uint8' | 'float32' | 'fp16',
        _filter: 'nearest' | 'linear',
        format: 'rgba' | 'alpha'
    ) {
        this.id = nextRenderTargetId++;
        this._device = device;
        this._width = width;
        this._height = height;
        this._depth = depth;
        this._type = type;
        this._format = format;

        this._initialize();
    }

    private _initialize(): void {
        const device = this._device;

        // Create color texture
        this._colorTexture = device.createTexture({
            size: { width: this._width, height: this._height },
            format: this._getTextureFormat(),
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
        });

        // Create depth texture if needed
        if (this._depth) {
            this._depthTexture = device.createTexture({
                size: { width: this._width, height: this._height },
                format: 'depth32float',
                usage: GPUTextureUsage.RENDER_ATTACHMENT,
            });
        }

        // Create texture view wrapper
        const self = this;
        const wrapperTexture: Texture = {
            id: createTextureId(),
            width: this._width,
            height: this._height,
            depth: 1,
            format: this._getAbstractFormat(),
            dimension: '2d' as const,
            mipLevelCount: 1,
            sampleCount: 1,
            write: () => {},
            getByteCount: () => self.getByteCount(),
            reset: () => self._initialize(),
            destroy: () => {},
            createView: () => self._textureView!,
        };

        this._textureView = new WebGPUTextureView(
            this._colorTexture!.createView(),
            wrapperTexture
        );
    }

    private _getTextureFormat(): GPUTextureFormat {
        if (this._format === 'alpha') return 'r8unorm';
        switch (this._type) {
            case 'fp16': return 'rgba16float';
            case 'float32': return 'rgba32float';
            default: return 'rgba8unorm';
        }
    }

    private _getAbstractFormat(): import('../gpu/texture').TextureFormat {
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

    /**
     * Get the depth texture view for use as a depth-stencil attachment.
     * Returns null if this render target was created without depth.
     */
    get depthTextureView(): TextureView | null {
        if (!this._depthTexture) return null;
        if (!this._depthTextureView) {
            const self = this;
            // Create wrapper texture for the depth texture
            const wrapperTexture: Texture = {
                id: createTextureId(),
                width: this._width,
                height: this._height,
                depth: 1,
                format: 'depth32float',
                dimension: '2d' as const,
                mipLevelCount: 1,
                sampleCount: 1,
                write: () => {},
                getByteCount: () => this._width * this._height * 4,
                reset: () => self._initialize(),
                destroy: () => {},
                createView: () => self._depthTextureView!,
            };
            this._depthTextureView = new WebGPUTextureView(
                this._depthTexture.createView(),
                wrapperTexture
            );
        }
        return this._depthTextureView;
    }
    private _depthTextureView: TextureView | null = null;

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
        // WebGPU doesn't bind render targets directly
        // Binding happens via render pass descriptors
        // This method exists for API compatibility
    }

    getGPUColorTexture(): GPUTexture | null {
        return this._colorTexture;
    }

    getGPUDepthTexture(): GPUTexture | null {
        return this._depthTexture;
    }

    setSize(width: number, height: number): void {
        if (this._width === width && this._height === height) return;

        // Destroy existing textures
        this._colorTexture?.destroy();
        this._depthTexture?.destroy();

        this._width = width;
        this._height = height;

        // Recreate
        this._initialize();
    }

    reset(): void {
        this._initialize();
    }

    destroy(): void {
        if (this._destroyed) return;

        this._colorTexture?.destroy();
        this._depthTexture?.destroy();

        this._colorTexture = null;
        this._depthTexture = null;
        this._destroyed = true;
    }
}

/**
 * WebGPU draw target representing the swapchain texture.
 */
class WebGPUDrawTarget implements RenderTarget {
    readonly id = -1;

    private _gpuContext: GPUCanvasContext;
    private _textureView: TextureView;

    constructor(gpuContext: GPUCanvasContext, _device: GPUDevice) {
        this._gpuContext = gpuContext;

        // Create a dummy texture view wrapper
        const self = this;
        const texture = gpuContext.getCurrentTexture();
        const dummyTexture: Texture = {
            id: -1,
            width: texture.width,
            height: texture.height,
            depth: 1,
            format: 'rgba8unorm',
            dimension: '2d' as const,
            mipLevelCount: 1,
            sampleCount: 1,
            write: () => {},
            getByteCount: () => 0,
            reset: () => {},
            destroy: () => {},
            createView: () => self._textureView,
        };

        this._textureView = new WebGPUTextureView(
            texture.createView(),
            dummyTexture
        );
    }

    get texture(): TextureView {
        // Return a fresh view of the current swapchain texture
        const texture = this._gpuContext.getCurrentTexture();
        const self = this;
        const wrapperTexture: Texture = {
            id: -1,
            width: texture.width,
            height: texture.height,
            depth: 1,
            format: 'rgba8unorm',
            dimension: '2d' as const,
            mipLevelCount: 1,
            sampleCount: 1,
            write: () => {},
            getByteCount: () => 0,
            reset: () => {},
            destroy: () => {},
            createView: () => self._textureView,
        };
        return new WebGPUTextureView(texture.createView(), wrapperTexture);
    }

    getByteCount(): number {
        return 0; // Swapchain memory is managed by the browser
    }

    getWidth(): number {
        return this._gpuContext.getCurrentTexture().width;
    }

    getHeight(): number {
        return this._gpuContext.getCurrentTexture().height;
    }

    bind(): void {
        // WebGPU doesn't bind render targets directly
        // This method exists for API compatibility
    }

    setSize(_width: number, _height: number): void {
        // Swapchain size is controlled by canvas dimensions
    }

    reset(): void {
        // Nothing to reset for the swapchain
    }

    destroy(): void {
        // Swapchain is managed by the browser
    }
}

/**
 * WebGPU implementation of RenderState interface.
 *
 * In WebGPU, render state is immutable and baked into pipeline objects.
 * This class tracks the desired state for:
 * 1. Pipeline creation/selection
 * 2. Dynamic state that can be set during render pass (viewport, scissor)
 *
 * Most "state changes" just update tracked values - they don't apply immediately
 * because WebGPU pipelines are immutable.
 */
class WebGPURenderState implements RenderState {
    currentProgramId: number = -1;
    currentMaterialId: number = -1;
    currentRenderItemId: number = -1;

    // Track current state for pipeline creation
    private _blendEnabled = false;
    private _depthTestEnabled = false;
    private _stencilTestEnabled = false;
    private _cullFaceEnabled = false;
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

    // Viewport and scissor (these are dynamic in WebGPU)
    private _viewport: [number, number, number, number] = [0, 0, 0, 0];
    private _scissor: [number, number, number, number] = [0, 0, 0, 0];

    // Vertex attribute tracking (for compatibility)
    private _enabledVertexAttribs: Set<number> = new Set();

    // Feature enable/disable (updates tracked state for pipeline creation)

    enableBlend(): void {
        this._blendEnabled = true;
    }

    disableBlend(): void {
        this._blendEnabled = false;
    }

    enableDepthTest(): void {
        this._depthTestEnabled = true;
    }

    disableDepthTest(): void {
        this._depthTestEnabled = false;
    }

    enableStencilTest(): void {
        this._stencilTestEnabled = true;
    }

    disableStencilTest(): void {
        this._stencilTestEnabled = false;
    }

    enableCullFace(): void {
        this._cullFaceEnabled = true;
    }

    disableCullFace(): void {
        this._cullFaceEnabled = false;
    }

    enableScissorTest(): void {
        // WebGPU always uses scissor rects in render pass
    }

    disableScissorTest(): void {
        // WebGPU always uses scissor rects in render pass
    }

    enablePolygonOffsetFill(): void {
        // WebGPU handles this via depthBias in pipeline descriptor
    }

    disablePolygonOffsetFill(): void {
        // WebGPU handles this via depthBias in pipeline descriptor
    }

    // Blend state

    blendFunc(src: BlendFactor, dst: BlendFactor): void {
        this._blendSrcRGB = this._blendSrcAlpha = src;
        this._blendDstRGB = this._blendDstAlpha = dst;
    }

    blendFuncSeparate(srcRGB: BlendFactor, dstRGB: BlendFactor, srcAlpha: BlendFactor, dstAlpha: BlendFactor): void {
        this._blendSrcRGB = srcRGB;
        this._blendDstRGB = dstRGB;
        this._blendSrcAlpha = srcAlpha;
        this._blendDstAlpha = dstAlpha;
    }

    blendEquation(mode: BlendOperation): void {
        this._blendOpRGB = this._blendOpAlpha = mode;
    }

    blendEquationSeparate(modeRGB: BlendOperation, modeAlpha: BlendOperation): void {
        this._blendOpRGB = modeRGB;
        this._blendOpAlpha = modeAlpha;
    }

    blendColor(_red: number, _green: number, _blue: number, _alpha: number): void {
        // WebGPU sets blend constant via setBlendConstant on render pass encoder
    }

    // Depth state

    depthMask(flag: boolean): void {
        this._depthWriteEnabled = flag;
    }

    depthFunc(func: CompareFunction): void {
        this._depthCompare = func;
    }

    clearDepth(_depth: number): void {
        // WebGPU sets clear depth in render pass descriptor
    }

    // Stencil state

    stencilFunc(_func: CompareFunction, _ref: number, _mask: number): void {
        // WebGPU stencil is configured in pipeline descriptor
    }

    stencilFuncSeparate(_face: 'front' | 'back' | 'front-and-back', _func: CompareFunction, _ref: number, _mask: number): void {
        // WebGPU stencil is configured in pipeline descriptor
    }

    stencilMask(_mask: number): void {
        // WebGPU stencil is configured in pipeline descriptor
    }

    stencilMaskSeparate(_face: 'front' | 'back' | 'front-and-back', _mask: number): void {
        // WebGPU stencil is configured in pipeline descriptor
    }

    stencilOp(_fail: StencilOperation, _zfail: StencilOperation, _zpass: StencilOperation): void {
        // WebGPU stencil is configured in pipeline descriptor
    }

    stencilOpSeparate(_face: 'front' | 'back' | 'front-and-back', _fail: StencilOperation, _zfail: StencilOperation, _zpass: StencilOperation): void {
        // WebGPU stencil is configured in pipeline descriptor
    }

    // Rasterization state

    frontFace(mode: FrontFace): void {
        this._frontFace = mode;
    }

    cullFace(mode: CullMode): void {
        this._cullMode = mode;
        if (mode === 'none') {
            this._cullFaceEnabled = false;
        }
    }

    polygonOffset(_factor: number, _units: number): void {
        // WebGPU handles this via depthBias in pipeline descriptor
    }

    // Color state

    colorMask(_red: boolean, _green: boolean, _blue: boolean, _alpha: boolean): void {
        // WebGPU color mask is part of pipeline color target state
    }

    clearColor(_red: number, _green: number, _blue: number, _alpha: number): void {
        // WebGPU sets clear color in render pass descriptor
    }

    // Viewport and scissor (these ARE dynamic in WebGPU)

    viewport(x: number, y: number, width: number, height: number): void {
        this._viewport = [x, y, width, height];
    }

    scissor(x: number, y: number, width: number, height: number): void {
        this._scissor = [x, y, width, height];
    }

    // Vertex attribute state (compatibility layer)

    enableVertexAttrib(index: number): void {
        this._enabledVertexAttribs.add(index);
    }

    clearVertexAttribsState(): void {
        this._enabledVertexAttribs.clear();
    }

    disableUnusedVertexAttribs(): void {
        // In WebGPU, vertex attributes are defined by the pipeline layout
        // No runtime enable/disable
    }

    // State snapshot (for pipeline key generation)

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

    // Get current viewport (for render pass encoder)
    getViewport(): [number, number, number, number] {
        return this._viewport;
    }

    // Get current scissor (for render pass encoder)
    getScissor(): [number, number, number, number] {
        return this._scissor;
    }

    // Reset state

    reset(): void {
        this.currentProgramId = -1;
        this.currentMaterialId = -1;
        this.currentRenderItemId = -1;

        this._blendEnabled = false;
        this._depthTestEnabled = false;
        this._stencilTestEnabled = false;
        this._cullFaceEnabled = false;
        this._cullMode = 'back';
        this._frontFace = 'ccw';

        this._blendSrcRGB = this._blendSrcAlpha = 'one';
        this._blendDstRGB = this._blendDstAlpha = 'zero';
        this._blendOpRGB = this._blendOpAlpha = 'add';

        this._depthWriteEnabled = true;
        this._depthCompare = 'less';

        this._viewport = [0, 0, 0, 0];
        this._scissor = [0, 0, 0, 0];

        this._enabledVertexAttribs.clear();
    }
}
