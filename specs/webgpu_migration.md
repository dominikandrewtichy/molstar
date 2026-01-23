# WebGL to WebGPU Migration Guide

This document outlines the strategy and technical details for migrating Mol*'s rendering engine from WebGL to WebGPU.

## 1. Current Architecture Overview

The rendering pipeline in Mol* is layered:

```
State → Representation → Geometry (mol-geo) → RenderObject → Renderable (mol-gl) → WebGL
```

The key module to change is **`mol-gl`** (`src/mol-gl/`), which provides a clean abstraction layer over WebGL. The higher layers (`mol-canvas3d`, `mol-repr`, `mol-geo`) can largely remain unchanged.

### Current mol-gl Structure

```
src/mol-gl/
├── webgl/                  # Low-level WebGL wrapper
│   ├── context.ts          # WebGL context creation and management
│   ├── shader.ts           # Shader compilation
│   ├── program.ts          # Program linking, uniforms, attributes
│   ├── buffer.ts           # VBO, element buffer, uniform buffer
│   ├── vertex-array.ts     # VAO management
│   ├── texture.ts          # 2D/3D textures
│   ├── framebuffer.ts      # Framebuffer objects
│   ├── state.ts            # Render state caching
│   ├── render-item.ts      # Draw call management
│   ├── extensions.ts       # WebGL extension discovery
│   ├── compat.ts           # WebGL1/WebGL2 compatibility
│   └── resources.ts        # Resource caching
├── shader/                 # GLSL shader sources
│   ├── chunks/             # Reusable shader code
│   └── *.vert.ts, *.frag.ts
├── renderable/             # High-level renderables
│   ├── mesh.ts
│   ├── spheres.ts
│   ├── cylinders.ts
│   └── ...
├── compute/                # GPU compute operations
├── renderer.ts             # Main rendering orchestration
├── renderable.ts           # Renderable interface
└── scene.ts                # Scene graph
```

---

## 2. WebGL vs WebGPU Conceptual Differences

### 2.1 Context Management

| Aspect | WebGL | WebGPU |
|--------|-------|--------|
| Initialization | `canvas.getContext('webgl2')` | `navigator.gpu.requestAdapter()` → `adapter.requestDevice()` |
| Main handle | `WebGLRenderingContext` | `GPUDevice` + `GPUQueue` |
| Context loss | Event-based (`webglcontextlost`) | `device.lost` Promise |
| Synchronicity | Synchronous | Asynchronous |

### 2.2 Shader System

| Aspect | WebGL | WebGPU |
|--------|-------|--------|
| Language | GLSL (ES 3.0) | WGSL |
| Compilation | Runtime via `gl.compileShader()` | `device.createShaderModule()` |
| Linking | Program = vert + frag | Pipeline = shader + full state |
| Uniforms | Location-based | Bind group layouts |
| Textures | Texture units | Bind group entries |

### 2.3 Buffer Management

| Aspect | WebGL | WebGPU |
|--------|-------|--------|
| Buffer binding | Target-based (`ARRAY_BUFFER`, etc.) | Usage flags, target-agnostic |
| Data upload | `gl.bufferData()` / `gl.bufferSubData()` | `device.createBuffer()` + `queue.writeBuffer()` |
| Vertex layout | VAO captures attribute state | Defined in pipeline descriptor |
| Uniform buffers | WebGL2 UBOs | Bind groups with buffer bindings |

### 2.4 Render State

| Aspect | WebGL | WebGPU |
|--------|-------|--------|
| State model | Mutable state machine | Immutable pipeline objects |
| Blend/depth/stencil | `gl.enable()` / `gl.blendFunc()` | Part of pipeline descriptor |
| Viewport/scissor | `gl.viewport()` / `gl.scissor()` | Set on render pass encoder |
| State changes | Per-call, cached for efficiency | Pipeline switch |

### 2.5 Draw Calls

| Aspect | WebGL | WebGPU |
|--------|-------|--------|
| Execution model | Immediate mode | Command encoding |
| Draw call | `gl.drawElements*()` | `passEncoder.drawIndexed()` |
| Submission | Implicit | Explicit `queue.submit()` |
| Multi-draw | Extensions available | Not yet standardized |

### 2.6 Framebuffers

| Aspect | WebGL | WebGPU |
|--------|-------|--------|
| Creation | `gl.createFramebuffer()` | Render pass descriptor |
| Attachments | `gl.framebufferTexture2D()` | Pass descriptor attachments |
| Resolve | Implicit (MSAA) | Explicit resolve targets |

---

## 3. Migration Strategy

### 3.1 Recommended Approach: Parallel Implementation

Rather than replacing WebGL, implement WebGPU as an alternative backend:

1. **Create abstraction layer** - Common interfaces for both backends
2. **Implement WebGPU backend** - New `webgpu/` directory alongside `webgl/`
3. **Runtime selection** - Choose backend based on browser support
4. **Gradual migration** - Port renderables one at a time

This approach allows:
- WebGL fallback for unsupported browsers
- Incremental testing and validation
- Side-by-side performance comparison

### 3.2 Directory Structure After Migration

```
src/mol-gl/
├── gpu/                    # NEW: Abstract GPU interface
│   ├── context.ts          # GPUContext interface
│   ├── buffer.ts           # Buffer interface
│   ├── texture.ts          # Texture interface
│   ├── pipeline.ts         # Pipeline interface
│   ├── bind-group.ts       # Bind group interface
│   └── render-pass.ts      # Render pass interface
├── webgl/                  # EXISTING: WebGL implementation
│   └── ...
├── webgpu/                 # NEW: WebGPU implementation
│   ├── context.ts
│   ├── buffer.ts
│   ├── texture.ts
│   ├── pipeline.ts
│   ├── bind-group.ts
│   └── render-pass.ts
├── shader/
│   ├── glsl/               # MOVED: GLSL shaders
│   └── wgsl/               # NEW: WGSL shaders
└── ...
```

---

## 4. Abstraction Layer Design

### 4.1 Context Interface

```typescript
// src/mol-gl/gpu/context.ts
interface GPUContextDescriptor {
  canvas: HTMLCanvasElement | OffscreenCanvas;
  pixelScale?: number;
  preferredBackend?: 'webgl' | 'webgpu' | 'auto';
}

interface GPUContext {
  readonly backend: 'webgl' | 'webgpu';
  readonly canvas: HTMLCanvasElement | OffscreenCanvas;
  readonly pixelRatio: number;
  readonly maxTextureSize: number;
  readonly maxVertexAttribs: number;

  // Resource creation
  createBuffer(descriptor: BufferDescriptor): Buffer;
  createTexture(descriptor: TextureDescriptor): Texture;
  createSampler(descriptor: SamplerDescriptor): Sampler;
  createBindGroupLayout(descriptor: BindGroupLayoutDescriptor): BindGroupLayout;
  createBindGroup(descriptor: BindGroupDescriptor): BindGroup;
  createPipelineLayout(descriptor: PipelineLayoutDescriptor): PipelineLayout;
  createRenderPipeline(descriptor: RenderPipelineDescriptor): RenderPipeline;
  createComputePipeline(descriptor: ComputePipelineDescriptor): ComputePipeline;
  createShaderModule(descriptor: ShaderModuleDescriptor): ShaderModule;

  // Command encoding
  createCommandEncoder(): CommandEncoder;
  submit(commandBuffers: CommandBuffer[]): void;

  // Canvas management
  getCurrentTexture(): Texture;
  resize(width: number, height: number): void;

  // Lifecycle
  readonly lost: Promise<void>;
  destroy(): void;
}
```

### 4.2 Buffer Interface

```typescript
// src/mol-gl/gpu/buffer.ts
type BufferUsage =
  | 'vertex'
  | 'index'
  | 'uniform'
  | 'storage'
  | 'copy-src'
  | 'copy-dst';

interface BufferDescriptor {
  size: number;
  usage: BufferUsage[];
  mappedAtCreation?: boolean;
}

interface Buffer {
  readonly size: number;
  readonly usage: BufferUsage[];

  write(data: ArrayBufferView, offset?: number): void;
  read(): Promise<ArrayBuffer>;
  destroy(): void;
}
```

### 4.3 Texture Interface

```typescript
// src/mol-gl/gpu/texture.ts
type TextureFormat =
  | 'rgba8unorm'
  | 'rgba8snorm'
  | 'rgba16float'
  | 'rgba32float'
  | 'depth24plus'
  | 'depth24plus-stencil8'
  | 'depth32float';

type TextureDimension = '1d' | '2d' | '3d';

interface TextureDescriptor {
  size: [number, number, number?];
  format: TextureFormat;
  dimension?: TextureDimension;
  mipLevelCount?: number;
  sampleCount?: number;
  usage: TextureUsage[];
}

interface Texture {
  readonly width: number;
  readonly height: number;
  readonly depth: number;
  readonly format: TextureFormat;

  write(data: ArrayBufferView, origin?: [number, number, number]): void;
  createView(descriptor?: TextureViewDescriptor): TextureView;
  destroy(): void;
}
```

### 4.4 Pipeline Interface

```typescript
// src/mol-gl/gpu/pipeline.ts
interface VertexAttribute {
  shaderLocation: number;
  format: VertexFormat;
  offset: number;
}

interface VertexBufferLayout {
  arrayStride: number;
  stepMode: 'vertex' | 'instance';
  attributes: VertexAttribute[];
}

interface RenderPipelineDescriptor {
  layout: PipelineLayout;
  vertex: {
    module: ShaderModule;
    entryPoint: string;
    buffers: VertexBufferLayout[];
  };
  fragment: {
    module: ShaderModule;
    entryPoint: string;
    targets: ColorTargetState[];
  };
  primitive?: {
    topology?: 'point-list' | 'line-list' | 'line-strip' | 'triangle-list' | 'triangle-strip';
    cullMode?: 'none' | 'front' | 'back';
    frontFace?: 'ccw' | 'cw';
  };
  depthStencil?: DepthStencilState;
  multisample?: {
    count?: number;
    alphaToCoverageEnabled?: boolean;
  };
}

interface RenderPipeline {
  readonly id: number;
  getBindGroupLayout(index: number): BindGroupLayout;
}
```

### 4.5 Render Pass Interface

```typescript
// src/mol-gl/gpu/render-pass.ts
interface RenderPassDescriptor {
  colorAttachments: ColorAttachment[];
  depthStencilAttachment?: DepthStencilAttachment;
}

interface ColorAttachment {
  view: TextureView;
  resolveTarget?: TextureView;
  clearValue?: [number, number, number, number];
  loadOp: 'load' | 'clear';
  storeOp: 'store' | 'discard';
}

interface RenderPassEncoder {
  setPipeline(pipeline: RenderPipeline): void;
  setBindGroup(index: number, bindGroup: BindGroup, dynamicOffsets?: number[]): void;
  setVertexBuffer(slot: number, buffer: Buffer, offset?: number, size?: number): void;
  setIndexBuffer(buffer: Buffer, format: 'uint16' | 'uint32', offset?: number, size?: number): void;
  setViewport(x: number, y: number, width: number, height: number, minDepth: number, maxDepth: number): void;
  setScissorRect(x: number, y: number, width: number, height: number): void;

  draw(vertexCount: number, instanceCount?: number, firstVertex?: number, firstInstance?: number): void;
  drawIndexed(indexCount: number, instanceCount?: number, firstIndex?: number, baseVertex?: number, firstInstance?: number): void;

  end(): void;
}
```

---

## 5. Shader Migration

### 5.1 GLSL to WGSL Conversion Strategy

**Option A: Automatic Transpilation**
- Use tools like [naga](https://github.com/gfx-rs/naga) (Rust) or [glslang](https://github.com/AcademySoftwareFoundation/OpenShadingLanguage)
- Pros: Faster initial migration
- Cons: May produce suboptimal WGSL, harder to debug

**Option B: Manual Rewrite**
- Convert shaders by hand to idiomatic WGSL
- Pros: Clean, optimized code; better understanding
- Cons: Time-consuming; ~50+ shader files

**Recommended**: Hybrid approach
1. Auto-transpile for initial port
2. Manually optimize critical shaders (mesh, spheres, cylinders)
3. Gradually replace transpiled code with hand-written WGSL

### 5.2 GLSL vs WGSL Syntax Comparison

#### Variable Declarations

```glsl
// GLSL
uniform mat4 uProjection;
uniform sampler2D tColor;
attribute vec3 aPosition;
varying vec3 vNormal;
```

```wgsl
// WGSL
@group(0) @binding(0) var<uniform> uProjection: mat4x4<f32>;
@group(0) @binding(1) var tColor: texture_2d<f32>;
@group(0) @binding(2) var tColorSampler: sampler;

struct VertexInput {
  @location(0) aPosition: vec3<f32>,
}

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) vNormal: vec3<f32>,
}
```

#### Functions

```glsl
// GLSL
void main() {
  gl_Position = uProjection * vec4(aPosition, 1.0);
  vNormal = aNormal;
}
```

```wgsl
// WGSL
@vertex
fn main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  output.position = uProjection * vec4<f32>(input.aPosition, 1.0);
  output.vNormal = input.aNormal;
  return output;
}
```

#### Texture Sampling

```glsl
// GLSL
vec4 color = texture2D(tColor, vUv);
```

```wgsl
// WGSL
let color: vec4<f32> = textureSample(tColor, tColorSampler, vUv);
```

### 5.3 Bind Group Organization

Organize uniforms and textures into logical bind groups:

```
Bind Group 0: Per-Frame (changes once per frame)
  - Camera matrices (view, projection)
  - Light positions
  - Time, resolution

Bind Group 1: Per-Material (changes per material)
  - Material properties (color, metalness, roughness)
  - Material textures

Bind Group 2: Per-Object (changes per draw call)
  - Model matrix
  - Object ID (for picking)
  - Instance data
```

### 5.4 Shader Module Structure

```typescript
// src/mol-gl/shader/wgsl/mesh.wgsl.ts
export const MeshShader = {
  vertex: /* wgsl */`
    struct Uniforms {
      viewProjection: mat4x4<f32>,
      model: mat4x4<f32>,
    }

    @group(0) @binding(0) var<uniform> uniforms: Uniforms;

    struct VertexInput {
      @location(0) position: vec3<f32>,
      @location(1) normal: vec3<f32>,
    }

    struct VertexOutput {
      @builtin(position) position: vec4<f32>,
      @location(0) normal: vec3<f32>,
    }

    @vertex
    fn main(input: VertexInput) -> VertexOutput {
      var output: VertexOutput;
      output.position = uniforms.viewProjection * uniforms.model * vec4<f32>(input.position, 1.0);
      output.normal = (uniforms.model * vec4<f32>(input.normal, 0.0)).xyz;
      return output;
    }
  `,
  fragment: /* wgsl */`
    struct VertexOutput {
      @builtin(position) position: vec4<f32>,
      @location(0) normal: vec3<f32>,
    }

    @fragment
    fn main(input: VertexOutput) -> @location(0) vec4<f32> {
      let lightDir = normalize(vec3<f32>(1.0, 1.0, 1.0));
      let diffuse = max(dot(normalize(input.normal), lightDir), 0.0);
      return vec4<f32>(vec3<f32>(diffuse), 1.0);
    }
  `,
};
```

---

## 6. Pipeline Management

### 6.1 Pipeline Permutation Challenge

In WebGL, render state is mutable. In WebGPU, render state is baked into immutable pipelines.

Current Mol* variants per renderable:
- `color` (standard rendering)
- `pick` (object picking)
- `depth` (depth pre-pass)
- `marking` (highlight/selection overlay)
- `emissive` (emissive pass)
- `tracing` (ray tracing)

Additional state combinations:
- Transparency: `opaque`, `blended`, `wboit`, `dpoit`
- Cull mode: `none`, `front`, `back`
- Depth: `test`, `write`, various compare functions

This creates a combinatorial explosion of pipeline variants.

### 6.2 Pipeline Cache Strategy

```typescript
// src/mol-gl/webgpu/pipeline-cache.ts
interface PipelineKey {
  shaderId: number;
  variant: RenderVariant;
  transparency: TransparencyMode;
  cullMode: CullMode;
  depthTest: boolean;
  depthWrite: boolean;
  blendMode: BlendMode;
  colorFormat: TextureFormat;
  depthFormat: TextureFormat;
  sampleCount: number;
}

class PipelineCache {
  private cache = new Map<string, RenderPipeline>();

  private hashKey(key: PipelineKey): string {
    return JSON.stringify(key);
  }

  get(context: GPUContext, key: PipelineKey): RenderPipeline {
    const hash = this.hashKey(key);
    let pipeline = this.cache.get(hash);

    if (!pipeline) {
      pipeline = this.createPipeline(context, key);
      this.cache.set(hash, pipeline);
    }

    return pipeline;
  }

  private createPipeline(context: GPUContext, key: PipelineKey): RenderPipeline {
    // Create pipeline with all state baked in
    return context.createRenderPipeline({
      // ... descriptor based on key
    });
  }
}
```

### 6.3 Lazy Pipeline Creation

Create pipelines on-demand rather than upfront:

```typescript
class Renderable {
  private pipelineCache = new Map<string, RenderPipeline>();

  render(pass: RenderPassEncoder, variant: RenderVariant) {
    const pipelineKey = this.getPipelineKey(variant);

    let pipeline = this.pipelineCache.get(pipelineKey);
    if (!pipeline) {
      pipeline = this.context.createRenderPipeline(this.getPipelineDescriptor(variant));
      this.pipelineCache.set(pipelineKey, pipeline);
    }

    pass.setPipeline(pipeline);
    pass.setBindGroup(0, this.frameBindGroup);
    pass.setBindGroup(1, this.materialBindGroup);
    pass.setVertexBuffer(0, this.vertexBuffer);
    pass.setIndexBuffer(this.indexBuffer, 'uint32');
    pass.drawIndexed(this.indexCount, this.instanceCount);
  }
}
```

---

## 7. Transparency Algorithms

### 7.1 Simple Blending (Order-Dependent)

WebGPU implementation is straightforward:

```typescript
const blendState: GPUBlendState = {
  color: {
    srcFactor: 'src-alpha',
    dstFactor: 'one-minus-src-alpha',
    operation: 'add',
  },
  alpha: {
    srcFactor: 'one',
    dstFactor: 'one-minus-src-alpha',
    operation: 'add',
  },
};
```

### 7.2 Weighted Blended OIT (WBOIT)

Requires two render targets:
1. Accumulation buffer (RGBA16F or RGBA32F)
2. Revealage buffer (R8 or R16F)

```wgsl
// Fragment shader for WBOIT accumulation
struct FragmentOutput {
  @location(0) accum: vec4<f32>,
  @location(1) reveal: f32,
}

@fragment
fn main(input: VertexOutput) -> FragmentOutput {
  let color = /* computed color */;
  let alpha = color.a;

  // Weight function
  let weight = clamp(pow(min(1.0, alpha * 10.0) + 0.01, 3.0) * 1e8 *
                     pow(1.0 - gl_FragCoord.z * 0.9, 3.0), 1e-2, 3e3);

  var output: FragmentOutput;
  output.accum = vec4<f32>(color.rgb * alpha, alpha) * weight;
  output.reveal = alpha;
  return output;
}
```

### 7.3 Depth Peeling OIT (DPOIT)

Requires multiple passes, each peeling one layer of transparency.

Implementation approach:
1. First pass: Render closest fragments
2. Subsequent passes: Render next-closest fragments using depth from previous pass
3. Composite all layers back-to-front

---

## 8. Compute Shader Migration

### 8.1 Current Compute Operations

Mol* uses compute-like operations via fragment shaders:
- Histogram pyramid generation
- Marching cubes (isosurface extraction)
- Hi-Z buffer generation
- Grid operations

### 8.2 WebGPU Compute Pipelines

WebGPU has native compute shader support:

```typescript
const computePipeline = device.createComputePipeline({
  layout: 'auto',
  compute: {
    module: device.createShaderModule({
      code: /* wgsl */`
        @group(0) @binding(0) var<storage, read> input: array<f32>;
        @group(0) @binding(1) var<storage, read_write> output: array<f32>;

        @compute @workgroup_size(64)
        fn main(@builtin(global_invocation_id) id: vec3<u32>) {
          let idx = id.x;
          output[idx] = input[idx] * 2.0;
        }
      `,
    }),
    entryPoint: 'main',
  },
});

// Dispatch
const encoder = device.createCommandEncoder();
const pass = encoder.beginComputePass();
pass.setPipeline(computePipeline);
pass.setBindGroup(0, bindGroup);
pass.dispatchWorkgroups(Math.ceil(dataLength / 64));
pass.end();
device.queue.submit([encoder.finish()]);
```

---

## 9. Implementation Phases

### Phase 1: Foundation (Week 1-2)

1. Create `src/mol-gl/gpu/` abstraction interfaces
2. Implement `src/mol-gl/webgpu/context.ts`
3. Implement basic buffer and texture management
4. Create context factory with backend selection

### Phase 2: Shader System (Week 3-4)

1. Convert core shader chunks to WGSL
2. Implement shader module loading
3. Create bind group layout system
4. Port `mesh` shaders as proof of concept

### Phase 3: Pipeline System (Week 5-6)

1. Implement pipeline cache
2. Create pipeline descriptors for all variants
3. Implement render pass encoding
4. Port `MeshRenderable` to WebGPU

### Phase 4: Remaining Renderables (Week 7-10)

1. Port `SpheresRenderable` (ray-cast impostors)
2. Port `CylindersRenderable`
3. Port `TextRenderable` (SDF text)
4. Port `DirectVolumeRenderable`
5. Port remaining renderables

### Phase 5: Advanced Features (Week 11-12)

1. Implement WBOIT transparency
2. Implement DPOIT transparency
3. Port post-processing effects (SSAO, outline, FXAA)
4. Implement picking system

### Phase 6: Integration & Testing (Week 13-14)

1. Integrate with `mol-canvas3d`
2. Add backend toggle to viewer
3. Performance benchmarking
4. Bug fixes and optimization

---

## 10. Testing Strategy

### 10.1 Unit Tests

- Buffer creation and data upload
- Texture creation and sampling
- Pipeline creation with various states
- Bind group layout compatibility

### 10.2 Visual Regression Tests

- Render reference images with WebGL
- Compare WebGPU output pixel-by-pixel
- Test all representation types
- Test all color themes

### 10.3 Performance Tests

- Draw call throughput
- Large molecule rendering (1M+ atoms)
- Memory usage comparison
- Frame time consistency

---

## 11. Known Challenges

### 11.1 Multi-Draw Absence

WebGPU lacks multi-draw extensions. Workarounds:
- Use indirect draw with compute-generated commands
- Batch geometry into larger buffers
- Accept more draw calls (WebGPU overhead is lower)

### 11.2 Provoking Vertex

WebGL uses last vertex for flat shading by default. WebGPU uses first vertex.
- May need to adjust index buffer generation
- Or use `@interpolate(flat, first)` in WGSL

### 11.3 Depth Range

WebGL: depth range [-1, 1] (can be configured)
WebGPU: depth range [0, 1]
- Adjust projection matrices accordingly

### 11.4 Texture Formats

Some WebGL texture formats don't map directly:
- `LUMINANCE` → Use `r8unorm` with swizzle in shader
- `LUMINANCE_ALPHA` → Use `rg8unorm` with swizzle

### 11.5 Browser Support

As of 2024, WebGPU support:
- Chrome: Full support
- Firefox: Behind flag
- Safari: Partial support
- Mobile: Limited

Always maintain WebGL fallback.

---

## 12. Resources

### Documentation
- [WebGPU Specification](https://www.w3.org/TR/webgpu/)
- [WGSL Specification](https://www.w3.org/TR/WGSL/)
- [WebGPU Fundamentals](https://webgpufundamentals.org/)

### Tools
- [naga](https://github.com/gfx-rs/naga) - Shader translation
- [wgpu](https://github.com/gfx-rs/wgpu) - Reference implementation
- [Tint](https://dawn.googlesource.com/tint) - Google's WGSL compiler

### Examples
- [WebGPU Samples](https://webgpu.github.io/webgpu-samples/)
- [three.js WebGPU Renderer](https://github.com/mrdoob/three.js/tree/dev/src/renderers/webgpu)

---

## 13. Implementation Progress Report

**Last Updated:** 2026-01-23

### 13.1 Phase 1 Status: ✅ COMPLETE

The foundation layer has been implemented. All files compile without errors.

#### GPU Abstraction Layer (`src/mol-gl/gpu/`)

| File | Status | Description |
|------|--------|-------------|
| `index.ts` | ✅ | Module exports |
| `context.ts` | ✅ | `GPUContext` interface, `GPULimits`, `GPUStats`, backend detection utilities |
| `context-factory.ts` | ✅ | `createGPUContext()` factory, `getAvailableBackends()`, `getBackendSupportInfo()`, `getBackendFeatures()` |
| `buffer.ts` | ✅ | `Buffer` interface, `BufferDescriptor`, usage types, data types |
| `texture.ts` | ✅ | `Texture`, `TextureView`, `Sampler` interfaces with all format types |
| `bind-group.ts` | ✅ | `BindGroup`, `BindGroupLayout`, `PipelineLayout` interfaces |
| `pipeline.ts` | ✅ | `RenderPipeline`, `ComputePipeline`, `ShaderModule` interfaces, all state types |
| `render-pass.ts` | ✅ | `CommandEncoder`, `RenderPassEncoder`, `ComputePassEncoder` interfaces |

#### WebGPU Backend (`src/mol-gl/webgpu/`)

| File | Status | Lines | Description |
|------|--------|-------|-------------|
| `index.ts` | ✅ | ~10 | Module exports |
| `context.ts` | ✅ | ~1050 | Full `GPUContext` implementation with all resource creation methods |
| `pipeline-cache.ts` | ✅ | ~280 | `PipelineCache` class, `PipelineKey` interface, blend/depth state helpers, `CommonPipelineKeys` presets |
| `webgpu-types.d.ts` | ✅ | ~500 | Complete WebGPU TypeScript type declarations |

#### WGSL Shader System (`src/mol-gl/shader/wgsl/`)

| File | Status | Description |
|------|--------|-------------|
| `index.ts` | ✅ | Module exports |
| `shader-module.ts` | ✅ | `ShaderModuleManager` class, `WGSLPreprocessor`, `createShaderVariants()` |
| `chunks/common.wgsl.ts` | ✅ | Common utilities: math, packing, color space, depth functions |
| `chunks/uniforms.wgsl.ts` | ✅ | Uniform structs: `FrameUniforms`, `LightUniforms`, `MaterialUniforms`, `ObjectUniforms` |
| `mesh.wgsl.ts` | ✅ | Proof-of-concept mesh shader with vertex + color/pick/depth fragments |

### 13.2 Key Implementation Decisions

#### Bind Group Organization
```
Group 0: Per-Frame (FrameUniforms, LightUniforms)
  - Camera matrices, viewport, time
  - Lighting parameters

Group 1: Per-Material (MaterialUniforms)
  - Base color, interior color
  - Material properties (alpha, metalness, roughness)
  - Rendering flags

Group 2: Per-Object (ObjectUniforms, instance storage buffer)
  - Transform matrices
  - Object/instance IDs
  - Bounding box
```

#### Pipeline Cache Strategy
- Lazy pipeline creation on first use
- JSON-stringified `PipelineKey` for cache lookup
- Supports all Mol* render variants: `color`, `pick`, `depth`, `marking`, `emissive`, `tracing`
- Pre-defined keys in `CommonPipelineKeys` for common configurations

#### WebGPU Context Features
- Async initialization via `createWebGPUContext()`
- Full resource creation: buffers, textures, samplers, bind groups, pipelines
- Command encoding with render/compute passes
- Device loss handling
- Async pixel reading via `readPixelsAsync()`

### 13.3 Files Created

```
src/mol-gl/
├── gpu/                           # NEW: Abstract GPU interface
│   ├── index.ts
│   ├── context.ts                 # GPUContext interface
│   ├── context-factory.ts         # Backend selection factory
│   ├── buffer.ts                  # Buffer interface
│   ├── texture.ts                 # Texture/Sampler interfaces
│   ├── bind-group.ts              # BindGroup/Layout interfaces
│   ├── pipeline.ts                # Pipeline interfaces
│   └── render-pass.ts             # CommandEncoder interfaces
├── webgpu/                        # NEW: WebGPU implementation
│   ├── index.ts
│   ├── context.ts                 # Full WebGPU context (~1050 lines)
│   ├── pipeline-cache.ts          # Pipeline caching system
│   ├── renderable.ts              # WebGPU renderable base class
│   ├── webgpu-types.d.ts          # TypeScript type declarations
│   └── renderable/                # Concrete renderable implementations
│       ├── index.ts
│       └── mesh.ts                # WebGPU mesh renderable
└── shader/
    └── wgsl/                      # NEW: WGSL shaders
        ├── index.ts
        ├── shader-module.ts       # Shader compilation manager
        ├── mesh.wgsl.ts           # Mesh shader (color/pick/depth variants)
        ├── spheres.wgsl.ts        # Ray-cast impostor spheres
        ├── cylinders.wgsl.ts      # Ray-cast impostor cylinders
        ├── points.wgsl.ts         # Point primitives
        ├── lines.wgsl.ts          # Wide line primitives
        ├── text.wgsl.ts           # SDF text rendering
        └── chunks/
            ├── common.wgsl.ts         # Common utilities (math, packing, color space)
            ├── uniforms.wgsl.ts       # Uniform buffer structs
            ├── read-from-texture.wgsl.ts  # Texture sampling utilities
            ├── lighting.wgsl.ts       # PBR lighting functions
            ├── fog.wgsl.ts            # Fog calculations
            ├── transparency.wgsl.ts   # WBOIT and DPOIT implementations
            ├── color.wgsl.ts          # Color assignment utilities
            ├── marker.wgsl.ts         # Highlight/selection markers
            ├── clipping.wgsl.ts       # Clipping planes and objects
            ├── size.wgsl.ts           # Size assignment and LOD
            └── interior.wgsl.ts       # Interior coloring and x-ray
```

### 13.4 Phase 2 Progress: Shader System

#### Completed WGSL Shader Chunks

| File | Status | Description |
|------|--------|-------------|
| `read-from-texture.wgsl.ts` | ✅ | Texture sampling utilities, 3D-from-2D emulation |
| `lighting.wgsl.ts` | ✅ | PBR lighting, Blinn-Phong, cel shading, bump mapping |
| `fog.wgsl.ts` | ✅ | Distance fog, transparent background handling |
| `transparency.wgsl.ts` | ✅ | WBOIT and DPOIT implementations |
| `color.wgsl.ts` | ✅ | Color assignment from all sources (texture, volume, attribute) |
| `marker.wgsl.ts` | ✅ | Highlighting and selection markers |
| `clipping.wgsl.ts` | ✅ | Clip planes, spheres, cubes, cylinders |
| `size.wgsl.ts` | ✅ | Size assignment, LOD, screen/world size conversion |
| `interior.wgsl.ts` | ✅ | Interior coloring, x-ray shading |

#### Completed WGSL Shaders

| File | Status | Lines | Description |
|------|--------|-------|-------------|
| `mesh.wgsl.ts` | ✅ | ~260 | Mesh shader with color/pick/depth variants |
| `spheres.wgsl.ts` | ✅ | ~650 | Ray-cast impostor spheres with projection optimizations |
| `cylinders.wgsl.ts` | ✅ | ~650 | Ray-cast impostor cylinders with caps and solid interior |
| `points.wgsl.ts` | ✅ | ~300 | Point primitives with circle/fuzzy styles |
| `lines.wgsl.ts` | ✅ | ~350 | Wide line primitives with screen-space width |
| `text.wgsl.ts` | ✅ | ~400 | SDF text rendering with border and background |

#### Phase 2 Status: ✅ COMPLETE

All core shaders for Phase 2 have been ported:
- ✅ Mesh shader (standard geometry)
- ✅ Spheres shader (ray-cast impostors)
- ✅ Cylinders shader (ray-cast impostors)
- ✅ Points shader (screen-space quads)
- ✅ Lines shader (wide lines)
- ✅ Text shader (SDF rendering)

#### Phase 2: Remaining Optional Tasks
- [ ] Create shader variant system with defines/overrides (can be done during Phase 3)

#### Phase 3 Status: 🔄 IN PROGRESS

Completed:
- ✅ Create `WebGPURenderable` base class (`webgpu/renderable.ts`)
- ✅ Create `WebGPURenderableBase` abstract class with common functionality
- ✅ Port `MeshRenderable` to WebGPU (`webgpu/renderable/mesh.ts`)
- ✅ Implement bind group layout creation
- ✅ Implement vertex buffer upload and versioning

Remaining:
- [ ] Implement full bind group management with uniform updates
- [ ] Implement vertex buffer layout generation from schema
- [ ] Handle dynamic uniform updates
- [ ] Port remaining renderables (SpheresRenderable, CylindersRenderable, etc.)

#### Phase 4: Remaining Renderables
- [ ] `SpheresRenderable` (most complex - ray marching)
- [ ] `CylindersRenderable`
- [ ] `TextRenderable`
- [ ] `DirectVolumeRenderable`
- [ ] `PointsRenderable`, `LinesRenderable`, `ImageRenderable`

#### Phase 5: Advanced Features
- [ ] WBOIT transparency (dual render targets)
- [ ] DPOIT transparency (multi-pass)
- [ ] Post-processing: SSAO, outlines, FXAA, bloom
- [ ] Picking system with GPU readback
- [ ] Compute shader ports (histogram pyramid, marching cubes)

#### Phase 6: Integration
- [ ] Create WebGL adapter implementing `GPUContext` interface
- [ ] Integrate with `mol-canvas3d`
- [ ] Add backend toggle to viewer settings
- [ ] Visual regression tests
- [ ] Performance benchmarks

### 13.5 Usage Example

```typescript
import { createGPUContext, getBackendSupportInfo } from 'mol-gl/gpu';

// Check support
const support = getBackendSupportInfo();
console.log(`Recommended backend: ${support.recommended}`);

// Create context
const context = await createGPUContext({
    canvas: document.getElementById('canvas') as HTMLCanvasElement,
    preferredBackend: 'webgpu', // or 'webgl' or 'auto'
});

// Create resources
const buffer = context.createBuffer({
    size: 1024,
    usage: ['vertex', 'copy-dst'],
});

const texture = context.createTexture({
    size: [512, 512],
    format: 'rgba8unorm',
    usage: ['texture-binding', 'render-attachment'],
});

// Render
const encoder = context.createCommandEncoder();
const pass = context.beginRenderPass(encoder, {
    colorAttachments: [{
        view: texture.createView(),
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: [0, 0, 0, 1],
    }],
});
// ... set pipeline, bindgroups, draw ...
pass.end();
context.submit([encoder.finish()]);
```

### 13.6 Notes for Continuing Implementation

1. **TypeScript Compilation**: All new files compile cleanly. Run `npx tsc --noEmit` to verify.

2. **WebGPU Types**: Custom type declarations in `webgpu-types.d.ts`. Consider installing `@webgpu/types` package for production.

3. **Testing WebGPU**: Requires Chrome 113+ or Firefox with `dom.webgpu.enabled` flag. Use Chrome DevTools for GPU debugging.

4. **Shader Migration Priority**:
   - Start with simpler shaders (points, lines) before complex ones (spheres, volume)
   - The mesh shader serves as a template for the pattern

5. **Depth Range**: WebGPU uses [0, 1] vs WebGL's [-1, 1]. The projection matrix helpers in `common.wgsl.ts` should account for this.

6. **Instance Data**: Currently using storage buffers for instance transforms. This allows unlimited instances without attribute divisor limits.

7. **Pipeline Cache**: The `PipelineCache` class handles the permutation explosion. Register pipeline creators per shader, and the cache handles variant creation.
