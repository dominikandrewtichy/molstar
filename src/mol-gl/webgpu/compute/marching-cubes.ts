/**
 * Copyright (c) 2025-2026 mol* contributors, licensed under MIT, See LICENSE file for more info.
 *
 * @author Alexander Rose <alexander.rose@weirdbyte.de>
 */

import { GPUContext } from '../../gpu/context';
import { Texture } from '../../gpu/texture';
import { Buffer } from '../../gpu/buffer';
import { ComputePipeline, ShaderModule } from '../../gpu/pipeline';
import { Vec2, Vec3, Mat4, Mat3 } from '../../../mol-math/linear-algebra';
import { HistogramPyramidResult } from './histogram-pyramid';
import { activeVoxels2d_wgsl } from '../../shader/wgsl/compute/active-voxels.wgsl';
import { isosurface_wgsl } from '../../shader/wgsl/compute/isosurface.wgsl';

/**
 * Axis order for group ID calculation.
 */
export type AxisOrder = '012' | '021' | '102' | '120' | '201' | '210';

function axisOrderToIndex(order: AxisOrder): number {
    switch (order) {
        case '012': return 0;
        case '021': return 1;
        case '102': return 2;
        case '120': return 3;
        case '201': return 4;
        case '210': return 5;
    }
}

/**
 * Options for isosurface extraction.
 */
export interface IsosurfaceOptions {
    /** The isovalue for surface extraction */
    isoValue: number;
    /** Whether to invert the surface (negative isovalue) */
    invert: boolean;
    /** Whether group IDs are packed in the volume texture */
    packedGroup: boolean;
    /** Axis order for group ID calculation */
    axisOrder: Vec3;
    /** Whether to use constant group ID per triangle */
    constantGroup: boolean;
}

/**
 * Result of isosurface extraction.
 */
export interface IsosurfaceResult {
    /** Buffer containing vertex positions (vec4<f32>) */
    vertexBuffer: Buffer;
    /** Buffer containing group IDs (vec4<f32>) */
    groupBuffer: Buffer;
    /** Buffer containing normals (vec4<f32>) */
    normalBuffer: Buffer;
    /** Number of vertices generated */
    vertexCount: number;
}

/**
 * Result of active voxels calculation.
 */
export interface ActiveVoxelsResult {
    /** Texture containing active voxel information */
    texture: Texture;
    /** Width of the texture */
    width: number;
    /** Height of the texture */
    height: number;
}

/**
 * WebGPU compute-based marching cubes implementation.
 *
 * Replaces the WebGL fragment shader-based approach with native compute shaders.
 */
export class WebGPUMarchingCubes {
    private ctx: GPUContext;

    // Pipelines
    private activeVoxelsPipeline: ComputePipeline | null = null;
    private isosurfacePipeline: ComputePipeline | null = null;

    // Shader modules
    private activeVoxelsShaderModule: ShaderModule | null = null;
    private isosurfaceShaderModule: ShaderModule | null = null;

    // Lookup tables
    private triCountTexture: Texture | null = null;
    private triIndicesTexture: Texture | null = null;

    // Uniform buffers
    private activeVoxelsUniformBuffer: Buffer | null = null;
    private isosurfaceUniformBuffer: Buffer | null = null;

    // Cached active voxels texture
    private activeVoxelsTexture: Texture | null = null;

    constructor(ctx: GPUContext) {
        this.ctx = ctx;
    }

    /**
     * Calculate active voxels in the volume.
     */
    async calcActiveVoxels(
        volumeData: Texture,
        gridDim: Vec3,
        gridTexDim: Vec3,
        isoValue: number,
        gridScale: Vec2
    ): Promise<ActiveVoxelsResult> {
        const width = volumeData.width;
        const height = volumeData.height;

        this.ensureActiveVoxelsPipeline();
        this.ensureActiveVoxelsTexture(width, height);
        this.ensureTriCountTexture();

        // Update uniforms
        const uniformData = new ArrayBuffer(48);
        const floatView = new Float32Array(uniformData);
        const uintView = new Uint32Array(uniformData);

        floatView[0] = isoValue;
        floatView[1] = gridDim[0];
        floatView[2] = gridDim[1];
        floatView[3] = gridDim[2];
        floatView[4] = gridTexDim[0];
        floatView[5] = gridTexDim[1];
        floatView[6] = gridTexDim[2];
        floatView[7] = 0; // padding
        floatView[8] = gridScale[0];
        floatView[9] = gridScale[1];
        uintView[10] = width;
        uintView[11] = height;

        this.activeVoxelsUniformBuffer!.write(new Uint8Array(uniformData));

        // Create sampler
        const sampler = this.ctx.createSampler({
            magFilter: 'nearest',
            minFilter: 'nearest',
        });

        // Create bind group
        const bindGroup = this.ctx.createBindGroup({
            layout: this.activeVoxelsPipeline!.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: this.activeVoxelsUniformBuffer! } },
                { binding: 1, resource: volumeData.createView() },
                { binding: 2, resource: sampler },
                { binding: 3, resource: this.triCountTexture!.createView() },
                { binding: 4, resource: this.activeVoxelsTexture!.createView() },
            ],
        });

        // Run compute pass
        const encoder = this.ctx.createCommandEncoder();
        const computePass = encoder.beginComputePass();
        computePass.setPipeline(this.activeVoxelsPipeline!);
        computePass.setBindGroup(0, bindGroup);
        computePass.dispatchWorkgroups(
            Math.ceil(width / 16),
            Math.ceil(height / 16)
        );
        computePass.end();

        this.ctx.submit([encoder.finish()]);

        return {
            texture: this.activeVoxelsTexture!,
            width,
            height,
        };
    }

    /**
     * Extract isosurface from the volume using the histogram pyramid.
     */
    async extractIsosurface(
        volumeData: Texture,
        activeVoxelsBase: Texture,
        histogramPyramid: HistogramPyramidResult,
        gridDim: Vec3,
        gridTexDim: Vec3,
        gridDataDim: Vec3,
        transform: Mat4,
        options: IsosurfaceOptions
    ): Promise<IsosurfaceResult> {
        const { pyramidTexture, count, levels, scale } = histogramPyramid;

        this.ensureIsosurfacePipeline();
        this.ensureTriIndicesTexture();

        // Create output buffers
        const vertexBuffer = this.ctx.createBuffer({
            size: count * 16, // vec4<f32> per vertex
            usage: ['storage', 'vertex', 'copy-src'],
        });

        const groupBuffer = this.ctx.createBuffer({
            size: count * 16,
            usage: ['storage', 'vertex', 'copy-src'],
        });

        const normalBuffer = this.ctx.createBuffer({
            size: count * 16,
            usage: ['storage', 'vertex', 'copy-src'],
        });

        // Calculate adjoint of transform matrix
        const transformAdjoint = Mat3.adjointFromMat4(Mat3(), transform);

        // Prepare uniform data
        // struct IsosurfaceUniforms { ... }
        const uniformSize = 256; // Ensure proper alignment
        const uniformData = new ArrayBuffer(uniformSize);
        const floatView = new Float32Array(uniformData);
        const uintView = new Uint32Array(uniformData);

        let offset = 0;

        // isoValue, levels, size, count
        floatView[offset++] = options.isoValue;
        floatView[offset++] = levels;
        floatView[offset++] = Math.pow(2, levels);
        floatView[offset++] = count;

        // gridDim (vec3) + invert (u32)
        floatView[offset++] = gridDim[0];
        floatView[offset++] = gridDim[1];
        floatView[offset++] = gridDim[2];
        uintView[offset++] = options.invert ? 1 : 0;

        // gridTexDim (vec3) + packedGroup (u32)
        floatView[offset++] = gridTexDim[0];
        floatView[offset++] = gridTexDim[1];
        floatView[offset++] = gridTexDim[2];
        uintView[offset++] = options.packedGroup ? 1 : 0;

        // gridDataDim (vec3) + constantGroup (u32)
        floatView[offset++] = gridDataDim[0];
        floatView[offset++] = gridDataDim[1];
        floatView[offset++] = gridDataDim[2];
        uintView[offset++] = options.constantGroup ? 1 : 0;

        // gridTransform (mat4x4)
        for (let i = 0; i < 16; i++) {
            floatView[offset++] = transform[i];
        }

        // gridTransformAdjoint (mat3x3) - needs padding for alignment
        for (let col = 0; col < 3; col++) {
            for (let row = 0; row < 3; row++) {
                floatView[offset++] = transformAdjoint[col * 3 + row];
            }
            offset++; // Padding for vec4 alignment
        }

        // scale (vec2) + axisOrder (u32) + padding
        floatView[offset++] = scale[0];
        floatView[offset++] = scale[1];
        const axisOrderStr = options.axisOrder.join('') as AxisOrder;
        uintView[offset++] = axisOrderToIndex(axisOrderStr);
        offset++; // padding

        this.isosurfaceUniformBuffer!.write(new Uint8Array(uniformData));

        // Create sampler
        const sampler = this.ctx.createSampler({
            magFilter: 'nearest',
            minFilter: 'nearest',
        });

        // Create bind groups
        const bindGroup0 = this.ctx.createBindGroup({
            layout: this.isosurfacePipeline!.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: this.isosurfaceUniformBuffer! } },
                { binding: 1, resource: pyramidTexture.createView() },
                { binding: 2, resource: activeVoxelsBase.createView() },
                { binding: 3, resource: volumeData.createView() },
                { binding: 4, resource: this.triIndicesTexture!.createView() },
                { binding: 5, resource: sampler },
            ],
        });

        const bindGroup1 = this.ctx.createBindGroup({
            layout: this.isosurfacePipeline!.getBindGroupLayout(1),
            entries: [
                { binding: 0, resource: { buffer: vertexBuffer } },
                { binding: 1, resource: { buffer: groupBuffer } },
                { binding: 2, resource: { buffer: normalBuffer } },
            ],
        });

        // Run compute pass
        const encoder = this.ctx.createCommandEncoder();
        const computePass = encoder.beginComputePass();
        computePass.setPipeline(this.isosurfacePipeline!);
        computePass.setBindGroup(0, bindGroup0);
        computePass.setBindGroup(1, bindGroup1);
        computePass.dispatchWorkgroups(Math.ceil(count / 64));
        computePass.end();

        this.ctx.submit([encoder.finish()]);

        return {
            vertexBuffer,
            groupBuffer,
            normalBuffer,
            vertexCount: count,
        };
    }

    private ensureActiveVoxelsPipeline(): void {
        if (!this.activeVoxelsPipeline) {
            this.activeVoxelsShaderModule = this.ctx.createShaderModule({
                code: activeVoxels2d_wgsl,
                label: 'active-voxels',
            });

            this.activeVoxelsPipeline = this.ctx.createComputePipeline({
                layout: 'auto',
                compute: {
                    module: this.activeVoxelsShaderModule,
                    entryPoint: 'main',
                },
                label: 'active-voxels-pipeline',
            });

            this.activeVoxelsUniformBuffer = this.ctx.createBuffer({
                size: 48,
                usage: ['uniform', 'copy-dst'],
            });
        }
    }

    private ensureIsosurfacePipeline(): void {
        if (!this.isosurfacePipeline) {
            this.isosurfaceShaderModule = this.ctx.createShaderModule({
                code: isosurface_wgsl,
                label: 'isosurface',
            });

            this.isosurfacePipeline = this.ctx.createComputePipeline({
                layout: 'auto',
                compute: {
                    module: this.isosurfaceShaderModule,
                    entryPoint: 'main',
                },
                label: 'isosurface-pipeline',
            });

            this.isosurfaceUniformBuffer = this.ctx.createBuffer({
                size: 256,
                usage: ['uniform', 'copy-dst'],
            });
        }
    }

    private ensureActiveVoxelsTexture(width: number, height: number): void {
        if (!this.activeVoxelsTexture ||
            this.activeVoxelsTexture.width !== width ||
            this.activeVoxelsTexture.height !== height) {

            if (this.activeVoxelsTexture) {
                this.activeVoxelsTexture.destroy();
            }

            this.activeVoxelsTexture = this.ctx.createTexture({
                size: [width, height],
                format: 'rgba8unorm',
                usage: ['texture-binding', 'storage-binding'],
            });
        }
    }

    private ensureTriCountTexture(): void {
        if (!this.triCountTexture) {
            // Triangle count lookup table (16x16 = 256 entries)
            // This contains the number of triangles for each MC case
            const triCountData = getTriCountData();

            this.triCountTexture = this.ctx.createTexture({
                size: [16, 16],
                format: 'r8uint',
                usage: ['texture-binding', 'copy-dst'],
            });

            this.triCountTexture.write(triCountData);
        }
    }

    private ensureTriIndicesTexture(): void {
        if (!this.triIndicesTexture) {
            // Triangle indices lookup table (64x64 = 4096 entries)
            // This contains the edge indices for each MC case
            const triIndicesData = getTriIndicesData();

            this.triIndicesTexture = this.ctx.createTexture({
                size: [64, 64],
                format: 'rgba8unorm',
                usage: ['texture-binding', 'copy-dst'],
            });

            this.triIndicesTexture.write(triIndicesData);
        }
    }

    /**
     * Destroy all resources.
     */
    destroy(): void {
        this.activeVoxelsPipeline?.destroy();
        this.isosurfacePipeline?.destroy();
        this.activeVoxelsShaderModule?.destroy();
        this.isosurfaceShaderModule?.destroy();
        this.triCountTexture?.destroy();
        this.triIndicesTexture?.destroy();
        this.activeVoxelsUniformBuffer?.destroy();
        this.isosurfaceUniformBuffer?.destroy();
        this.activeVoxelsTexture?.destroy();
    }
}

/**
 * Get the triangle count lookup table data.
 * Each entry contains the number of triangles for the corresponding MC case.
 */
function getTriCountData(): Uint8Array {
    // Standard marching cubes triangle counts for each of the 256 cases
    const triCount = new Uint8Array([
        0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 2,
        1, 2, 2, 3, 2, 3, 3, 4, 2, 3, 3, 4, 3, 4, 4, 3,
        1, 2, 2, 3, 2, 3, 3, 4, 2, 3, 3, 4, 3, 4, 4, 3,
        2, 3, 3, 2, 3, 4, 4, 3, 3, 4, 4, 3, 4, 5, 5, 2,
        1, 2, 2, 3, 2, 3, 3, 4, 2, 3, 3, 4, 3, 4, 4, 3,
        2, 3, 3, 4, 3, 4, 4, 5, 3, 4, 4, 5, 4, 5, 5, 4,
        2, 3, 3, 4, 3, 4, 2, 3, 3, 4, 4, 5, 4, 5, 3, 2,
        3, 4, 4, 3, 4, 5, 3, 2, 4, 5, 5, 4, 5, 2, 4, 1,
        1, 2, 2, 3, 2, 3, 3, 4, 2, 3, 3, 4, 3, 4, 4, 3,
        2, 3, 3, 4, 3, 4, 4, 5, 3, 2, 4, 3, 4, 3, 5, 2,
        2, 3, 3, 4, 3, 4, 4, 5, 3, 4, 4, 5, 4, 5, 5, 4,
        3, 4, 4, 3, 4, 5, 5, 4, 4, 3, 5, 2, 5, 4, 2, 1,
        2, 3, 3, 4, 3, 4, 4, 5, 3, 4, 4, 5, 2, 3, 3, 2,
        3, 4, 4, 5, 4, 5, 5, 2, 4, 3, 5, 4, 3, 2, 4, 1,
        3, 4, 4, 5, 4, 5, 3, 4, 4, 5, 5, 2, 3, 4, 2, 1,
        2, 3, 3, 2, 3, 4, 2, 1, 3, 2, 4, 1, 2, 1, 1, 0,
    ]);
    return triCount;
}

/**
 * Get the triangle indices lookup table data.
 * Each entry contains edge indices encoded in RGBA format.
 * The edge index is stored in the alpha channel for compatibility with the WGSL shader.
 *
 * Standard Marching Cubes triangle table - 256 cases, up to 16 entries per case.
 * Texture is 64x64 = 4096 entries (256 * 16).
 */
function getTriIndicesData(): Uint8Array {
    // Standard Marching Cubes triangle table from Paul Bourke
    // http://paulbourke.net/geometry/polygonise/
    const TriTable: readonly (readonly number[])[] = [
        [],
        [0, 8, 3],
        [0, 1, 9],
        [1, 8, 3, 9, 8, 1],
        [1, 2, 10],
        [0, 8, 3, 1, 2, 10],
        [9, 2, 10, 0, 2, 9],
        [2, 8, 3, 2, 10, 8, 10, 9, 8],
        [3, 11, 2],
        [0, 11, 2, 8, 11, 0],
        [1, 9, 0, 2, 3, 11],
        [1, 11, 2, 1, 9, 11, 9, 8, 11],
        [3, 10, 1, 11, 10, 3],
        [0, 10, 1, 0, 8, 10, 8, 11, 10],
        [3, 9, 0, 3, 11, 9, 11, 10, 9],
        [9, 8, 10, 10, 8, 11],
        [4, 7, 8],
        [4, 3, 0, 7, 3, 4],
        [0, 1, 9, 8, 4, 7],
        [4, 1, 9, 4, 7, 1, 7, 3, 1],
        [1, 2, 10, 8, 4, 7],
        [3, 4, 7, 3, 0, 4, 1, 2, 10],
        [9, 2, 10, 9, 0, 2, 8, 4, 7],
        [2, 10, 9, 2, 9, 7, 2, 7, 3, 7, 9, 4],
        [8, 4, 7, 3, 11, 2],
        [11, 4, 7, 11, 2, 4, 2, 0, 4],
        [9, 0, 1, 8, 4, 7, 2, 3, 11],
        [4, 7, 11, 9, 4, 11, 9, 11, 2, 9, 2, 1],
        [3, 10, 1, 3, 11, 10, 7, 8, 4],
        [1, 11, 10, 1, 4, 11, 1, 0, 4, 7, 11, 4],
        [4, 7, 8, 9, 0, 11, 9, 11, 10, 11, 0, 3],
        [4, 7, 11, 4, 11, 9, 9, 11, 10],
        [9, 5, 4],
        [9, 5, 4, 0, 8, 3],
        [0, 5, 4, 1, 5, 0],
        [8, 5, 4, 8, 3, 5, 3, 1, 5],
        [1, 2, 10, 9, 5, 4],
        [3, 0, 8, 1, 2, 10, 4, 9, 5],
        [5, 2, 10, 5, 4, 2, 4, 0, 2],
        [2, 10, 5, 3, 2, 5, 3, 5, 4, 3, 4, 8],
        [9, 5, 4, 2, 3, 11],
        [0, 11, 2, 0, 8, 11, 4, 9, 5],
        [0, 5, 4, 0, 1, 5, 2, 3, 11],
        [2, 1, 5, 2, 5, 8, 2, 8, 11, 4, 8, 5],
        [10, 3, 11, 10, 1, 3, 9, 5, 4],
        [4, 9, 5, 0, 8, 1, 8, 10, 1, 8, 11, 10],
        [5, 4, 0, 5, 0, 11, 5, 11, 10, 11, 0, 3],
        [5, 4, 8, 5, 8, 10, 10, 8, 11],
        [9, 7, 8, 5, 7, 9],
        [9, 3, 0, 9, 5, 3, 5, 7, 3],
        [0, 7, 8, 0, 1, 7, 1, 5, 7],
        [1, 5, 3, 3, 5, 7],
        [9, 7, 8, 9, 5, 7, 10, 1, 2],
        [10, 1, 2, 9, 5, 0, 5, 3, 0, 5, 7, 3],
        [8, 0, 2, 8, 2, 5, 8, 5, 7, 10, 5, 2],
        [2, 10, 5, 2, 5, 3, 3, 5, 7],
        [7, 9, 5, 7, 8, 9, 3, 11, 2],
        [9, 5, 7, 9, 7, 2, 9, 2, 0, 2, 7, 11],
        [2, 3, 11, 0, 1, 8, 1, 7, 8, 1, 5, 7],
        [11, 2, 1, 11, 1, 7, 7, 1, 5],
        [9, 5, 8, 8, 5, 7, 10, 1, 3, 10, 3, 11],
        [5, 7, 0, 5, 0, 9, 7, 11, 0, 1, 0, 10, 11, 10, 0],
        [11, 10, 0, 11, 0, 3, 10, 5, 0, 8, 0, 7, 5, 7, 0],
        [11, 10, 5, 7, 11, 5],
        [10, 6, 5],
        [0, 8, 3, 5, 10, 6],
        [9, 0, 1, 5, 10, 6],
        [1, 8, 3, 1, 9, 8, 5, 10, 6],
        [1, 6, 5, 2, 6, 1],
        [1, 6, 5, 1, 2, 6, 3, 0, 8],
        [9, 6, 5, 9, 0, 6, 0, 2, 6],
        [5, 9, 8, 5, 8, 2, 5, 2, 6, 3, 2, 8],
        [2, 3, 11, 10, 6, 5],
        [11, 0, 8, 11, 2, 0, 10, 6, 5],
        [0, 1, 9, 2, 3, 11, 5, 10, 6],
        [5, 10, 6, 1, 9, 2, 9, 11, 2, 9, 8, 11],
        [6, 3, 11, 6, 5, 3, 5, 1, 3],
        [0, 8, 11, 0, 11, 5, 0, 5, 1, 5, 11, 6],
        [3, 11, 6, 0, 3, 6, 0, 6, 5, 0, 5, 9],
        [6, 5, 9, 6, 9, 11, 11, 9, 8],
        [5, 10, 6, 4, 7, 8],
        [4, 3, 0, 4, 7, 3, 6, 5, 10],
        [1, 9, 0, 5, 10, 6, 8, 4, 7],
        [10, 6, 5, 1, 9, 7, 1, 7, 3, 7, 9, 4],
        [6, 1, 2, 6, 5, 1, 4, 7, 8],
        [1, 2, 5, 5, 2, 6, 3, 0, 4, 3, 4, 7],
        [8, 4, 7, 9, 0, 5, 0, 6, 5, 0, 2, 6],
        [7, 3, 9, 7, 9, 4, 3, 2, 9, 5, 9, 6, 2, 6, 9],
        [3, 11, 2, 7, 8, 4, 10, 6, 5],
        [5, 10, 6, 4, 7, 2, 4, 2, 0, 2, 7, 11],
        [0, 1, 9, 4, 7, 8, 2, 3, 11, 5, 10, 6],
        [9, 2, 1, 9, 11, 2, 9, 4, 11, 7, 11, 4, 5, 10, 6],
        [8, 4, 7, 3, 11, 5, 3, 5, 1, 5, 11, 6],
        [5, 1, 11, 5, 11, 6, 1, 0, 11, 7, 11, 4, 0, 4, 11],
        [0, 5, 9, 0, 6, 5, 0, 3, 6, 11, 6, 3, 8, 4, 7],
        [6, 5, 9, 6, 9, 11, 4, 7, 9, 7, 11, 9],
        [10, 4, 9, 6, 4, 10],
        [4, 10, 6, 4, 9, 10, 0, 8, 3],
        [10, 0, 1, 10, 6, 0, 6, 4, 0],
        [8, 3, 1, 8, 1, 6, 8, 6, 4, 6, 1, 10],
        [1, 4, 9, 1, 2, 4, 2, 6, 4],
        [3, 0, 8, 1, 2, 9, 2, 4, 9, 2, 6, 4],
        [0, 2, 4, 4, 2, 6],
        [8, 3, 2, 8, 2, 4, 4, 2, 6],
        [10, 4, 9, 10, 6, 4, 11, 2, 3],
        [0, 8, 2, 2, 8, 11, 4, 9, 10, 4, 10, 6],
        [3, 11, 2, 0, 1, 6, 0, 6, 4, 6, 1, 10],
        [6, 4, 1, 6, 1, 10, 4, 8, 1, 2, 1, 11, 8, 11, 1],
        [9, 6, 4, 9, 3, 6, 9, 1, 3, 11, 6, 3],
        [8, 11, 1, 8, 1, 0, 11, 6, 1, 9, 1, 4, 6, 4, 1],
        [3, 11, 6, 3, 6, 0, 0, 6, 4],
        [6, 4, 8, 11, 6, 8],
        [7, 10, 6, 7, 8, 10, 8, 9, 10],
        [0, 7, 3, 0, 10, 7, 0, 9, 10, 6, 7, 10],
        [10, 6, 7, 1, 10, 7, 1, 7, 8, 1, 8, 0],
        [10, 6, 7, 10, 7, 1, 1, 7, 3],
        [1, 2, 6, 1, 6, 8, 1, 8, 9, 8, 6, 7],
        [2, 6, 9, 2, 9, 1, 6, 7, 9, 0, 9, 3, 7, 3, 9],
        [7, 8, 0, 7, 0, 6, 6, 0, 2],
        [7, 3, 2, 6, 7, 2],
        [2, 3, 11, 10, 6, 8, 10, 8, 9, 8, 6, 7],
        [2, 0, 7, 2, 7, 11, 0, 9, 7, 6, 7, 10, 9, 10, 7],
        [1, 8, 0, 1, 7, 8, 1, 10, 7, 6, 7, 10, 2, 3, 11],
        [11, 2, 1, 11, 1, 7, 10, 6, 1, 6, 7, 1],
        [8, 9, 6, 8, 6, 7, 9, 1, 6, 11, 6, 3, 1, 3, 6],
        [0, 9, 1, 11, 6, 7],
        [7, 8, 0, 7, 0, 6, 3, 11, 0, 11, 6, 0],
        [7, 11, 6],
        [7, 6, 11],
        [3, 0, 8, 11, 7, 6],
        [0, 1, 9, 11, 7, 6],
        [8, 1, 9, 8, 3, 1, 11, 7, 6],
        [10, 1, 2, 6, 11, 7],
        [1, 2, 10, 3, 0, 8, 6, 11, 7],
        [2, 9, 0, 2, 10, 9, 6, 11, 7],
        [6, 11, 7, 2, 10, 3, 10, 8, 3, 10, 9, 8],
        [7, 2, 3, 6, 2, 7],
        [7, 0, 8, 7, 6, 0, 6, 2, 0],
        [2, 7, 6, 2, 3, 7, 0, 1, 9],
        [1, 6, 2, 1, 8, 6, 1, 9, 8, 8, 7, 6],
        [10, 7, 6, 10, 1, 7, 1, 3, 7],
        [10, 7, 6, 1, 7, 10, 1, 8, 7, 1, 0, 8],
        [0, 3, 7, 0, 7, 10, 0, 10, 9, 6, 10, 7],
        [7, 6, 10, 7, 10, 8, 8, 10, 9],
        [6, 8, 4, 11, 8, 6],
        [3, 6, 11, 3, 0, 6, 0, 4, 6],
        [8, 6, 11, 8, 4, 6, 9, 0, 1],
        [9, 4, 6, 9, 6, 3, 9, 3, 1, 11, 3, 6],
        [6, 8, 4, 6, 11, 8, 2, 10, 1],
        [1, 2, 10, 3, 0, 11, 0, 6, 11, 0, 4, 6],
        [4, 11, 8, 4, 6, 11, 0, 2, 9, 2, 10, 9],
        [10, 9, 3, 10, 3, 2, 9, 4, 3, 11, 3, 6, 4, 6, 3],
        [8, 2, 3, 8, 4, 2, 4, 6, 2],
        [0, 4, 2, 4, 6, 2],
        [1, 9, 0, 2, 3, 4, 2, 4, 6, 4, 3, 8],
        [1, 9, 4, 1, 4, 2, 2, 4, 6],
        [8, 1, 3, 8, 6, 1, 8, 4, 6, 6, 10, 1],
        [10, 1, 0, 10, 0, 6, 6, 0, 4],
        [4, 6, 3, 4, 3, 8, 6, 10, 3, 0, 3, 9, 10, 9, 3],
        [10, 9, 4, 6, 10, 4],
        [4, 9, 5, 7, 6, 11],
        [0, 8, 3, 4, 9, 5, 11, 7, 6],
        [5, 0, 1, 5, 4, 0, 7, 6, 11],
        [11, 7, 6, 8, 3, 4, 3, 5, 4, 3, 1, 5],
        [9, 5, 4, 10, 1, 2, 7, 6, 11],
        [6, 11, 7, 1, 2, 10, 0, 8, 3, 4, 9, 5],
        [7, 6, 11, 5, 4, 10, 4, 2, 10, 4, 0, 2],
        [3, 4, 8, 3, 5, 4, 3, 2, 5, 10, 5, 2, 11, 7, 6],
        [7, 2, 3, 7, 6, 2, 5, 4, 9],
        [9, 5, 4, 0, 8, 6, 0, 6, 2, 6, 8, 7],
        [3, 6, 2, 3, 7, 6, 1, 5, 0, 5, 4, 0],
        [6, 2, 8, 6, 8, 7, 2, 1, 8, 4, 8, 5, 1, 5, 8],
        [9, 5, 4, 10, 1, 6, 1, 7, 6, 1, 3, 7],
        [1, 6, 10, 1, 7, 6, 1, 0, 7, 8, 7, 0, 9, 5, 4],
        [4, 0, 10, 4, 10, 5, 0, 3, 10, 6, 10, 7, 3, 7, 10],
        [7, 6, 10, 7, 10, 8, 5, 4, 10, 4, 8, 10],
        [6, 9, 5, 6, 11, 9, 11, 8, 9],
        [3, 6, 11, 0, 6, 3, 0, 5, 6, 0, 9, 5],
        [0, 11, 8, 0, 5, 11, 0, 1, 5, 5, 6, 11],
        [6, 11, 3, 6, 3, 5, 5, 3, 1],
        [1, 2, 10, 9, 5, 11, 9, 11, 8, 11, 5, 6],
        [0, 11, 3, 0, 6, 11, 0, 9, 6, 5, 6, 9, 1, 2, 10],
        [11, 8, 5, 11, 5, 6, 8, 0, 5, 10, 5, 2, 0, 2, 5],
        [6, 11, 3, 6, 3, 5, 2, 10, 3, 10, 5, 3],
        [5, 8, 9, 5, 2, 8, 5, 6, 2, 3, 8, 2],
        [9, 5, 6, 9, 6, 0, 0, 6, 2],
        [1, 5, 8, 1, 8, 0, 5, 6, 8, 3, 8, 2, 6, 2, 8],
        [1, 5, 6, 2, 1, 6],
        [1, 3, 6, 1, 6, 10, 3, 8, 6, 5, 6, 9, 8, 9, 6],
        [10, 1, 0, 10, 0, 6, 9, 5, 0, 5, 6, 0],
        [0, 3, 8, 5, 6, 10],
        [10, 5, 6],
        [11, 5, 10, 7, 5, 11],
        [11, 5, 10, 11, 7, 5, 8, 3, 0],
        [5, 11, 7, 5, 10, 11, 1, 9, 0],
        [10, 7, 5, 10, 11, 7, 9, 8, 1, 8, 3, 1],
        [11, 1, 2, 11, 7, 1, 7, 5, 1],
        [0, 8, 3, 1, 2, 7, 1, 7, 5, 7, 2, 11],
        [9, 7, 5, 9, 2, 7, 9, 0, 2, 2, 11, 7],
        [7, 5, 2, 7, 2, 11, 5, 9, 2, 3, 2, 8, 9, 8, 2],
        [2, 5, 10, 2, 3, 5, 3, 7, 5],
        [8, 2, 0, 8, 5, 2, 8, 7, 5, 10, 2, 5],
        [9, 0, 1, 5, 10, 3, 5, 3, 7, 3, 10, 2],
        [9, 8, 2, 9, 2, 1, 8, 7, 2, 10, 2, 5, 7, 5, 2],
        [1, 3, 5, 3, 7, 5],
        [0, 8, 7, 0, 7, 1, 1, 7, 5],
        [9, 0, 3, 9, 3, 5, 5, 3, 7],
        [9, 8, 7, 5, 9, 7],
        [5, 8, 4, 5, 10, 8, 10, 11, 8],
        [5, 0, 4, 5, 11, 0, 5, 10, 11, 11, 3, 0],
        [0, 1, 9, 8, 4, 10, 8, 10, 11, 10, 4, 5],
        [10, 11, 4, 10, 4, 5, 11, 3, 4, 9, 4, 1, 3, 1, 4],
        [2, 5, 1, 2, 8, 5, 2, 11, 8, 4, 5, 8],
        [0, 4, 11, 0, 11, 3, 4, 5, 11, 2, 11, 1, 5, 1, 11],
        [0, 2, 5, 0, 5, 9, 2, 11, 5, 4, 5, 8, 11, 8, 5],
        [9, 4, 5, 2, 11, 3],
        [2, 5, 10, 3, 5, 2, 3, 4, 5, 3, 8, 4],
        [5, 10, 2, 5, 2, 4, 4, 2, 0],
        [3, 10, 2, 3, 5, 10, 3, 8, 5, 4, 5, 8, 0, 1, 9],
        [5, 10, 2, 5, 2, 4, 1, 9, 2, 9, 4, 2],
        [8, 4, 5, 8, 5, 3, 3, 5, 1],
        [0, 4, 5, 1, 0, 5],
        [8, 4, 5, 8, 5, 3, 9, 0, 5, 0, 3, 5],
        [9, 4, 5],
        [4, 11, 7, 4, 9, 11, 9, 10, 11],
        [0, 8, 3, 4, 9, 7, 9, 11, 7, 9, 10, 11],
        [1, 10, 11, 1, 11, 4, 1, 4, 0, 7, 4, 11],
        [3, 1, 4, 3, 4, 8, 1, 10, 4, 7, 4, 11, 10, 11, 4],
        [4, 11, 7, 9, 11, 4, 9, 2, 11, 9, 1, 2],
        [9, 7, 4, 9, 11, 7, 9, 1, 11, 2, 11, 1, 0, 8, 3],
        [11, 7, 4, 11, 4, 2, 2, 4, 0],
        [11, 7, 4, 11, 4, 2, 8, 3, 4, 3, 2, 4],
        [2, 9, 10, 2, 7, 9, 2, 3, 7, 7, 4, 9],
        [9, 10, 7, 9, 7, 4, 10, 2, 7, 8, 7, 0, 2, 0, 7],
        [3, 7, 10, 3, 10, 2, 7, 4, 10, 1, 10, 0, 4, 0, 10],
        [1, 10, 2, 8, 7, 4],
        [4, 9, 1, 4, 1, 7, 7, 1, 3],
        [4, 9, 1, 4, 1, 7, 0, 8, 1, 8, 7, 1],
        [4, 0, 3, 7, 4, 3],
        [4, 8, 7],
        [9, 10, 8, 10, 11, 8],
        [3, 0, 9, 3, 9, 11, 11, 9, 10],
        [0, 1, 10, 0, 10, 8, 8, 10, 11],
        [3, 1, 10, 11, 3, 10],
        [1, 2, 11, 1, 11, 9, 9, 11, 8],
        [3, 0, 9, 3, 9, 11, 1, 2, 9, 2, 11, 9],
        [0, 2, 11, 8, 0, 11],
        [3, 2, 11],
        [2, 3, 8, 2, 8, 10, 10, 8, 9],
        [9, 10, 2, 0, 9, 2],
        [2, 3, 8, 2, 8, 10, 0, 1, 8, 1, 10, 8],
        [1, 10, 2],
        [1, 3, 8, 9, 1, 8],
        [0, 9, 1],
        [0, 3, 8],
        []
    ];

    // Create RGBA data - edge index goes in alpha channel
    const data = new Uint8Array(64 * 64 * 4);

    for (let i = 0, il = TriTable.length; i < il; ++i) {
        for (let j = 0; j < 16; ++j) {
            const idx = (i * 16 + j) * 4;
            if (j < TriTable[i].length) {
                // Store edge index in alpha channel (compatible with WGSL shader)
                data[idx + 0] = 0; // R
                data[idx + 1] = 0; // G
                data[idx + 2] = 0; // B
                data[idx + 3] = TriTable[i][j]; // A - edge index
            } else {
                // No triangle - mark with 255
                data[idx + 0] = 0;
                data[idx + 1] = 0;
                data[idx + 2] = 0;
                data[idx + 3] = 255;
            }
        }
    }

    return data;
}

/**
 * High-level function to extract isosurface using WebGPU compute shaders.
 *
 * This is the main entry point that combines active voxel calculation,
 * histogram pyramid building, and isosurface extraction.
 */
export async function extractIsosurfaceWebGPU(
    ctx: GPUContext,
    volumeData: Texture,
    gridDim: Vec3,
    gridTexDim: Vec3,
    gridDataDim: Vec3,
    gridTexScale: Vec2,
    transform: Mat4,
    options: IsosurfaceOptions
): Promise<IsosurfaceResult> {
    const mc = new WebGPUMarchingCubes(ctx);

    try {
        // Import histogram pyramid builder
        const { WebGPUHistogramPyramid } = await import('./histogram-pyramid');
        const pyramidBuilder = new WebGPUHistogramPyramid(ctx);

        // Step 1: Calculate active voxels
        const activeVoxels = await mc.calcActiveVoxels(
            volumeData,
            gridDim,
            gridTexDim,
            options.isoValue,
            gridTexScale
        );

        // Step 2: Build histogram pyramid
        const pyramid = await pyramidBuilder.create(
            activeVoxels.texture,
            gridTexScale,
            gridTexDim
        );

        // Step 3: Extract isosurface
        const result = await mc.extractIsosurface(
            volumeData,
            activeVoxels.texture,
            pyramid,
            gridDim,
            gridTexDim,
            gridDataDim,
            transform,
            options
        );

        return result;
    } finally {
        // Cleanup is managed by the caller
    }
}
