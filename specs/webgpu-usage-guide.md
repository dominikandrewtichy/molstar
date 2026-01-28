# WebGPU Usage Guide

This guide covers how to use the WebGPU backend in Mol*.

## Table of Contents

1. [Quick Start](#quick-start)
2. [Backend Selection](#backend-selection)
3. [Native WebGPU Rendering](#native-webgpu-rendering)
4. [GPUContext API](#gpucontext-api)
5. [Shader Development](#shader-development)
6. [Performance Tips](#performance-tips)
7. [Troubleshooting](#troubleshooting)

## Quick Start

### Automatic Backend Selection

The easiest way to use WebGPU is with automatic backend selection:

```typescript
import { Canvas3D, Canvas3DContext } from 'molstar/lib/mol-canvas3d/canvas3d';

const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const assetManager = new AssetManager();

// Automatically selects WebGPU if available, falls back to WebGL
const context = await Canvas3DContext.fromCanvasAsync(canvas, assetManager, {
    preferredBackend: 'auto' // 'webgl' | 'webgpu' | 'auto'
});

console.log('Using backend:', context.backend); // 'webgl' or 'webgpu'

const canvas3d = Canvas3D.create(context);
```

### Explicit Backend Selection

Force a specific backend:

```typescript
// Force WebGPU
const webgpuContext = await Canvas3DContext.fromCanvasAsync(canvas, assetManager, {
    preferredBackend: 'webgpu'
});

// Force WebGL
const webglContext = await Canvas3DContext.fromCanvasAsync(canvas, assetManager, {
    preferredBackend: 'webgl'
});
```

## Backend Selection

### Understanding Backend Selection

| `preferredBackend` | Behavior |
|-------------------|----------|
| `'auto'` | Use WebGPU if available, otherwise WebGL |
| `'webgpu'` | Force WebGPU, throw error if not available |
| `'webgl'` | Use WebGL (legacy behavior) |

### Checking Backend Support

```typescript
import { getBackendSupportInfo } from 'molstar/lib/mol-gl/gpu/context-factory';

const support = getBackendSupportInfo();
console.log(support);
// {
//     webgl: { supported: true, version: '2.0' },
//     webgpu: { supported: true },
//     recommended: 'webgpu'
// }
```

## Native WebGPU Rendering

For advanced use cases, you can use the native WebGPU rendering pipeline directly.

### Creating a WebGPU Context

```typescript
import { createWebGPUContext } from 'molstar/lib/mol-gl/webgpu/context';
import { createWebGPURenderer } from 'molstar/lib/mol-gl/webgpu/renderer';
import { createWebGPUScene } from 'molstar/lib/mol-gl/webgpu/scene';
import { WebGPUMeshRenderable } from 'molstar/lib/mol-gl/webgpu/renderable/mesh';
import { MeshShader } from 'molstar/lib/mol-gl/shader/wgsl/mesh.wgsl';

// Create WebGPU context
const context = await createWebGPUContext({
    canvas: document.getElementById('canvas') as HTMLCanvasElement,
    pixelScale: 1
});

// Create renderer and scene
const renderer = createWebGPURenderer(context);
const scene = createWebGPUScene(context);
```

### Creating Renderables

```typescript
// Create a mesh renderable
const meshRenderable = new WebGPUMeshRenderable({
    context,
    materialId: 1,
    topology: 'triangle-list',
    values: {
        // Vertex buffer data
        aPosition: { ref: ValueCell.create(vertexData) },
        aNormal: { ref: ValueCell.create(normalData) },
        // Instance data
        instanceCount: { ref: ValueCell.create(1) },
        // Uniforms
        uColor: { ref: ValueCell.create(Color(0x4488CC)) },
        // ... other values
    },
    state: {
        visible: true,
        alphaFactor: 1,
        pickable: true,
        // ... other state
    },
    transparency: 'opaque',
    vertexShader: MeshShader.vertex,
    fragmentShaders: MeshShader.fragment,
    vertexBufferLayouts: [
        // Describe vertex buffer layout
        {
            arrayStride: 12, // 3 floats * 4 bytes
            attributes: [
                { shaderLocation: 0, offset: 0, format: 'float32x3' }
            ]
        }
    ],
    bindGroupLayouts: [
        // Frame uniforms (group 0)
        context.createBindGroupLayout({
            entries: [
                { binding: 0, visibility: ['vertex', 'fragment'], buffer: { type: 'uniform' } }
            ]
        }),
        // Material uniforms (group 1)
        context.createBindGroupLayout({
            entries: [
                { binding: 0, visibility: ['fragment'], buffer: { type: 'uniform' } }
            ]
        })
    ]
});

// Add to scene
scene.add(renderObject, meshRenderable);
```

### Rendering Loop

```typescript
function renderFrame(camera: Camera) {
    // Update renderer
    renderer.update(camera, scene);

    // Create command encoder
    const encoder = context.createCommandEncoder();

    // Begin render pass
    const passEncoder = encoder.beginRenderPass({
        colorAttachments: [{
            view: context.getCurrentTexture().createView(),
            clearValue: [0, 0, 0, 1],
            loadOp: 'clear',
            storeOp: 'store'
        }],
        depthStencilAttachment: {
            view: depthTextureView,
            depthClearValue: 1.0,
            depthLoadOp: 'clear',
            depthStoreOp: 'store'
        }
    });

    // Render opaque objects
    renderer.renderOpaque(scene, camera, passEncoder);

    // Render transparent objects
    renderer.renderTransparent(scene, camera, passEncoder);

    // End pass and submit
    passEncoder.end();
    context.submit([encoder.finish()]);
}
```

## GPUContext API

The `GPUContext` interface provides a unified API for both WebGL and WebGPU.

### Resource Creation

```typescript
// Buffers
const buffer = context.createBuffer({
    size: 1024,
    usage: ['vertex', 'copy-dst'],
    label: 'Vertex Buffer'
});
buffer.write(new Float32Array([...]));

// Textures
const texture = context.createTexture({
    size: [256, 256, 1],
    format: 'rgba8unorm',
    usage: ['texture-binding', 'copy-dst'],
    label: 'Color Texture'
});
texture.write(imageData);

// Samplers
const sampler = context.createSampler({
    magFilter: 'linear',
    minFilter: 'linear',
    addressModeU: 'clamp-to-edge',
    addressModeV: 'clamp-to-edge'
});

// Shader Modules
const shaderModule = context.createShaderModule({
    code: wgslShaderCode,
    label: 'My Shader'
});

// Render Pipelines
const pipeline = context.createRenderPipeline({
    layout: pipelineLayout,
    vertex: {
        module: shaderModule,
        entryPoint: 'vs_main',
        buffers: vertexBufferLayouts
    },
    fragment: {
        module: shaderModule,
        entryPoint: 'fs_main',
        targets: [{ format: 'bgra8unorm' }]
    },
    primitive: {
        topology: 'triangle-list',
        cullMode: 'back'
    },
    depthStencil: {
        depthWriteEnabled: true,
        depthCompare: 'less'
    }
});

// Bind Groups
const bindGroup = context.createBindGroup({
    layout: bindGroupLayout,
    entries: [
        { binding: 0, resource: { buffer: uniformBuffer } },
        { binding: 1, resource: texture.createView() },
        { binding: 2, resource: sampler }
    ]
});
```

### Command Encoding

```typescript
const encoder = context.createCommandEncoder();

// Render pass
const passEncoder = encoder.beginRenderPass({
    colorAttachments: [...],
    depthStencilAttachment: {...}
});

passEncoder.setPipeline(pipeline);
passEncoder.setBindGroup(0, bindGroup);
passEncoder.setVertexBuffer(0, vertexBuffer);
passEncoder.setIndexBuffer(indexBuffer, 'uint32');
passEncoder.drawIndexed(indexCount, instanceCount);
passEncoder.end();

// Compute pass
const computePass = encoder.beginComputePass();
computePass.setPipeline(computePipeline);
computePass.setBindGroup(0, computeBindGroup);
computePass.dispatchWorkgroups(workgroupCountX, workgroupCountY);
computePass.end();

// Submit
context.submit([encoder.finish()]);
```

### Render State

```typescript
// Set render state (works with both WebGL and WebGPU)
context.state.enableBlend();
context.state.blendFunc('src-alpha', 'one-minus-src-alpha');
context.state.enableDepthTest();
context.state.depthFunc('less');
context.state.enableCullFace();
context.state.cullFace('back');
context.state.viewport(0, 0, width, height);
```

### Canvas Management

```typescript
// Get current texture for rendering
const currentTexture = context.getDrawingBufferSize();

// Resize
context.resize(width, height);

// Get drawing buffer size
const { width, height } = context.getDrawingBufferSize();

// Set pixel scale
context.setPixelScale(window.devicePixelRatio);
```

## Shader Development

### WGSL Shader Structure

WGSL shaders in Mol* follow a specific structure:

```wgsl
// 1. Common imports
${common_wgsl}
${frame_uniforms_wgsl}

// 2. Bind group layouts
@group(0) @binding(0) var<uniform> frame: FrameUniforms;
@group(1) @binding(0) var<uniform> material: MaterialUniforms;
@group(2) @binding(0) var<uniform> object: ObjectUniforms;

// 3. Vertex shader
struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @builtin(instance_index) instance_index: u32,
}

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) v_normal: vec3<f32>,
}

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    // ... vertex processing
    return output;
}

// 4. Fragment shader
struct FragmentInput {
    @builtin(position) frag_coord: vec4<f32>,
    @location(0) v_normal: vec3<f32>,
}

struct FragmentOutput {
    @location(0) color: vec4<f32>,
}

@fragment
fn fs_main(input: FragmentInput) -> FragmentOutput {
    var output: FragmentOutput;
    // ... fragment processing
    output.color = vec4<f32>(1.0, 0.0, 0.0, 1.0);
    return output;
}
```

### Bind Group Organization

| Group | Purpose | Update Frequency |
|-------|---------|------------------|
| 0 | Frame uniforms (camera, lights) | Once per frame |
| 1 | Material uniforms (colors, properties) | Per material |
| 2 | Object uniforms (transforms, IDs) | Per object/draw call |

### Available Shader Chunks

| Chunk | Description |
|-------|-------------|
| `common_wgsl` | Math utilities, packing functions |
| `frame_uniforms_wgsl` | Camera matrices, viewport, time |
| `light_uniforms_wgsl` | Lighting parameters |
| `material_uniforms_wgsl` | Material colors and properties |
| `object_uniforms_wgsl` | Object transforms and IDs |
| `lighting_wgsl` | PBR lighting functions |
| `color_wgsl` | Color assignment utilities |
| `transparency_wgsl` | WBOIT/DPOIT implementations |
| `fog_wgsl` | Distance fog |
| `clipping_wgsl` | Clip planes and volumes |
| `marker_wgsl` | Highlight/selection markers |
| `size_wgsl` | Size assignment and LOD |

## Performance Tips

### 1. Pipeline Caching

WebGPU pipelines are expensive to create. The `PipelineCache` class helps reuse pipelines:

```typescript
import { PipelineCache } from 'molstar/lib/mol-gl/webgpu/pipeline-cache';

const cache = new PipelineCache(context);

// Get or create pipeline
const pipeline = cache.get({
    shaderId: 1,
    variant: 'color',
    transparency: 'opaque',
    // ... other key properties
});
```

### 2. Minimize Buffer Updates

Upload data in bulk rather than frequent small updates:

```typescript
// Good: Upload all at once
const buffer = context.createBuffer({
    size: totalSize,
    usage: ['vertex', 'copy-dst']
});
buffer.write(allVertexData);

// Avoid: Multiple small uploads
vertices.forEach(v => buffer.write(v)); // Slow!
```

### 3. Batch Draw Calls

Combine geometries where possible to reduce draw calls:

```typescript
// Good: Batch into single buffer
const mergedMesh = mergeMeshes(meshes);

// Avoid: Individual draw calls
meshes.forEach(m => renderMesh(m)); // More draw calls
```

### 4. Use Instancing

For repeated geometry, use instancing:

```typescript
// Single draw call for many instances
passEncoder.drawIndexed(indexCount, instanceCount);
```

### 5. Async Operations

Use async operations for non-blocking GPU work:

```typescript
// Async pixel readback
const pixels = await context.readPixelsAsync(x, y, width, height);
```

## Troubleshooting

### WebGPU Not Available

**Problem:** `navigator.gpu` is undefined

**Solution:**
- Use Chrome 113+ or Edge 113+
- Enable WebGPU in Firefox: `dom.webgpu.enabled` in about:config
- Fallback to WebGL:

```typescript
const context = await Canvas3DContext.fromCanvasAsync(canvas, assetManager, {
    preferredBackend: 'auto' // Automatically falls back to WebGL
});
```

### Shader Compilation Errors

**Problem:** WGSL shader fails to compile

**Solution:**
- Check browser console for detailed error messages
- Validate WGSL syntax using online tools
- Ensure all bindings are correctly declared

### Performance Issues

**Problem:** WebGPU is slower than expected

**Solutions:**
- Check that you're using the native WebGPU renderer, not WebGL adapter
- Verify pipeline caching is working
- Minimize CPU-GPU data transfers
- Use compute shaders for GPU-side processing

### Memory Leaks

**Problem:** GPU memory keeps growing

**Solution:**
- Always call `destroy()` on resources when done:

```typescript
buffer.destroy();
texture.destroy();
pipeline.destroy();
```

### Visual Differences

**Problem:** WebGPU output differs from WebGL

**Common Causes:**
- Depth range: WebGPU uses [0,1], WebGL uses [-1,1]
- Provoking vertex: WebGPU uses first, WebGL uses last
- Texture formats: Some formats have different precision

**Debugging:**
- Use visual comparison tests
- Check shader output with renderdoc or browser devtools
- Compare pixel values at specific locations

## Browser Compatibility

| Browser | Version | Support | Notes |
|---------|---------|---------|-------|
| Chrome | 113+ | ✅ Full | Recommended |
| Edge | 113+ | ✅ Full | Based on Chromium |
| Firefox | Nightly | ⚠️ Partial | Enable `dom.webgpu.enabled` |
| Safari | TP | ⚠️ Partial | Technology Preview |

## Migration from WebGL

If you're migrating existing Mol* code to use WebGPU:

1. **Update context creation:**
   ```typescript
   // Before
   const context = Canvas3DContext.fromCanvas(canvas, assetManager);
   
   // After
   const context = await Canvas3DContext.fromCanvasAsync(canvas, assetManager, {
       preferredBackend: 'auto'
   });
   ```

2. **Check for GPUContext:**
   ```typescript
   if (context.gpuContext) {
       // Use modern GPU API
   }
   ```

3. **Update shader code:**
   - GLSL shaders work via WebGL adapter
   - For native WebGPU, use WGSL shaders

4. **Handle async operations:**
   - Many WebGPU operations are async
   - Use `await` or `.then()` appropriately

---

**Last Updated:** 2026-01-28
