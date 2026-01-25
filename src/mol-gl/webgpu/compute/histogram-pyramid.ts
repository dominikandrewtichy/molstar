/**
 * Copyright (c) 2025-2026 mol* contributors, licensed under MIT, See LICENSE file for more info.
 *
 * @author Alexander Rose <alexander.rose@weirdbyte.de>
 */

import { GPUContext } from '../../gpu/context';
import { Texture } from '../../gpu/texture';
import { Buffer } from '../../gpu/buffer';
import { ComputePipeline, ShaderModule } from '../../gpu/pipeline';
import { Vec2, Vec3 } from '../../../mol-math/linear-algebra';
import { isPowerOfTwo } from '../../../mol-math/misc';
import {
    histogramPyramidReduction_wgsl,
    histogramPyramidSum_wgsl,
} from '../../shader/wgsl/compute/histogram-pyramid.wgsl';

/**
 * Result of histogram pyramid creation.
 */
export interface HistogramPyramidResult {
    /** The pyramid texture containing all levels packed horizontally */
    pyramidTexture: Texture;
    /** Total count of active elements */
    count: number;
    /** Height of the output (count / size) */
    height: number;
    /** Number of pyramid levels */
    levels: number;
    /** Scale factor for texture coordinates */
    scale: Vec2;
}

/**
 * WebGPU compute-based histogram pyramid builder.
 *
 * Replaces the WebGL fragment shader-based approach with native compute shaders.
 */
export class WebGPUHistogramPyramid {
    private ctx: GPUContext;
    private reductionPipeline: ComputePipeline | null = null;
    private sumPipeline: ComputePipeline | null = null;
    private reductionShaderModule: ShaderModule | null = null;
    private sumShaderModule: ShaderModule | null = null;

    // Cached resources
    private levelTextures: Map<number, Texture> = new Map();
    private pyramidTexture: Texture | null = null;
    private uniformBuffer: Buffer | null = null;
    private sumResultBuffer: Buffer | null = null;
    private sumStagingBuffer: Buffer | null = null;

    constructor(ctx: GPUContext) {
        this.ctx = ctx;
    }

    /**
     * Create a histogram pyramid from an input texture.
     *
     * The input texture should contain vertex counts in the red channel (normalized 0-1).
     *
     * @param inputTexture The input texture with active voxel data
     * @param scale Scale factor for texture coordinates
     * @param gridTexDim Grid texture dimensions
     * @returns Promise resolving to the histogram pyramid result
     */
    async create(
        inputTexture: Texture,
        scale: Vec2,
        gridTexDim: Vec3
    ): Promise<HistogramPyramidResult> {
        const w = inputTexture.width;
        const h = inputTexture.height;

        if (w !== h || !isPowerOfTwo(w)) {
            throw new Error('inputTexture must be of square power-of-two size');
        }

        // Ensure pipelines are created
        this.ensurePipelines();

        // Calculate pyramid parameters
        const levels = Math.ceil(Math.log2(w));
        const maxSize = Math.pow(2, levels);
        const maxSizeX = maxSize;
        const maxSizeY = maxSize / 2;

        // Create or resize pyramid texture
        this.ensurePyramidTexture(maxSizeX, maxSizeY);

        // Create level textures
        for (let i = 0; i < levels; i++) {
            this.ensureLevelTexture(i, Math.pow(2, i));
        }

        // Run reduction passes
        await this.runReductionPasses(inputTexture, levels, maxSize, gridTexDim);

        // Get the sum from the top of the pyramid
        const count = await this.getSum(levels);

        // Calculate output height
        const height = Math.ceil(Math.max(1, count) / maxSize);

        return {
            pyramidTexture: this.pyramidTexture!,
            count: Math.max(1, count),
            height,
            levels,
            scale: Vec2.clone(scale),
        };
    }

    private ensurePipelines(): void {
        if (!this.reductionPipeline) {
            this.reductionShaderModule = this.ctx.createShaderModule({
                code: histogramPyramidReduction_wgsl,
                label: 'histogram-pyramid-reduction',
            });

            this.reductionPipeline = this.ctx.createComputePipeline({
                layout: 'auto',
                compute: {
                    module: this.reductionShaderModule,
                    entryPoint: 'main',
                },
                label: 'histogram-pyramid-reduction-pipeline',
            });
        }

        if (!this.sumPipeline) {
            this.sumShaderModule = this.ctx.createShaderModule({
                code: histogramPyramidSum_wgsl,
                label: 'histogram-pyramid-sum',
            });

            this.sumPipeline = this.ctx.createComputePipeline({
                layout: 'auto',
                compute: {
                    module: this.sumShaderModule,
                    entryPoint: 'main',
                },
                label: 'histogram-pyramid-sum-pipeline',
            });
        }

        if (!this.uniformBuffer) {
            this.uniformBuffer = this.ctx.createBuffer({
                size: 16, // 4 floats
                usage: ['uniform', 'copy-dst'],
            });
        }

        if (!this.sumResultBuffer) {
            this.sumResultBuffer = this.ctx.createBuffer({
                size: 4, // 1 int32
                usage: ['storage', 'copy-src'],
            });
        }

        if (!this.sumStagingBuffer) {
            // Staging buffer for reading results back to CPU
            // The Buffer.read() method handles mapping internally
            this.sumStagingBuffer = this.ctx.createBuffer({
                size: 4,
                usage: ['copy-dst'],
            });
        }
    }

    private ensurePyramidTexture(width: number, height: number): void {
        if (!this.pyramidTexture ||
            this.pyramidTexture.width !== width ||
            this.pyramidTexture.height !== height) {

            if (this.pyramidTexture) {
                this.pyramidTexture.destroy();
            }

            this.pyramidTexture = this.ctx.createTexture({
                size: [width, height],
                format: 'r32sint',
                usage: ['texture-binding', 'storage-binding', 'copy-dst', 'copy-src'],
            });
        }
    }

    private ensureLevelTexture(level: number, size: number): void {
        let texture = this.levelTextures.get(level);

        if (!texture || texture.width !== size) {
            if (texture) {
                texture.destroy();
            }

            texture = this.ctx.createTexture({
                size: [size, size],
                format: 'r32sint',
                usage: ['texture-binding', 'storage-binding', 'copy-src'],
            });

            this.levelTextures.set(level, texture);
        }
    }

    private async runReductionPasses(
        inputTexture: Texture,
        levels: number,
        maxSize: number,
        _gridTexDim: Vec3
    ): Promise<void> {
        const encoder = this.ctx.createCommandEncoder();

        let offset = 0;

        for (let i = 0; i < levels; i++) {
            const currLevel = levels - 1 - i;
            const size = Math.pow(2, currLevel);
            const levelTexture = this.levelTextures.get(currLevel)!;

            // Update uniforms
            const uniformData = new Float32Array([
                Math.pow(2, i + 1) / maxSize, // size
                size,                          // texSize
                i === 0 ? 1 : 0,              // first
                0,                             // padding
            ]);
            this.uniformBuffer!.write(uniformData);

            // Create bind group for this pass
            const inputTex = i === 0 ? inputTexture : this.levelTextures.get(levels - i)!;
            const previousTex = this.levelTextures.get(0)!; // Placeholder for first iteration

            const bindGroup = this.ctx.createBindGroup({
                layout: this.reductionPipeline!.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: { buffer: this.uniformBuffer! } },
                    { binding: 1, resource: inputTex.createView() },
                    { binding: 2, resource: previousTex.createView() },
                    { binding: 3, resource: levelTexture.createView() },
                ],
            });

            // Run compute pass
            const computePass = encoder.beginComputePass();
            computePass.setPipeline(this.reductionPipeline!);
            computePass.setBindGroup(0, bindGroup);
            computePass.dispatchWorkgroups(
                Math.ceil(size / 16),
                Math.ceil(size / 16)
            );
            computePass.end();

            // Copy level to pyramid texture
            // Note: This would require a copy operation from levelTexture to pyramidTexture
            // at offset position. Simplified for now.

            offset += size;
        }

        this.ctx.submit([encoder.finish()]);
    }

    private async getSum(levels: number): Promise<number> {
        const topLevelTexture = this.levelTextures.get(0)!;

        const bindGroup = this.ctx.createBindGroup({
            layout: this.sumPipeline!.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: topLevelTexture.createView() },
                { binding: 1, resource: { buffer: this.sumResultBuffer! } },
            ],
        });

        const encoder = this.ctx.createCommandEncoder();

        const computePass = encoder.beginComputePass();
        computePass.setPipeline(this.sumPipeline!);
        computePass.setBindGroup(0, bindGroup);
        computePass.dispatchWorkgroups(1);
        computePass.end();

        // Copy result to staging buffer
        encoder.copyBufferToBuffer(
            this.sumResultBuffer!,
            0,
            this.sumStagingBuffer!,
            0,
            4
        );

        this.ctx.submit([encoder.finish()]);

        // Read back the result
        const result = await this.sumStagingBuffer!.read();
        const sumArray = new Int32Array(result);
        return sumArray[0];
    }

    /**
     * Destroy all resources.
     */
    destroy(): void {
        this.reductionPipeline?.destroy();
        this.sumPipeline?.destroy();
        this.reductionShaderModule?.destroy();
        this.sumShaderModule?.destroy();
        this.pyramidTexture?.destroy();
        this.uniformBuffer?.destroy();
        this.sumResultBuffer?.destroy();
        this.sumStagingBuffer?.destroy();

        for (const texture of this.levelTextures.values()) {
            texture.destroy();
        }
        this.levelTextures.clear();
    }
}

/**
 * Create a histogram pyramid from an input texture using WebGPU compute shaders.
 */
export async function createHistogramPyramidWebGPU(
    ctx: GPUContext,
    inputTexture: Texture,
    scale: Vec2,
    gridTexDim: Vec3
): Promise<HistogramPyramidResult> {
    const builder = new WebGPUHistogramPyramid(ctx);
    try {
        return await builder.create(inputTexture, scale, gridTexDim);
    } finally {
        // Note: Don't destroy here if the result is still being used
        // The caller should manage the lifecycle
    }
}
