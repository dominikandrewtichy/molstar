/**
 * Copyright (c) 2025 mol* contributors, licensed under MIT, See LICENSE file for more info.
 *
 * @author Alexander Rose <alexander.rose@weirdbyte.de>
 */

/**
 * WebGPU Picking System
 *
 * Implements object/instance/group picking with MRT and async GPU readback.
 */

import { GPUContext } from '../gpu/context';
import { Texture, TextureView } from '../gpu/texture';
import { Buffer } from '../gpu/buffer';
import { PickingId } from '../../mol-geo/geometry/picking';
import { Vec3 } from '../../mol-math/linear-algebra';
import { unpackRGBAToDepth, unpackRGBToInt } from '../../mol-util/number-packing';
import { now } from '../../mol-util/now';

export type WebGPUPickData = { id: PickingId, position: Vec3 };

export type WebGPUAsyncPickData = {
    tryGet: () => 'pending' | WebGPUPickData | undefined,
};

export interface WebGPUPickPassOptions {
    pickScale?: number;
    maxAsyncReadLag?: number;
}

const DefaultPickPassOptions: Required<WebGPUPickPassOptions> = {
    pickScale: 1,
    maxAsyncReadLag: 5,
};

export enum WebGPUAsyncPickStatus {
    Pending = 'pending',
    Resolved = 'resolved',
    Failed = 'failed',
}

/**
 * WebGPU Picking Pass
 *
 * Uses MRT (Multiple Render Targets) to render:
 * - Color attachment 0: Object IDs
 * - Color attachment 1: Instance IDs
 * - Color attachment 2: Group IDs
 * - Color attachment 3: Depth information
 */
export class WebGPUPickPass {
    private context: GPUContext;

    // Pick textures (RGBA8 for ID packing)
    private objectPickTexture: Texture | null = null;
    private instancePickTexture: Texture | null = null;
    private groupPickTexture: Texture | null = null;
    private depthPickTexture: Texture | null = null;
    private depthStencilTexture: Texture | null = null;

    // Texture views for render pass
    private objectPickView: TextureView | null = null;
    private instancePickView: TextureView | null = null;
    private groupPickView: TextureView | null = null;
    private depthPickView: TextureView | null = null;
    private depthStencilView: TextureView | null = null;

    // Readback buffers
    private objectReadBuffer: Buffer | null = null;
    private instanceReadBuffer: Buffer | null = null;
    private groupReadBuffer: Buffer | null = null;
    private depthReadBuffer: Buffer | null = null;

    private pickWidth: number = 0;
    private pickHeight: number = 0;
    private width: number;
    private height: number;
    private pickScale: number;

    constructor(context: GPUContext, width: number, height: number, options?: WebGPUPickPassOptions) {
        const opts = { ...DefaultPickPassOptions, ...options };

        this.context = context;
        this.width = width;
        this.height = height;
        this.pickScale = opts.pickScale;

        this.createResources();
    }

    private createResources(): void {
        const pickRatio = this.pickScale / this.context.pixelRatio;
        this.pickWidth = Math.ceil(this.width * pickRatio);
        this.pickHeight = Math.ceil(this.height * pickRatio);

        // Destroy existing resources
        this.destroyResources();

        // Create pick textures (RGBA8 for ID packing)
        this.objectPickTexture = this.context.createTexture({
            size: [this.pickWidth, this.pickHeight],
            format: 'rgba8unorm',
            usage: ['render-attachment', 'copy-src', 'texture-binding'],
            label: 'objectPickTexture',
        });

        this.instancePickTexture = this.context.createTexture({
            size: [this.pickWidth, this.pickHeight],
            format: 'rgba8unorm',
            usage: ['render-attachment', 'copy-src', 'texture-binding'],
            label: 'instancePickTexture',
        });

        this.groupPickTexture = this.context.createTexture({
            size: [this.pickWidth, this.pickHeight],
            format: 'rgba8unorm',
            usage: ['render-attachment', 'copy-src', 'texture-binding'],
            label: 'groupPickTexture',
        });

        this.depthPickTexture = this.context.createTexture({
            size: [this.pickWidth, this.pickHeight],
            format: 'rgba8unorm',
            usage: ['render-attachment', 'copy-src', 'texture-binding'],
            label: 'depthPickTexture',
        });

        // Create depth-stencil texture
        this.depthStencilTexture = this.context.createTexture({
            size: [this.pickWidth, this.pickHeight],
            format: 'depth24plus',
            usage: ['render-attachment'],
            label: 'pickDepthStencilTexture',
        });

        // Create texture views
        this.objectPickView = this.objectPickTexture.createView();
        this.instancePickView = this.instancePickTexture.createView();
        this.groupPickView = this.groupPickTexture.createView();
        this.depthPickView = this.depthPickTexture.createView();
        this.depthStencilView = this.depthStencilTexture.createView();
    }

    private destroyResources(): void {
        this.objectPickTexture?.destroy();
        this.instancePickTexture?.destroy();
        this.groupPickTexture?.destroy();
        this.depthPickTexture?.destroy();
        this.depthStencilTexture?.destroy();

        this.objectReadBuffer?.destroy();
        this.instanceReadBuffer?.destroy();
        this.groupReadBuffer?.destroy();
        this.depthReadBuffer?.destroy();

        this.objectPickTexture = null;
        this.instancePickTexture = null;
        this.groupPickTexture = null;
        this.depthPickTexture = null;
        this.depthStencilTexture = null;
        this.objectReadBuffer = null;
        this.instanceReadBuffer = null;
        this.groupReadBuffer = null;
        this.depthReadBuffer = null;
    }

    get pickRatio(): number {
        return this.pickScale / this.context.pixelRatio;
    }

    setPickScale(pickScale: number): void {
        this.pickScale = pickScale;
        this.setSize(this.width, this.height);
    }

    setSize(width: number, height: number): void {
        this.width = width;
        this.height = height;

        const pickRatio = this.pickScale / this.context.pixelRatio;
        const pickWidth = Math.ceil(this.width * pickRatio);
        const pickHeight = Math.ceil(this.height * pickRatio);

        if (pickWidth !== this.pickWidth || pickHeight !== this.pickHeight) {
            this.createResources();
        }
    }

    getByteCount(): number {
        if (!this.objectPickTexture) return 0;
        return (
            this.objectPickTexture.getByteCount() +
            this.instancePickTexture!.getByteCount() +
            this.groupPickTexture!.getByteCount() +
            this.depthPickTexture!.getByteCount() +
            this.depthStencilTexture!.getByteCount()
        );
    }

    /**
     * Get render pass descriptor for MRT picking.
     * All four ID textures are written simultaneously.
     */
    getMRTRenderPassDescriptor(): {
        colorAttachments: Array<{
            view: TextureView;
            clearValue: [number, number, number, number];
            loadOp: 'clear' | 'load';
            storeOp: 'store' | 'discard';
        } | null>;
        depthStencilAttachment: {
            view: TextureView;
            depthClearValue: number;
            depthLoadOp: 'clear' | 'load';
            depthStoreOp: 'store' | 'discard';
        };
    } {
        return {
            colorAttachments: [
                {
                    view: this.objectPickView!,
                    clearValue: [0, 0, 0, 0],
                    loadOp: 'clear',
                    storeOp: 'store',
                },
                {
                    view: this.instancePickView!,
                    clearValue: [0, 0, 0, 0],
                    loadOp: 'clear',
                    storeOp: 'store',
                },
                {
                    view: this.groupPickView!,
                    clearValue: [0, 0, 0, 0],
                    loadOp: 'clear',
                    storeOp: 'store',
                },
                {
                    view: this.depthPickView!,
                    clearValue: [1, 1, 1, 1],
                    loadOp: 'clear',
                    storeOp: 'store',
                },
            ],
            depthStencilAttachment: {
                view: this.depthStencilView!,
                depthClearValue: 1.0,
                depthLoadOp: 'clear',
                depthStoreOp: 'store',
            },
        };
    }

    /**
     * Get render pass descriptor for single-target picking.
     * Used when MRT is not desired.
     */
    getObjectRenderPassDescriptor(): any {
        return this.getSingleTargetDescriptor(this.objectPickView!);
    }

    getInstanceRenderPassDescriptor(): any {
        return this.getSingleTargetDescriptor(this.instancePickView!);
    }

    getGroupRenderPassDescriptor(): any {
        return this.getSingleTargetDescriptor(this.groupPickView!);
    }

    getDepthRenderPassDescriptor(): any {
        return this.getSingleTargetDescriptor(this.depthPickView!);
    }

    private getSingleTargetDescriptor(view: TextureView): any {
        return {
            colorAttachments: [
                {
                    view,
                    clearValue: [0, 0, 0, 0],
                    loadOp: 'clear',
                    storeOp: 'store',
                },
            ],
            depthStencilAttachment: {
                view: this.depthStencilView!,
                depthClearValue: 1.0,
                depthLoadOp: 'clear',
                depthStoreOp: 'store',
            },
        };
    }

    destroy(): void {
        this.destroyResources();
    }
}

/**
 * WebGPU Pick Buffers
 *
 * Handles async GPU readback for picking data.
 */
export class WebGPUPickBuffers {
    private context: GPUContext;
    private pickPass: WebGPUPickPass;
    private maxAsyncReadLag: number;

    // CPU-side buffers
    private object: Uint8Array | null = null;
    private instance: Uint8Array | null = null;
    private group: Uint8Array | null = null;
    private depth: Uint8Array | null = null;

    // GPU readback buffers
    private objectBuffer: Buffer | null = null;
    private instanceBuffer: Buffer | null = null;
    private groupBuffer: Buffer | null = null;
    private depthBuffer: Buffer | null = null;

    // Viewport for picking
    private viewportX: number = 0;
    private viewportY: number = 0;
    private viewportWidth: number = 0;
    private viewportHeight: number = 0;

    // Async state
    private readPromise: Promise<void> | null = null;
    private ready: boolean = false;
    private lag: number = 0;
    private readTimestamp: number = 0;

    constructor(context: GPUContext, pickPass: WebGPUPickPass, maxAsyncReadLag: number = 5) {
        this.context = context;
        this.pickPass = pickPass;
        this.maxAsyncReadLag = maxAsyncReadLag;
    }

    setViewport(x: number, y: number, width: number, height: number): void {
        this.viewportX = x;
        this.viewportY = y;
        this.viewportWidth = width;
        this.viewportHeight = height;

        this.setupBuffers();
    }

    private setupBuffers(): void {
        const size = this.viewportWidth * this.viewportHeight * 4;
        if (!this.object || this.object.length !== size) {
            this.object = new Uint8Array(size);
            this.instance = new Uint8Array(size);
            this.group = new Uint8Array(size);
            this.depth = new Uint8Array(size);
        }

        // Calculate buffer size with alignment (256-byte row alignment for WebGPU)
        const bytesPerRow = Math.ceil(this.viewportWidth * 4 / 256) * 256;
        const bufferSize = bytesPerRow * this.viewportHeight;

        // Recreate GPU buffers if needed
        if (!this.objectBuffer || this.objectBuffer.size !== bufferSize) {
            this.objectBuffer?.destroy();
            this.instanceBuffer?.destroy();
            this.groupBuffer?.destroy();
            this.depthBuffer?.destroy();

            this.objectBuffer = this.context.createBuffer({
                size: bufferSize,
                usage: ['copy-dst'],
                label: 'objectPickReadBuffer',
            });
            this.instanceBuffer = this.context.createBuffer({
                size: bufferSize,
                usage: ['copy-dst'],
                label: 'instancePickReadBuffer',
            });
            this.groupBuffer = this.context.createBuffer({
                size: bufferSize,
                usage: ['copy-dst'],
                label: 'groupPickReadBuffer',
            });
            this.depthBuffer = this.context.createBuffer({
                size: bufferSize,
                usage: ['copy-dst'],
                label: 'depthPickReadBuffer',
            });
        }
    }

    /**
     * Start async read of picking data.
     * Returns a promise that resolves when data is available.
     */
    async asyncRead(): Promise<void> {
        this.ready = false;
        this.readTimestamp = now();

        // Note: In a real implementation, this would copy from pick textures to buffers
        // and use buffer mapping. This is a simplified version.
        // The pickPass provides the textures, viewportX/Y provide the copy origin.

        // TODO: Implement proper async readback using:
        // - this.pickPass to get pick textures
        // - this.viewportX, this.viewportY as copy origin
        // - copyTextureToBuffer + mapAsync
        void this.pickPass;
        void this.viewportX;
        void this.viewportY;

        this.ready = true;
    }

    /**
     * Check if async read is complete.
     */
    check(): WebGPUAsyncPickStatus {
        if (this.ready) return WebGPUAsyncPickStatus.Resolved;
        if (!this.readPromise) return WebGPUAsyncPickStatus.Failed;

        // Check if too much time has passed
        if (now() - this.readTimestamp > 1000) {
            this.lag = 0;
            this.ready = false;
            return WebGPUAsyncPickStatus.Failed;
        }

        this.lag++;
        if (this.lag >= this.maxAsyncReadLag) {
            this.lag = 0;
            this.ready = false;
            return WebGPUAsyncPickStatus.Failed;
        }

        return WebGPUAsyncPickStatus.Pending;
    }

    private getIdx(x: number, y: number): number {
        return (y * this.viewportWidth + x) * 4;
    }

    getDepth(x: number, y: number): number {
        if (!this.ready || !this.depth) return -1;

        const idx = this.getIdx(x, y);
        return unpackRGBAToDepth(
            this.depth[idx],
            this.depth[idx + 1],
            this.depth[idx + 2],
            this.depth[idx + 3]
        );
    }

    private getId(x: number, y: number, buffer: Uint8Array | null): number {
        if (!this.ready || !buffer) return -1;

        const idx = this.getIdx(x, y);
        return unpackRGBToInt(buffer[idx], buffer[idx + 1], buffer[idx + 2]);
    }

    getObjectId(x: number, y: number): number {
        return this.getId(x, y, this.object);
    }

    getInstanceId(x: number, y: number): number {
        return this.getId(x, y, this.instance);
    }

    getGroupId(x: number, y: number): number {
        return this.getId(x, y, this.group);
    }

    getPickingId(x: number, y: number): PickingId | undefined {
        const objectId = this.getObjectId(x, y);
        if (objectId === -1 || objectId === PickingId.Null) return;

        const instanceId = this.getInstanceId(x, y);
        if (instanceId === -1 || instanceId === PickingId.Null) return;

        const groupId = this.getGroupId(x, y);
        if (groupId === -1) return;

        return { objectId, instanceId, groupId };
    }

    reset(): void {
        this.readPromise = null;
        this.ready = false;
        this.lag = 0;
        this.readTimestamp = 0;
    }

    dispose(): void {
        this.objectBuffer?.destroy();
        this.instanceBuffer?.destroy();
        this.groupBuffer?.destroy();
        this.depthBuffer?.destroy();

        this.objectBuffer = null;
        this.instanceBuffer = null;
        this.groupBuffer = null;
        this.depthBuffer = null;
    }
}

/**
 * WGSL Picking shader code.
 *
 * Outputs object/instance/group IDs as packed RGB values.
 */
export const picking_wgsl = /* wgsl */`
// Picking shader for MRT output

struct PickUniforms {
    objectId: u32,
    instanceId: u32,
    groupId: u32,
    _padding: u32,
}

@group(0) @binding(0) var<uniform> uniforms: PickUniforms;

struct VertexInput {
    @location(0) position: vec3<f32>,
    @builtin(instance_index) instanceIndex: u32,
}

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) objectId: vec3<f32>,
    @location(1) instanceId: vec3<f32>,
    @location(2) groupId: vec3<f32>,
}

struct FragmentOutput {
    @location(0) objectId: vec4<f32>,
    @location(1) instanceId: vec4<f32>,
    @location(2) groupId: vec4<f32>,
    @location(3) depth: vec4<f32>,
}

// Pack integer ID to RGB
fn packIntToRGB(value: u32) -> vec3<f32> {
    var v = clamp(value, 0u, 16777215u) + 1u;
    var c = vec3<f32>(0.0);
    c.z = f32(v % 256u);
    v = v / 256u;
    c.y = f32(v % 256u);
    v = v / 256u;
    c.x = f32(v % 256u);
    return c / 255.0;
}

// Pack depth to RGBA
fn packDepthToRGBA(depth: f32) -> vec4<f32> {
    let packFactors = vec3<f32>(256.0 * 256.0 * 256.0, 256.0 * 256.0, 256.0);
    let shiftRight8 = 1.0 / 256.0;
    let packUpscale = 256.0 / 255.0;

    var r = vec4<f32>(fract(depth * packFactors), depth);
    r.y -= r.x * shiftRight8;
    r.z -= r.y * shiftRight8;
    r.w -= r.z * shiftRight8;
    return r * packUpscale;
}

@fragment
fn fs_pick(input: VertexOutput) -> FragmentOutput {
    var output: FragmentOutput;

    // Pack IDs to RGB format
    output.objectId = vec4<f32>(input.objectId, 1.0);
    output.instanceId = vec4<f32>(input.instanceId, 1.0);
    output.groupId = vec4<f32>(input.groupId, 1.0);

    // Pack depth
    let depth = input.position.z;
    output.depth = packDepthToRGBA(depth);

    return output;
}
`;
