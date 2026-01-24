/**
 * Copyright (c) 2025 mol* contributors, licensed under MIT, See LICENSE file for more info.
 *
 * @author Alexander Rose <alexander.rose@weirdbyte.de>
 *
 * WebGPU mesh renderable test - renders a simple cube using the WebGPU mesh system.
 */

import { createWebGPUContext } from '../../mol-gl/webgpu/context';

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

function createPerspectiveMatrix(fov: number, aspect: number, near: number, far: number): Float32Array {
    const f = 1.0 / Math.tan(fov / 2);
    const nf = 1 / (near - far);

    return new Float32Array([
        f / aspect, 0, 0, 0,
        0, f, 0, 0,
        0, 0, (far + near) * nf, -1,
        0, 0, 2 * far * near * nf, 0,
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

export async function runMeshTest() {
    const container = document.getElementById('app');
    if (!container) {
        console.error('No app container found');
        return;
    }

    const logDiv = document.createElement('div');
    logDiv.style.fontFamily = 'monospace';
    logDiv.style.padding = '10px';
    container.appendChild(logDiv);

    function log(message: string, isError = false) {
        const p = document.createElement('p');
        p.style.margin = '4px 0';
        p.style.color = isError ? '#c00' : '#333';
        p.textContent = message;
        logDiv.appendChild(p);
        console.log(message);
    }

    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 512;
    canvas.style.border = '1px solid #ccc';
    canvas.style.margin = '10px';
    container.appendChild(canvas);

    try {
        log('Initializing WebGPU...');
        const context = await createWebGPUContext({ canvas, pixelScale: 1 });
        log(`Backend: ${context.backend}`);
        log(`Max texture size: ${context.limits.maxTextureSize}`);

        log('Creating shader module...');
        const shaderModule = context.createShaderModule({
            code: meshShaderCode,
            label: 'Mesh Shader',
        });

        log('Creating cube geometry...');
        const cube = createCubeGeometry();
        log(`Vertices: ${cube.positions.length / 3}, Indices: ${cube.indices.length}`);

        // Create vertex buffers
        const positionBuffer = context.createBuffer({
            size: cube.positions.byteLength,
            usage: ['vertex', 'copy-dst'],
            label: 'Position Buffer',
        });
        positionBuffer.write(cube.positions);

        const normalBuffer = context.createBuffer({
            size: cube.normals.byteLength,
            usage: ['vertex', 'copy-dst'],
            label: 'Normal Buffer',
        });
        normalBuffer.write(cube.normals);

        const indexBuffer = context.createBuffer({
            size: cube.indices.byteLength,
            usage: ['index', 'copy-dst'],
            label: 'Index Buffer',
        });
        indexBuffer.write(cube.indices);

        // Create uniform buffers
        const frameUniformBuffer = context.createBuffer({
            size: 128,
            usage: ['uniform', 'copy-dst'],
            label: 'Frame Uniforms',
        });

        const objectUniformBuffer = context.createBuffer({
            size: 80,
            usage: ['uniform', 'copy-dst'],
            label: 'Object Uniforms',
        });

        // Create bind group layouts
        log('Creating pipeline layout...');
        const frameBindGroupLayout = context.createBindGroupLayout({
            entries: [{
                binding: 0,
                visibility: ['vertex', 'fragment'],
                buffer: { type: 'uniform' },
            }],
            label: 'Frame Bind Group Layout',
        });

        const objectBindGroupLayout = context.createBindGroupLayout({
            entries: [{
                binding: 0,
                visibility: ['vertex', 'fragment'],
                buffer: { type: 'uniform' },
            }],
            label: 'Object Bind Group Layout',
        });

        const pipelineLayout = context.createPipelineLayout({
            bindGroupLayouts: [frameBindGroupLayout, objectBindGroupLayout],
            label: 'Mesh Pipeline Layout',
        });

        // Create bind groups
        const frameBindGroup = context.createBindGroup({
            layout: frameBindGroupLayout,
            entries: [{
                binding: 0,
                resource: { buffer: frameUniformBuffer },
            }],
            label: 'Frame Bind Group',
        });

        const objectBindGroup = context.createBindGroup({
            layout: objectBindGroupLayout,
            entries: [{
                binding: 0,
                resource: { buffer: objectUniformBuffer },
            }],
            label: 'Object Bind Group',
        });

        // Create depth texture
        const depthTexture = context.createTexture({
            size: [canvas.width, canvas.height],
            format: 'depth24plus',
            usage: ['render-attachment'],
            label: 'Depth Texture',
        });
        const depthView = depthTexture.createView();

        // Create render pipeline
        log('Creating render pipeline...');
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
            label: 'Mesh Pipeline',
        });

        const aspect = canvas.width / canvas.height;

        log('Starting render loop...');
        log('SUCCESS: Rendering animated cube with WebGPU!');

        // Animation state
        const state = { rotation: 0 };

        const render = () => {
            state.rotation += 0.01;

            // Update matrices
            const eye = [Math.sin(state.rotation) * 3, 1.5, Math.cos(state.rotation) * 3];
            const view = createLookAtMatrix(eye, [0, 0, 0], [0, 1, 0]);
            const projection = createPerspectiveMatrix(Math.PI / 4, aspect, 0.1, 100);
            const model = createRotationYMatrix(state.rotation * 0.5);

            // Pack and upload frame uniforms
            const frameData = new Float32Array(32);
            frameData.set(view, 0);
            frameData.set(projection, 16);
            frameUniformBuffer.write(frameData);

            // Pack and upload object uniforms
            const objectData = new Float32Array(20);
            objectData.set(model, 0);
            objectData.set([0.3, 0.6, 0.9, 1.0], 16);
            objectUniformBuffer.write(objectData);

            // Get current texture
            const currentTexture = context.getCurrentTexture();
            const colorView = currentTexture.createView();

            // Create command encoder
            const encoder = context.createCommandEncoder();
            const pass = context.beginRenderPass(encoder, {
                colorAttachments: [{
                    view: colorView,
                    clearValue: [0.1, 0.1, 0.15, 1.0],
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

            pass.setPipeline(pipeline);
            pass.setBindGroup(0, frameBindGroup);
            pass.setBindGroup(1, objectBindGroup);
            pass.setVertexBuffer(0, positionBuffer);
            pass.setVertexBuffer(1, normalBuffer);
            pass.setIndexBuffer(indexBuffer, 'uint32');
            pass.drawIndexed(cube.indices.length);
            pass.end();

            context.submit([encoder.finish()]);

            requestAnimationFrame(render);
        };

        requestAnimationFrame(render);

    } catch (error) {
        log(`ERROR: ${error instanceof Error ? error.message : String(error)}`, true);
        console.error(error);
    }
}

// Auto-run
if (typeof window !== 'undefined') {
    window.addEventListener('DOMContentLoaded', () => {
        runMeshTest().catch(console.error);
    });
}
