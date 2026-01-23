/**
 * Copyright (c) 2025 mol* contributors, licensed under MIT, See LICENSE file for more info.
 *
 * @author Alexander Rose <alexander.rose@weirdbyte.de>
 */

import { BindGroup } from './bind-group';
import { Buffer } from './buffer';
import { IndexFormat, RenderPipeline, ComputePipeline } from './pipeline';
import { TextureView } from './texture';

/**
 * Load operation for a render pass attachment.
 */
export type LoadOp = 'load' | 'clear';

/**
 * Store operation for a render pass attachment.
 */
export type StoreOp = 'store' | 'discard';

/**
 * Color attachment descriptor for a render pass.
 */
export interface ColorAttachment {
    /** The texture view to render to */
    view: TextureView;
    /** Optional resolve target for MSAA */
    resolveTarget?: TextureView;
    /** Clear value (RGBA) when loadOp is 'clear' */
    clearValue?: [number, number, number, number];
    /** Load operation */
    loadOp: LoadOp;
    /** Store operation */
    storeOp: StoreOp;
}

/**
 * Depth stencil attachment descriptor for a render pass.
 */
export interface DepthStencilAttachment {
    /** The depth/stencil texture view */
    view: TextureView;
    /** Clear value for depth (0.0 - 1.0) when depthLoadOp is 'clear' */
    depthClearValue?: number;
    /** Load operation for depth */
    depthLoadOp?: LoadOp;
    /** Store operation for depth */
    depthStoreOp?: StoreOp;
    /** If true, depth is read-only */
    depthReadOnly?: boolean;
    /** Clear value for stencil when stencilLoadOp is 'clear' */
    stencilClearValue?: number;
    /** Load operation for stencil */
    stencilLoadOp?: LoadOp;
    /** Store operation for stencil */
    stencilStoreOp?: StoreOp;
    /** If true, stencil is read-only */
    stencilReadOnly?: boolean;
}

/**
 * Render pass descriptor.
 */
export interface RenderPassDescriptor {
    /** Color attachments */
    colorAttachments: (ColorAttachment | null)[];
    /** Depth/stencil attachment */
    depthStencilAttachment?: DepthStencilAttachment;
    /** Optional label for debugging */
    label?: string;
}

/**
 * Abstract render pass encoder interface.
 */
export interface RenderPassEncoder {
    /**
     * Set the current render pipeline.
     */
    setPipeline(pipeline: RenderPipeline): void;

    /**
     * Set a bind group.
     */
    setBindGroup(index: number, bindGroup: BindGroup, dynamicOffsets?: number[]): void;

    /**
     * Set a vertex buffer.
     */
    setVertexBuffer(slot: number, buffer: Buffer, offset?: number, size?: number): void;

    /**
     * Set the index buffer.
     */
    setIndexBuffer(buffer: Buffer, format: IndexFormat, offset?: number, size?: number): void;

    /**
     * Set the viewport.
     */
    setViewport(x: number, y: number, width: number, height: number, minDepth: number, maxDepth: number): void;

    /**
     * Set the scissor rectangle.
     */
    setScissorRect(x: number, y: number, width: number, height: number): void;

    /**
     * Set the blend constant color.
     */
    setBlendConstant(color: [number, number, number, number]): void;

    /**
     * Set the stencil reference value.
     */
    setStencilReference(reference: number): void;

    /**
     * Draw primitives.
     */
    draw(vertexCount: number, instanceCount?: number, firstVertex?: number, firstInstance?: number): void;

    /**
     * Draw indexed primitives.
     */
    drawIndexed(indexCount: number, instanceCount?: number, firstIndex?: number, baseVertex?: number, firstInstance?: number): void;

    /**
     * Draw primitives with indirect parameters.
     */
    drawIndirect(indirectBuffer: Buffer, indirectOffset: number): void;

    /**
     * Draw indexed primitives with indirect parameters.
     */
    drawIndexedIndirect(indirectBuffer: Buffer, indirectOffset: number): void;

    /**
     * End the render pass.
     */
    end(): void;
}

/**
 * Abstract compute pass encoder interface.
 */
export interface ComputePassEncoder {
    /**
     * Set the current compute pipeline.
     */
    setPipeline(pipeline: ComputePipeline): void;

    /**
     * Set a bind group.
     */
    setBindGroup(index: number, bindGroup: BindGroup, dynamicOffsets?: number[]): void;

    /**
     * Dispatch workgroups.
     */
    dispatchWorkgroups(workgroupCountX: number, workgroupCountY?: number, workgroupCountZ?: number): void;

    /**
     * Dispatch workgroups with indirect parameters.
     */
    dispatchWorkgroupsIndirect(indirectBuffer: Buffer, indirectOffset: number): void;

    /**
     * End the compute pass.
     */
    end(): void;
}

/**
 * Abstract command encoder interface.
 */
export interface CommandEncoder {
    /**
     * Begin a render pass.
     */
    beginRenderPass(descriptor: RenderPassDescriptor): RenderPassEncoder;

    /**
     * Begin a compute pass.
     */
    beginComputePass(): ComputePassEncoder;

    /**
     * Copy data from one buffer to another.
     */
    copyBufferToBuffer(
        source: Buffer,
        sourceOffset: number,
        destination: Buffer,
        destinationOffset: number,
        size: number
    ): void;

    /**
     * Copy data from a buffer to a texture.
     */
    copyBufferToTexture(
        source: { buffer: Buffer; offset?: number; bytesPerRow?: number; rowsPerImage?: number },
        destination: { texture: TextureView; mipLevel?: number; origin?: [number, number, number] },
        copySize: [number, number, number]
    ): void;

    /**
     * Copy data from a texture to a buffer.
     */
    copyTextureToBuffer(
        source: { texture: TextureView; mipLevel?: number; origin?: [number, number, number] },
        destination: { buffer: Buffer; offset?: number; bytesPerRow?: number; rowsPerImage?: number },
        copySize: [number, number, number]
    ): void;

    /**
     * Copy data from one texture to another.
     */
    copyTextureToTexture(
        source: { texture: TextureView; mipLevel?: number; origin?: [number, number, number] },
        destination: { texture: TextureView; mipLevel?: number; origin?: [number, number, number] },
        copySize: [number, number, number]
    ): void;

    /**
     * Finish encoding and return a command buffer.
     */
    finish(): CommandBuffer;
}

/**
 * Abstract command buffer interface.
 * Command buffers are opaque handles that are submitted to the GPU queue.
 */
export interface CommandBuffer {
    readonly label?: string;
}
