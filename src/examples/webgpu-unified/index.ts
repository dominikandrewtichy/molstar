/**
 * Copyright (c) 2025 mol* contributors, licensed under MIT, See LICENSE file for more info.
 *
 * @author Alexander Rose <alexander.rose@weirdbyte.de>
 *
 * Unified backend test demonstrating both WebGL and WebGPU working through
 * the common GPUContext interface.
 */

import { createGPUContext, getBackendSupportInfo, getBackendFeatures } from '../../mol-gl/gpu/context-factory';
import { GPUContext, GPUBackend } from '../../mol-gl/gpu/context';
import './index.html';

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

function logInfo(message: string, logElement: HTMLElement) {
    const div = document.createElement('div');
    div.style.padding = '8px';
    div.style.margin = '4px 0';
    div.style.backgroundColor = '#e2e3e5';
    div.style.borderRadius = '4px';
    div.innerHTML = message;
    logElement.appendChild(div);
}


async function testBufferOperations(context: GPUContext, logElement: HTMLElement): Promise<void> {
    const result = await runTest('Buffer operations', async () => {
        // Create a vertex buffer
        const vertexData = new Float32Array([
            // Position (xyz), Color (rgb)
            0.0, 0.5, 0.0, 1.0, 0.0, 0.0,
            -0.5, -0.5, 0.0, 0.0, 1.0, 0.0,
            0.5, -0.5, 0.0, 0.0, 0.0, 1.0,
        ]);

        const buffer = context.createBuffer({
            size: vertexData.byteLength,
            usage: ['vertex', 'copy-dst'],
        });

        buffer.write(vertexData);

        if (buffer.size !== vertexData.byteLength) {
            throw new Error(`Buffer size mismatch: expected ${vertexData.byteLength}, got ${buffer.size}`);
        }

        logInfo(`Created buffer: ${buffer.size} bytes, id=${buffer.id}`, logElement);

        buffer.destroy();
    });

    logResult(result, logElement);
}

async function testTextureOperations(context: GPUContext, logElement: HTMLElement): Promise<void> {
    const result = await runTest('Texture operations', async () => {
        // Create a 2D texture
        const texture = context.createTexture({
            size: [256, 256],
            format: 'rgba8unorm',
            usage: ['texture-binding', 'copy-dst'],
        });

        if (texture.width !== 256 || texture.height !== 256) {
            throw new Error(`Texture size mismatch: expected 256x256, got ${texture.width}x${texture.height}`);
        }

        logInfo(`Created texture: ${texture.width}x${texture.height}, format=${texture.format}, id=${texture.id}`, logElement);

        // Create texture view
        const view = texture.createView();
        logInfo(`Created texture view: id=${view.id}`, logElement);

        view.destroy();
        texture.destroy();
    });

    logResult(result, logElement);
}

async function testSamplerOperations(context: GPUContext, logElement: HTMLElement): Promise<void> {
    const result = await runTest('Sampler operations', async () => {
        const sampler = context.createSampler({
            addressModeU: 'repeat',
            addressModeV: 'repeat',
            magFilter: 'linear',
            minFilter: 'linear',
            mipmapFilter: 'linear',
        });

        logInfo(`Created sampler: id=${sampler.id}`, logElement);

        sampler.destroy();
    });

    logResult(result, logElement);
}

async function testUniformBuffer(context: GPUContext, logElement: HTMLElement): Promise<void> {
    const result = await runTest('Uniform buffer operations', async () => {
        // Create a uniform buffer for transformation matrices
        const uniformData = new Float32Array(16); // 4x4 matrix
        uniformData.set([
            1, 0, 0, 0,
            0, 1, 0, 0,
            0, 0, 1, 0,
            0, 0, 0, 1,
        ]);

        const buffer = context.createBuffer({
            size: uniformData.byteLength,
            usage: ['uniform', 'copy-dst'],
        });

        buffer.write(uniformData);

        logInfo(`Created uniform buffer: ${buffer.size} bytes`, logElement);

        buffer.destroy();
    });

    logResult(result, logElement);
}

async function testDrawingBufferSize(context: GPUContext, logElement: HTMLElement): Promise<void> {
    const result = await runTest('Drawing buffer size', async () => {
        const size = context.getDrawingBufferSize();

        if (size.width <= 0 || size.height <= 0) {
            throw new Error(`Invalid drawing buffer size: ${size.width}x${size.height}`);
        }

        logInfo(`Drawing buffer size: ${size.width}x${size.height}`, logElement);
    });

    logResult(result, logElement);
}

async function testCommandEncoder(context: GPUContext, logElement: HTMLElement): Promise<void> {
    const result = await runTest('Command encoder', async () => {
        const encoder = context.createCommandEncoder();
        const commandBuffer = encoder.finish();

        context.submit([commandBuffer]);

        logInfo('Command encoder created and submitted successfully', logElement);
    });

    logResult(result, logElement);
}

async function runUnifiedTests() {
    const container = document.getElementById('app');
    if (!container) {
        console.error('No app container found');
        return;
    }

    // Title
    const title = document.createElement('h1');
    title.textContent = 'Unified GPU Backend Test';
    container.appendChild(title);

    // Backend support info
    const supportInfo = getBackendSupportInfo();
    const supportDiv = document.createElement('div');
    supportDiv.style.marginBottom = '20px';
    supportDiv.innerHTML = `
        <h2>Backend Support</h2>
        <ul>
            <li><strong>WebGL:</strong> ${supportInfo.webgl.supported ? `Supported (v${supportInfo.webgl.version})` : 'Not supported'}</li>
            <li><strong>WebGPU:</strong> ${supportInfo.webgpu.supported ? 'Supported' : 'Not supported'}</li>
            <li><strong>Recommended:</strong> ${supportInfo.recommended}</li>
        </ul>
    `;
    container.appendChild(supportDiv);

    // Test canvases
    const backendsToTest: (GPUBackend | 'auto')[] = ['auto'];
    if (supportInfo.webgl.supported) backendsToTest.push('webgl');
    if (supportInfo.webgpu.supported) backendsToTest.push('webgpu');

    for (const backend of backendsToTest) {
        const section = document.createElement('div');
        section.style.marginBottom = '30px';
        section.style.padding = '15px';
        section.style.border = '1px solid #ccc';
        section.style.borderRadius = '8px';

        const heading = document.createElement('h2');
        heading.textContent = `Testing: ${backend.toUpperCase()}`;
        section.appendChild(heading);

        // Create canvas for this backend
        const canvas = document.createElement('canvas');
        canvas.width = 400;
        canvas.height = 300;
        canvas.style.border = '1px solid black';
        canvas.style.marginBottom = '10px';
        section.appendChild(canvas);

        const logElement = document.createElement('div');
        section.appendChild(logElement);

        try {
            // Features for this backend
            if (backend !== 'auto') {
                const features = getBackendFeatures(backend);
                logInfo(`<strong>Features:</strong> Compute=${features.compute}, Storage Buffers=${features.storageBuffers}, Indirect Draw=${features.indirectDraw}`, logElement);
            }

            // Create context
            const { context, backend: actualBackend, fallbackUsed } = await createGPUContext(
                { canvas, preferredBackend: backend }
            );

            logInfo(`<strong>Actual Backend:</strong> ${actualBackend}${fallbackUsed ? ' (fallback)' : ''}`, logElement);
            logInfo(`<strong>Max Texture Size:</strong> ${context.limits.maxTextureSize}`, logElement);
            logInfo(`<strong>Max Draw Buffers:</strong> ${context.limits.maxDrawBuffers}`, logElement);

            // Run tests
            await testBufferOperations(context, logElement);
            await testTextureOperations(context, logElement);
            await testSamplerOperations(context, logElement);
            await testUniformBuffer(context, logElement);
            await testDrawingBufferSize(context, logElement);
            await testCommandEncoder(context, logElement);

            // Summary
            const summary = document.createElement('div');
            summary.style.marginTop = '10px';
            summary.style.padding = '10px';
            summary.style.backgroundColor = '#d4edda';
            summary.style.borderRadius = '4px';
            summary.innerHTML = `<strong>All tests passed for ${actualBackend}!</strong>`;
            logElement.appendChild(summary);

            // Don't destroy context so canvas stays valid
        } catch (error) {
            const errorDiv = document.createElement('div');
            errorDiv.style.padding = '10px';
            errorDiv.style.backgroundColor = '#f8d7da';
            errorDiv.style.borderRadius = '4px';
            errorDiv.textContent = `Failed to initialize ${backend}: ${error instanceof Error ? error.message : String(error)}`;
            logElement.appendChild(errorDiv);
        }

        container.appendChild(section);
    }
}

// Run tests when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', runUnifiedTests);
} else {
    runUnifiedTests();
}

export { runUnifiedTests };
