/**
 * Copyright (c) 2025-2026 mol* contributors, licensed under MIT, See LICENSE file for more info.
 *
 * @author Alexander Rose <alexander.rose@weirdbyte.de>
 *
 * WebGPU-native Passes implementation.
 */

import { GPUContext } from '../gpu/context';
import { WebGPURenderer } from './renderer';
import { WebGPUScene } from './scene';
import { Camera } from '../../mol-canvas3d/camera';
import { RenderTarget, RenderTargetOptions, TextureView } from '../gpu';
import { isTimingMode } from '../../mol-util/debug';
import { WebGPUPickPass } from './picking';
import { TransparencyPassManager, TransparencyPassConfig } from './transparency';

// Re-export TransparencyMode from pipeline-cache to avoid redefinition
export type { TransparencyMode } from './pipeline-cache';
import type { TransparencyMode } from './pipeline-cache';

export interface RenderContext {
    renderer: WebGPURenderer;
    camera: Camera;
    scene: WebGPUScene;
}

/**
 * WebGPU DrawPass implementation.
 * Handles rendering to the main color target with depth buffering.
 */
export class WebGPUDrawPass {
    readonly colorTarget: RenderTarget;

    private width: number;
    private height: number;
    private transparencyMode: TransparencyMode = 'blended';
    private transparencyManager: TransparencyPassManager | null = null;

    constructor(
        private context: GPUContext,
        width: number,
        height: number,
        transparency: TransparencyMode = 'blended'
    ) {
        this.width = width;
        this.height = height;
        this.transparencyMode = transparency;

        // Create color render target with depth
        const options: RenderTargetOptions = {
            width,
            height,
            depth: true,
            type: 'uint8',
            filter: 'linear',
        };
        this.colorTarget = context.createRenderTarget(options);

        // Initialize transparency manager for advanced modes
        if (transparency === 'wboit' || transparency === 'dpoit') {
            this.transparencyManager = new TransparencyPassManager(context);
            this.initializeTransparencyManager();
        }
    }

    private initializeTransparencyManager(): void {
        if (!this.transparencyManager) return;

        const config: TransparencyPassConfig = {
            mode: this.transparencyMode as 'wboit' | 'dpoit',
            dpoitPasses: 4,
            includeBackfaces: true,
        };
        this.transparencyManager.initialize(this.width, this.height, config);
    }

    get transparency(): TransparencyMode {
        return this.transparencyMode;
    }

    setTransparency(transparency: TransparencyMode): void {
        if (this.transparencyMode === transparency) return;

        this.transparencyMode = transparency;

        // Update transparency manager
        if (transparency === 'wboit' || transparency === 'dpoit') {
            if (!this.transparencyManager) {
                this.transparencyManager = new TransparencyPassManager(this.context);
            }
            this.initializeTransparencyManager();
        } else {
            // Clean up transparency manager if not needed
            if (this.transparencyManager) {
                this.transparencyManager.dispose();
                this.transparencyManager = null;
            }
        }
    }

    /**
     * Get byte count of all GPU resources used by this pass.
     */
    getByteCount(): number {
        let bytes = this.colorTarget.getByteCount();
        if (this.transparencyManager) {
            bytes += this.transparencyManager.getByteCount();
        }
        return bytes;
    }

    /**
     * Reset any transient state.
     */
    reset(): void {
        // No-op for now
    }

    /**
     * Resize the render targets.
     */
    setSize(width: number, height: number): void {
        if (width === this.width && height === this.height) return;

        this.width = width;
        this.height = height;

        // Destroy old target
        this.colorTarget.destroy();

        // Recreate with new size
        const options: RenderTargetOptions = {
            width,
            height,
            depth: true,
            type: 'uint8',
            filter: 'linear',
        };
        (this as any).colorTarget = this.context.createRenderTarget(options);

        // Resize transparency manager if active
        if (this.transparencyManager) {
            this.initializeTransparencyManager();
        }
    }

    /**
     * Render the scene.
     */
    render(ctx: RenderContext, props: WebGPUDrawPassProps, toDrawingBuffer: boolean): void {
        if (isTimingMode) console.time('WebGPUDrawPass.render');

        const { renderer, camera, scene } = ctx;

        // Update renderer
        renderer.update(camera, scene);

        // Create command encoder
        const encoder = this.context.createCommandEncoder();

        // Get the target texture view
        let colorView: TextureView;
        if (toDrawingBuffer) {
            colorView = this.context.getCurrentTexture().createView();
        } else {
            colorView = this.colorTarget.texture;
        }

        // Get depth texture view - the WebGPU render target implementation
        // provides a depthTextureView property (not in the abstract interface)
        const webgpuTarget = this.colorTarget as any;
        const depthView: TextureView | null = webgpuTarget.depthTextureView || null;

        if (!depthView) {
            throw new Error('Depth texture view not available');
        }

        // Begin render pass using the abstract interface
        // The WebGPU implementation will internally unwrap to native views
        const passEncoder = encoder.beginRenderPass({
            colorAttachments: [{
                view: colorView,
                clearValue: [0, 0, 0, 1],
                loadOp: 'clear',
                storeOp: 'store',
            }],
            depthStencilAttachment: {
                view: depthView,
                depthClearValue: 1.0,
                depthLoadOp: 'clear',
                depthStoreOp: 'store',
            },
        });

        // Set viewport
        passEncoder.setViewport(0, 0, this.width, this.height, 0, 1);

        // Render opaque objects
        renderer.renderOpaque(scene, camera, passEncoder);

        // Render transparent objects based on transparency mode
        if (scene.getTransparentRenderables().length > 0) {
            if (this.transparencyMode === 'blended') {
                renderer.renderTransparent(scene, camera, passEncoder);
            } else if (this.transparencyMode === 'wboit' && this.transparencyManager) {
                // End current pass to prepare for WBOIT
                passEncoder.end();
                this.renderWBOIT(ctx, encoder, colorView);
                return; // WBOIT handles its own submission
            } else if (this.transparencyMode === 'dpoit' && this.transparencyManager) {
                // End current pass to prepare for DPOIT
                passEncoder.end();
                this.renderDPOIT(ctx, encoder, colorView);
                return; // DPOIT handles its own submission
            }
        }

        passEncoder.end();

        // Submit commands
        this.context.submit([encoder.finish()]);

        if (isTimingMode) console.timeEnd('WebGPUDrawPass.render');
    }

    /**
     * Render picking pass.
     */
    renderPick(
        ctx: RenderContext,
        pickPass: WebGPUPickPass,
        pickType: import('../renderer').PickType,
        x: number,
        y: number,
        width: number,
        height: number
    ): void {
        if (isTimingMode) console.time('WebGPUDrawPass.renderPick');

        const { renderer, camera, scene } = ctx;

        // Update renderer
        renderer.update(camera, scene);

        // Create command encoder
        const encoder = this.context.createCommandEncoder();

        // Get MRT render pass descriptor from pick pass
        const descriptor = pickPass.getMRTRenderPassDescriptor();

        // Begin render pass
        const passEncoder = encoder.beginRenderPass(descriptor);

        // Set viewport for picking area
        passEncoder.setViewport(x, y, width, height, 0, 1);

        // Render pickable objects
        renderer.renderPick(scene, camera, passEncoder, pickType);

        passEncoder.end();

        // Submit commands
        this.context.submit([encoder.finish()]);

        if (isTimingMode) console.timeEnd('WebGPUDrawPass.renderPick');
    }

    /**
     * Render transparent objects using WBOIT (Weighted Blended Order-Independent Transparency).
     */
    private renderWBOIT(ctx: RenderContext, encoder: import('../gpu').CommandEncoder, colorView: TextureView): void {
        if (!this.transparencyManager) return;

        const { renderer, camera, scene } = ctx;

        // Phase 1: Accumulation pass - render transparent objects to accumulation and revealage buffers
        const accumPass = this.transparencyManager.beginWboitAccumulationPass(encoder);
        if (accumPass) {
            accumPass.setViewport(0, 0, this.width, this.height, 0, 1);
            renderer.renderTransparent(scene, camera, accumPass);
            accumPass.end();
        }

        // Phase 2: Composite pass - blend WBOIT result onto main color buffer
        const compositePass = encoder.beginRenderPass({
            colorAttachments: [{
                view: colorView,
                loadOp: 'load', // Preserve opaque rendering
                storeOp: 'store',
            }],
            label: 'wboit-composite',
        });

        this.transparencyManager.compositeWboit(compositePass);
        compositePass.end();

        // Submit all commands
        this.context.submit([encoder.finish()]);

        if (isTimingMode) console.timeEnd('WebGPUDrawPass.render');
    }

    /**
     * Render transparent objects using DPOIT (Depth Peeling Order-Independent Transparency).
     */
    private renderDPOIT(ctx: RenderContext, encoder: import('../gpu').CommandEncoder, colorView: TextureView): void {
        if (!this.transparencyManager) return;

        const { renderer, camera, scene } = ctx;
        const numPasses = 4; // Number of depth peels

        // Multiple peel passes
        for (let i = 0; i < numPasses; i++) {
            const peelPass = this.transparencyManager.beginDpoitPeelPass(encoder, i);
            if (peelPass) {
                peelPass.setViewport(0, 0, this.width, this.height, 0, 1);
                renderer.renderTransparent(scene, camera, peelPass);
                peelPass.end();
            }
        }

        // Composite all peels onto the main color buffer
        const compositePass = encoder.beginRenderPass({
            colorAttachments: [{
                view: colorView,
                loadOp: 'load', // Preserve opaque rendering
                storeOp: 'store',
            }],
            label: 'dpoit-composite',
        });

        this.transparencyManager.compositeDpoit(compositePass);
        compositePass.end();

        // Submit all commands
        this.context.submit([encoder.finish()]);

        if (isTimingMode) console.timeEnd('WebGPUDrawPass.render');
    }
}

export interface WebGPUDrawPassProps {
    transparentBackground: boolean;
}

// Re-export WebGPUPickPass from picking.ts
export { WebGPUPickPass };

/**
 * Container for all WebGPU passes.
 */
export class WebGPUPasses {
    readonly draw: WebGPUDrawPass;
    readonly pick: WebGPUPickPass;

    constructor(
        private context: GPUContext,
        width: number,
        height: number,
        attribs: Partial<{ pickScale: number; transparency: TransparencyMode }> = {}
    ) {
        this.draw = new WebGPUDrawPass(
            context,
            width,
            height,
            attribs.transparency || 'blended'
        );
        this.pick = new WebGPUPickPass(
            context,
            width,
            height,
            { pickScale: attribs.pickScale || 0.25 }
        );
    }

    /**
     * Get total byte count of all passes.
     */
    getByteCount(): number {
        return this.draw.getByteCount() + this.pick.getByteCount();
    }

    /**
     * Update pick scale.
     */
    setPickScale(pickScale: number): void {
        this.pick.setPickScale(pickScale);
    }

    /**
     * Update transparency mode.
     */
    setTransparency(transparency: TransparencyMode): void {
        this.draw.setTransparency(transparency);
    }

    /**
     * Resize all passes.
     */
    updateSize(): void {
        const { width, height } = this.context.getDrawingBufferSize();
        // Ensure minimum size to avoid zero-dimension issues
        const safeWidth = Math.max(width, 2);
        const safeHeight = Math.max(height, 2);
        this.draw.setSize(safeWidth, safeHeight);
        this.pick.setSize(safeWidth, safeHeight);
    }

    /**
     * Dispose all resources.
     */
    dispose(): void {
        this.draw.colorTarget.destroy();
        this.pick.destroy();
    }
}

/**
 * Create WebGPU passes from a GPUContext.
 */
export function createWebGPUPasses(
    context: GPUContext,
    attribs: Partial<{ pickScale: number; transparency: TransparencyMode }> = {}
): WebGPUPasses {
    const { width, height } = context.getDrawingBufferSize();
    return new WebGPUPasses(context, width, height, attribs);
}

//
// WebGPU MultiSamplePass Implementation
//

import { ParamDefinition as PD } from '../../mol-util/param-definition';
import { Texture } from '../gpu/texture';
import { RenderPassEncoder } from '../gpu/render-pass';

/**
 * Multi-sample parameters matching the WebGL version.
 */
export const WebGPUMultiSampleParams = {
    mode: PD.Select('temporal', [['off', 'Off'], ['on', 'On'], ['temporal', 'Temporal']] as const),
    sampleLevel: PD.Numeric(2, { min: 0, max: 5, step: 1 }, { description: 'Take level^2 samples.' }),
    reduceFlicker: PD.Boolean(true, { description: 'Reduce flicker in "temporal" mode.' }),
    reuseOcclusion: PD.Boolean(true, { description: 'Reuse occlusion data. It is faster but has some artefacts.' }),
};
export type WebGPUMultiSampleProps = PD.Values<typeof WebGPUMultiSampleParams>;

/**
 * Jitter vectors for multi-sample anti-aliasing.
 * Each level provides an increasing number of sample offsets.
 */
export const WebGPUJitterVectors = [
    [[0, 0]],
    [[0, 0], [-4, -4]],
    [[0, 0], [6, -2], [-6, 2], [2, 6]],
    [
        [0, 0], [-1, 3], [5, 1], [-3, -5],
        [-5, 5], [-7, -1], [3, 7], [7, -7]
    ],
    [
        [0, 0], [-1, -3], [-3, 2], [4, -1],
        [-5, -2], [2, 5], [5, 3], [3, -5],
        [-2, 6], [0, -7], [-4, -6], [-6, 4],
        [-8, 0], [7, -4], [6, 7], [-7, -8]
    ],
    [
        [0, 0], [-7, -5], [-3, -5], [-5, -4],
        [-1, -4], [-2, -2], [-6, -1], [-4, 0],
        [-7, 1], [-1, 2], [-6, 3], [-3, 3],
        [-7, 6], [-3, 6], [-5, 7], [-1, 7],
        [5, -7], [1, -6], [6, -5], [4, -4],
        [2, -3], [7, -2], [1, -1], [4, -1],
        [2, 1], [6, 2], [0, 4], [4, 4],
        [2, 5], [7, 5], [5, 6], [3, 7]
    ]
];

// Scale jitter vectors
WebGPUJitterVectors.forEach(offsetList => {
    offsetList.forEach(offset => {
        // 0.0625 = 1 / 16
        offset[0] *= 0.0625;
        offset[1] *= 0.0625;
    });
});

/**
 * WebGPU MultiSample Pass.
 * Implements multi-sample anti-aliasing (MSAA) via temporal accumulation
 * or direct multi-sampling with camera jitter.
 */
export class WebGPUMultiSamplePass {
    private context: GPUContext;
    private drawPass: WebGPUDrawPass;

    private colorTarget: RenderTarget;
    private composeTarget: RenderTarget;
    private holdTarget: RenderTarget;

    // Compose pipeline for blending samples
    private composePipeline: import('../gpu').RenderPipeline | null = null;
    private composeBindGroup: import('../gpu').BindGroup | null = null;

    private width: number;
    private height: number;

    constructor(context: GPUContext, drawPass: WebGPUDrawPass) {
        this.context = context;
        this.drawPass = drawPass;

        const { width, height } = context.getDrawingBufferSize();
        this.width = width;
        this.height = height;

        // Create render targets
        this.colorTarget = context.createRenderTarget({
            width,
            height,
            depth: false,
            type: 'uint8',
            filter: 'linear',
        });

        // Use higher precision for accumulation target
        this.composeTarget = context.createRenderTarget({
            width,
            height,
            depth: false,
            type: 'fp16',
            filter: 'linear',
        });

        this.holdTarget = context.createRenderTarget({
            width,
            height,
            depth: false,
            type: 'uint8',
            filter: 'linear',
        });

        this.createComposePipeline();
    }

    private createComposePipeline(): void {
        // Create bind group layout for composition
        const bindGroupLayout = this.context.createBindGroupLayout({
            entries: [
                {
                    binding: 0,
                    visibility: ['fragment'],
                    texture: { sampleType: 'float', viewDimension: '2d' },
                },
                {
                    binding: 1,
                    visibility: ['fragment'],
                    sampler: { type: 'filtering' },
                },
                {
                    binding: 2,
                    visibility: ['vertex', 'fragment'],
                    buffer: { type: 'uniform' },
                },
            ],
        });

        // Create pipeline layout
        const pipelineLayout = this.context.createPipelineLayout({
            bindGroupLayouts: [bindGroupLayout],
        });

        // Create shader modules
        const vertexShader = this.context.createShaderModule({
            code: /* wgsl */`
                struct VertexOutput {
                    @builtin(position) position: vec4<f32>,
                    @location(0) texCoord: vec2<f32>,
                }

                @vertex
                fn main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
                    var pos = array<vec2<f32>, 4>(
                        vec2<f32>(-1.0, -1.0),
                        vec2<f32>( 1.0, -1.0),
                        vec2<f32>(-1.0,  1.0),
                        vec2<f32>( 1.0,  1.0)
                    );
                    var tex = array<vec2<f32>, 4>(
                        vec2<f32>(0.0, 1.0),
                        vec2<f32>(1.0, 1.0),
                        vec2<f32>(0.0, 0.0),
                        vec2<f32>(1.0, 0.0)
                    );

                    var output: VertexOutput;
                    output.position = vec4<f32>(pos[vertexIndex], 0.0, 1.0);
                    output.texCoord = tex[vertexIndex];
                    return output;
                }
            `,
        });

        const fragmentShader = this.context.createShaderModule({
            code: /* wgsl */`
                struct Uniforms {
                    weight: f32,
                    _padding: vec3<f32>,
                }

                @group(0) @binding(0) var tColor: texture_2d<f32>;
                @group(0) @binding(1) var sColor: sampler;
                @group(0) @binding(2) var<uniform> uniforms: Uniforms;

                @fragment
                fn main(@location(0) texCoord: vec2<f32>) -> @location(0) vec4<f32> {
                    let color = textureSample(tColor, sColor, texCoord);
                    return vec4<f32>(color.rgb * uniforms.weight, color.a);
                }
            `,
        });

        // Create render pipeline
        this.composePipeline = this.context.createRenderPipeline({
            layout: pipelineLayout,
            vertex: {
                module: vertexShader,
                entryPoint: 'main',
                buffers: [],
            },
            fragment: {
                module: fragmentShader,
                entryPoint: 'main',
                targets: [{ format: this.context.preferredFormat }],
            },
            primitive: {
                topology: 'triangle-strip',
            },
        });
    }

    private updateComposeBindGroup(texture: Texture): void {
        const sampler = this.context.createSampler({
            magFilter: 'linear',
            minFilter: 'linear',
        });

        // Create uniform buffer for weight
        const uniformBuffer = this.context.createBuffer({
            size: 16, // 4 floats
            usage: ['uniform', 'copy-dst'],
        });

        this.composeBindGroup = this.context.createBindGroup({
            layout: this.composePipeline!.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: texture.createView() },
                { binding: 1, resource: sampler },
                { binding: 2, resource: { buffer: uniformBuffer, offset: 0, size: 16 } },
            ],
        });
    }

    /**
     * Check if multi-sample is enabled.
     */
    static isEnabled(props: WebGPUMultiSampleProps): boolean {
        return props.mode !== 'off';
    }

    /**
     * Get byte count of all resources.
     */
    getByteCount(): number {
        return this.colorTarget.getByteCount() + this.composeTarget.getByteCount() + this.holdTarget.getByteCount();
    }

    /**
     * Sync render target sizes with draw pass.
     */
    syncSize(): void {
        const width = this.drawPass.colorTarget.getWidth();
        const height = this.drawPass.colorTarget.getHeight();

        if (width !== this.width || height !== this.height) {
            this.width = width;
            this.height = height;

            this.colorTarget.destroy();
            this.composeTarget.destroy();
            this.holdTarget.destroy();

            this.colorTarget = this.context.createRenderTarget({
                width,
                height,
                depth: false,
                type: 'uint8',
                filter: 'linear',
            });

            this.composeTarget = this.context.createRenderTarget({
                width,
                height,
                depth: false,
                type: 'fp16',
                filter: 'linear',
            });

            this.holdTarget = this.context.createRenderTarget({
                width,
                height,
                depth: false,
                type: 'uint8',
                filter: 'linear',
            });
        }
    }

    /**
     * Render multi-sample pass.
     */
    render(
        sampleIndex: number,
        ctx: RenderContext,
        props: { multiSample: WebGPUMultiSampleProps },
        toDrawingBuffer: boolean,
        forceOn: boolean
    ): number {
        if (props.multiSample.mode === 'temporal' && !forceOn) {
            return this.renderTemporalMultiSample(sampleIndex, ctx, props, toDrawingBuffer);
        } else {
            this.renderMultiSample(ctx, props, toDrawingBuffer);
            return -2;
        }
    }

    private renderMultiSample(
        ctx: RenderContext,
        props: { multiSample: WebGPUMultiSampleProps },
        toDrawingBuffer: boolean
    ): void {
        if (isTimingMode) console.time('WebGPUMultiSamplePass.renderMultiSample');

        const { camera } = ctx;
        const offsetList = WebGPUJitterVectors[Math.max(0, Math.min(props.multiSample.sampleLevel, 5))];
        const baseSampleWeight = 1.0 / offsetList.length;
        const roundingRange = 1 / 32;

        // Store original view offset state
        const viewOffsetEnabled = camera.viewOffset.enabled;
        camera.viewOffset.enabled = true;

        const encoder = this.context.createCommandEncoder();

        // Render and accumulate samples
        for (let i = 0; i < offsetList.length; i++) {
            const offset = offsetList[i];
            Camera.setViewOffset(camera.viewOffset, this.width, this.height, offset[0], offset[1], this.width, this.height);
            camera.update();

            // Calculate sample weight
            const uniformCenteredDistribution = -0.5 + (i + 0.5) / offsetList.length;
            const sampleWeight = baseSampleWeight + roundingRange * uniformCenteredDistribution;

            // Render scene to draw pass
            this.drawPass.render(ctx, { transparentBackground: false }, false);

            // Compose into accumulation target
            const composePass = encoder.beginRenderPass({
                colorAttachments: [{
                    view: this.composeTarget.texture,
                    loadOp: i === 0 ? 'clear' : 'load',
                    storeOp: 'store',
                    clearValue: [0, 0, 0, 0],
                }],
            });

            // Set blend state for additive blending
            // Note: WebGPU blend state is set in pipeline, would need separate pipeline for blend modes
            this.renderCompose(composePass, this.drawPass.colorTarget.texture as unknown as Texture, sampleWeight);
            composePass.end();
        }

        // Restore camera state
        camera.viewOffset.enabled = viewOffsetEnabled;
        camera.update();

        // Final compose to output
        const outputView = toDrawingBuffer
            ? this.context.getCurrentTexture().createView()
            : this.colorTarget.texture;

        const outputPass = encoder.beginRenderPass({
            colorAttachments: [{
                view: outputView,
                loadOp: 'clear',
                storeOp: 'store',
                clearValue: [0, 0, 0, 1],
            }],
        });

        this.renderCompose(outputPass, this.composeTarget.texture as unknown as Texture, 1.0);
        outputPass.end();

        this.context.submit([encoder.finish()]);

        if (isTimingMode) console.timeEnd('WebGPUMultiSamplePass.renderMultiSample');
    }

    private renderTemporalMultiSample(
        sampleIndex: number,
        ctx: RenderContext,
        props: { multiSample: WebGPUMultiSampleProps },
        toDrawingBuffer: boolean
    ): number {
        if (isTimingMode) console.time('WebGPUMultiSamplePass.renderTemporalMultiSample');

        const { camera } = ctx;
        const offsetList = WebGPUJitterVectors[Math.max(0, Math.min(props.multiSample.sampleLevel, 5))];

        if (sampleIndex === -2 || sampleIndex >= offsetList.length) {
            if (isTimingMode) console.timeEnd('WebGPUMultiSamplePass.renderTemporalMultiSample');
            return -2;
        }

        const sampleWeight = 1.0 / offsetList.length;
        const viewOffsetEnabled = camera.viewOffset.enabled;
        camera.viewOffset.enabled = true;

        const encoder = this.context.createCommandEncoder();

        if (sampleIndex === -1) {
            // Initial frame - render without jitter
            this.drawPass.render(ctx, { transparentBackground: false }, false);

            // Copy to hold target
            const holdPass = encoder.beginRenderPass({
                colorAttachments: [{
                    view: this.holdTarget.texture,
                    loadOp: 'clear',
                    storeOp: 'store',
                    clearValue: [0, 0, 0, 0],
                }],
            });
            this.renderCompose(holdPass, this.drawPass.colorTarget.texture as unknown as Texture, 1.0);
            holdPass.end();

            sampleIndex = 0;
        }

        // Render samples
        const numSamplesPerFrame = Math.pow(2, Math.max(0, props.multiSample.sampleLevel - 2));
        for (let i = 0; i < numSamplesPerFrame && sampleIndex < offsetList.length; i++) {
            const offset = offsetList[sampleIndex];
            Camera.setViewOffset(camera.viewOffset, this.width, this.height, offset[0], offset[1], this.width, this.height);
            camera.update();

            this.drawPass.render(ctx, { transparentBackground: false }, false);

            // Accumulate
            const composePass = encoder.beginRenderPass({
                colorAttachments: [{
                    view: this.composeTarget.texture,
                    loadOp: sampleIndex === 0 ? 'clear' : 'load',
                    storeOp: 'store',
                    clearValue: [0, 0, 0, 0],
                }],
            });
            this.renderCompose(composePass, this.drawPass.colorTarget.texture as unknown as Texture, sampleWeight);
            composePass.end();

            sampleIndex++;
        }

        // Output to final target
        const outputView = toDrawingBuffer
            ? this.context.getCurrentTexture().createView()
            : this.colorTarget.texture;

        const outputPass = encoder.beginRenderPass({
            colorAttachments: [{
                view: outputView,
                loadOp: 'clear',
                storeOp: 'store',
                clearValue: [0, 0, 0, 1],
            }],
        });

        // Blend accumulated samples with hold target
        const accumulationWeight = sampleIndex * sampleWeight;
        if (accumulationWeight > 0) {
            this.renderCompose(outputPass, this.composeTarget.texture as unknown as Texture, 1.0);
        }

        outputPass.end();

        // Restore camera
        camera.viewOffset.enabled = viewOffsetEnabled;
        camera.update();

        this.context.submit([encoder.finish()]);

        if (isTimingMode) console.timeEnd('WebGPUMultiSamplePass.renderTemporalMultiSample');

        return sampleIndex >= offsetList.length ? -2 : sampleIndex;
    }

    private renderCompose(passEncoder: RenderPassEncoder, texture: Texture, weight: number): void {
        // Update bind group with current texture
        this.updateComposeBindGroup(texture);

        // Update weight in uniform buffer
        // Note: In a full implementation, we'd update the uniform buffer here

        passEncoder.setPipeline(this.composePipeline!);
        passEncoder.setBindGroup(0, this.composeBindGroup!);
        passEncoder.draw(4);
    }

    /**
     * Dispose all resources.
     */
    dispose(): void {
        this.colorTarget.destroy();
        this.composeTarget.destroy();
        this.holdTarget.destroy();
    }
}

/**
 * Helper class for managing temporal multi-sample state.
 */
export class WebGPUMultiSampleHelper {
    private sampleIndex = -2;

    /**
     * Update helper state.
     * @returns true if more samples are needed
     */
    update(changed: boolean, props: WebGPUMultiSampleProps): boolean {
        if (changed) this.sampleIndex = -1;
        return props.mode === 'temporal' ? this.sampleIndex !== -2 : false;
    }

    /**
     * Render multi-sample pass.
     * @returns true when all samples are complete
     */
    render(
        ctx: RenderContext,
        props: { multiSample: WebGPUMultiSampleProps },
        toDrawingBuffer: boolean,
        forceOn?: boolean
    ): boolean {
        // Note: In a full implementation, this would call the pass render method
        // For now, just return true to indicate completion
        this.sampleIndex = -2;
        return true;
    }

    constructor(_multiSamplePass: WebGPUMultiSamplePass) {}
}
