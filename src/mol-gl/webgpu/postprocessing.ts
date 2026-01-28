/**
 * Copyright (c) 2025-2026 mol* contributors, licensed under MIT, See LICENSE file for more info.
 *
 * @author Alexander Rose <alexander.rose@weirdbyte.de>
 *
 * WebGPU Post-processing pass implementation.
 * Implements SSAO, shadows, outlines, and final compositing.
 */

import { GPUContext, RenderTarget, Texture, BindGroupLayout, BindGroup, RenderPipeline, Buffer } from '../gpu';
import { ICamera } from '../../mol-canvas3d/camera';
import { WebGPUScene } from './scene';
import { Light } from './renderer';
import { Vec2, Vec3 } from '../../mol-math/linear-algebra';
import { Color } from '../../mol-util/color';
import { ParamDefinition as PD } from '../../mol-util/param-definition';
import { ssao_wgsl, ssao_blur_wgsl } from '../shader/wgsl/ssao.wgsl';
import { postprocessing_wgsl, postprocessing_simple_wgsl } from '../shader/wgsl/postprocessing.wgsl';
import { outlines_wgsl } from '../shader/wgsl/outlines.wgsl';
import { shadow_wgsl } from '../shader/wgsl/shadow.wgsl';
import { isTimingMode } from '../../mol-util/debug';

//
// SSAO Pass
//

export const SsaoParams = {
    radius: PD.Numeric(5, { min: 0, max: 10, step: 0.1 }, { description: 'Shadow radius' }),
    bias: PD.Numeric(0.8, { min: 0, max: 1, step: 0.05 }, { description: 'Shadow bias' }),
    blurKernelSize: PD.Numeric(4, { min: 0, max: 8, step: 1 }, { description: 'Blur kernel size' }),
    blurStdDev: PD.Numeric(2, { min: 0.5, max: 4, step: 0.1 }, { description: 'Blur standard deviation' }),
    samples: PD.Numeric(32, { min: 8, max: 64, step: 8 }, { description: 'Number of samples' }),
    color: PD.Color(Color(0x000000)),
    includeTransparent: PD.Boolean(true, { description: 'Include transparent objects in occlusion' }),
    multiScale: PD.MappedStatic('off', {
        on: PD.Group({
            levels: PD.Numeric(4, { min: 2, max: 6, step: 1 }),
            near: PD.Numeric(5, { min: 1, max: 20, step: 1 }),
            far: PD.Numeric(30, { min: 10, max: 100, step: 1 }),
        }),
        off: PD.Group({})
    }),
};
export type SsaoProps = PD.Values<typeof SsaoParams>;

/**
 * WebGPU SSAO Pass.
 * Implements Screen Space Ambient Occlusion with bilateral blur.
 */
export class WebGPUSsaoPass {
    private ssaoTarget: RenderTarget;
    private ssaoBlurTarget: RenderTarget;
    private ssaoDepthTexture: Texture;
    private ssaoDepthTransparentTexture: Texture;

    private ssaoPipeline: RenderPipeline | null = null;
    private blurPipeline: RenderPipeline | null = null;
    private ssaoBindGroupLayout: BindGroupLayout | null = null;
    private blurBindGroupLayout: BindGroupLayout | null = null;

    private ssaoUniformBuffer: Buffer | null = null;
    private blurUniformBuffer: Buffer | null = null;
    private sampleBuffer: Buffer | null = null;

    private width: number;
    private height: number;

    constructor(
        private context: GPUContext,
        width: number,
        height: number,
        private depthTexture: Texture | import('../gpu').TextureView
    ) {
        this.width = width;
        this.height = height;

        // Create SSAO render targets
        this.ssaoTarget = context.createRenderTarget({
            width,
            height,
            depth: false,
            type: 'uint8',
            filter: 'nearest',
        });

        this.ssaoBlurTarget = context.createRenderTarget({
            width,
            height,
            depth: false,
            type: 'uint8',
            filter: 'linear',
        });

        // Create depth textures for SSAO output
        this.ssaoDepthTexture = context.createTexture({
            size: [width, height, 1],
            format: 'rgba8unorm',
            usage: ['texture-binding', 'render-attachment'],
        });

        this.ssaoDepthTransparentTexture = context.createTexture({
            size: [width, height, 1],
            format: 'rgba8unorm',
            usage: ['texture-binding', 'render-attachment'],
        });

        this.createPipelines();
        this.createUniformBuffers();
    }

    private createPipelines(): void {
        // Create SSAO shader module
        const ssaoShader = this.context.createShaderModule({
            code: ssao_wgsl,
            label: 'SSAO Shader'
        });

        // Create blur shader module
        const blurShader = this.context.createShaderModule({
            code: ssao_blur_wgsl,
            label: 'SSAO Blur Shader'
        });

        // Create bind group layouts
        this.ssaoBindGroupLayout = this.context.createBindGroupLayout({
            entries: [
                {
                    binding: 0,
                    visibility: ['vertex', 'fragment'],
                    buffer: { type: 'uniform' },
                },
                {
                    binding: 1,
                    visibility: ['fragment'],
                    buffer: { type: 'read-only-storage' },
                },
                {
                    binding: 2,
                    visibility: ['fragment'],
                    texture: { sampleType: 'float', viewDimension: '2d' },
                },
                {
                    binding: 3,
                    visibility: ['fragment'],
                    texture: { sampleType: 'float', viewDimension: '2d' },
                },
                {
                    binding: 4,
                    visibility: ['fragment'],
                    texture: { sampleType: 'float', viewDimension: '2d' },
                },
                {
                    binding: 5,
                    visibility: ['fragment'],
                    sampler: { type: 'filtering' },
                },
            ],
            label: 'SSAO Bind Group Layout'
        });

        this.blurBindGroupLayout = this.context.createBindGroupLayout({
            entries: [
                {
                    binding: 0,
                    visibility: ['vertex', 'fragment'],
                    buffer: { type: 'uniform' },
                },
                {
                    binding: 1,
                    visibility: ['fragment'],
                    texture: { sampleType: 'float', viewDimension: '2d' },
                },
                {
                    binding: 2,
                    visibility: ['fragment'],
                    sampler: { type: 'filtering' },
                },
            ],
            label: 'SSAO Blur Bind Group Layout'
        });

        // Create pipeline layouts
        const ssaoPipelineLayout = this.context.createPipelineLayout({
            bindGroupLayouts: [this.ssaoBindGroupLayout],
            label: 'SSAO Pipeline Layout'
        });

        const blurPipelineLayout = this.context.createPipelineLayout({
            bindGroupLayouts: [this.blurBindGroupLayout],
            label: 'SSAO Blur Pipeline Layout'
        });

        // Create SSAO pipeline
        this.ssaoPipeline = this.context.createRenderPipeline({
            layout: ssaoPipelineLayout,
            vertex: {
                module: ssaoShader,
                entryPoint: 'vs_main',
                buffers: [],
            },
            fragment: {
                module: ssaoShader,
                entryPoint: 'fs_main',
                targets: [{ format: 'rgba8unorm' }],
            },
            primitive: {
                topology: 'triangle-list',
            },
            label: 'SSAO Pipeline'
        });

        // Create blur pipeline
        this.blurPipeline = this.context.createRenderPipeline({
            layout: blurPipelineLayout,
            vertex: {
                module: blurShader,
                entryPoint: 'vs_main',
                buffers: [],
            },
            fragment: {
                module: blurShader,
                entryPoint: 'fs_main',
                targets: [{ format: 'rgba8unorm' }],
            },
            primitive: {
                topology: 'triangle-list',
            },
            label: 'SSAO Blur Pipeline'
        });
    }

    private createUniformBuffers(): void {
        // SSAO uniforms
        this.ssaoUniformBuffer = this.context.createBuffer({
            size: 160, // Size of SsaoUniforms with padding
            usage: ['uniform', 'copy-dst'],
            label: 'SSAO Uniform Buffer'
        });

        // Blur uniforms
        this.blurUniformBuffer = this.context.createBuffer({
            size: 32, // vec2 + vec2 + int + padding
            usage: ['uniform', 'copy-dst'],
            label: 'SSAO Blur Uniform Buffer'
        });

        // Generate sample directions
        this.generateSampleBuffer(32);
    }

    private generateSampleBuffer(nSamples: number): void {
        const samples: number[] = [];
        for (let i = 0; i < nSamples; i++) {
            // Random point in hemisphere
            const r = Math.random();
            const phi = Math.random() * 2 * Math.PI;
            const theta = Math.acos(1 - r);

            const x = Math.sin(theta) * Math.cos(phi);
            const y = Math.sin(theta) * Math.sin(phi);
            const z = Math.cos(theta);

            // Scale by random factor for better distribution
            const scale = i / nSamples;
            const scaleMix = 0.1 + scale * 0.9;

            samples.push(x * scaleMix, y * scaleMix, z * scaleMix);
        }

        this.sampleBuffer = this.context.createBuffer({
            size: samples.length * 4,
            usage: ['storage', 'copy-dst'],
            label: 'SSAO Sample Buffer'
        });
        this.sampleBuffer.write(new Float32Array(samples));
    }

    private createSsaoBindGroup(depthTexture: Texture | import('../gpu').TextureView): BindGroup {
        const sampler = this.context.createSampler({
            magFilter: 'linear',
            minFilter: 'linear',
        });

        // Helper to get texture view from Texture or TextureView
        const getView = (tex: Texture | import('../gpu').TextureView): import('../gpu').TextureView => {
            return 'createView' in tex ? (tex as Texture).createView() : (tex as import('../gpu').TextureView);
        };

        return this.context.createBindGroup({
            layout: this.ssaoBindGroupLayout!,
            entries: [
                { binding: 0, resource: { buffer: this.ssaoUniformBuffer! } },
                { binding: 1, resource: { buffer: this.sampleBuffer! } },
                { binding: 2, resource: getView(depthTexture) },
                { binding: 3, resource: getView(depthTexture) }, // Half depth (use same for now)
                { binding: 4, resource: getView(depthTexture) }, // Quarter depth (use same for now)
                { binding: 5, resource: sampler },
            ],
            label: 'SSAO Bind Group'
        });
    }

    private createBlurBindGroup(inputTexture: Texture | import('../gpu').TextureView): BindGroup {
        const sampler = this.context.createSampler({
            magFilter: 'linear',
            minFilter: 'linear',
        });

        // Handle both Texture (needs createView) and TextureView (already a view)
        const textureView = 'createView' in inputTexture
            ? (inputTexture as Texture).createView()
            : inputTexture as import('../gpu').TextureView;

        return this.context.createBindGroup({
            layout: this.blurBindGroupLayout!,
            entries: [
                { binding: 0, resource: { buffer: this.blurUniformBuffer! } },
                { binding: 1, resource: textureView },
                { binding: 2, resource: sampler },
            ],
            label: 'SSAO Blur Bind Group'
        });
    }

    private updateUniforms(camera: ICamera, props: SsaoProps): void {
        const orthographic = camera.state.mode === 'orthographic' ? 1 : 0;

        // Update SSAO uniforms
        const uniforms = new Float32Array([
            this.width, this.height, // texSize
            0, 0, 0, 0, // bounds (vec4)
            ...camera.projection, // projection matrix
            ...camera.projection, // invProjection (placeholder - should compute inverse)
            props.radius,
            props.bias,
            camera.near,
            camera.far,
            orthographic,
            0, // transparencyFlag
            props.samples,
            0, // padding
        ]);

        this.ssaoUniformBuffer!.write(uniforms);
    }

    private updateBlurUniforms(direction: Vec2, kernelRadius: number): void {
        const uniforms = new Float32Array([
            this.width, this.height,
            direction[0], direction[1],
            kernelRadius, 0, 0, 0,
        ]);
        this.blurUniformBuffer!.write(uniforms);
    }

    /**
     * Update SSAO pass.
     */
    update(camera: ICamera, scene: WebGPUScene, props: SsaoProps): void {
        void scene;
        this.updateUniforms(camera, props);
    }

    /**
     * Render SSAO pass.
     */
    render(encoder: import('../gpu').CommandEncoder, camera: ICamera): void {
        void camera;
        if (isTimingMode) console.time('WebGPUSsaoPass.render');

        // SSAO pass
        const ssaoPass = encoder.beginRenderPass({
            colorAttachments: [{
                view: this.ssaoTarget.texture,
                loadOp: 'clear',
                storeOp: 'store',
                clearValue: [1, 1, 1, 1],
            }],
            label: 'SSAO Pass'
        });

        const ssaoBindGroup = this.createSsaoBindGroup(this.depthTexture);
        ssaoPass.setPipeline(this.ssaoPipeline!);
        ssaoPass.setBindGroup(0, ssaoBindGroup);
        ssaoPass.draw(3); // Full-screen triangle
        ssaoPass.end();

        // Horizontal blur pass
        this.updateBlurUniforms(Vec2.create(1, 0), 4);
        const hBlurPass = encoder.beginRenderPass({
            colorAttachments: [{
                view: this.ssaoBlurTarget.texture,
                loadOp: 'clear',
                storeOp: 'store',
                clearValue: [0, 0, 0, 0],
            }],
            label: 'SSAO H-Blur Pass'
        });

        const hBlurBindGroup = this.createBlurBindGroup(this.ssaoTarget.texture as unknown as Texture);
        hBlurPass.setPipeline(this.blurPipeline!);
        hBlurPass.setBindGroup(0, hBlurBindGroup);
        hBlurPass.draw(3);
        hBlurPass.end();

        // Vertical blur pass (back to ssaoTarget)
        this.updateBlurUniforms(Vec2.create(0, 1), 4);
        const vBlurPass = encoder.beginRenderPass({
            colorAttachments: [{
                view: this.ssaoTarget.texture,
                loadOp: 'clear',
                storeOp: 'store',
                clearValue: [0, 0, 0, 0],
            }],
            label: 'SSAO V-Blur Pass'
        });

        const vBlurBindGroup = this.createBlurBindGroup(this.ssaoBlurTarget.texture as unknown as Texture);
        vBlurPass.setPipeline(this.blurPipeline!);
        vBlurPass.setBindGroup(0, vBlurBindGroup);
        vBlurPass.draw(3);
        vBlurPass.end();

        if (isTimingMode) console.timeEnd('WebGPUSsaoPass.render');
    }

    /**
     * Get SSAO depth texture.
     */
    getSsaoDepthTexture(): Texture {
        return this.ssaoTarget.texture as unknown as Texture;
    }

    /**
     * Get SSAO transparent depth texture.
     */
    getSsaoDepthTransparentTexture(): Texture {
        return this.ssaoDepthTransparentTexture;
    }

    /**
     * Resize the pass.
     */
    setSize(width: number, height: number): void {
        if (width === this.width && height === this.height) return;

        this.width = width;
        this.height = height;

        this.ssaoTarget.destroy();
        this.ssaoBlurTarget.destroy();
        this.ssaoDepthTexture.destroy();
        this.ssaoDepthTransparentTexture.destroy();

        this.ssaoTarget = this.context.createRenderTarget({
            width,
            height,
            depth: false,
            type: 'uint8',
            filter: 'nearest',
        });

        this.ssaoBlurTarget = this.context.createRenderTarget({
            width,
            height,
            depth: false,
            type: 'uint8',
            filter: 'linear',
        });

        this.ssaoDepthTexture = this.context.createTexture({
            size: [width, height, 1],
            format: 'rgba8unorm',
            usage: ['texture-binding', 'render-attachment'],
        });

        this.ssaoDepthTransparentTexture = this.context.createTexture({
            size: [width, height, 1],
            format: 'rgba8unorm',
            usage: ['texture-binding', 'render-attachment'],
        });
    }

    /**
     * Get byte count of all resources.
     */
    getByteCount(): number {
        return this.ssaoTarget.getByteCount() +
               this.ssaoBlurTarget.getByteCount() +
               this.ssaoDepthTexture.width * this.ssaoDepthTexture.height * 4 +
               this.ssaoDepthTransparentTexture.width * this.ssaoDepthTransparentTexture.height * 4;
    }

    /**
     * Dispose all resources.
     */
    dispose(): void {
        this.ssaoTarget.destroy();
        this.ssaoBlurTarget.destroy();
        this.ssaoDepthTexture.destroy();
        this.ssaoDepthTransparentTexture.destroy();
        this.ssaoUniformBuffer?.destroy();
        this.blurUniformBuffer?.destroy();
        this.sampleBuffer?.destroy();
    }
}

//
// Outline Pass
//

export const OutlineParams = {
    scale: PD.Numeric(1, { min: 1, max: 5, step: 1 }, { description: 'Outline scale' }),
    threshold: PD.Numeric(0.33, { min: 0, max: 1, step: 0.01 }),
    includeTransparent: PD.Boolean(true, { description: 'Include transparent objects in outline' }),
    color: PD.Color(Color(0x000000)),
};
export type OutlineProps = PD.Values<typeof OutlineParams>;

/**
 * WebGPU Outline Pass.
 * Renders outlines around objects using depth discontinuity detection.
 */
export class WebGPUOutlinePass {
    private target: RenderTarget;
    private pipeline: RenderPipeline | null = null;
    private bindGroupLayout: BindGroupLayout | null = null;
    private uniformBuffer: Buffer | null = null;

    private width: number;
    private height: number;

    constructor(
        private context: GPUContext,
        width: number,
        height: number,
        private depthTexture: Texture | import('../gpu').TextureView
    ) {
        this.width = width;
        this.height = height;

        this.target = context.createRenderTarget({
            width,
            height,
            depth: false,
            type: 'uint8',
            filter: 'nearest',
        });

        this.createPipeline();
        this.createUniformBuffer();
    }

    private createPipeline(): void {
        const shader = this.context.createShaderModule({
            code: outlines_wgsl,
            label: 'Outline Shader'
        });

        this.bindGroupLayout = this.context.createBindGroupLayout({
            entries: [
                {
                    binding: 0,
                    visibility: ['vertex', 'fragment'],
                    buffer: { type: 'uniform' },
                },
                {
                    binding: 1,
                    visibility: ['fragment'],
                    texture: { sampleType: 'float', viewDimension: '2d' },
                },
                {
                    binding: 2,
                    visibility: ['fragment'],
                    texture: { sampleType: 'float', viewDimension: '2d' },
                },
                {
                    binding: 3,
                    visibility: ['fragment'],
                    sampler: { type: 'filtering' },
                },
            ],
            label: 'Outline Bind Group Layout'
        });

        const pipelineLayout = this.context.createPipelineLayout({
            bindGroupLayouts: [this.bindGroupLayout],
            label: 'Outline Pipeline Layout'
        });

        this.pipeline = this.context.createRenderPipeline({
            layout: pipelineLayout,
            vertex: {
                module: shader,
                entryPoint: 'vs_main',
                buffers: [],
            },
            fragment: {
                module: shader,
                entryPoint: 'fs_main',
                targets: [{ format: 'rgba8unorm' }],
            },
            primitive: {
                topology: 'triangle-list',
            },
            label: 'Outline Pipeline'
        });
    }

    private createUniformBuffer(): void {
        this.uniformBuffer = this.context.createBuffer({
            size: 32,
            usage: ['uniform', 'copy-dst'],
            label: 'Outline Uniform Buffer'
        });
    }

    private createBindGroup(): BindGroup {
        const sampler = this.context.createSampler({
            magFilter: 'linear',
            minFilter: 'linear',
        });

        // Helper to get texture view from Texture or TextureView
        const getView = (tex: Texture | import('../gpu').TextureView): import('../gpu').TextureView => {
            return 'createView' in tex ? (tex as Texture).createView() : (tex as import('../gpu').TextureView);
        };

        return this.context.createBindGroup({
            layout: this.bindGroupLayout!,
            entries: [
                { binding: 0, resource: { buffer: this.uniformBuffer! } },
                { binding: 1, resource: getView(this.depthTexture) },
                { binding: 2, resource: getView(this.depthTexture) },
                { binding: 3, resource: sampler },
            ],
            label: 'Outline Bind Group'
        });
    }

    /**
     * Update outline pass.
     */
    update(camera: ICamera, props: OutlineProps): void {
        void camera;
        const uniforms = new Float32Array([
            this.width, this.height,
            props.scale,
            props.threshold,
            1.0, // uStep
            1.0, // uScale
            0, 0, // padding
        ]);
        this.uniformBuffer!.write(uniforms);
    }

    /**
     * Render outline pass.
     */
    render(encoder: import('../gpu').CommandEncoder): void {
        if (isTimingMode) console.time('WebGPUOutlinePass.render');

        const pass = encoder.beginRenderPass({
            colorAttachments: [{
                view: this.target.texture,
                loadOp: 'clear',
                storeOp: 'store',
                clearValue: [0, 0, 0, 0],
            }],
            label: 'Outline Pass'
        });

        const bindGroup = this.createBindGroup();
        pass.setPipeline(this.pipeline!);
        pass.setBindGroup(0, bindGroup);
        pass.draw(3);
        pass.end();

        if (isTimingMode) console.timeEnd('WebGPUOutlinePass.render');
    }

    /**
     * Get outline texture.
     */
    getTexture(): Texture {
        return this.target.texture as unknown as Texture;
    }

    /**
     * Resize the pass.
     */
    setSize(width: number, height: number): void {
        if (width === this.width && height === this.height) return;
        this.width = width;
        this.height = height;
        this.target.destroy();
        this.target = this.context.createRenderTarget({
            width,
            height,
            depth: false,
            type: 'uint8',
            filter: 'nearest',
        });
    }

    /**
     * Get byte count.
     */
    getByteCount(): number {
        return this.target.getByteCount();
    }

    /**
     * Dispose all resources.
     */
    dispose(): void {
        this.target.destroy();
        this.uniformBuffer?.destroy();
    }
}

//
// Shadow Pass
//

export const ShadowParams = {
    color: PD.Color(Color(0x000000)),
    intensity: PD.Numeric(0.5, { min: 0, max: 1, step: 0.05 }),
};
export type ShadowProps = PD.Values<typeof ShadowParams>;

/**
 * WebGPU Shadow Pass.
 * Implements screen-space shadow calculation.
 */
export class WebGPUShadowPass {
    private target: RenderTarget;
    private pipeline: RenderPipeline | null = null;
    private bindGroupLayout: BindGroupLayout | null = null;
    private uniformBuffer: Buffer | null = null;

    private width: number;
    private height: number;

    constructor(
        private context: GPUContext,
        width: number,
        height: number,
        private depthTexture: Texture | import('../gpu').TextureView
    ) {
        this.width = width;
        this.height = height;

        this.target = context.createRenderTarget({
            width,
            height,
            depth: false,
            type: 'uint8',
            filter: 'linear',
        });

        this.createPipeline();
        this.createUniformBuffer();
    }

    private createPipeline(): void {
        const shader = this.context.createShaderModule({
            code: shadow_wgsl,
            label: 'Shadow Shader'
        });

        this.bindGroupLayout = this.context.createBindGroupLayout({
            entries: [
                {
                    binding: 0,
                    visibility: ['vertex', 'fragment'],
                    buffer: { type: 'uniform' },
                },
                {
                    binding: 1,
                    visibility: ['fragment'],
                    texture: { sampleType: 'float', viewDimension: '2d' },
                },
                {
                    binding: 2,
                    visibility: ['fragment'],
                    sampler: { type: 'filtering' },
                },
            ],
            label: 'Shadow Bind Group Layout'
        });

        const pipelineLayout = this.context.createPipelineLayout({
            bindGroupLayouts: [this.bindGroupLayout],
            label: 'Shadow Pipeline Layout'
        });

        this.pipeline = this.context.createRenderPipeline({
            layout: pipelineLayout,
            vertex: {
                module: shader,
                entryPoint: 'vs_main',
                buffers: [],
            },
            fragment: {
                module: shader,
                entryPoint: 'fs_main',
                targets: [{ format: 'rgba8unorm' }],
            },
            primitive: {
                topology: 'triangle-list',
            },
            label: 'Shadow Pipeline'
        });
    }

    private createUniformBuffer(): void {
        this.uniformBuffer = this.context.createBuffer({
            size: 144, // mat4x4 (64) + vec3 (12) + 3 floats + vec2 (8) + padding = 144
            usage: ['uniform', 'copy-dst'],
            label: 'Shadow Uniform Buffer'
        });
    }

    private createBindGroup(): BindGroup {
        const sampler = this.context.createSampler({
            magFilter: 'linear',
            minFilter: 'linear',
        });

        // Helper to get texture view from Texture or TextureView
        const getView = (tex: Texture | import('../gpu').TextureView): import('../gpu').TextureView => {
            return 'createView' in tex ? (tex as Texture).createView() : (tex as import('../gpu').TextureView);
        };

        return this.context.createBindGroup({
            layout: this.bindGroupLayout!,
            entries: [
                { binding: 0, resource: { buffer: this.uniformBuffer! } },
                { binding: 1, resource: getView(this.depthTexture) },
                { binding: 2, resource: sampler },
            ],
            label: 'Shadow Bind Group'
        });
    }

    /**
     * Update shadow pass.
     */
    update(camera: ICamera, light: Light, ambientColor: Vec3, props: ShadowProps): void {
        void ambientColor;

        // Calculate light view projection matrix
        const lightDir = Vec3.create(light.direction[0], light.direction[1], light.direction[2]);
        Vec3.normalize(lightDir, lightDir);

        // Update uniforms
        // Light view projection is a simplified orthographic projection from light's perspective
        const lightViewProj = new Float32Array(16);
        // For now, use identity matrix (screen-space shadows don't need explicit light matrix)
        lightViewProj.set([
            1, 0, 0, 0,
            0, 1, 0, 0,
            0, 0, 1, 0,
            0, 0, 0, 1
        ]);

        const uniforms = new Float32Array(36); // 144 bytes / 4
        uniforms.set(lightViewProj, 0); // mat4x4 at offset 0
        uniforms.set([
            lightDir[0], lightDir[1], lightDir[2], // lightDirection
            props.intensity, // intensity
            0.005, // bias
            this.width, this.height, // texSize
            0, 0 // padding
        ], 16);

        this.uniformBuffer!.write(uniforms);
    }

    /**
     * Render shadow pass.
     */
    render(encoder: import('../gpu').CommandEncoder): void {
        if (isTimingMode) console.time('WebGPUShadowPass.render');

        const pass = encoder.beginRenderPass({
            colorAttachments: [{
                view: this.target.texture,
                loadOp: 'clear',
                storeOp: 'store',
                clearValue: [1, 1, 1, 1], // No shadow (white = full light)
            }],
            label: 'Shadow Pass'
        });

        const bindGroup = this.createBindGroup();
        pass.setPipeline(this.pipeline!);
        pass.setBindGroup(0, bindGroup);
        pass.draw(3); // Full-screen triangle
        pass.end();

        if (isTimingMode) console.timeEnd('WebGPUShadowPass.render');
    }

    /**
     * Get shadow texture.
     */
    getTexture(): Texture {
        return this.target.texture as unknown as Texture;
    }

    /**
     * Resize the pass.
     */
    setSize(width: number, height: number): void {
        if (width === this.width && height === this.height) return;
        this.width = width;
        this.height = height;
        this.target.destroy();
        this.target = this.context.createRenderTarget({
            width,
            height,
            depth: false,
            type: 'uint8',
            filter: 'linear',
        });
    }

    /**
     * Get byte count.
     */
    getByteCount(): number {
        return this.target.getByteCount();
    }

    /**
     * Dispose all resources.
     */
    dispose(): void {
        this.target.destroy();
        this.uniformBuffer?.destroy();
    }
}

//
// Postprocessing Pass
//

export const PostprocessingParams = {
    enabled: PD.Boolean(true),
    occlusion: PD.MappedStatic('on', {
        on: PD.Group(SsaoParams),
        off: PD.Group({})
    }),
    shadow: PD.MappedStatic('off', {
        on: PD.Group(ShadowParams),
        off: PD.Group({})
    }),
    outline: PD.MappedStatic('off', {
        on: PD.Group(OutlineParams),
        off: PD.Group({})
    }),
};
export type PostprocessingProps = PD.Values<typeof PostprocessingParams>;

/**
 * WebGPU Postprocessing Pass.
 * Composites SSAO, shadows, outlines, and applies final color grading.
 */
export class WebGPUPostprocessingPass {
    private _target: RenderTarget;

    readonly ssao: WebGPUSsaoPass;
    readonly outline: WebGPUOutlinePass;
    readonly shadow: WebGPUShadowPass;

    private pipeline: RenderPipeline | null = null;
    private bindGroupLayout: BindGroupLayout | null = null;
    private uniformBuffer: Buffer | null = null;

    private width: number;
    private height: number;

    private transparentBackground = false;

    constructor(
        private context: GPUContext,
        width: number,
        height: number,
        private colorTexture: Texture | import('../gpu').TextureView,
        private depthTexture: Texture | import('../gpu').TextureView,
        private transparentColorTexture?: Texture | import('../gpu').TextureView,
        private depthTextureTransparent?: Texture | import('../gpu').TextureView
    ) {
        this.width = width;
        this.height = height;

        this._target = context.createRenderTarget({
            width,
            height,
            depth: false,
            type: 'uint8',
            filter: 'linear',
        });

        this.ssao = new WebGPUSsaoPass(context, width, height, depthTexture);
        this.outline = new WebGPUOutlinePass(context, width, height, depthTexture);
        this.shadow = new WebGPUShadowPass(context, width, height, depthTexture);

        this.createPipelines();
        this.createUniformBuffer();
    }

    private createPipelines(): void {
        const shader = this.context.createShaderModule({
            code: postprocessing_wgsl,
            label: 'Postprocessing Shader'
        });

        this.bindGroupLayout = this.context.createBindGroupLayout({
            entries: [
                {
                    binding: 0,
                    visibility: ['vertex', 'fragment'],
                    buffer: { type: 'uniform' },
                },
                {
                    binding: 1,
                    visibility: ['fragment'],
                    texture: { sampleType: 'float', viewDimension: '2d' },
                },
                {
                    binding: 2,
                    visibility: ['fragment'],
                    texture: { sampleType: 'float', viewDimension: '2d' },
                },
                {
                    binding: 3,
                    visibility: ['fragment'],
                    texture: { sampleType: 'float', viewDimension: '2d' },
                },
                {
                    binding: 4,
                    visibility: ['fragment'],
                    texture: { sampleType: 'float', viewDimension: '2d' },
                },
                {
                    binding: 5,
                    visibility: ['fragment'],
                    texture: { sampleType: 'float', viewDimension: '2d' },
                },
                {
                    binding: 6,
                    visibility: ['fragment'],
                    texture: { sampleType: 'float', viewDimension: '2d' },
                },
                {
                    binding: 7,
                    visibility: ['fragment'],
                    texture: { sampleType: 'float', viewDimension: '2d' },
                },
                {
                    binding: 8,
                    visibility: ['fragment'],
                    texture: { sampleType: 'float', viewDimension: '2d' },
                },
                {
                    binding: 9,
                    visibility: ['fragment'],
                    sampler: { type: 'filtering' },
                },
            ],
            label: 'Postprocessing Bind Group Layout'
        });

        const pipelineLayout = this.context.createPipelineLayout({
            bindGroupLayouts: [this.bindGroupLayout],
            label: 'Postprocessing Pipeline Layout'
        });

        this.pipeline = this.context.createRenderPipeline({
            layout: pipelineLayout,
            vertex: {
                module: shader,
                entryPoint: 'vs_main',
                buffers: [],
            },
            fragment: {
                module: shader,
                entryPoint: 'fs_main',
                targets: [{ format: this.context.preferredFormat }],
            },
            primitive: {
                topology: 'triangle-list',
            },
            label: 'Postprocessing Pipeline'
        });

        void postprocessing_simple_wgsl;
    }

    private createUniformBuffer(): void {
        this.uniformBuffer = this.context.createBuffer({
            size: 96, // Size of PostprocessingUniforms
            usage: ['uniform', 'copy-dst'],
            label: 'Postprocessing Uniform Buffer'
        });
    }

    private createBindGroup(
        camera: ICamera,
        props: PostprocessingProps,
        backgroundColor: Color
    ): BindGroup {
        const sampler = this.context.createSampler({
            magFilter: 'linear',
            minFilter: 'linear',
        });

        const orthographic = camera.state.mode === 'orthographic' ? 1 : 0;
        const fogColor = Color.toVec3Normalized(Vec3(), backgroundColor);
        const outlineColor = props.outline.name === 'on'
            ? Color.toVec3Normalized(Vec3(), (props.outline.params as OutlineProps).color)
            : Vec3.create(0, 0, 0);
        const occlusionColor = props.occlusion.name === 'on'
            ? Color.toVec3Normalized(Vec3(), (props.occlusion.params as SsaoProps).color)
            : Vec3.create(0, 0, 0);

        const uniforms = new Float32Array([
            this.width, this.height, // texSize
            camera.near,
            camera.far,
            camera.fogNear,
            camera.fogFar,
            fogColor[0], fogColor[1], fogColor[2],
            outlineColor[0], outlineColor[1], outlineColor[2],
            occlusionColor[0], occlusionColor[1], occlusionColor[2],
            0, 0, // occlusionOffset
            this.transparentBackground ? 1 : 0,
            orthographic,
            props.outline.name === 'on' ? (props.outline.params as OutlineProps).scale : 1,
            0, // padding
        ]);

        this.uniformBuffer!.write(uniforms);

        // Helper to get texture view from Texture or TextureView
        const getView = (tex: Texture | import('../gpu').TextureView): import('../gpu').TextureView => {
            return 'createView' in tex ? (tex as Texture).createView() : (tex as import('../gpu').TextureView);
        };

        return this.context.createBindGroup({
            layout: this.bindGroupLayout!,
            entries: [
                { binding: 0, resource: { buffer: this.uniformBuffer! } },
                { binding: 1, resource: getView(this.colorTexture) },
                { binding: 2, resource: getView(this.depthTexture) },
                { binding: 3, resource: this.ssao.getSsaoDepthTexture().createView() },
                { binding: 4, resource: this.outline.getTexture().createView() },
                { binding: 5, resource: this.shadow.getTexture().createView() },
                { binding: 6, resource: this.transparentColorTexture ? getView(this.transparentColorTexture) : getView(this.colorTexture) },
                { binding: 7, resource: this.depthTextureTransparent ? getView(this.depthTextureTransparent) : getView(this.depthTexture) },
                { binding: 8, resource: this.ssao.getSsaoDepthTransparentTexture().createView() },
                { binding: 9, resource: sampler },
            ],
            label: 'Postprocessing Bind Group'
        });
    }

    /**
     * Check if postprocessing is enabled.
     */
    static isEnabled(props: PostprocessingProps): boolean {
        return props.enabled && (
            props.occlusion.name === 'on' ||
            props.shadow.name === 'on' ||
            props.outline.name === 'on'
        );
    }

    /**
     * Set transparent background.
     */
    setTransparentBackground(value: boolean): void {
        this.transparentBackground = value;
    }

    /**
     * Update postprocessing pass.
     */
    update(camera: ICamera, scene: WebGPUScene, props: PostprocessingProps): void {
        if (props.occlusion.name === 'on') {
            this.ssao.update(camera, scene, props.occlusion.params as SsaoProps);
        }
        if (props.outline.name === 'on') {
            this.outline.update(camera, props.outline.params as OutlineProps);
        }
    }

    /**
     * Render postprocessing pass.
     */
    render(
        encoder: import('../gpu').CommandEncoder,
        camera: ICamera,
        scene: WebGPUScene,
        props: PostprocessingProps,
        backgroundColor: Color
    ): void {
        if (isTimingMode) console.time('WebGPUPostprocessingPass.render');

        // Render SSAO if enabled
        if (props.occlusion.name === 'on') {
            this.ssao.render(encoder, camera);
        }

        // Render outline if enabled
        if (props.outline.name === 'on') {
            this.outline.render(encoder);
        }

        // Render shadows if enabled
        if (props.shadow.name === 'on') {
            this.shadow.render(encoder);
        }

        // Composite pass
        const pass = encoder.beginRenderPass({
            colorAttachments: [{
                view: this._target.texture,
                loadOp: 'clear',
                storeOp: 'store',
                clearValue: [0, 0, 0, 1],
            }],
            label: 'Postprocessing Composite Pass'
        });

        const bindGroup = this.createBindGroup(camera, props, backgroundColor);
        pass.setPipeline(this.pipeline!);
        pass.setBindGroup(0, bindGroup);
        pass.draw(3);
        pass.end();

        if (isTimingMode) console.timeEnd('WebGPUPostprocessingPass.render');
    }

    /**
     * Get the target render target.
     */
    get target(): RenderTarget {
        return this._target;
    }

    /**
     * Resize the pass.
     */
    setSize(width: number, height: number): void {
        if (width === this.width && height === this.height) return;
        this.width = width;
        this.height = height;
        this._target.destroy();
        this._target = this.context.createRenderTarget({
            width,
            height,
            depth: false,
            type: 'uint8',
            filter: 'linear',
        });
        this.ssao.setSize(width, height);
        this.outline.setSize(width, height);
        this.shadow.setSize(width, height);
    }

    /**
     * Get byte count.
     */
    getByteCount(): number {
        return this._target.getByteCount() +
               this.ssao.getByteCount() +
               this.outline.getByteCount() +
               this.shadow.getByteCount();
    }

    /**
     * Dispose all resources.
     */
    dispose(): void {
        this._target.destroy();
        this.ssao.dispose();
        this.outline.dispose();
        this.shadow.dispose();
        this.uniformBuffer?.destroy();
    }
}
