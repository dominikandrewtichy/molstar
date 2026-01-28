/**
 * Copyright (c) 2025-2026 mol* contributors, licensed under MIT, See LICENSE file for more info.
 *
 * @author Alexander Rose <alexander.rose@weirdbyte.de>
 *
 * Performance benchmark framework for WebGPU migration.
 * Compares rendering performance between WebGL and WebGPU backends.
 */

import { GPUContext } from '../../gpu/context';
import { createWebGLAdapterContext } from '../../webgl/context-adapter';
import { createWebGPUContext } from '../context';

export interface BenchmarkConfig {
    name: string;
    width: number;
    height: number;
    warmupFrames?: number;
    benchmarkFrames?: number;
}

export interface BenchmarkResult {
    name: string;
    webgl: BackendResult;
    webgpu: BackendResult;
    speedup: number;
}

export interface BackendResult {
    avgFrameTime: number;
    minFrameTime: number;
    maxFrameTime: number;
    stdDeviation: number;
    fps: number;
    memoryMB?: number;
}

/**
 * Performance benchmark runner for comparing WebGL and WebGPU.
 */
export class PerformanceBenchmark {
    private webglCanvas: HTMLCanvasElement | null = null;
    private webgpuCanvas: HTMLCanvasElement | null = null;
    private webglContext: GPUContext | null = null;
    private webgpuContext: GPUContext | null = null;

    /**
     * Initialize the benchmark with canvas elements.
     */
    async initialize(width: number, height: number): Promise<boolean> {
        this.webglCanvas = document.createElement('canvas');
        this.webglCanvas.width = width;
        this.webglCanvas.height = height;

        this.webgpuCanvas = document.createElement('canvas');
        this.webgpuCanvas.width = width;
        this.webgpuCanvas.height = height;

        try {
            this.webglContext = createWebGLAdapterContext({
                canvas: this.webglCanvas,
                pixelScale: 1,
            });
        } catch (error) {
            console.error('Failed to create WebGL context:', error);
            return false;
        }

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
     * Run a performance benchmark comparing WebGL and WebGPU.
     */
    async runBenchmark(
        config: BenchmarkConfig,
        renderFn: (context: GPUContext, frameIndex: number) => Promise<void>
    ): Promise<BenchmarkResult> {
        const warmupFrames = config.warmupFrames ?? 10;
        const benchmarkFrames = config.benchmarkFrames ?? 100;

        // Benchmark WebGL
        const webglResult = await this.benchmarkBackend(
            this.webglContext!,
            renderFn,
            warmupFrames,
            benchmarkFrames
        );

        // Benchmark WebGPU
        const webgpuResult = await this.benchmarkBackend(
            this.webgpuContext!,
            renderFn,
            warmupFrames,
            benchmarkFrames
        );

        // Calculate speedup
        const speedup = webglResult.avgFrameTime / webgpuResult.avgFrameTime;

        return {
            name: config.name,
            webgl: webglResult,
            webgpu: webgpuResult,
            speedup,
        };
    }

    /**
     * Benchmark a single backend.
     */
    private async benchmarkBackend(
        context: GPUContext,
        renderFn: (context: GPUContext, frameIndex: number) => Promise<void>,
        warmupFrames: number,
        benchmarkFrames: number
    ): Promise<BackendResult> {
        // Warmup
        for (let i = 0; i < warmupFrames; i++) {
            await renderFn(context, i);
            await context.waitForGpuCommandsComplete();
        }

        // Benchmark
        const frameTimes: number[] = [];
        const startMemory = (performance as any).memory?.usedJSHeapSize;

        for (let i = 0; i < benchmarkFrames; i++) {
            const frameStart = performance.now();
            await renderFn(context, i);
            await context.waitForGpuCommandsComplete();
            const frameTime = performance.now() - frameStart;
            frameTimes.push(frameTime);
        }

        const endMemory = (performance as any).memory?.usedJSHeapSize;

        // Calculate statistics
        const avgFrameTime = frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length;
        const minFrameTime = Math.min(...frameTimes);
        const maxFrameTime = Math.max(...frameTimes);
        const variance = frameTimes.reduce((sum, time) => sum + Math.pow(time - avgFrameTime, 2), 0) / frameTimes.length;
        const stdDeviation = Math.sqrt(variance);

        return {
            avgFrameTime,
            minFrameTime,
            maxFrameTime,
            stdDeviation,
            fps: 1000 / avgFrameTime,
            memoryMB: startMemory && endMemory ? (endMemory - startMemory) / (1024 * 1024) : undefined,
        };
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
 * Run a suite of performance benchmarks.
 */
export async function runPerformanceSuite(
    benchmarks: BenchmarkConfig[],
    renderFn: (context: GPUContext, frameIndex: number, config: BenchmarkConfig) => Promise<void>
): Promise<BenchmarkResult[]> {
    const runner = new PerformanceBenchmark();
    const results: BenchmarkResult[] = [];

    const maxWidth = Math.max(...benchmarks.map(b => b.width));
    const maxHeight = Math.max(...benchmarks.map(b => b.height));

    if (!await runner.initialize(maxWidth, maxHeight)) {
        return [];
    }

    try {
        for (const config of benchmarks) {
            const result = await runner.runBenchmark(config, (ctx, frame) => renderFn(ctx, frame, config));
            results.push(result);
        }
    } finally {
        runner.dispose();
    }

    return results;
}

/**
 * Format benchmark results for display.
 */
export function formatBenchmarkResults(results: BenchmarkResult[]): string {
    let output = '\nPerformance Benchmark Results\n';
    output += '='.repeat(80) + '\n\n';

    for (const result of results) {
        output += `${result.name}:\n`;
        output += '-'.repeat(40) + '\n';
        output += `  WebGL:  ${result.webgl.avgFrameTime.toFixed(2)}ms/frame (${result.webgl.fps.toFixed(1)} FPS)\n`;
        output += `  WebGPU: ${result.webgpu.avgFrameTime.toFixed(2)}ms/frame (${result.webgpu.fps.toFixed(1)} FPS)\n`;
        output += `  Speedup: ${result.speedup.toFixed(2)}x ${result.speedup > 1 ? '(WebGPU faster)' : '(WebGL faster)'}\n`;
        output += '\n';
        output += `  WebGL stats:  min=${result.webgl.minFrameTime.toFixed(2)}ms, max=${result.webgl.maxFrameTime.toFixed(2)}ms, std=${result.webgl.stdDeviation.toFixed(2)}ms\n`;
        output += `  WebGPU stats: min=${result.webgpu.minFrameTime.toFixed(2)}ms, max=${result.webgpu.maxFrameTime.toFixed(2)}ms, std=${result.webgpu.stdDeviation.toFixed(2)}ms\n`;
        if (result.webgl.memoryMB !== undefined) {
            output += `  Memory delta: ${result.webgl.memoryMB.toFixed(2)}MB (WebGL), ${result.webgpu.memoryMB?.toFixed(2)}MB (WebGPU)\n`;
        }
        output += '\n';
    }

    return output;
}

/**
 * Quick benchmark for a single render function.
 */
export async function quickBenchmark(
    name: string,
    renderFn: (context: GPUContext) => Promise<void>,
    options: { width?: number; height?: number; frames?: number } = {}
): Promise<BenchmarkResult | null> {
    const width = options.width ?? 512;
    const height = options.height ?? 512;
    const frames = options.frames ?? 60;

    const benchmark = new PerformanceBenchmark();

    if (!await benchmark.initialize(width, height)) {
        return null;
    }

    try {
        return await benchmark.runBenchmark(
            { name, width, height, benchmarkFrames: frames },
            renderFn
        );
    } finally {
        benchmark.dispose();
    }
}
