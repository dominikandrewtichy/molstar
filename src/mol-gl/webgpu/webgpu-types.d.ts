/**
 * Copyright (c) 2025 mol* contributors, licensed under MIT, See LICENSE file for more info.
 *
 * WebGPU type declarations for TypeScript.
 * These are minimal declarations needed for the Mol* WebGPU backend.
 * For full types, install @webgpu/types.
 */

// Navigator extension
interface Navigator {
    readonly gpu?: GPU;
}

// GPU interface
interface GPU {
    requestAdapter(options?: GPURequestAdapterOptions): Promise<GPUAdapter | null>;
    getPreferredCanvasFormat(): GPUTextureFormat;
}

interface GPURequestAdapterOptions {
    powerPreference?: GPUPowerPreference;
    forceFallbackAdapter?: boolean;
}

type GPUPowerPreference = 'low-power' | 'high-performance';

// GPUAdapter
interface GPUAdapter {
    readonly features: GPUSupportedFeatures;
    readonly limits: GPUSupportedLimits;
    readonly isFallbackAdapter: boolean;
    requestDevice(descriptor?: GPUDeviceDescriptor): Promise<GPUDevice>;
    requestAdapterInfo(): Promise<GPUAdapterInfo>;
}

interface GPUSupportedFeatures {
    has(feature: GPUFeatureName): boolean;
}

interface GPUSupportedLimits {
    readonly maxTextureDimension1D: number;
    readonly maxTextureDimension2D: number;
    readonly maxTextureDimension3D: number;
    readonly maxTextureArrayLayers: number;
    readonly maxBindGroups: number;
    readonly maxBindGroupsPlusVertexBuffers: number;
    readonly maxBindingsPerBindGroup: number;
    readonly maxDynamicUniformBuffersPerPipelineLayout: number;
    readonly maxDynamicStorageBuffersPerPipelineLayout: number;
    readonly maxSampledTexturesPerShaderStage: number;
    readonly maxSamplersPerShaderStage: number;
    readonly maxStorageBuffersPerShaderStage: number;
    readonly maxStorageTexturesPerShaderStage: number;
    readonly maxUniformBuffersPerShaderStage: number;
    readonly maxUniformBufferBindingSize: number;
    readonly maxStorageBufferBindingSize: number;
    readonly minUniformBufferOffsetAlignment: number;
    readonly minStorageBufferOffsetAlignment: number;
    readonly maxVertexBuffers: number;
    readonly maxBufferSize: number;
    readonly maxVertexAttributes: number;
    readonly maxVertexBufferArrayStride: number;
    readonly maxInterStageShaderComponents: number;
    readonly maxInterStageShaderVariables: number;
    readonly maxColorAttachments: number;
    readonly maxColorAttachmentBytesPerSample: number;
    readonly maxComputeWorkgroupStorageSize: number;
    readonly maxComputeInvocationsPerWorkgroup: number;
    readonly maxComputeWorkgroupSizeX: number;
    readonly maxComputeWorkgroupSizeY: number;
    readonly maxComputeWorkgroupSizeZ: number;
    readonly maxComputeWorkgroupsPerDimension: number;
}

interface GPUAdapterInfo {
    readonly vendor: string;
    readonly architecture: string;
    readonly device: string;
    readonly description: string;
}

type GPUFeatureName =
    | 'depth-clip-control'
    | 'depth32float-stencil8'
    | 'texture-compression-bc'
    | 'texture-compression-etc2'
    | 'texture-compression-astc'
    | 'timestamp-query'
    | 'indirect-first-instance'
    | 'shader-f16'
    | 'rg11b10ufloat-renderable'
    | 'bgra8unorm-storage'
    | 'float32-filterable';

interface GPUDeviceDescriptor {
    label?: string;
    requiredFeatures?: Iterable<GPUFeatureName>;
    requiredLimits?: Record<string, number>;
    defaultQueue?: GPUQueueDescriptor;
}

interface GPUQueueDescriptor {
    label?: string;
}

// GPUDevice
interface GPUDevice {
    readonly features: GPUSupportedFeatures;
    readonly limits: GPUSupportedLimits;
    readonly queue: GPUQueue;
    readonly lost: Promise<GPUDeviceLostInfo>;
    destroy(): void;
    createBuffer(descriptor: GPUBufferDescriptor): GPUBuffer;
    createTexture(descriptor: GPUTextureDescriptor): GPUTexture;
    createSampler(descriptor?: GPUSamplerDescriptor): GPUSampler;
    createBindGroupLayout(descriptor: GPUBindGroupLayoutDescriptor): GPUBindGroupLayout;
    createPipelineLayout(descriptor: GPUPipelineLayoutDescriptor): GPUPipelineLayout;
    createBindGroup(descriptor: GPUBindGroupDescriptor): GPUBindGroup;
    createShaderModule(descriptor: GPUShaderModuleDescriptor): GPUShaderModule;
    createComputePipeline(descriptor: GPUComputePipelineDescriptor): GPUComputePipeline;
    createRenderPipeline(descriptor: GPURenderPipelineDescriptor): GPURenderPipeline;
    createCommandEncoder(descriptor?: GPUCommandEncoderDescriptor): GPUCommandEncoder;
}

interface GPUDeviceLostInfo {
    readonly reason: 'unknown' | 'destroyed';
    readonly message: string;
}

// GPUQueue
interface GPUQueue {
    submit(commandBuffers: Iterable<GPUCommandBuffer>): void;
    onSubmittedWorkDone(): Promise<void>;
    writeBuffer(buffer: GPUBuffer, bufferOffset: number, data: BufferSource, dataOffset?: number, size?: number): void;
    writeTexture(
        destination: GPUImageCopyTexture,
        data: BufferSource,
        dataLayout: GPUImageDataLayout,
        size: GPUExtent3DStrict
    ): void;
    copyExternalImageToTexture(
        source: GPUImageCopyExternalImage,
        destination: GPUImageCopyTextureTagged,
        copySize: GPUExtent3D
    ): void;
}

// Buffer
interface GPUBufferDescriptor {
    label?: string;
    size: number;
    usage: GPUBufferUsageFlags;
    mappedAtCreation?: boolean;
}

interface GPUBuffer {
    readonly label: string | undefined;
    readonly size: number;
    readonly usage: GPUBufferUsageFlags;
    readonly mapState: GPUBufferMapState;
    mapAsync(mode: GPUMapModeFlags, offset?: number, size?: number): Promise<void>;
    getMappedRange(offset?: number, size?: number): ArrayBuffer;
    unmap(): void;
    destroy(): void;
}

type GPUBufferMapState = 'unmapped' | 'pending' | 'mapped';
type GPUBufferUsageFlags = number;
type GPUMapModeFlags = number;

declare const GPUBufferUsage: {
    readonly MAP_READ: 0x0001;
    readonly MAP_WRITE: 0x0002;
    readonly COPY_SRC: 0x0004;
    readonly COPY_DST: 0x0008;
    readonly INDEX: 0x0010;
    readonly VERTEX: 0x0020;
    readonly UNIFORM: 0x0040;
    readonly STORAGE: 0x0080;
    readonly INDIRECT: 0x0100;
    readonly QUERY_RESOLVE: 0x0200;
};

declare const GPUMapMode: {
    readonly READ: 0x0001;
    readonly WRITE: 0x0002;
};

// Texture
interface GPUTextureDescriptor {
    label?: string;
    size: GPUExtent3DStrict;
    mipLevelCount?: number;
    sampleCount?: number;
    dimension?: GPUTextureDimension;
    format: GPUTextureFormat;
    usage: GPUTextureUsageFlags;
    viewFormats?: Iterable<GPUTextureFormat>;
}

interface GPUTexture {
    readonly label: string | undefined;
    readonly width: number;
    readonly height: number;
    readonly depthOrArrayLayers: number;
    readonly mipLevelCount: number;
    readonly sampleCount: number;
    readonly dimension: GPUTextureDimension;
    readonly format: GPUTextureFormat;
    readonly usage: GPUTextureUsageFlags;
    createView(descriptor?: GPUTextureViewDescriptor): GPUTextureView;
    destroy(): void;
}

interface GPUTextureView {
    readonly label: string | undefined;
}

interface GPUTextureViewDescriptor {
    label?: string;
    format?: GPUTextureFormat;
    dimension?: GPUTextureViewDimension;
    aspect?: GPUTextureAspect;
    baseMipLevel?: number;
    mipLevelCount?: number;
    baseArrayLayer?: number;
    arrayLayerCount?: number;
}

type GPUTextureDimension = '1d' | '2d' | '3d';
type GPUTextureViewDimension = '1d' | '2d' | '2d-array' | 'cube' | 'cube-array' | '3d';
type GPUTextureAspect = 'all' | 'stencil-only' | 'depth-only';
type GPUTextureUsageFlags = number;

declare const GPUTextureUsage: {
    readonly COPY_SRC: 0x01;
    readonly COPY_DST: 0x02;
    readonly TEXTURE_BINDING: 0x04;
    readonly STORAGE_BINDING: 0x08;
    readonly RENDER_ATTACHMENT: 0x10;
};

type GPUTextureFormat =
    | 'r8unorm' | 'r8snorm' | 'r8uint' | 'r8sint'
    | 'r16uint' | 'r16sint' | 'r16float'
    | 'rg8unorm' | 'rg8snorm' | 'rg8uint' | 'rg8sint'
    | 'r32uint' | 'r32sint' | 'r32float'
    | 'rg16uint' | 'rg16sint' | 'rg16float'
    | 'rgba8unorm' | 'rgba8unorm-srgb' | 'rgba8snorm' | 'rgba8uint' | 'rgba8sint'
    | 'bgra8unorm' | 'bgra8unorm-srgb'
    | 'rgb9e5ufloat' | 'rgb10a2uint' | 'rgb10a2unorm' | 'rg11b10ufloat'
    | 'rg32uint' | 'rg32sint' | 'rg32float'
    | 'rgba16uint' | 'rgba16sint' | 'rgba16float'
    | 'rgba32uint' | 'rgba32sint' | 'rgba32float'
    | 'stencil8' | 'depth16unorm' | 'depth24plus' | 'depth24plus-stencil8' | 'depth32float' | 'depth32float-stencil8';

// Sampler
interface GPUSamplerDescriptor {
    label?: string;
    addressModeU?: GPUAddressMode;
    addressModeV?: GPUAddressMode;
    addressModeW?: GPUAddressMode;
    magFilter?: GPUFilterMode;
    minFilter?: GPUFilterMode;
    mipmapFilter?: GPUMipmapFilterMode;
    lodMinClamp?: number;
    lodMaxClamp?: number;
    compare?: GPUCompareFunction;
    maxAnisotropy?: number;
}

interface GPUSampler {
    readonly label: string | undefined;
}

type GPUAddressMode = 'clamp-to-edge' | 'repeat' | 'mirror-repeat';
type GPUFilterMode = 'nearest' | 'linear';
type GPUMipmapFilterMode = 'nearest' | 'linear';
type GPUCompareFunction = 'never' | 'less' | 'equal' | 'less-equal' | 'greater' | 'not-equal' | 'greater-equal' | 'always';

// Bind Group Layout
interface GPUBindGroupLayoutDescriptor {
    label?: string;
    entries: Iterable<GPUBindGroupLayoutEntry>;
}

interface GPUBindGroupLayoutEntry {
    binding: number;
    visibility: GPUShaderStageFlags;
    buffer?: GPUBufferBindingLayout;
    sampler?: GPUSamplerBindingLayout;
    texture?: GPUTextureBindingLayout;
    storageTexture?: GPUStorageTextureBindingLayout;
    externalTexture?: GPUExternalTextureBindingLayout;
}

interface GPUBufferBindingLayout {
    type?: GPUBufferBindingType;
    hasDynamicOffset?: boolean;
    minBindingSize?: number;
}

interface GPUSamplerBindingLayout {
    type?: GPUSamplerBindingType;
}

interface GPUTextureBindingLayout {
    sampleType?: GPUTextureSampleType;
    viewDimension?: GPUTextureViewDimension;
    multisampled?: boolean;
}

interface GPUStorageTextureBindingLayout {
    access?: GPUStorageTextureAccess;
    format: GPUTextureFormat;
    viewDimension?: GPUTextureViewDimension;
}

interface GPUExternalTextureBindingLayout {}

type GPUBufferBindingType = 'uniform' | 'storage' | 'read-only-storage';
type GPUSamplerBindingType = 'filtering' | 'non-filtering' | 'comparison';
type GPUTextureSampleType = 'float' | 'unfilterable-float' | 'depth' | 'sint' | 'uint';
type GPUStorageTextureAccess = 'write-only' | 'read-only' | 'read-write';
type GPUShaderStageFlags = number;

interface GPUBindGroupLayout {
    readonly label: string | undefined;
}

// Pipeline Layout
interface GPUPipelineLayoutDescriptor {
    label?: string;
    bindGroupLayouts: Iterable<GPUBindGroupLayout>;
}

interface GPUPipelineLayout {
    readonly label: string | undefined;
}

// Bind Group
interface GPUBindGroupDescriptor {
    label?: string;
    layout: GPUBindGroupLayout;
    entries: Iterable<GPUBindGroupEntry>;
}

interface GPUBindGroupEntry {
    binding: number;
    resource: GPUBindingResource;
}

type GPUBindingResource = GPUSampler | GPUTextureView | GPUBufferBinding | GPUExternalTexture;

interface GPUBufferBinding {
    buffer: GPUBuffer;
    offset?: number;
    size?: number;
}

interface GPUExternalTexture {}

interface GPUBindGroup {
    readonly label: string | undefined;
}

// Shader Module
interface GPUShaderModuleDescriptor {
    label?: string;
    code: string;
}

interface GPUShaderModule {
    readonly label: string | undefined;
    getCompilationInfo(): Promise<GPUCompilationInfo>;
}

interface GPUCompilationInfo {
    readonly messages: readonly GPUCompilationMessage[];
}

interface GPUCompilationMessage {
    readonly message: string;
    readonly type: GPUCompilationMessageType;
    readonly lineNum: number;
    readonly linePos: number;
    readonly offset: number;
    readonly length: number;
}

type GPUCompilationMessageType = 'error' | 'warning' | 'info';

// Pipeline
interface GPUPipelineDescriptorBase {
    label?: string;
    layout: GPUPipelineLayout | 'auto';
}

interface GPUProgrammableStage {
    module: GPUShaderModule;
    entryPoint: string;
    constants?: Record<string, number>;
}

// Compute Pipeline
interface GPUComputePipelineDescriptor extends GPUPipelineDescriptorBase {
    compute: GPUProgrammableStage;
}

interface GPUComputePipeline {
    readonly label: string | undefined;
    getBindGroupLayout(index: number): GPUBindGroupLayout;
}

// Render Pipeline
interface GPURenderPipelineDescriptor extends GPUPipelineDescriptorBase {
    vertex: GPUVertexState;
    primitive?: GPUPrimitiveState;
    depthStencil?: GPUDepthStencilState;
    multisample?: GPUMultisampleState;
    fragment?: GPUFragmentState;
}

interface GPUVertexState extends GPUProgrammableStage {
    buffers?: Iterable<GPUVertexBufferLayout | null>;
}

interface GPUVertexBufferLayout {
    arrayStride: number;
    stepMode?: GPUVertexStepMode;
    attributes: Iterable<GPUVertexAttribute>;
}

interface GPUVertexAttribute {
    format: GPUVertexFormat;
    offset: number;
    shaderLocation: number;
}

type GPUVertexStepMode = 'vertex' | 'instance';

type GPUVertexFormat =
    | 'uint8x2' | 'uint8x4' | 'sint8x2' | 'sint8x4' | 'unorm8x2' | 'unorm8x4' | 'snorm8x2' | 'snorm8x4'
    | 'uint16x2' | 'uint16x4' | 'sint16x2' | 'sint16x4' | 'unorm16x2' | 'unorm16x4' | 'snorm16x2' | 'snorm16x4' | 'float16x2' | 'float16x4'
    | 'float32' | 'float32x2' | 'float32x3' | 'float32x4'
    | 'uint32' | 'uint32x2' | 'uint32x3' | 'uint32x4'
    | 'sint32' | 'sint32x2' | 'sint32x3' | 'sint32x4';

interface GPUPrimitiveState {
    topology?: GPUPrimitiveTopology;
    stripIndexFormat?: GPUIndexFormat;
    frontFace?: GPUFrontFace;
    cullMode?: GPUCullMode;
    unclippedDepth?: boolean;
}

type GPUPrimitiveTopology = 'point-list' | 'line-list' | 'line-strip' | 'triangle-list' | 'triangle-strip';
type GPUIndexFormat = 'uint16' | 'uint32';
type GPUFrontFace = 'ccw' | 'cw';
type GPUCullMode = 'none' | 'front' | 'back';

interface GPUDepthStencilState {
    format: GPUTextureFormat;
    depthWriteEnabled?: boolean;
    depthCompare?: GPUCompareFunction;
    stencilFront?: GPUStencilFaceState;
    stencilBack?: GPUStencilFaceState;
    stencilReadMask?: number;
    stencilWriteMask?: number;
    depthBias?: number;
    depthBiasSlopeScale?: number;
    depthBiasClamp?: number;
}

interface GPUStencilFaceState {
    compare?: GPUCompareFunction;
    failOp?: GPUStencilOperation;
    depthFailOp?: GPUStencilOperation;
    passOp?: GPUStencilOperation;
}

type GPUStencilOperation = 'keep' | 'zero' | 'replace' | 'invert' | 'increment-clamp' | 'decrement-clamp' | 'increment-wrap' | 'decrement-wrap';

interface GPUMultisampleState {
    count?: number;
    mask?: number;
    alphaToCoverageEnabled?: boolean;
}

interface GPUFragmentState extends GPUProgrammableStage {
    targets: Iterable<GPUColorTargetState | null>;
}

interface GPUColorTargetState {
    format: GPUTextureFormat;
    blend?: GPUBlendState;
    writeMask?: GPUColorWriteFlags;
}

interface GPUBlendState {
    color: GPUBlendComponent;
    alpha: GPUBlendComponent;
}

interface GPUBlendComponent {
    operation?: GPUBlendOperation;
    srcFactor?: GPUBlendFactor;
    dstFactor?: GPUBlendFactor;
}

type GPUBlendOperation = 'add' | 'subtract' | 'reverse-subtract' | 'min' | 'max';
type GPUBlendFactor = 'zero' | 'one' | 'src' | 'one-minus-src' | 'src-alpha' | 'one-minus-src-alpha' | 'dst' | 'one-minus-dst' | 'dst-alpha' | 'one-minus-dst-alpha' | 'src-alpha-saturated' | 'constant' | 'one-minus-constant';
type GPUColorWriteFlags = number;

interface GPURenderPipeline {
    readonly label: string | undefined;
    getBindGroupLayout(index: number): GPUBindGroupLayout;
}

// Command Encoder
interface GPUCommandEncoderDescriptor {
    label?: string;
}

interface GPUCommandEncoder {
    readonly label: string | undefined;
    beginRenderPass(descriptor: GPURenderPassDescriptor): GPURenderPassEncoder;
    beginComputePass(descriptor?: GPUComputePassDescriptor): GPUComputePassEncoder;
    copyBufferToBuffer(source: GPUBuffer, sourceOffset: number, destination: GPUBuffer, destinationOffset: number, size: number): void;
    copyBufferToTexture(source: GPUImageCopyBuffer, destination: GPUImageCopyTexture, copySize: GPUExtent3DStrict): void;
    copyTextureToBuffer(source: GPUImageCopyTexture, destination: GPUImageCopyBuffer, copySize: GPUExtent3DStrict): void;
    copyTextureToTexture(source: GPUImageCopyTexture, destination: GPUImageCopyTexture, copySize: GPUExtent3DStrict): void;
    finish(descriptor?: GPUCommandBufferDescriptor): GPUCommandBuffer;
}

interface GPUImageCopyBuffer {
    buffer: GPUBuffer;
    offset?: number;
    bytesPerRow?: number;
    rowsPerImage?: number;
}

interface GPUImageCopyTexture {
    texture: GPUTexture;
    mipLevel?: number;
    origin?: GPUOrigin3DStrict;
    aspect?: GPUTextureAspect;
}

interface GPUImageDataLayout {
    offset?: number;
    bytesPerRow?: number;
    rowsPerImage?: number;
}

interface GPUImageCopyExternalImage {
    source: ImageBitmap | HTMLCanvasElement | HTMLImageElement | HTMLVideoElement | OffscreenCanvas | VideoFrame;
    origin?: GPUOrigin2D;
    flipY?: boolean;
}

type GPUImageCopyExternalImageSource = ImageBitmap | HTMLCanvasElement | HTMLImageElement | HTMLVideoElement | OffscreenCanvas | VideoFrame;

interface GPUImageCopyTextureTagged extends GPUImageCopyTexture {
    premultipliedAlpha?: boolean;
    colorSpace?: GPUPredefinedColorSpace;
}

type GPUPredefinedColorSpace = 'srgb' | 'display-p3';

type GPUExtent3D = [number, number, number] | { width: number; height?: number; depthOrArrayLayers?: number };
type GPUOrigin2D = [number, number] | { x?: number; y?: number };

type GPUExtent3DStrict = [number, number, number] | { width: number; height?: number; depthOrArrayLayers?: number };
type GPUOrigin3DStrict = [number, number, number] | { x?: number; y?: number; z?: number };

interface GPUCommandBufferDescriptor {
    label?: string;
}

interface GPUCommandBuffer {
    readonly label: string | undefined;
}

// Render Pass
interface GPURenderPassDescriptor {
    label?: string;
    colorAttachments: Iterable<GPURenderPassColorAttachment | null>;
    depthStencilAttachment?: GPURenderPassDepthStencilAttachment;
    occlusionQuerySet?: GPUQuerySet;
    timestampWrites?: GPURenderPassTimestampWrites;
    maxDrawCount?: number;
}

interface GPURenderPassColorAttachment {
    view: GPUTextureView;
    resolveTarget?: GPUTextureView;
    clearValue?: GPUColor;
    loadOp: GPULoadOp;
    storeOp: GPUStoreOp;
}

interface GPURenderPassDepthStencilAttachment {
    view: GPUTextureView;
    depthClearValue?: number;
    depthLoadOp?: GPULoadOp;
    depthStoreOp?: GPUStoreOp;
    depthReadOnly?: boolean;
    stencilClearValue?: number;
    stencilLoadOp?: GPULoadOp;
    stencilStoreOp?: GPUStoreOp;
    stencilReadOnly?: boolean;
}

interface GPURenderPassTimestampWrites {
    querySet: GPUQuerySet;
    beginningOfPassWriteIndex?: number;
    endOfPassWriteIndex?: number;
}

interface GPUQuerySet {}

type GPUColor = [number, number, number, number] | { r: number; g: number; b: number; a: number };
type GPULoadOp = 'load' | 'clear';
type GPUStoreOp = 'store' | 'discard';

interface GPURenderPassEncoder {
    readonly label: string | undefined;
    setViewport(x: number, y: number, width: number, height: number, minDepth: number, maxDepth: number): void;
    setScissorRect(x: number, y: number, width: number, height: number): void;
    setBlendConstant(color: GPUColor): void;
    setStencilReference(reference: number): void;
    setPipeline(pipeline: GPURenderPipeline): void;
    setBindGroup(index: number, bindGroup: GPUBindGroup | null, dynamicOffsets?: Iterable<number>): void;
    setVertexBuffer(slot: number, buffer: GPUBuffer | null, offset?: number, size?: number): void;
    setIndexBuffer(buffer: GPUBuffer, indexFormat: GPUIndexFormat, offset?: number, size?: number): void;
    draw(vertexCount: number, instanceCount?: number, firstVertex?: number, firstInstance?: number): void;
    drawIndexed(indexCount: number, instanceCount?: number, firstIndex?: number, baseVertex?: number, firstInstance?: number): void;
    drawIndirect(indirectBuffer: GPUBuffer, indirectOffset: number): void;
    drawIndexedIndirect(indirectBuffer: GPUBuffer, indirectOffset: number): void;
    end(): void;
}

// Compute Pass
interface GPUComputePassDescriptor {
    label?: string;
    timestampWrites?: GPUComputePassTimestampWrites;
}

interface GPUComputePassTimestampWrites {
    querySet: GPUQuerySet;
    beginningOfPassWriteIndex?: number;
    endOfPassWriteIndex?: number;
}

interface GPUComputePassEncoder {
    readonly label: string | undefined;
    setPipeline(pipeline: GPUComputePipeline): void;
    setBindGroup(index: number, bindGroup: GPUBindGroup | null, dynamicOffsets?: Iterable<number>): void;
    dispatchWorkgroups(workgroupCountX: number, workgroupCountY?: number, workgroupCountZ?: number): void;
    dispatchWorkgroupsIndirect(indirectBuffer: GPUBuffer, indirectOffset: number): void;
    end(): void;
}

// Canvas Context
interface GPUCanvasContext {
    readonly canvas: HTMLCanvasElement | OffscreenCanvas;
    configure(configuration: GPUCanvasConfiguration): void;
    unconfigure(): void;
    getCurrentTexture(): GPUTexture;
}

interface GPUCanvasConfiguration {
    device: GPUDevice;
    format: GPUTextureFormat;
    usage?: GPUTextureUsageFlags;
    viewFormats?: Iterable<GPUTextureFormat>;
    colorSpace?: PredefinedColorSpace;
    alphaMode?: GPUCanvasAlphaMode;
}

type GPUCanvasAlphaMode = 'opaque' | 'premultiplied';

// Extend HTMLCanvasElement and OffscreenCanvas
interface HTMLCanvasElement {
    getContext(contextId: 'webgpu'): GPUCanvasContext | null;
}

interface OffscreenCanvas {
    getContext(contextId: 'webgpu'): GPUCanvasContext | null;
}

// This file is intentionally ambient (no exports) to declare global WebGPU types
