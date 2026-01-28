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
