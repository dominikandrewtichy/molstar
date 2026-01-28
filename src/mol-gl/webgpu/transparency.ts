/**
 * Copyright (c) 2025 mol* contributors, licensed under MIT, See LICENSE file for more info.
 *
 * @author Alexander Rose <alexander.rose@weirdbyte.de>
 */

import { GPUContext } from '../gpu/context';
import { Texture, TextureView } from '../gpu/texture';
import { Buffer } from '../gpu/buffer';
import { BindGroup, BindGroupLayout } from '../gpu/bind-group';
import { RenderPipeline, ShaderModule } from '../gpu/pipeline';
import { RenderPassEncoder, CommandEncoder } from '../gpu/render-pass';

/**
 * Transparency mode
 */
export type TransparencyMode = 'none' | 'blended' | 'wboit' | 'dpoit';

/**
 * WBOIT render targets
 */
export interface WboitTargets {
    /** Accumulation texture (RGBA16F): RGB = weighted color * alpha, A = alpha weight */
    accumulation: Texture;
    /** Revealage texture (R16F): product of (1 - alpha) weights */
    revealage: Texture;
    /** Views for the render targets */
    accumulationView: TextureView;
    revealageView: TextureView;
}

/**
 * DPOIT render targets for a single peel pass
 */
export interface DpoitTargets {
    /** Front color accumulation (RGBA16F) */
    frontColor: Texture;
    /** Back color for current peel (RGBA16F) */
    backColor: Texture;
    /** Depth texture (RG32F): R = -near depth, G = far depth */
    depth: Texture;
    /** Views */
    frontColorView: TextureView;
    backColorView: TextureView;
    depthView: TextureView;
}

/**
 * Configuration for the transparency pass
 */
export interface TransparencyPassConfig {
    /** Transparency mode */
    mode: TransparencyMode;
    /** Number of depth peeling passes for DPOIT */
    dpoitPasses?: number;
    /** Whether to include transparent backfaces */
    includeBackfaces?: boolean;
}

/**
 * Manages transparency rendering with support for WBOIT and DPOIT.
 */
export class TransparencyPassManager {
    private context: GPUContext;
    private width: number = 0;
    private height: number = 0;

    private wboitTargets: WboitTargets | null = null;
    private dpoitTargetsPing: DpoitTargets | null = null;
    private dpoitTargetsPong: DpoitTargets | null = null;

    private compositeBindGroupLayout: BindGroupLayout | null = null;
    private wboitCompositeBindGroup: BindGroup | null = null;
    private dpoitCompositeBindGroup: BindGroup | null = null;

    private wboitCompositePipeline: RenderPipeline | null = null;
    private dpoitCompositePipeline: RenderPipeline | null = null;

    private compositeSampler: import('../gpu/texture').Sampler | null = null;
    private quadVertexBuffer: Buffer | null = null;
    private shaderModule: ShaderModule | null = null;

    constructor(context: GPUContext) {
        this.context = context;
    }

    /**
     * Initialize or resize transparency render targets.
     */
    initialize(width: number, height: number, config: TransparencyPassConfig): void {
        if (this.width === width && this.height === height) {
            return;
        }

        this.width = width;
        this.height = height;

        // Clean up existing targets
        this.destroyTargets();

        // Create sampler if needed
        if (!this.compositeSampler) {
            this.compositeSampler = this.context.createSampler({
                magFilter: 'linear',
                minFilter: 'linear',
                addressModeU: 'clamp-to-edge',
                addressModeV: 'clamp-to-edge',
            });
        }

        // Create quad vertex buffer if needed
        if (!this.quadVertexBuffer) {
            const quadVertices = new Float32Array([
                -1, -1, 0, 0,
                 1, -1, 1, 0,
                -1, 1, 0, 1,
                 1, 1, 1, 1,
            ]);
            this.quadVertexBuffer = this.context.createBuffer({
                size: quadVertices.byteLength,
                usage: ['vertex', 'copy-dst'],
            });
            this.quadVertexBuffer.write(quadVertices);
        }

        // Create targets based on mode
        if (config.mode === 'wboit') {
            this.createWboitTargets(width, height);
        } else if (config.mode === 'dpoit') {
            this.createDpoitTargets(width, height);
        }

        // Create shader module if needed
        if (!this.shaderModule) {
            this.shaderModule = this.context.createShaderModule({
                code: TRANSPARENCY_COMPOSITE_SHADER,
                label: 'transparency-composite',
            });
        }

        // Create composite pipelines
        this.createCompositePipelines(config);
    }

    /**
     * Create WBOIT render targets.
     */
    private createWboitTargets(width: number, height: number): void {
        const accumulation = this.context.createTexture({
            size: [width, height],
            format: 'rgba16float',
            usage: ['render-attachment', 'texture-binding'],
            label: 'wboit-accumulation',
        });

        const revealage = this.context.createTexture({
            size: [width, height],
            format: 'r16float',
            usage: ['render-attachment', 'texture-binding'],
            label: 'wboit-revealage',
        });

        this.wboitTargets = {
            accumulation,
            revealage,
            accumulationView: accumulation.createView(),
            revealageView: revealage.createView(),
        };
    }

    /**
     * Create DPOIT render targets (ping-pong buffers).
     */
    private createDpoitTargets(width: number, height: number): void {
        this.dpoitTargetsPing = this.createDpoitTargetSet(width, height, 'ping');
        this.dpoitTargetsPong = this.createDpoitTargetSet(width, height, 'pong');
    }

    private createDpoitTargetSet(width: number, height: number, suffix: string): DpoitTargets {
        const frontColor = this.context.createTexture({
            size: [width, height],
            format: 'rgba16float',
            usage: ['render-attachment', 'texture-binding'],
            label: `dpoit-front-${suffix}`,
        });

        const backColor = this.context.createTexture({
            size: [width, height],
            format: 'rgba16float',
            usage: ['render-attachment', 'texture-binding'],
            label: `dpoit-back-${suffix}`,
        });

        const depth = this.context.createTexture({
            size: [width, height],
            format: 'rg32float',
            usage: ['render-attachment', 'texture-binding'],
            label: `dpoit-depth-${suffix}`,
        });

        return {
            frontColor,
            backColor,
            depth,
            frontColorView: frontColor.createView(),
            backColorView: backColor.createView(),
            depthView: depth.createView(),
        };
    }

    /**
     * Create composite pipelines for blending transparency results.
     */
    private createCompositePipelines(config: TransparencyPassConfig): void {
        // Create bind group layout for compositing
        if (!this.compositeBindGroupLayout) {
            this.compositeBindGroupLayout = this.context.createBindGroupLayout({
                entries: [
                    { binding: 0, visibility: ['fragment'], texture: { sampleType: 'float' } },
                    { binding: 1, visibility: ['fragment'], texture: { sampleType: 'float' } },
                    { binding: 2, visibility: ['fragment'], sampler: { type: 'filtering' } },
                ],
                label: 'transparency-composite-layout',
            });
        }

        const pipelineLayout = this.context.createPipelineLayout({
            bindGroupLayouts: [this.compositeBindGroupLayout],
        });

        // Create WBOIT composite pipeline
        if (config.mode === 'wboit' && this.shaderModule) {
            this.wboitCompositePipeline = this.context.createRenderPipeline({
                layout: pipelineLayout,
                vertex: {
                    module: this.shaderModule,
                    entryPoint: 'vs_main',
                    buffers: [{
                        arrayStride: 16,
                        attributes: [
                            { shaderLocation: 0, format: 'float32x2', offset: 0 },
                            { shaderLocation: 1, format: 'float32x2', offset: 8 },
                        ],
                    }],
                },
                fragment: {
                    module: this.shaderModule,
                    entryPoint: 'fs_wboit_composite',
                    targets: [{
                        format: this.context.preferredFormat as import('../gpu/texture').TextureFormat,
                        blend: {
                            color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                        },
                    }],
                },
                primitive: {
                    topology: 'triangle-strip',
                },
                label: 'wboit-composite-pipeline',
            });

            // Create WBOIT bind group
            if (this.wboitTargets && this.compositeSampler) {
                this.wboitCompositeBindGroup = this.context.createBindGroup({
                    layout: this.compositeBindGroupLayout,
                    entries: [
                        { binding: 0, resource: this.wboitTargets.accumulationView },
                        { binding: 1, resource: this.wboitTargets.revealageView },
                        { binding: 2, resource: this.compositeSampler },
                    ],
                    label: 'wboit-composite-bindgroup',
                });
            }
        }

        // Create DPOIT composite pipeline
        if (config.mode === 'dpoit' && this.shaderModule) {
            this.dpoitCompositePipeline = this.context.createRenderPipeline({
                layout: pipelineLayout,
                vertex: {
                    module: this.shaderModule,
                    entryPoint: 'vs_main',
                    buffers: [{
                        arrayStride: 16,
                        attributes: [
                            { shaderLocation: 0, format: 'float32x2', offset: 0 },
                            { shaderLocation: 1, format: 'float32x2', offset: 8 },
                        ],
                    }],
                },
                fragment: {
                    module: this.shaderModule,
                    entryPoint: 'fs_dpoit_composite',
                    targets: [{
                        format: this.context.preferredFormat as import('../gpu/texture').TextureFormat,
                        blend: {
                            color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                        },
                    }],
                },
                primitive: {
                    topology: 'triangle-strip',
                },
                label: 'dpoit-composite-pipeline',
            });
        }
    }

    /**
     * Begin WBOIT accumulation pass.
     * Returns the render pass encoder for rendering transparent geometry.
     */
    beginWboitAccumulationPass(encoder: CommandEncoder): RenderPassEncoder | null {
        if (!this.wboitTargets) return null;

        return this.context.beginRenderPass(encoder, {
            colorAttachments: [
                {
                    view: this.wboitTargets.accumulationView,
                    loadOp: 'clear',
                    storeOp: 'store',
                    clearValue: [0, 0, 0, 0],
                },
                {
                    view: this.wboitTargets.revealageView,
                    loadOp: 'clear',
                    storeOp: 'store',
                    clearValue: [1, 0, 0, 0],
                },
            ],
            label: 'wboit-accumulation-pass',
        });
    }

    /**
     * Composite WBOIT result onto the main color buffer.
     */
    compositeWboit(passEncoder: RenderPassEncoder): void {
        if (!this.wboitCompositePipeline || !this.wboitCompositeBindGroup || !this.quadVertexBuffer) {
            return;
        }

        passEncoder.setPipeline(this.wboitCompositePipeline);
        passEncoder.setBindGroup(0, this.wboitCompositeBindGroup);
        passEncoder.setVertexBuffer(0, this.quadVertexBuffer);
        passEncoder.draw(4);
    }

    /**
     * Begin DPOIT peel pass.
     */
    beginDpoitPeelPass(encoder: CommandEncoder, passIndex: number): RenderPassEncoder | null {
        const isEven = passIndex % 2 === 0;
        const targets = isEven ? this.dpoitTargetsPing : this.dpoitTargetsPong;

        if (!targets) return null;

        const loadOp = passIndex === 0 ? 'clear' as const : 'load' as const;

        return this.context.beginRenderPass(encoder, {
            colorAttachments: [
                {
                    view: targets.frontColorView,
                    loadOp,
                    storeOp: 'store',
                    clearValue: [0, 0, 0, 0],
                },
                {
                    view: targets.backColorView,
                    loadOp: 'clear',
                    storeOp: 'store',
                    clearValue: [0, 0, 0, 0],
                },
                {
                    view: targets.depthView,
                    loadOp: 'clear',
                    storeOp: 'store',
                    clearValue: [-99999, -99999, 0, 0],
                },
            ],
            label: `dpoit-peel-pass-${passIndex}`,
        });
    }

    /**
     * Get the previous pass depth texture for DPOIT.
     */
    getDpoitPreviousDepthView(passIndex: number): TextureView | null {
        if (passIndex === 0) return null;

        const isEven = passIndex % 2 === 0;
        const previousTargets = isEven ? this.dpoitTargetsPong : this.dpoitTargetsPing;

        return previousTargets?.depthView ?? null;
    }

    /**
     * Composite DPOIT result onto the main color buffer.
     */
    compositeDpoit(passEncoder: RenderPassEncoder): void {
        if (!this.dpoitCompositePipeline || !this.dpoitCompositeBindGroup || !this.quadVertexBuffer) {
            return;
        }

        passEncoder.setPipeline(this.dpoitCompositePipeline);
        passEncoder.setBindGroup(0, this.dpoitCompositeBindGroup);
        passEncoder.setVertexBuffer(0, this.quadVertexBuffer);
        passEncoder.draw(4);
    }

    /**
     * Get WBOIT targets for rendering.
     */
    getWboitTargets(): WboitTargets | null {
        return this.wboitTargets;
    }

    /**
     * Get blend state for WBOIT accumulation.
     */
    static getWboitAccumulationBlendState(): { color: import('../gpu/pipeline').BlendComponent; alpha: import('../gpu/pipeline').BlendComponent }[] {
        return [
            // Accumulation buffer: additive blending
            {
                color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
                alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
            },
            // Revealage buffer: multiplicative blending (simulated with additive of weighted alpha)
            {
                color: { srcFactor: 'zero', dstFactor: 'one-minus-src', operation: 'add' },
                alpha: { srcFactor: 'zero', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            },
        ];
    }

    /**
     * Destroy targets and free GPU resources.
     */
    private destroyTargets(): void {
        if (this.wboitTargets) {
            this.wboitTargets.accumulation.destroy();
            this.wboitTargets.revealage.destroy();
            this.wboitTargets = null;
        }

        if (this.dpoitTargetsPing) {
            this.dpoitTargetsPing.frontColor.destroy();
            this.dpoitTargetsPing.backColor.destroy();
            this.dpoitTargetsPing.depth.destroy();
            this.dpoitTargetsPing = null;
        }

        if (this.dpoitTargetsPong) {
            this.dpoitTargetsPong.frontColor.destroy();
            this.dpoitTargetsPong.backColor.destroy();
            this.dpoitTargetsPong.depth.destroy();
            this.dpoitTargetsPong = null;
        }

        this.wboitCompositeBindGroup = null;
        this.dpoitCompositeBindGroup = null;
    }

    /**
     * Dispose of all resources.
     */
    dispose(): void {
        this.destroyTargets();

        if (this.quadVertexBuffer) {
            this.quadVertexBuffer.destroy();
            this.quadVertexBuffer = null;
        }

        if (this.compositeSampler) {
            this.compositeSampler.destroy();
            this.compositeSampler = null;
        }

        this.compositeBindGroupLayout = null;
        this.wboitCompositePipeline = null;
        this.dpoitCompositePipeline = null;
        this.shaderModule = null;
    }

    /**
     * Get byte count of all GPU resources used by the transparency pass.
     */
    getByteCount(): number {
        let bytes = 0;

        if (this.wboitTargets) {
            bytes += this.wboitTargets.accumulation.getByteCount();
            bytes += this.wboitTargets.revealage.getByteCount();
        }

        if (this.dpoitTargetsPing) {
            bytes += this.dpoitTargetsPing.frontColor.getByteCount();
            bytes += this.dpoitTargetsPing.backColor.getByteCount();
            bytes += this.dpoitTargetsPing.depth.getByteCount();
        }

        if (this.dpoitTargetsPong) {
            bytes += this.dpoitTargetsPong.frontColor.getByteCount();
            bytes += this.dpoitTargetsPong.backColor.getByteCount();
            bytes += this.dpoitTargetsPong.depth.getByteCount();
        }

        if (this.quadVertexBuffer) {
            bytes += this.quadVertexBuffer.getByteCount();
        }

        return bytes;
    }
}

/**
 * WGSL shader for transparency compositing.
 */
const TRANSPARENCY_COMPOSITE_SHADER = /* wgsl */`
struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
}

@group(0) @binding(0) var accumTexture: texture_2d<f32>;
@group(0) @binding(1) var revealTexture: texture_2d<f32>;
@group(0) @binding(2) var texSampler: sampler;

@vertex
fn vs_main(
    @location(0) position: vec2<f32>,
    @location(1) uv: vec2<f32>
) -> VertexOutput {
    var output: VertexOutput;
    output.position = vec4<f32>(position, 0.0, 1.0);
    output.uv = uv;
    return output;
}

// WBOIT composite fragment shader
@fragment
fn fs_wboit_composite(input: VertexOutput) -> @location(0) vec4<f32> {
    let accum = textureSample(accumTexture, texSampler, input.uv);
    let reveal = textureSample(revealTexture, texSampler, input.uv).r;

    // Avoid division by zero
    let epsilon = 0.00001;

    // If reveal is 1.0, nothing was rendered (fully transparent)
    if (reveal >= 1.0 - epsilon) {
        discard;
    }

    // Compute average color
    // accum.rgb = sum of (color * alpha * weight)
    // accum.a = sum of (alpha * weight)
    let avgColor = accum.rgb / max(accum.a, epsilon);

    // Alpha is 1 - reveal (reveal is product of 1-alpha values)
    let alpha = 1.0 - reveal;

    return vec4<f32>(avgColor * alpha, alpha);
}

// DPOIT composite fragment shader
@fragment
fn fs_dpoit_composite(input: VertexOutput) -> @location(0) vec4<f32> {
    let frontColor = textureSample(accumTexture, texSampler, input.uv);
    let backColor = textureSample(revealTexture, texSampler, input.uv);

    // Front color is pre-accumulated, back color needs blending
    var result = backColor;

    // Blend front over back
    let frontAlpha = frontColor.a;
    result.rgb = result.rgb * (1.0 - frontAlpha) + frontColor.rgb;
    result.a = result.a * (1.0 - frontAlpha) + frontAlpha;

    if (result.a < 0.001) {
        discard;
    }

    return result;
}
`;
