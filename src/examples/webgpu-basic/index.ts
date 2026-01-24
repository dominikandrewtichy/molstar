/**
 * Copyright (c) 2025 mol* contributors, licensed under MIT, See LICENSE file for more info.
 *
 * @author Alexander Rose <alexander.rose@weirdbyte.de>
 *
 * Minimal WebGPU test to verify the WebGPU backend works.
 * This renders a simple colored triangle using the WebGPU context.
 */

import { createWebGPUContext } from '../../mol-gl/webgpu/context';
import { GPUContext } from '../../mol-gl/gpu/context';
import './index.html';

// Simple triangle shader - standalone for testing
const triangleShaderCode = /* wgsl */`
struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) color: vec3<f32>,
}

@vertex
fn vs_main(@builtin(vertex_index) vertex_index: u32) -> VertexOutput {
    var positions = array<vec2<f32>, 3>(
        vec2<f32>(0.0, 0.5),
        vec2<f32>(-0.5, -0.5),
        vec2<f32>(0.5, -0.5)
    );

    var colors = array<vec3<f32>, 3>(
        vec3<f32>(1.0, 0.0, 0.0),
        vec3<f32>(0.0, 1.0, 0.0),
        vec3<f32>(0.0, 0.0, 1.0)
    );

    var output: VertexOutput;
    output.position = vec4<f32>(positions[vertex_index], 0.0, 1.0);
    output.color = colors[vertex_index];
    return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
    return vec4<f32>(input.color, 1.0);
}
`;

interface TestResult {
    success: boolean;
    message: string;
    details?: string;
}

async function runTest(testName: string, testFn: () => Promise<void>): Promise<TestResult> {
    try {
        await testFn();
        return { success: true, message: `${testName}: PASSED` };
    } catch (error) {
        return {
            success: false,
            message: `${testName}: FAILED`,
            details: error instanceof Error ? error.message : String(error)
        };
    }
}

function logResult(result: TestResult, logElement: HTMLElement) {
    const div = document.createElement('div');
    div.style.padding = '8px';
    div.style.margin = '4px 0';
    div.style.borderRadius = '4px';

    if (result.success) {
        div.style.backgroundColor = '#d4edda';
        div.style.color = '#155724';
    } else {
        div.style.backgroundColor = '#f8d7da';
        div.style.color = '#721c24';
    }

    div.textContent = result.message;

    if (result.details) {
        const details = document.createElement('pre');
        details.style.fontSize = '12px';
        details.style.margin = '4px 0 0 0';
        details.textContent = result.details;
        div.appendChild(details);
    }

    logElement.appendChild(div);
}

export async function runWebGPUTests() {
    const container = document.getElementById('app');
    if (!container) {
        console.error('No app container found');
        return;
    }

    // Create log element
    const logElement = document.createElement('div');
    logElement.id = 'test-log';
    logElement.style.fontFamily = 'monospace';
    logElement.style.padding = '20px';
    container.appendChild(logElement);

    // Create canvas for rendering tests
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 512;
    canvas.style.border = '1px solid #ccc';
    canvas.style.margin = '20px';
    container.appendChild(canvas);

    const results: TestResult[] = [];

    // Test 1: Check WebGPU support
    results.push(await runTest('WebGPU Support Check', async () => {
        if (!navigator.gpu) {
            throw new Error('WebGPU is not supported in this browser. Use Chrome 113+ or Firefox with WebGPU enabled.');
        }
    }));

    if (!results[0].success) {
        results.forEach(r => logResult(r, logElement));
        return;
    }

    // Test 2: Create WebGPU context
    let context: GPUContext | null = null;
    results.push(await runTest('Create WebGPU Context', async () => {
        context = await createWebGPUContext({
            canvas,
            pixelScale: 1,
            preferredBackend: 'webgpu'
        });

        if (!context) {
            throw new Error('Failed to create context');
        }

        if (context.backend !== 'webgpu') {
            throw new Error(`Expected webgpu backend, got ${context.backend}`);
        }
    }));

    if (!context) {
        results.forEach(r => logResult(r, logElement));
        return;
    }

    // Test 3: Create shader module
    let shaderModule: ReturnType<GPUContext['createShaderModule']> | null = null;
    results.push(await runTest('Create Shader Module', async () => {
        shaderModule = context!.createShaderModule({
            code: triangleShaderCode,
            label: 'Triangle Shader'
        });
    }));

    if (!shaderModule) {
        results.forEach(r => logResult(r, logElement));
        return;
    }

    // Test 4: Create render pipeline
    let pipeline: ReturnType<GPUContext['createRenderPipeline']> | null = null;
    results.push(await runTest('Create Render Pipeline', async () => {
        pipeline = context!.createRenderPipeline({
            layout: 'auto',
            vertex: {
                module: shaderModule!,
                entryPoint: 'vs_main',
            },
            fragment: {
                module: shaderModule!,
                entryPoint: 'fs_main',
                targets: [{
                    format: 'bgra8unorm'
                }]
            },
            primitive: {
                topology: 'triangle-list',
            },
            label: 'Triangle Pipeline'
        });
    }));

    if (!pipeline) {
        results.forEach(r => logResult(r, logElement));
        return;
    }

    // Test 5: Render a frame
    results.push(await runTest('Render Triangle', async () => {
        const currentTexture = context!.getCurrentTexture();
        const textureView = context!.createTextureView(currentTexture);

        const encoder = context!.createCommandEncoder();
        const pass = context!.beginRenderPass(encoder, {
            colorAttachments: [{
                view: textureView,
                clearValue: [0.1, 0.1, 0.1, 1.0],
                loadOp: 'clear',
                storeOp: 'store'
            }]
        });

        pass.setPipeline(pipeline!);
        pass.draw(3);
        pass.end();

        const commandBuffer = encoder.finish();
        context!.submit([commandBuffer]);

        // Wait for GPU to complete
        await context!.waitForGpuCommandsComplete();
    }));

    // Test 6: Create and upload buffer
    results.push(await runTest('Create and Upload Buffer', async () => {
        const data = new Float32Array([
            0.0, 0.5, 0.0,
            -0.5, -0.5, 0.0,
            0.5, -0.5, 0.0
        ]);

        const buffer = context!.createBuffer({
            size: data.byteLength,
            usage: ['vertex', 'copy-dst'],
            label: 'Vertex Buffer'
        });

        buffer.write(data);

        // Verify buffer was created
        if (buffer.size !== data.byteLength) {
            throw new Error(`Buffer size mismatch: expected ${data.byteLength}, got ${buffer.size}`);
        }

        buffer.destroy();
    }));

    // Test 7: Create texture
    results.push(await runTest('Create Texture', async () => {
        const texture = context!.createTexture({
            size: [256, 256, 1],
            format: 'rgba8unorm',
            usage: ['texture-binding', 'copy-dst'],
            label: 'Test Texture'
        });

        if (texture.width !== 256 || texture.height !== 256) {
            throw new Error(`Texture size mismatch: expected 256x256, got ${texture.width}x${texture.height}`);
        }

        texture.destroy();
    }));

    // Test 8: Create sampler
    results.push(await runTest('Create Sampler', async () => {
        const sampler = context!.createSampler({
            magFilter: 'linear',
            minFilter: 'linear',
            label: 'Test Sampler'
        });

        if (!sampler) {
            throw new Error('Failed to create sampler');
        }
    }));

    // Test 9: Check stats
    results.push(await runTest('Stats Tracking', async () => {
        const stats = context!.stats;

        if (stats.drawCount < 1) {
            throw new Error(`Expected at least 1 draw call, got ${stats.drawCount}`);
        }

        // Note: resourceCounts may not be accurate after destroys
    }));

    // Display all results
    results.forEach(r => logResult(r, logElement));

    // Summary
    const passed = results.filter(r => r.success).length;
    const total = results.length;

    const summary = document.createElement('h3');
    summary.textContent = `Results: ${passed}/${total} tests passed`;
    summary.style.color = passed === total ? '#155724' : '#721c24';
    logElement.insertBefore(summary, logElement.firstChild);

    console.log('WebGPU tests complete:', { passed, total });
}

// Auto-run if in browser
if (typeof window !== 'undefined') {
    window.addEventListener('DOMContentLoaded', () => {
        runWebGPUTests().catch(console.error);
    });
}
