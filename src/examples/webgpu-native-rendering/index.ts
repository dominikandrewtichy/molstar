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

// Simple mesh shader for the test
const meshShaderCode = /* wgsl */`
// Frame uniforms
struct FrameUniforms {
    view: mat4x4<f32>,
    projection: mat4x4<f32>,
}

@group(0) @binding(0) var<uniform> frame: FrameUniforms;

// Object uniforms
struct ObjectUniforms {
    model: mat4x4<f32>,
    color: vec4<f32>,
}

@group(1) @binding(0) var<uniform> object: ObjectUniforms;

// Vertex input
struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) normal: vec3<f32>,
}

// Vertex output
struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) normal: vec3<f32>,
    @location(1) world_position: vec3<f32>,
}

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;

    let world_position = object.model * vec4<f32>(input.position, 1.0);
    let view_position = frame.view * world_position;

    output.position = frame.projection * view_position;
    output.normal = (object.model * vec4<f32>(input.normal, 0.0)).xyz;
    output.world_position = world_position.xyz;

    return output;
}

// Fragment output
@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
    // Simple directional lighting
    let light_dir = normalize(vec3<f32>(1.0, 1.0, 1.0));
    let normal = normalize(input.normal);

    let diffuse = max(dot(normal, light_dir), 0.0);
    let ambient = 0.3;

    let lit = ambient + diffuse * 0.7;

    return vec4<f32>(object.color.rgb * lit, object.color.a);
}
`;

// Generate cube geometry
function createCubeGeometry() {
    const positions: number[] = [];
    const normals: number[] = [];
    const indices: number[] = [];

    const faces = [
        { normal: [0, 0, 1], corners: [[-.5, -.5, .5], [.5, -.5, .5], [.5, .5, .5], [-.5, .5, .5]] },
        { normal: [0, 0, -1], corners: [[.5, -.5, -.5], [-.5, -.5, -.5], [-.5, .5, -.5], [.5, .5, -.5]] },
        { normal: [0, 1, 0], corners: [[-.5, .5, .5], [.5, .5, .5], [.5, .5, -.5], [-.5, .5, -.5]] },
        { normal: [0, -1, 0], corners: [[-.5, -.5, -.5], [.5, -.5, -.5], [.5, -.5, .5], [-.5, -.5, .5]] },
        { normal: [1, 0, 0], corners: [[.5, -.5, .5], [.5, -.5, -.5], [.5, .5, -.5], [.5, .5, .5]] },
        { normal: [-1, 0, 0], corners: [[-.5, -.5, -.5], [-.5, -.5, .5], [-.5, .5, .5], [-.5, .5, -.5]] },
    ];

    let vertexIndex = 0;
    for (const face of faces) {
        for (const corner of face.corners) {
            positions.push(...corner);
            normals.push(...face.normal);
        }
        indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2);
        indices.push(vertexIndex, vertexIndex + 2, vertexIndex + 3);
        vertexIndex += 4;
    }

    return {
        positions: new Float32Array(positions),
        normals: new Float32Array(normals),
        indices: new Uint32Array(indices),
    };
}

// Generate sphere geometry
function createSphereGeometry(radius: number, latSegments: number, lonSegments: number) {
    const positions: number[] = [];
    const normals: number[] = [];
    const indices: number[] = [];

    for (let lat = 0; lat <= latSegments; lat++) {
        const theta = lat * Math.PI / latSegments;
        const sinTheta = Math.sin(theta);
        const cosTheta = Math.cos(theta);

        for (let lon = 0; lon <= lonSegments; lon++) {
            const phi = lon * 2 * Math.PI / lonSegments;
            const sinPhi = Math.sin(phi);
            const cosPhi = Math.cos(phi);

            const x = cosPhi * sinTheta;
            const y = cosTheta;
            const z = sinPhi * sinTheta;

            normals.push(x, y, z);
            positions.push(radius * x, radius * y, radius * z);
        }
    }

    for (let lat = 0; lat < latSegments; lat++) {
        for (let lon = 0; lon < lonSegments; lon++) {
            const first = lat * (lonSegments + 1) + lon;
            const second = first + lonSegments + 1;

            indices.push(first, second, first + 1);
            indices.push(second, second + 1, first + 1);
        }
    }

    return {
        positions: new Float32Array(positions),
        normals: new Float32Array(normals),
        indices: new Uint32Array(indices),
    };
}

// Simple matrix helpers
function createLookAtMatrix(eye: number[], center: number[], up: number[]): Float32Array {
    const z = normalize3([eye[0] - center[0], eye[1] - center[1], eye[2] - center[2]]);
    const x = normalize3(cross3(up, z));
    const y = cross3(z, x);

    return new Float32Array([
        x[0], y[0], z[0], 0,
        x[1], y[1], z[1], 0,
        x[2], y[2], z[2], 0,
        -dot3(x, eye), -dot3(y, eye), -dot3(z, eye), 1,
    ]);
}

// Create a perspective matrix suitable for WebGPU's [0, 1] depth range
function createPerspectiveMatrix(fov: number, aspect: number, near: number, far: number): Float32Array {
    const f = 1.0 / Math.tan(fov / 2);
    const nf = 1 / (near - far);

    // WebGPU uses [0, 1] depth range (like Vulkan/DirectX), not [-1, 1] (like OpenGL)
    // Adjusted matrix for WebGPU's clip space
    return new Float32Array([
        f / aspect, 0, 0, 0,
        0, f, 0, 0,
        0, 0, far * nf, -1,
        0, 0, near * far * nf, 0,
    ]);
}

function createRotationYMatrix(angle: number): Float32Array {
    const c = Math.cos(angle);
    const s = Math.sin(angle);

    return new Float32Array([
        c, 0, -s, 0,
        0, 1, 0, 0,
        s, 0, c, 0,
        0, 0, 0, 1,
    ]);
}

function createRotationXMatrix(angle: number): Float32Array {
    const c = Math.cos(angle);
    const s = Math.sin(angle);

    return new Float32Array([
        1, 0, 0, 0,
        0, c, s, 0,
        0, -s, c, 0,
        0, 0, 0, 1,
    ]);
}

function multiplyMatrices(a: Float32Array, b: Float32Array): Float32Array {
    const result = new Float32Array(16);
    for (let i = 0; i < 4; i++) {
        for (let j = 0; j < 4; j++) {
            result[i * 4 + j] = 
                a[i * 4 + 0] * b[0 * 4 + j] +
                a[i * 4 + 1] * b[1 * 4 + j] +
                a[i * 4 + 2] * b[2 * 4 + j] +
                a[i * 4 + 3] * b[3 * 4 + j];
        }
    }
    return result;
}

function normalize3(v: number[]): number[] {
    const len = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
    return [v[0] / len, v[1] / len, v[2] / len];
}

function cross3(a: number[], b: number[]): number[] {
    return [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ];
}

function dot3(a: number[], b: number[]): number {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

// Scene object interface
interface SceneObject {
    name: string;
    geometry: { positions: Float32Array; normals: Float32Array; indices: Uint32Array };
    positionBuffer: ReturnType<GPUContext['createBuffer']>;
    normalBuffer: ReturnType<GPUContext['createBuffer']>;
    indexBuffer: ReturnType<GPUContext['createBuffer']>;
    bindGroup: ReturnType<GPUContext['createBindGroup']>;
    uniformBuffer: ReturnType<GPUContext['createBuffer']>;
    indexCount: number;
    rotationX: number;
    rotationY: number;
    scale: number;
    color: [number, number, number, number];
}

interface AppState {
    context: GPUContext | null;
    isRotating: boolean;
    wireframe: boolean;
    lastFrameTime: number;
    fps: number;
    rafId: number;
    startTime: number;
    pipeline: ReturnType<GPUContext['createRenderPipeline']> | null;
    frameUniformBuffer: ReturnType<GPUContext['createBuffer']> | null;
    frameBindGroup: ReturnType<GPUContext['createBindGroup']> | null;
    depthTexture: ReturnType<GPUContext['createTexture']> | null;
    objects: SceneObject[];
    camera: {
        distance: number;
        rotationX: number;
        rotationY: number;
    };
}

const state: AppState = {
    context: null,
    isRotating: true,
    wireframe: false,
    lastFrameTime: 0,
    fps: 0,
    rafId: 0,
    startTime: 0,
    pipeline: null,
    frameUniformBuffer: null,
    frameBindGroup: null,
    depthTexture: null,
    objects: [],
    camera: {
        distance: 5,
        rotationX: 0.3,
        rotationY: 0,
    },
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
    getElement('stat-draws').textContent = String(state.objects.length);
    getElement('stat-objects').textContent = String(state.objects.length);
    let vertices = 0;
    for (const obj of state.objects) {
        vertices += obj.geometry.positions.length / 3;
    }
    getElement('stat-vertices').textContent = String(vertices);
}

// Create scene object
function createSceneObject(
    context: GPUContext,
    name: string,
    geometry: { positions: Float32Array; normals: Float32Array; indices: Uint32Array },
    objectBindGroupLayout: ReturnType<GPUContext['createBindGroupLayout']>,
    color: [number, number, number, number] = [0.3, 0.6, 0.9, 1.0]
): SceneObject {
    // Create buffers
    const positionBuffer = context.createBuffer({
        size: geometry.positions.byteLength,
        usage: ['vertex', 'copy-dst'],
        label: `${name} Position Buffer`,
    });
    positionBuffer.write(geometry.positions);

    const normalBuffer = context.createBuffer({
        size: geometry.normals.byteLength,
        usage: ['vertex', 'copy-dst'],
        label: `${name} Normal Buffer`,
    });
    normalBuffer.write(geometry.normals);

    const indexBuffer = context.createBuffer({
        size: geometry.indices.byteLength,
        usage: ['index', 'copy-dst'],
        label: `${name} Index Buffer`,
    });
    indexBuffer.write(geometry.indices);

    // Create uniform buffer for this object
    const uniformBuffer = context.createBuffer({
        size: 80, // mat4 (64 bytes) + vec4 (16 bytes)
        usage: ['uniform', 'copy-dst'],
        label: `${name} Uniform Buffer`,
    });

    // Create bind group
    const bindGroup = context.createBindGroup({
        layout: objectBindGroupLayout,
        entries: [{
            binding: 0,
            resource: { buffer: uniformBuffer },
        }],
        label: `${name} Bind Group`,
    });

    return {
        name,
        geometry,
        positionBuffer,
        normalBuffer,
        indexBuffer,
        bindGroup,
        uniformBuffer,
        indexCount: geometry.indices.length,
        rotationX: 0,
        rotationY: 0,
        scale: 1,
        color,
    };
}

// Add cube to scene
function addCube() {
    if (!state.context || !state.pipeline) return;

    const geometry = createCubeGeometry();
    const objectBindGroupLayout = state.pipeline.getBindGroupLayout(1);
    const color: [number, number, number, number] = [
        0.3 + Math.random() * 0.7,
        0.3 + Math.random() * 0.7,
        0.3 + Math.random() * 0.7,
        1.0,
    ];
    const obj = createSceneObject(state.context, `Cube ${state.objects.length + 1}`, geometry, objectBindGroupLayout, color);
    
    // Random position
    obj.rotationX = Math.random() * Math.PI;
    obj.rotationY = Math.random() * Math.PI;
    
    state.objects.push(obj);
    updateStats();
}

// Add sphere to scene
function addSphere() {
    if (!state.context || !state.pipeline) return;

    const geometry = createSphereGeometry(0.5, 16, 16);
    const objectBindGroupLayout = state.pipeline.getBindGroupLayout(1);
    const color: [number, number, number, number] = [
        0.3 + Math.random() * 0.7,
        0.3 + Math.random() * 0.7,
        0.3 + Math.random() * 0.7,
        1.0,
    ];
    const obj = createSceneObject(state.context, `Sphere ${state.objects.length + 1}`, geometry, objectBindGroupLayout, color);
    
    // Random position
    obj.rotationX = Math.random() * Math.PI;
    obj.rotationY = Math.random() * Math.PI;
    
    state.objects.push(obj);
    updateStats();
}

// Clear scene
function clearScene() {
    for (const obj of state.objects) {
        obj.positionBuffer.destroy();
        obj.normalBuffer.destroy();
        obj.indexBuffer.destroy();
        obj.uniformBuffer.destroy();
    }
    state.objects = [];
    updateStats();
}

// Reset camera
function resetCamera() {
    state.camera = {
        distance: 5,
        rotationX: 0.3,
        rotationY: 0,
    };
}

// Toggle rotation
function toggleRotation() {
    state.isRotating = !state.isRotating;
    const btn = getElement<HTMLButtonElement>('btn-rotate');
    btn.textContent = state.isRotating ? 'Stop Rotation' : 'Start Rotation';
    btn.classList.toggle('active', state.isRotating);
}

// Toggle wireframe
function toggleWireframe() {
    state.wireframe = !state.wireframe;
    const btn = getElement<HTMLButtonElement>('btn-wireframe');
    btn.classList.toggle('active', state.wireframe);
}

// Animation loop
function animate(time: number) {
    if (!state.context || !state.pipeline || !state.frameUniformBuffer || !state.frameBindGroup) {
        state.rafId = requestAnimationFrame(animate);
        return;
    }

    // Calculate FPS
    if (state.lastFrameTime > 0) {
        const delta = time - state.lastFrameTime;
        state.fps = 1000 / delta;
    }
    state.lastFrameTime = time;

    const elapsed = (time - state.startTime) / 1000;

    // Update camera rotation
    if (state.isRotating) {
        state.camera.rotationY += 0.005;
    }

    // Calculate camera position
    const camX = Math.sin(state.camera.rotationY) * Math.cos(state.camera.rotationX) * state.camera.distance;
    const camY = Math.sin(state.camera.rotationX) * state.camera.distance;
    const camZ = Math.cos(state.camera.rotationY) * Math.cos(state.camera.rotationX) * state.camera.distance;

    // Update matrices
    const { width, height } = state.context.getDrawingBufferSize();
    const aspect = width / height;
    const view = createLookAtMatrix([camX, camY, camZ], [0, 0, 0], [0, 1, 0]);
    const projection = createPerspectiveMatrix(Math.PI / 4, aspect, 0.1, 100);

    // Pack and upload frame uniforms
    const frameData = new Float32Array(32);
    frameData.set(view, 0);
    frameData.set(projection, 16);
    state.frameUniformBuffer.write(frameData);

    // Get current texture
    const currentTexture = state.context.getCurrentTexture();
    const colorView = currentTexture.createView();

    // Create command encoder
    const encoder = state.context.createCommandEncoder();
    const pass = state.context.beginRenderPass(encoder, {
        colorAttachments: [{
            view: colorView,
            clearValue: [0.1, 0.1, 0.15, 1.0],
            loadOp: 'clear',
            storeOp: 'store',
        }],
        depthStencilAttachment: state.depthTexture ? {
            view: state.depthTexture.createView(),
            depthClearValue: 1.0,
            depthLoadOp: 'clear',
            depthStoreOp: 'store',
        } : undefined,
    });

    // Set pipeline
    pass.setPipeline(state.pipeline);
    pass.setBindGroup(0, state.frameBindGroup);

    // Render all objects
    for (const obj of state.objects) {
        // Update object transform
        let model = createRotationYMatrix(obj.rotationY + elapsed * (state.isRotating ? 0.5 : 0));
        model = multiplyMatrices(model, createRotationXMatrix(obj.rotationX));

        // Pack and upload object uniforms
        const objectData = new Float32Array(20);
        objectData.set(model, 0);
        objectData.set(obj.color, 16);
        obj.uniformBuffer.write(objectData);

        // Draw
        pass.setBindGroup(1, obj.bindGroup);
        pass.setVertexBuffer(0, obj.positionBuffer);
        pass.setVertexBuffer(1, obj.normalBuffer);
        pass.setIndexBuffer(obj.indexBuffer, 'uint32');
        pass.drawIndexed(obj.indexCount);
    }

    pass.end();

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

        // Initial resize FIRST - must be done before creating depth texture
        const rect = canvas.getBoundingClientRect();
        context.resize(rect.width, rect.height);

        updateStatus('Creating shader and pipeline...');

        // Create shader module
        const shaderModule = context.createShaderModule({
            code: meshShaderCode,
            label: 'Mesh Shader'
        });

        // Create frame uniform buffer
        const frameUniformBuffer = context.createBuffer({
            size: 128, // 2 x mat4x4
            usage: ['uniform', 'copy-dst'],
            label: 'Frame Uniform Buffer'
        });
        state.frameUniformBuffer = frameUniformBuffer;

        // Create bind group layouts
        const frameBindGroupLayout = context.createBindGroupLayout({
            entries: [{
                binding: 0,
                visibility: ['vertex', 'fragment'],
                buffer: { type: 'uniform' },
            }],
            label: 'Frame Bind Group Layout'
        });

        const objectBindGroupLayout = context.createBindGroupLayout({
            entries: [{
                binding: 0,
                visibility: ['vertex', 'fragment'],
                buffer: { type: 'uniform' },
            }],
            label: 'Object Bind Group Layout'
        });

        // Create frame bind group
        const frameBindGroup = context.createBindGroup({
            layout: frameBindGroupLayout,
            entries: [{
                binding: 0,
                resource: { buffer: frameUniformBuffer },
            }],
            label: 'Frame Bind Group'
        });
        state.frameBindGroup = frameBindGroup;

        // Create pipeline layout
        const pipelineLayout = context.createPipelineLayout({
            bindGroupLayouts: [frameBindGroupLayout, objectBindGroupLayout],
            label: 'Mesh Pipeline Layout'
        });

        // Create depth texture AFTER resize - now it will have correct dimensions
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
                buffers: [
                    {
                        arrayStride: 12,
                        attributes: [{ shaderLocation: 0, format: 'float32x3', offset: 0 }],
                    },
                    {
                        arrayStride: 12,
                        attributes: [{ shaderLocation: 1, format: 'float32x3', offset: 0 }],
                    },
                ],
            },
            fragment: {
                module: shaderModule,
                entryPoint: 'fs_main',
                targets: [{ format: context.preferredFormat }],
            },
            primitive: {
                topology: 'triangle-list',
                cullMode: 'back',
                frontFace: 'ccw',
            },
            depthStencil: {
                format: 'depth24plus',
                depthWriteEnabled: true,
                depthCompare: 'less',
            },
            label: 'Mesh Pipeline'
        });
        state.pipeline = pipeline;

        // Setup UI
        getElement('btn-rotate').addEventListener('click', toggleRotation);
        getElement<HTMLButtonElement>('btn-rotate').classList.add('active');
        getElement('btn-reset').addEventListener('click', resetCamera);
        getElement('btn-wireframe').addEventListener('click', toggleWireframe);
        getElement('btn-cube').addEventListener('click', addCube);
        getElement('btn-sphere').addEventListener('click', addSphere);
        getElement('btn-clear').addEventListener('click', clearScene);

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

        // Add initial cube
        addCube();

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
    clearScene();
    if (state.depthTexture) {
        state.depthTexture.destroy();
    }
    if (state.frameUniformBuffer) {
        state.frameUniformBuffer.destroy();
    }
    if (state.context) {
        state.context.destroy();
    }
});

// Start
init();
