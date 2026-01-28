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
import { WebGPUPostprocessingPass, PostprocessingProps } from './postprocessing';

// Re-export TransparencyMode from pipeline-cache to avoid redefinition
export type { TransparencyMode } from './pipeline-cache';
import type { TransparencyMode } from './pipeline-cache';

export interface RenderContext {
    renderer: WebGPURenderer;
    camera: Camera;
    scene: WebGPUScene;
}

export interface WebGPUDrawPassProps {
    transparentBackground: boolean;
    postprocessing?: PostprocessingProps;
    backgroundColor?: import('../../mol-util/color').Color;
}

/**
 * WebGPU DrawPass implementation.
 * Handles rendering to the main color target with depth buffering.
 * Supports post-processing effects (SSAO, shadows, outlines).
 */
export class WebGPUDrawPass {
    readonly colorTarget: RenderTarget;
    readonly postprocessingTarget: RenderTarget;
    readonly depthTexture: import('../gpu').Texture;

    private width: number;
    private height: number;
    private transparencyMode: TransparencyMode = 'blended';
    private transparencyManager: TransparencyPassManager | null = null;
    private postprocessing: WebGPUPostprocessingPass | null = null;
    private postprocessingEnabled = false;

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

        // Create post-processing target (for final composited output)
        this.postprocessingTarget = context.createRenderTarget({
            width,
            height,
            depth: false,
            type: 'uint8',
            filter: 'linear',
        });

        // Create depth texture reference (for post-processing)
        // Note: WebGPU implementation stores the actual texture separately
        const webgpuTarget = this.colorTarget as any;
        this.depthTexture = (webgpuTarget.depthTexture || webgpuTarget._depthTexture || webgpuTarget.texture) as import('../gpu').Texture;

        // Initialize transparency manager for advanced modes
        if (transparency === 'wboit' || transparency === 'dpoit') {
            this.transparencyManager = new TransparencyPassManager(context);
            this.initializeTransparencyManager();
        }
    }

    /**
     * Enable or disable post-processing.
     */
    setPostprocessingEnabled(enabled: boolean): void {
        this.postprocessingEnabled = enabled;
        if (enabled && !this.postprocessing) {
            this.postprocessing = new WebGPUPostprocessingPass(
                this.context,
                this.width,
                this.height,
                this.colorTarget.texture,
                this.depthTexture
            );
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
        bytes += this.postprocessingTarget.getByteCount();
        if (this.transparencyManager) {
            bytes += this.transparencyManager.getByteCount();
        }
        if (this.postprocessing) {
            bytes += this.postprocessing.getByteCount();
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

        // Destroy old targets
        this.colorTarget.destroy();
        this.postprocessingTarget.destroy();

        // Recreate color target with new size
        const options: RenderTargetOptions = {
            width,
            height,
            depth: true,
            type: 'uint8',
            filter: 'linear',
        };
        (this as any).colorTarget = this.context.createRenderTarget(options);

        // Recreate post-processing target
        (this as any).postprocessingTarget = this.context.createRenderTarget({
            width,
            height,
            depth: false,
            type: 'uint8',
            filter: 'linear',
        });

        // Update depth texture reference
        const webgpuTarget = this.colorTarget as any;
        (this as any).depthTexture = webgpuTarget.depthTexture || webgpuTarget.texture;

        // Resize transparency manager if active
        if (this.transparencyManager) {
            this.initializeTransparencyManager();
        }

        // Resize post-processing if enabled
        if (this.postprocessing) {
            this.postprocessing.setSize(width, height);
        }
    }

    /**
     * Render the scene.
     */
    render(ctx: RenderContext, props: WebGPUDrawPassProps, toDrawingBuffer: boolean): void {
        if (isTimingMode) console.time('WebGPUDrawPass.render');

        const { renderer, camera, scene } = ctx;
        const postprocessingEnabled = this.postprocessingEnabled && 
            this.postprocessing && 
            props.postprocessing && 
            WebGPUPostprocessingPass.isEnabled(props.postprocessing);

        // Update renderer
        renderer.update(camera, scene);

        // Update post-processing if enabled
        if (postprocessingEnabled && this.postprocessing && props.postprocessing) {
            this.postprocessing.update(camera, scene, props.postprocessing);
        }

        // Create command encoder
        const encoder = this.context.createCommandEncoder();

        // Determine render target based on post-processing
        const targetForScene = postprocessingEnabled ? this.colorTarget.texture : 
            (toDrawingBuffer ? this.context.getCurrentTexture().createView() : this.colorTarget.texture);

        // Get depth texture view
        const webgpuTarget = this.colorTarget as any;
        const depthView: TextureView | null = webgpuTarget.depthTextureView || null;

        if (!depthView) {
            throw new Error('Depth texture view not available');
        }

        // Begin render pass for scene rendering
        const passEncoder = encoder.beginRenderPass({
            colorAttachments: [{
                view: targetForScene,
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
                this.renderWBOIT(ctx, encoder, targetForScene);
                
                // Apply post-processing after WBOIT if enabled
                if (postprocessingEnabled && this.postprocessing && props.postprocessing) {
                    const bgColor = props.backgroundColor !== undefined 
                        ? (typeof props.backgroundColor === 'number' ? props.backgroundColor : 0x000000)
                        : 0x000000;
                    this.postprocessing.render(encoder, camera, scene, props.postprocessing, bgColor as import('../../mol-util/color').Color);
                }
                
                this.context.submit([encoder.finish()]);
                if (isTimingMode) console.timeEnd('WebGPUDrawPass.render');
                return;
            } else if (this.transparencyMode === 'dpoit' && this.transparencyManager) {
                // End current pass to prepare for DPOIT
                passEncoder.end();
                this.renderDPOIT(ctx, encoder, targetForScene);
                
                // Apply post-processing after DPOIT if enabled
                if (postprocessingEnabled && this.postprocessing && props.postprocessing) {
                    const bgColor = props.backgroundColor !== undefined 
                        ? (typeof props.backgroundColor === 'number' ? props.backgroundColor : 0x000000)
                        : 0x000000;
                    this.postprocessing.render(encoder, camera, scene, props.postprocessing, bgColor as import('../../mol-util/color').Color);
                }
                
                this.context.submit([encoder.finish()]);
                if (isTimingMode) console.timeEnd('WebGPUDrawPass.render');
                return;
            }
        }

        passEncoder.end();

        // Apply post-processing if enabled
        if (postprocessingEnabled && this.postprocessing && props.postprocessing) {
            const bgColor = props.backgroundColor !== undefined 
                ? (typeof props.backgroundColor === 'number' ? props.backgroundColor : 0x000000)
                : 0x000000;
            this.postprocessing.render(encoder, camera, scene, props.postprocessing, bgColor as import('../../mol-util/color').Color);
        }

        // Submit commands
        this.context.submit([encoder.finish()]);

        if (isTimingMode) console.timeEnd('WebGPUDrawPass.render');
    }

    /**
     * Blit texture to target (drawing buffer or color target).
     */


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
import type { Texture } from '../gpu';

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

    private updateComposeBindGroup(texture: Texture | import('../gpu').TextureView): void {
        const sampler = this.context.createSampler({
            magFilter: 'linear',
            minFilter: 'linear',
        });

        // Create uniform buffer for weight
        const uniformBuffer = this.context.createBuffer({
            size: 16, // 4 floats
            usage: ['uniform', 'copy-dst'],
        });

        // Helper to get texture view from Texture or TextureView
        const getView = (tex: Texture | import('../gpu').TextureView): import('../gpu').TextureView => {
            return 'createView' in tex ? (tex as Texture).createView() : (tex as import('../gpu').TextureView);
        };

        this.composeBindGroup = this.context.createBindGroup({
            layout: this.composePipeline!.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: getView(texture) },
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

        // Render samples with jitter
        for (let i = 0; i < offsetList.length; i++) {
            const offset = offsetList[i];
            const sampleWeight = baseSampleWeight;

            // Apply jitter to camera
            Camera.setViewOffset(
                camera.viewOffset,
                this.width, this.height,
                offset[0] * roundingRange, offset[1] * roundingRange,
                this.width, this.height
            );

            // Render scene to color target
            const isFirstSample = i === 0;
            const isLastSample = i === offsetList.length - 1;
            
            // Accumulate samples
            if (isFirstSample) {
                // First sample: clear and render
                this.drawPass.render(ctx, { transparentBackground: false }, false);
            } else {
                // Subsequent samples: add to accumulation
                // Render to a temporary target and composite
                // For now, just render directly (simplified)
                this.drawPass.render(ctx, { transparentBackground: false }, false);
            }

            // Update uniform buffer with sample weight
            const uniformBuffer = this.context.createBuffer({
                size: 16,
                usage: ['uniform', 'copy-dst'],
            });
            uniformBuffer.write(new Float32Array([sampleWeight, 0, 0, 0]));

            // Compose into accumulation target
            const encoder = this.context.createCommandEncoder();
            const pass = encoder.beginRenderPass({
                colorAttachments: [{
                    view: this.composeTarget.texture,
                    loadOp: isFirstSample ? 'clear' : 'load',
                    storeOp: 'store',
                    clearValue: [0, 0, 0, 0],
                }],
            });

            // Update bind group with current weight
            this.updateComposeBindGroup(this.drawPass.colorTarget.texture as any);

            pass.setPipeline(this.composePipeline!);
            pass.setBindGroup(0, this.composeBindGroup!);
            pass.draw(4);
            pass.end();

            this.context.submit([encoder.finish()]);

            if (isLastSample && toDrawingBuffer) {
                // Copy final result to drawing buffer
                const finalEncoder = this.context.createCommandEncoder();
                // Use copyTextureToTexture or render a final quad
                finalEncoder.copyTextureToTexture(
                    { texture: this.composeTarget.texture as any },
                    { texture: this.context.getCurrentTexture() as any },
                    [this.width, this.height, 1]
                );
                this.context.submit([finalEncoder.finish()]);
            }
        }

        // Restore camera state
        camera.viewOffset.enabled = viewOffsetEnabled;
        camera.update();

        if (isTimingMode) console.timeEnd('WebGPUMultiSamplePass.renderMultiSample');
    }

    private renderTemporalMultiSample(
        sampleIndex: number,
        ctx: RenderContext,
        props: { multiSample: WebGPUMultiSampleProps },
        toDrawingBuffer: boolean
    ): number {
        if (isTimingMode) console.time('WebGPUMultiSamplePass.renderTemporal');

        const { camera } = ctx;
        const offsetList = WebGPUJitterVectors[Math.max(0, Math.min(props.multiSample.sampleLevel, 5))];
        const sampleCount = offsetList.length;
        const index = Math.abs(sampleIndex) % sampleCount;
        const offset = offsetList[index];

        // Store original view offset state
        const viewOffsetEnabled = camera.viewOffset.enabled;
        camera.viewOffset.enabled = true;

        // Apply jitter
        Camera.setViewOffset(
            camera.viewOffset,
            this.width, this.height,
            offset[0], offset[1],
            this.width, this.height
        );

        // Render scene
        this.drawPass.render(ctx, { transparentBackground: false }, false);

        // Temporal accumulation: blend with previous frame
        const encoder = this.context.createCommandEncoder();
        
        // Compose current frame with hold target
        const compositePass = encoder.beginRenderPass({
            colorAttachments: [{
                view: this.colorTarget.texture,
                loadOp: 'clear',
                storeOp: 'store',
                clearValue: [0, 0, 0, 0],
            }],
        });

        // Blend factor for temporal accumulation
        const blendFactor = 1.0 / sampleCount;
        const uniformBuffer = this.context.createBuffer({
            size: 16,
            usage: ['uniform', 'copy-dst'],
        });
        uniformBuffer.write(new Float32Array([blendFactor, 0, 0, 0]));

        this.updateComposeBindGroup(this.drawPass.colorTarget.texture as any);

        compositePass.setPipeline(this.composePipeline!);
        compositePass.setBindGroup(0, this.composeBindGroup!);
        compositePass.draw(4);
        compositePass.end();

        // Copy to hold target for next frame
        encoder.copyTextureToTexture(
            { texture: this.colorTarget.texture as any },
            { texture: this.holdTarget.texture as any },
            [this.width, this.height, 1]
        );

        // Copy to drawing buffer if needed
        if (toDrawingBuffer) {
            encoder.copyTextureToTexture(
                { texture: this.colorTarget.texture as any },
                { texture: this.context.getCurrentTexture() as any },
                [this.width, this.height, 1]
            );
        }

        this.context.submit([encoder.finish()]);

        // Restore camera state
        camera.viewOffset.enabled = viewOffsetEnabled;
        camera.update();

        if (isTimingMode) console.timeEnd('WebGPUMultiSamplePass.renderTemporal');

        // Return next sample index
        return sampleIndex + 1;
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

    constructor(_multiSamplePass: WebGPUMultiSamplePass) {}

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
        void ctx;
        void props;
        void toDrawingBuffer;
        void forceOn;
        this.sampleIndex = -2;
        return true;
    }
}

//
// WebGPU ImagePass Implementation
//

import { RuntimeContext } from '../../mol-task';
import { PixelData } from '../../mol-util/image';
import { Viewport } from '../../mol-canvas3d/camera/util';
import { CameraHelper, CameraHelperParams } from '../../mol-canvas3d/helper/camera-helper';
import { AssetManager } from '../../mol-util/assets';

/**
 * Parameters for image rendering.
 * Simplified version for WebGPU - only includes supported features.
 */
export const WebGPUImageParams = {
    transparentBackground: PD.Boolean(false),
    cameraHelper: PD.Group(CameraHelperParams),
};
export type WebGPUImageProps = PD.Values<typeof WebGPUImageParams>;

/**
 * WebGPU ImagePass implementation for off-screen image rendering.
 * Renders the scene to a render target and provides pixel data extraction.
 */
export class WebGPUImagePass {
    private _width = 0;
    private _height = 0;
    private _camera: Camera;

    readonly props: WebGPUImageProps;

    private _colorTarget: RenderTarget;
    get colorTarget() { return this._colorTarget; }

    private readonly drawPass: WebGPUDrawPass;
    private readonly helper: { camera: CameraHelper };

    get width() { return this._width; }
    get height() { return this._height; }

    constructor(
        private context: GPUContext,
        _assetManager: AssetManager,
        private renderer: WebGPURenderer,
        private scene: WebGPUScene,
        private camera: Camera,
        helper: { camera: CameraHelper; debug: any; handle: any; pointer: any },
        props: Partial<WebGPUImageProps>
    ) {
        this.props = { ...PD.getDefaultValues(WebGPUImageParams), ...props };
        this._camera = new Camera();

        // Create draw pass with default transparency (blended)
        // Note: WebGPUScene doesn't have transparency property like WebGL Scene
        this.drawPass = new WebGPUDrawPass(context, 128, 128, 'blended');

        this.helper = {
            camera: new CameraHelper(context as any, this.props.cameraHelper),
        };

        this._colorTarget = this.drawPass.colorTarget;

        this.setSize(1024, 768);
    }

    getByteCount(): number {
        return this.drawPass.getByteCount();
    }

    setSize(width: number, height: number): void {
        if (width === this._width && height === this._height) return;

        this._width = width;
        this._height = height;

        this.drawPass.setSize(width, height);
        this._colorTarget = this.drawPass.colorTarget;
    }

    setProps(props: Partial<WebGPUImageProps> = {}): void {
        Object.assign(this.props, props);
        if (props.cameraHelper) this.helper.camera.setProps(props.cameraHelper);
    }

    async render(_runtime: RuntimeContext): Promise<void> {
        // Copy camera state using setState method
        this._camera.setState(this.camera.getSnapshot(), 0);
        Viewport.set(this._camera.viewport, 0, 0, this._width, this._height);
        this._camera.update();

        const ctx: RenderContext = {
            renderer: this.renderer,
            camera: this._camera,
            scene: this.scene,
        };

        // Simple render without multi-sample or post-processing for now
        this.drawPass.render(ctx, { transparentBackground: this.props.transparentBackground }, false);
        this._colorTarget = this.drawPass.colorTarget;
    }

    async getImageData(_runtime: RuntimeContext, width: number, height: number, viewport?: Viewport): Promise<ImageData> {
        this.setSize(width, height);
        await this.render({ update: async () => {} } as RuntimeContext);

        const w = viewport?.width ?? width;
        const h = viewport?.height ?? height;

        // Read pixels from render target using WebGPU readPixelsAsync
        if (!this.context.readPixelsAsync) {
            throw new Error('readPixelsAsync is not supported by this GPU context');
        }

        let array: Uint8Array;
        // Access the underlying texture from the TextureView (WebGPUTextureView has a .texture property)
        const textureView = this._colorTarget.texture as any;
        const texture = textureView.texture;
        if (!viewport) {
            array = await this.context.readPixelsAsync(texture, 0, 0, w, h);
        } else {
            array = await this.context.readPixelsAsync(texture, viewport.x, height - viewport.y - viewport.height, w, h);
        }

        const pixelData = PixelData.create(array, w, h);
        PixelData.flipY(pixelData);
        PixelData.divideByAlpha(pixelData);
        return new ImageData(new Uint8ClampedArray(array), w, h);
    }

    dispose(): void {
        this.drawPass.colorTarget.destroy();
    }
}

/**
 * Helper function to create a WebGPUImagePass.
 */
export function createWebGPUImagePass(
    context: GPUContext,
    assetManager: AssetManager,
    renderer: WebGPURenderer,
    scene: WebGPUScene,
    camera: Camera,
    helper: { camera: CameraHelper; debug: any; handle: any; pointer: any },
    props: Partial<WebGPUImageProps> = {}
): WebGPUImagePass {
    return new WebGPUImagePass(context, assetManager, renderer, scene, camera, helper, props);
}
