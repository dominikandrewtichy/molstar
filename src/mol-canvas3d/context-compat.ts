/**
 * Copyright (c) 2025 mol* contributors, licensed under MIT, See LICENSE file for more info.
 *
 * @author Alexander Rose <alexander.rose@weirdbyte.de>
 */

/**
 * This module provides compatibility utilities for using the new GPUContext
 * abstraction layer with the existing Canvas3D infrastructure.
 *
 * During the migration from WebGLContext to GPUContext, this module bridges
 * the gap by providing:
 * 1. Factory functions that create GPUContext-backed Canvas3D contexts
 * 2. Type guards for determining which context type is in use
 * 3. Utilities for accessing the underlying WebGLContext when needed
 */

import { GPUContext, GPUBackend, isWebGLBackedContext } from '../mol-gl/gpu/context';
import { createGPUContext } from '../mol-gl/gpu/context-factory';
import { WebGLContext, createContext as createWebGLContext, getGLContext } from '../mol-gl/webgl/context';
import { AssetManager } from '../mol-util/assets';
import { InputObserver } from '../mol-util/input/input-observer';
import { Passes } from './passes/passes';
import { isDebugMode } from '../mol-util/debug';
import { isMobileBrowser } from '../mol-util/browser';
import { Subject, BehaviorSubject } from 'rxjs';
import { now } from '../mol-util/now';

/**
 * Extended Canvas3D context that supports both GPUContext and WebGLContext.
 */
export interface Canvas3DContextCompat {
    readonly canvas?: HTMLCanvasElement;
    readonly webgl: WebGLContext;
    readonly gpu: GPUContext;
    readonly input: InputObserver;
    readonly passes: Passes;
    readonly attribs: Readonly<Canvas3DContextCompatAttribs>;
    readonly props: Readonly<Canvas3DContextCompatProps>;
    readonly contextLost?: Subject<now.Timestamp>;
    readonly contextRestored?: Subject<now.Timestamp>;
    readonly assetManager: AssetManager;
    readonly changed?: BehaviorSubject<undefined>;
    readonly pixelScale: number;
    readonly backend: GPUBackend;

    syncPixelScale(): void;
    setProps: (props?: Partial<Canvas3DContextCompatProps>) => void;
    dispose: (options?: Partial<{ doNotForceWebGLContextLoss: boolean }>) => void;
}

export interface Canvas3DContextCompatAttribs {
    powerPreference: WebGLContextAttributes['powerPreference'];
    failIfMajorPerformanceCaveat: boolean;
    antialias: boolean;
    preserveDrawingBuffer: boolean;
    preferWebGl1: boolean;
    handleResize: () => void;
    /** Preferred GPU backend */
    preferredBackend?: GPUBackend | 'auto';
}

export const DefaultCanvas3DContextCompatAttribs: Canvas3DContextCompatAttribs = {
    powerPreference: 'high-performance',
    failIfMajorPerformanceCaveat: false,
    antialias: true,
    preserveDrawingBuffer: true,
    preferWebGl1: false,
    handleResize: () => {},
    preferredBackend: 'auto',
};

export interface Canvas3DContextCompatProps {
    resolutionMode: 'auto' | 'scaled' | 'native';
    pixelScale: number;
    pickScale: number;
    transparency: 'wboit' | 'dpoit' | 'blended';
}

export const DefaultCanvas3DContextCompatProps: Canvas3DContextCompatProps = {
    resolutionMode: 'auto',
    pixelScale: 1,
    pickScale: 0.25,
    transparency: 'wboit',
};

/**
 * Create a Canvas3D context with automatic GPU backend selection.
 * Uses GPUContext abstraction layer but maintains backward compatibility
 * with existing Canvas3D infrastructure via the WebGLContext.
 */
export async function createCanvas3DContextCompat(
    canvas: HTMLCanvasElement,
    assetManager: AssetManager,
    attribs: Partial<Canvas3DContextCompatAttribs> = {},
    props: Partial<Canvas3DContextCompatProps> = {}
): Promise<Canvas3DContextCompat> {
    const a = { ...DefaultCanvas3DContextCompatAttribs, ...attribs };
    const p = { ...DefaultCanvas3DContextCompatProps, ...props };

    // Create GPUContext using the factory
    const { context: gpu, backend } = await createGPUContext(
        {
            canvas,
            pixelScale: p.pixelScale,
            preferredBackend: a.preferredBackend,
        },
        {
            webgl: {
                contextAttributes: {
                    powerPreference: a.powerPreference,
                    failIfMajorPerformanceCaveat: a.failIfMajorPerformanceCaveat,
                    antialias: a.antialias,
                    preserveDrawingBuffer: a.preserveDrawingBuffer,
                    alpha: true,
                    depth: true,
                    premultipliedAlpha: true,
                },
                preferWebGl1: a.preferWebGl1,
            },
            webgpu: {
                powerPreference: a.powerPreference === 'high-performance' ? 'high-performance' : 'low-power',
            },
        }
    );

    // Get WebGLContext for backward compatibility
    let webgl: WebGLContext;
    if (isWebGLBackedContext(gpu)) {
        // WebGL backend - use the underlying WebGLContext
        webgl = gpu.getWebGLContext();
    } else {
        // WebGPU backend - still need a WebGLContext for the Passes system
        // This is a temporary solution during migration
        // Eventually, Passes will be updated to use GPUContext directly
        const gl = getGLContext(canvas, {
            powerPreference: a.powerPreference,
            failIfMajorPerformanceCaveat: a.failIfMajorPerformanceCaveat,
            antialias: a.antialias,
            preserveDrawingBuffer: a.preserveDrawingBuffer,
            alpha: true,
            depth: true,
            premultipliedAlpha: true,
            preferWebGl1: a.preferWebGl1,
        });
        if (!gl) {
            throw new Error('Could not create WebGL context for backward compatibility');
        }
        webgl = createWebGLContext(gl, { pixelScale: p.pixelScale });
    }

    // Pixel scale handling
    const getPixelScale = () => {
        const scaled = (p.pixelScale / (typeof window !== 'undefined' ? (window?.devicePixelRatio || 1) : 1));
        if (p.resolutionMode === 'auto') {
            return isMobileBrowser() ? scaled : p.pixelScale;
        }
        return p.resolutionMode === 'native' ? p.pixelScale : scaled;
    };

    const syncPixelScale = () => {
        const pixelScale = getPixelScale();
        input.setPixelScale(pixelScale);
        webgl.setPixelScale(pixelScale);
        gpu.setPixelScale(pixelScale);
    };

    const { pickScale, transparency } = p;
    const pixelScale = getPixelScale();
    const input = InputObserver.fromElement(canvas, { pixelScale, preventGestures: true });
    const passes = new Passes(webgl, assetManager, { pickScale, transparency });

    // Context loss handling
    const contextLost = new Subject<now.Timestamp>();

    if (backend === 'webgl') {
        // WebGL context loss handling
        const handleWebglContextLost = (e: Event) => {
            webgl.setContextLost();
            gpu.setContextLost();
            e.preventDefault();
            if (isDebugMode) console.log('context lost');
            contextLost.next(now());
        };

        const handleWebglContextRestored = () => {
            if (!webgl.isContextLost) return;
            webgl.handleContextRestored(() => {
                passes.draw.reset();
                passes.pick.reset();
                passes.illumination.reset();
            });
            gpu.handleContextRestored();
            if (isDebugMode) console.log('context restored');
        };

        canvas.addEventListener('webglcontextlost', handleWebglContextLost, false);
        canvas.addEventListener('webglcontextrestored', handleWebglContextRestored, false);
    }

    const changed = new BehaviorSubject<undefined>(undefined);

    return {
        canvas,
        webgl,
        gpu,
        input,
        passes,
        attribs: a,
        get props() { return { ...p }; },
        contextLost,
        contextRestored: webgl.contextRestored,
        assetManager,
        changed,
        get pixelScale() { return getPixelScale(); },
        backend,

        syncPixelScale,
        setProps: (props?: Partial<Canvas3DContextCompatProps>) => {
            if (!props) return;

            let hasChanged = false;
            let pixelScaleNeedsUpdate = false;

            if (props.resolutionMode !== undefined && props.resolutionMode !== p.resolutionMode) {
                p.resolutionMode = props.resolutionMode;
                pixelScaleNeedsUpdate = true;
            }

            if (props.pixelScale !== undefined && props.pixelScale !== p.pixelScale) {
                p.pixelScale = props.pixelScale;
                pixelScaleNeedsUpdate = true;
            }

            if (pixelScaleNeedsUpdate) {
                syncPixelScale();
                a.handleResize();
                hasChanged = true;
            }

            if (props.pickScale !== undefined && props.pickScale !== p.pickScale) {
                p.pickScale = props.pickScale;
                passes.setPickScale(props.pickScale);
                hasChanged = true;
            }

            if (props.transparency !== undefined && props.transparency !== p.transparency) {
                p.transparency = props.transparency;
                passes.setTransparency(props.transparency);
                hasChanged = true;
            }

            if (hasChanged) {
                changed.next(undefined);
            }
        },
        dispose: (options?: Partial<{ doNotForceWebGLContextLoss: boolean }>) => {
            input.dispose();
            gpu.destroy();
            webgl.destroy(options);
            contextLost.complete();
            changed.complete();
        },
    };
}

/**
 * Check if a Canvas3D context is using the WebGL backend.
 */
export function isWebGLBackend(ctx: Canvas3DContextCompat): boolean {
    return ctx.backend === 'webgl';
}

/**
 * Check if a Canvas3D context is using the WebGPU backend.
 */
export function isWebGPUBackend(ctx: Canvas3DContextCompat): boolean {
    return ctx.backend === 'webgpu';
}
