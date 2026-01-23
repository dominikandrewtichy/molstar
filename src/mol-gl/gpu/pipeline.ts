/**
 * Copyright (c) 2025 mol* contributors, licensed under MIT, See LICENSE file for more info.
 *
 * @author Alexander Rose <alexander.rose@weirdbyte.de>
 */

import { idFactory } from '../../mol-util/id-factory';
import { BindGroupLayout, PipelineLayout } from './bind-group';
import { TextureFormat } from './texture';

const getNextPipelineId = idFactory();
const getNextShaderModuleId = idFactory();

/**
 * Vertex format types.
 */
export type VertexFormat =
    | 'uint8x2'
    | 'uint8x4'
    | 'sint8x2'
    | 'sint8x4'
    | 'unorm8x2'
    | 'unorm8x4'
    | 'snorm8x2'
    | 'snorm8x4'
    | 'uint16x2'
    | 'uint16x4'
    | 'sint16x2'
    | 'sint16x4'
    | 'unorm16x2'
    | 'unorm16x4'
    | 'snorm16x2'
    | 'snorm16x4'
    | 'float16x2'
    | 'float16x4'
    | 'float32'
    | 'float32x2'
    | 'float32x3'
    | 'float32x4'
    | 'uint32'
    | 'uint32x2'
    | 'uint32x3'
    | 'uint32x4'
    | 'sint32'
    | 'sint32x2'
    | 'sint32x3'
    | 'sint32x4';

/**
 * Vertex step mode.
 */
export type VertexStepMode = 'vertex' | 'instance';

/**
 * Vertex attribute descriptor.
 */
export interface VertexAttribute {
    /** Shader location for this attribute */
    shaderLocation: number;
    /** Format of the attribute data */
    format: VertexFormat;
    /** Offset in bytes from the start of the vertex buffer */
    offset: number;
}

/**
 * Vertex buffer layout descriptor.
 */
export interface VertexBufferLayout {
    /** Stride in bytes between consecutive vertices/instances */
    arrayStride: number;
    /** Step mode for this buffer */
    stepMode?: VertexStepMode;
    /** Attributes in this buffer */
    attributes: VertexAttribute[];
}

/**
 * Primitive topology.
 */
export type PrimitiveTopology =
    | 'point-list'
    | 'line-list'
    | 'line-strip'
    | 'triangle-list'
    | 'triangle-strip';

/**
 * Front face winding order.
 */
export type FrontFace = 'ccw' | 'cw';

/**
 * Cull mode.
 */
export type CullMode = 'none' | 'front' | 'back';

/**
 * Index format.
 */
export type IndexFormat = 'uint16' | 'uint32';

/**
 * Primitive state descriptor.
 */
export interface PrimitiveState {
    topology?: PrimitiveTopology;
    stripIndexFormat?: IndexFormat;
    frontFace?: FrontFace;
    cullMode?: CullMode;
    /** Enable primitive clipping against depth */
    unclippedDepth?: boolean;
}

/**
 * Stencil operation.
 */
export type StencilOperation =
    | 'keep'
    | 'zero'
    | 'replace'
    | 'invert'
    | 'increment-clamp'
    | 'decrement-clamp'
    | 'increment-wrap'
    | 'decrement-wrap';

/**
 * Compare function for depth/stencil operations.
 */
export type DepthCompareFunction =
    | 'never'
    | 'less'
    | 'equal'
    | 'less-equal'
    | 'greater'
    | 'not-equal'
    | 'greater-equal'
    | 'always';

/**
 * Stencil face state.
 */
export interface StencilFaceState {
    compare?: DepthCompareFunction;
    failOp?: StencilOperation;
    depthFailOp?: StencilOperation;
    passOp?: StencilOperation;
}

/**
 * Depth stencil state descriptor.
 */
export interface DepthStencilState {
    format: TextureFormat;
    depthWriteEnabled?: boolean;
    depthCompare?: DepthCompareFunction;
    stencilFront?: StencilFaceState;
    stencilBack?: StencilFaceState;
    stencilReadMask?: number;
    stencilWriteMask?: number;
    depthBias?: number;
    depthBiasSlopeScale?: number;
    depthBiasClamp?: number;
}

/**
 * Multisample state descriptor.
 */
export interface MultisampleState {
    count?: number;
    mask?: number;
    alphaToCoverageEnabled?: boolean;
}

/**
 * Blend operation.
 */
export type BlendOperation = 'add' | 'subtract' | 'reverse-subtract' | 'min' | 'max';

/**
 * Blend factor.
 */
export type BlendFactor =
    | 'zero'
    | 'one'
    | 'src'
    | 'one-minus-src'
    | 'src-alpha'
    | 'one-minus-src-alpha'
    | 'dst'
    | 'one-minus-dst'
    | 'dst-alpha'
    | 'one-minus-dst-alpha'
    | 'src-alpha-saturated'
    | 'constant'
    | 'one-minus-constant';

/**
 * Blend component state.
 */
export interface BlendComponent {
    operation?: BlendOperation;
    srcFactor?: BlendFactor;
    dstFactor?: BlendFactor;
}

/**
 * Blend state.
 */
export interface BlendState {
    color?: BlendComponent;
    alpha?: BlendComponent;
}

/**
 * Color write flags.
 */
export type ColorWriteFlags = number;
export const ColorWrite = {
    RED: 0x1,
    GREEN: 0x2,
    BLUE: 0x4,
    ALPHA: 0x8,
    ALL: 0xF,
} as const;

/**
 * Color target state descriptor.
 */
export interface ColorTargetState {
    format: TextureFormat;
    blend?: BlendState;
    writeMask?: ColorWriteFlags;
}

/**
 * Shader module descriptor.
 */
export interface ShaderModuleDescriptor {
    /** Shader source code (WGSL for WebGPU, GLSL for WebGL) */
    code: string;
    /** Optional label for debugging */
    label?: string;
}

/**
 * Abstract shader module interface.
 */
export interface ShaderModule {
    readonly id: number;

    /**
     * Destroy the shader module.
     */
    destroy(): void;
}

/**
 * Vertex state descriptor.
 */
export interface VertexState {
    module: ShaderModule;
    entryPoint: string;
    buffers?: VertexBufferLayout[];
    constants?: Record<string, number>;
}

/**
 * Fragment state descriptor.
 */
export interface FragmentState {
    module: ShaderModule;
    entryPoint: string;
    targets: ColorTargetState[];
    constants?: Record<string, number>;
}

/**
 * Render pipeline descriptor.
 */
export interface RenderPipelineDescriptor {
    /** Pipeline layout (use 'auto' for automatic layout inference) */
    layout: PipelineLayout | 'auto';
    /** Vertex shader state */
    vertex: VertexState;
    /** Fragment shader state (optional for depth-only rendering) */
    fragment?: FragmentState;
    /** Primitive assembly state */
    primitive?: PrimitiveState;
    /** Depth/stencil state */
    depthStencil?: DepthStencilState;
    /** Multisample state */
    multisample?: MultisampleState;
    /** Optional label for debugging */
    label?: string;
}

/**
 * Abstract render pipeline interface.
 */
export interface RenderPipeline {
    readonly id: number;

    /**
     * Get the bind group layout for a given index.
     * Only valid if the pipeline was created with layout: 'auto'.
     */
    getBindGroupLayout(index: number): BindGroupLayout;

    /**
     * Destroy the render pipeline.
     */
    destroy(): void;
}

/**
 * Compute state descriptor.
 */
export interface ComputeState {
    module: ShaderModule;
    entryPoint: string;
    constants?: Record<string, number>;
}

/**
 * Compute pipeline descriptor.
 */
export interface ComputePipelineDescriptor {
    /** Pipeline layout (use 'auto' for automatic layout inference) */
    layout: PipelineLayout | 'auto';
    /** Compute shader state */
    compute: ComputeState;
    /** Optional label for debugging */
    label?: string;
}

/**
 * Abstract compute pipeline interface.
 */
export interface ComputePipeline {
    readonly id: number;

    /**
     * Get the bind group layout for a given index.
     * Only valid if the pipeline was created with layout: 'auto'.
     */
    getBindGroupLayout(index: number): BindGroupLayout;

    /**
     * Destroy the compute pipeline.
     */
    destroy(): void;
}

/**
 * Create a new pipeline ID.
 */
export function createPipelineId(): number {
    return getNextPipelineId();
}

/**
 * Create a new shader module ID.
 */
export function createShaderModuleId(): number {
    return getNextShaderModuleId();
}

/**
 * Get bytes per vertex for a vertex format.
 */
export function getVertexFormatSize(format: VertexFormat): number {
    switch (format) {
        case 'uint8x2':
        case 'sint8x2':
        case 'unorm8x2':
        case 'snorm8x2':
            return 2;
        case 'uint8x4':
        case 'sint8x4':
        case 'unorm8x4':
        case 'snorm8x4':
        case 'uint16x2':
        case 'sint16x2':
        case 'unorm16x2':
        case 'snorm16x2':
        case 'float16x2':
        case 'float32':
        case 'uint32':
        case 'sint32':
            return 4;
        case 'uint16x4':
        case 'sint16x4':
        case 'unorm16x4':
        case 'snorm16x4':
        case 'float16x4':
        case 'float32x2':
        case 'uint32x2':
        case 'sint32x2':
            return 8;
        case 'float32x3':
        case 'uint32x3':
        case 'sint32x3':
            return 12;
        case 'float32x4':
        case 'uint32x4':
        case 'sint32x4':
            return 16;
    }
}
