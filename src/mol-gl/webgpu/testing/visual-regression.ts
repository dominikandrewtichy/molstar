/**
 * Copyright (c) 2025-2026 mol* contributors, licensed under MIT, See LICENSE file for more info.
 *
 * @author Alexander Rose <alexander.rose@weirdbyte.de>
 *
 * Visual regression testing framework for WebGPU migration.
 * Compares rendering output between WebGL and WebGPU backends.
 */

import { GPUContext } from '../../gpu/context';
import { createWebGLAdapterContext } from '../../webgl/context-adapter';
import { createWebGPUContext } from '../context';

export interface VisualTestConfig {
    name: string;
    width: number;
    height: number;
}

export interface VisualTestResult {
    name: string;
    passed: boolean;
    webglTime: number;
    webgpuTime: number;
    pixelDiffCount: number;
    pixelDiffPercentage: number;
    error?: string;
}

export interface ComparisonOptions {
    /** Threshold for pixel difference (0-1) */
    threshold?: number;
    /** Maximum allowed pixel difference percentage */
    maxDiffPercentage?: number;
    /** Whether to ignore alpha differences */
    ignoreAlpha?: boolean;
}

const defaultOptions: Required<ComparisonOptions> = {
    threshold: 0.01,
    maxDiffPercentage: 1.0,
    ignoreAlpha: false,
};

/**
 * Visual regression test suite for WebGPU migration.
 */
export class VisualRegressionTester {
    private webglCanvas: HTMLCanvasElement | null = null;
    private webgpuCanvas: HTMLCanvasElement | null = null;
    private webglContext: GPUContext | null = null;
    private webgpuContext: GPUContext | null = null;

    /**
     * Initialize the tester with canvas elements.
     */
    async initialize(width: number, height: number): Promise<boolean> {
        // Create canvases
        this.webglCanvas = document.createElement('canvas');
        this.webglCanvas.width = width;
        this.webglCanvas.height = height;

        this.webgpuCanvas = document.createElement('canvas');
        this.webgpuCanvas.width = width;
        this.webgpuCanvas.height = height;

        // Initialize WebGL context
        try {
            this.webglContext = createWebGLAdapterContext({
                canvas: this.webglCanvas,
                pixelScale: 1,
            });
        } catch (error) {
            console.error('Failed to create WebGL context:', error);
            return false;
        }

        // Initialize WebGPU context
        try {
            this.webgpuContext = await createWebGPUContext({
                canvas: this.webgpuCanvas,
                pixelScale: 1,
                preferredBackend: 'webgpu',
            });
        } catch (error) {
            console.error('Failed to create WebGPU context:', error);
            return false;
        }

        return true;
    }

    /**
     * Run a visual comparison test between WebGL and WebGPU.
     */
    async runTest(
        config: VisualTestConfig,
        renderFn: (context: GPUContext, canvas: HTMLCanvasElement) => Promise<void>
    ): Promise<VisualTestResult> {
        if (!this.webglContext || !this.webgpuContext || !this.webglCanvas || !this.webgpuCanvas) {
            return {
                name: config.name,
                passed: false,
                webglTime: 0,
                webgpuTime: 0,
                pixelDiffCount: 0,
                pixelDiffPercentage: 0,
                error: 'Tester not initialized',
            };
        }

        // Resize canvases if needed
        if (this.webglCanvas.width !== config.width || this.webglCanvas.height !== config.height) {
            this.webglCanvas.width = config.width;
            this.webglCanvas.height = config.height;
            this.webgpuCanvas.width = config.width;
            this.webgpuCanvas.height = config.height;
        }

        // Render with WebGL
        const webglStart = performance.now();
        try {
            await renderFn(this.webglContext, this.webglCanvas);
            await this.webglContext.waitForGpuCommandsComplete();
        } catch (error) {
            return {
                name: config.name,
                passed: false,
                webglTime: 0,
                webgpuTime: 0,
                pixelDiffCount: 0,
                pixelDiffPercentage: 0,
                error: `WebGL render failed: ${error}`,
            };
        }
        const webglTime = performance.now() - webglStart;

        // Render with WebGPU
        const webgpuStart = performance.now();
        try {
            await renderFn(this.webgpuContext, this.webgpuCanvas);
            await this.webgpuContext.waitForGpuCommandsComplete();
        } catch (error) {
            return {
                name: config.name,
                passed: false,
                webglTime,
                webgpuTime: 0,
                pixelDiffCount: 0,
                pixelDiffPercentage: 0,
                error: `WebGPU render failed: ${error}`,
            };
        }
        const webgpuTime = performance.now() - webgpuStart;

        // Compare images
        const comparison = this.compareCanvases(this.webglCanvas, this.webgpuCanvas);

        return {
            name: config.name,
            passed: comparison.passed,
            webglTime,
            webgpuTime,
            pixelDiffCount: comparison.diffCount,
            pixelDiffPercentage: comparison.diffPercentage,
        };
    }

    /**
     * Compare two canvas elements pixel by pixel.
     */
    private compareCanvases(
        canvas1: HTMLCanvasElement,
        canvas2: HTMLCanvasElement,
        options: ComparisonOptions = {}
    ): { passed: boolean; diffCount: number; diffPercentage: number } {
        const opts = { ...defaultOptions, ...options };

        const ctx1 = canvas1.getContext('2d');
        const ctx2 = canvas2.getContext('2d');

        if (!ctx1 || !ctx2) {
            return { passed: false, diffCount: Infinity, diffPercentage: 100 };
        }

        const width = canvas1.width;
        const height = canvas1.height;

        const imageData1 = ctx1.getImageData(0, 0, width, height);
        const imageData2 = ctx2.getImageData(0, 0, width, height);

        const data1 = imageData1.data;
        const data2 = imageData2.data;

        let diffCount = 0;
        const totalPixels = width * height;

        for (let i = 0; i < data1.length; i += 4) {
            const r1 = data1[i];
            const g1 = data1[i + 1];
            const b1 = data1[i + 2];
            const a1 = data1[i + 3];

            const r2 = data2[i];
            const g2 = data2[i + 1];
            const b2 = data2[i + 2];
            const a2 = data2[i + 3];

            // Calculate difference
            const rDiff = Math.abs(r1 - r2) / 255;
            const gDiff = Math.abs(g1 - g2) / 255;
            const bDiff = Math.abs(b1 - b2) / 255;
            const aDiff = opts.ignoreAlpha ? 0 : Math.abs(a1 - a2) / 255;

            const maxDiff = Math.max(rDiff, gDiff, bDiff, aDiff);

            if (maxDiff > opts.threshold) {
                diffCount++;
            }
        }

        const diffPercentage = (diffCount / totalPixels) * 100;
        const passed = diffPercentage <= opts.maxDiffPercentage;

        return { passed, diffCount, diffPercentage };
    }

    /**
     * Dispose all resources.
     */
    dispose(): void {
        this.webglContext?.destroy();
        this.webgpuContext?.destroy();
        this.webglCanvas = null;
        this.webgpuCanvas = null;
        this.webglContext = null;
        this.webgpuContext = null;
    }
}

/**
 * Run a suite of visual regression tests.
 */
export async function runVisualRegressionSuite(
    tests: VisualTestConfig[],
    renderFn: (context: GPUContext, canvas: HTMLCanvasElement, config: VisualTestConfig) => Promise<void>
): Promise<VisualTestResult[]> {
    const tester = new VisualRegressionTester();
    const results: VisualTestResult[] = [];

    // Find max dimensions
    const maxWidth = Math.max(...tests.map(t => t.width));
    const maxHeight = Math.max(...tests.map(t => t.height));

    if (!await tester.initialize(maxWidth, maxHeight)) {
        return tests.map(t => ({
            name: t.name,
            passed: false,
            webglTime: 0,
            webgpuTime: 0,
            pixelDiffCount: 0,
            pixelDiffPercentage: 0,
            error: 'Failed to initialize tester',
        }));
    }

    try {
        for (const test of tests) {
            const result = await tester.runTest(test, (ctx, canvas) => renderFn(ctx, canvas, test));
            results.push(result);
        }
    } finally {
        tester.dispose();
    }

    return results;
}

/**
 * Format test results for display.
 */
export function formatTestResults(results: VisualTestResult[]): string {
    const passed = results.filter(r => r.passed).length;
    const total = results.length;

    let output = `\nVisual Regression Test Results: ${passed}/${total} passed\n`;
    output += '='.repeat(60) + '\n\n';

    for (const result of results) {
        const status = result.passed ? '✅ PASS' : '❌ FAIL';
        output += `${status}: ${result.name}\n`;

        if (result.error) {
            output += `  Error: ${result.error}\n`;
        } else {
            output += `  WebGL: ${result.webglTime.toFixed(2)}ms, WebGPU: ${result.webgpuTime.toFixed(2)}ms\n`;
            output += `  Pixel diff: ${result.pixelDiffCount} (${result.pixelDiffPercentage.toFixed(2)}%)\n`;
        }
        output += '\n';
    }

    return output;
}
