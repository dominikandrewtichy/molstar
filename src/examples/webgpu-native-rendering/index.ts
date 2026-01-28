/**
 * Copyright (c) 2025-2026 mol* contributors, licensed under MIT, See LICENSE file for more info.
 *
 * @author Alexander Rose <alexander.rose@weirdbyte.de>
 *
 * Native WebGPU rendering example.
 * Demonstrates direct use of the WebGPU API with Mol*'s GPUContext abstraction.
 */

import { createWebGPUContext } from '../../mol-gl/webgpu/context';
import { GPUContext } from '../../mol-gl/gpu/context';
// Native WebGPU rendering - no external math/color libs needed
import './index.html';

// Simple triangle shader for demonstration
const triangleShaderCode = /* wgsl */`
struct Uniforms {
    viewProjection: mat4x4<f32>,
    time: f32,
    _padding: vec3<f32>,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) color: vec3<f32>,
}

@vertex
fn vs_main(@builtin(vertex_index) vertex_index: u32) -> VertexOutput {
    var positions = array<vec3<f32>, 3>(
        vec3<f32>(0.0, 1.0, 0.0),
        vec3<f32>(-0.866, -0.5, 0.0),
        vec3<f32>(0.866, -0.5, 0.0)
    );
    
    var colors = array<vec3<f32>, 3>(
        vec3<f32>(1.0, 0.0, 0.0),
        vec3<f32>(0.0, 1.0, 0.0),
        vec3<f32>(0.0, 0.0, 1.0)
    );
    
    var output: VertexOutput;
    let pos = positions[vertex_index];
    
    // Add some animation based on time
    let angle = uniforms.time * 0.5;
    let s = sin(angle);
    let c = cos(angle);
    let rotated = vec3<f32>(
        pos.x * c - pos.y * s,
        pos.x * s + pos.y * c,
        pos.z
    );
    
    output.position = uniforms.viewProjection * vec4<f32>(rotated, 1.0);
    output.color = colors[vertex_index];
    return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
    return vec4<f32>(input.color, 1.0);
}
`;

interface AppState {
    context: GPUContext | null;
    isRotating: boolean;
    lastFrameTime: number;
    fps: number;
    rafId: number;
    startTime: number;
    pipeline: ReturnType<GPUContext['createRenderPipeline']> | null;
    uniformBuffer: ReturnType<GPUContext['createBuffer']> | null;
    bindGroup: ReturnType<GPUContext['createBindGroup']> | null;
    depthTexture: ReturnType<GPUContext['createTexture']> | null;
}

const state: AppState = {
    context: null,
    isRotating: true,
    lastFrameTime: 0,
    fps: 0,
    rafId: 0,
    startTime: 0,
    pipeline: null,
    uniformBuffer: null,
    bindGroup: null,
    depthTexture: null,
};

// UI Elements
function getElement<T extends HTMLElement>(id: string): T {
    return document.getElementById(id) as T;
}

function updateStatus(message: string, isError = false) {
    const status = getElement('status');
    status.textContent = message;
    status.className = isError ? 'error' : 'success';
}

function updateStats() {
    getElement('stat-fps').textContent = state.fps.toFixed(1);
    getElement('stat-backend').textContent = 'WebGPU (Native)';
}

// Create projection matrix
function createProjectionMatrix(width: number, height: number): Float32Array {
    const fov = Math.PI / 4;
    const aspect = width / height;
    const near = 0.1;
    const far = 100;
    
    const f = 1.0 / Math.tan(fov / 2);
    const nf = 1 / (near - far);
    
    return new Float32Array([
        f / aspect, 0, 0, 0,
        0, f, 0, 0,
        0, 0, far * nf, -1,
        0, 0, near * far * nf, 0,
    ]);
}

// Toggle rotation
function toggleRotation() {
    state.isRotating = !state.isRotating;
    const btn = getElement<HTMLButtonElement>('btn-rotate');
    btn.textContent = state.isRotating ? 'Stop Rotation' : 'Start Rotation';
    btn.classList.toggle('active', state.isRotating);
}

// Animation loop
function animate(time: number) {
    if (!state.context || !state.pipeline || !state.uniformBuffer || !state.bindGroup) {
        state.rafId = requestAnimationFrame(animate);
        return;
    }
    
    // Calculate FPS
    if (state.lastFrameTime > 0) {
        const delta = time - state.lastFrameTime;
        state.fps = 1000 / delta;
    }
    state.lastFrameTime = time;
    
    // Update uniform buffer with time
    const elapsed = (time - state.startTime) / 1000;
    const projection = createProjectionMatrix(
        state.context.getDrawingBufferSize().width,
        state.context.getDrawingBufferSize().height
    );
    
    const uniformData = new Float32Array([
        ...projection,
        elapsed,
        0, 0, 0, // padding
    ]);
    state.uniformBuffer.write(uniformData);
    
    // Create command encoder
    const encoder = state.context.createCommandEncoder();
    
    // Get current texture and create view
    const currentTexture = state.context.getCurrentTexture();
    const textureView = currentTexture.createView();
    
    // Begin render pass
    const passEncoder = encoder.beginRenderPass({
        colorAttachments: [{
            view: textureView,
            clearValue: [0.1, 0.1, 0.15, 1],
            loadOp: 'clear',
            storeOp: 'store'
        }],
        depthStencilAttachment: state.depthTexture ? {
            view: state.depthTexture.createView(),
            depthClearValue: 1.0,
            depthLoadOp: 'clear',
            depthStoreOp: 'store'
        } : undefined
    });
    
    // Set pipeline and bind group
    passEncoder.setPipeline(state.pipeline);
    passEncoder.setBindGroup(0, state.bindGroup);
    
    // Draw
    passEncoder.draw(3);
    passEncoder.end();
    
    // Submit
    state.context.submit([encoder.finish()]);
    
    // Update stats every 10 frames
    if (Math.floor(time / 16) % 10 === 0) {
        updateStats();
    }
    
    state.rafId = requestAnimationFrame(animate);
}

// Initialize the application
async function init() {
    const canvas = getElement<HTMLCanvasElement>('canvas');
    
    try {
        updateStatus('Creating WebGPU context...');
        
        // Check for WebGPU support
        if (!navigator.gpu) {
            throw new Error('WebGPU is not supported in this browser. Use Chrome 113+ or Edge 113+.');
        }
        
        // Create WebGPU context
        const context = await createWebGPUContext({
            canvas,
            pixelScale: window.devicePixelRatio,
            preferredBackend: 'webgpu'
        });
        
        state.context = context;
        state.startTime = performance.now();
        
        updateStatus('Creating shader and pipeline...');
        
        // Create shader module
        const shaderModule = context.createShaderModule({
            code: triangleShaderCode,
            label: 'Triangle Shader'
        });
        
        // Create uniform buffer
        const uniformBuffer = context.createBuffer({
            size: 16 * 4 + 4 + 12, // mat4x4 + float + padding to 16 bytes
            usage: ['uniform', 'copy-dst'],
            label: 'Uniform Buffer'
        });
        state.uniformBuffer = uniformBuffer;
        
        // Create bind group layout
        const bindGroupLayout = context.createBindGroupLayout({
            entries: [{
                binding: 0,
                visibility: ['vertex'],
                buffer: { type: 'uniform' }
            }],
            label: 'Uniform Bind Group Layout'
        });
        
        // Create bind group
        const bindGroup = context.createBindGroup({
            layout: bindGroupLayout,
            entries: [{
                binding: 0,
                resource: { buffer: uniformBuffer }
            }],
            label: 'Uniform Bind Group'
        });
        state.bindGroup = bindGroup;
        
        // Create pipeline layout
        const pipelineLayout = context.createPipelineLayout({
            bindGroupLayouts: [bindGroupLayout],
            label: 'Pipeline Layout'
        });
        
        // Create depth texture
        const { width, height } = context.getDrawingBufferSize();
        const depthTexture = context.createTexture({
            size: [width, height, 1],
            format: 'depth24plus',
            usage: ['render-attachment'],
            label: 'Depth Texture'
        });
        state.depthTexture = depthTexture;
        
        // Create render pipeline
        const pipeline = context.createRenderPipeline({
            layout: pipelineLayout,
            vertex: {
                module: shaderModule,
                entryPoint: 'vs_main',
            },
            fragment: {
                module: shaderModule,
                entryPoint: 'fs_main',
                targets: [{
                    format: 'bgra8unorm',
                }]
            },
            primitive: {
                topology: 'triangle-list',
            },
            depthStencil: {
                format: 'depth24plus',
                depthWriteEnabled: true,
                depthCompare: 'less',
            },
            label: 'Triangle Pipeline'
        });
        state.pipeline = pipeline;
        
        // Setup UI
        getElement('btn-rotate').addEventListener('click', toggleRotation);
        getElement<HTMLButtonElement>('btn-rotate').classList.add('active');
        
        // Handle resize
        window.addEventListener('resize', () => {
            if (!state.context) return;
            const rect = canvas.getBoundingClientRect();
            state.context.resize(rect.width, rect.height);
            
            // Recreate depth texture with new size
            if (state.depthTexture) {
                state.depthTexture.destroy();
            }
            const { width, height } = state.context.getDrawingBufferSize();
            state.depthTexture = state.context.createTexture({
                size: [width, height, 1],
                format: 'depth24plus',
                usage: ['render-attachment'],
                label: 'Depth Texture'
            });
        });
        
        // Initial resize
        const rect = canvas.getBoundingClientRect();
        context.resize(rect.width, rect.height);
        
        // Start animation
        state.rafId = requestAnimationFrame(animate);
        
        updateStatus('Ready - Native WebGPU rendering active');
        
    } catch (error) {
        console.error('Initialization failed:', error);
        updateStatus(`Error: ${error instanceof Error ? error.message : String(error)}`, true);
    }
}

// Cleanup on page unload
window.addEventListener('beforeunload', () => {
    if (state.rafId) {
        cancelAnimationFrame(state.rafId);
    }
    if (state.depthTexture) {
        state.depthTexture.destroy();
    }
    if (state.uniformBuffer) {
        state.uniformBuffer.destroy();
    }
    if (state.pipeline) {
        // Pipeline doesn't have destroy in WebGPU
    }
    if (state.context) {
        state.context.destroy();
    }
});

// Start
init();
