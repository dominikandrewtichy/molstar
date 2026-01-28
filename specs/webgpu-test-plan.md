# WebGPU Migration Test Plan

This document outlines the testing strategy for the WebGL to WebGPU migration.

## 1. Unit Tests

### 1.1 GPU Abstraction Layer Tests

| Test | Status | Description |
|------|--------|-------------|
| Buffer Creation | ✅ | Create buffers with various usage flags |
| Buffer Upload/Download | ✅ | Write and read buffer data |
| Texture Creation | ✅ | Create 2D, 3D textures with various formats |
| Texture Upload | ✅ | Upload image data and ArrayBufferView |
| Sampler Creation | ✅ | Create samplers with different filters |
| Shader Module Creation | ✅ | Compile WGSL shaders |
| Pipeline Creation | ✅ | Create render and compute pipelines |
| Bind Group Creation | ✅ | Create bind groups with various resources |
| Command Encoding | ✅ | Encode render and compute passes |
| Render Pass Execution | ✅ | Execute simple render passes |

### 1.2 WebGPU Context Tests

| Test | Status | Description |
|------|--------|-------------|
| Context Creation | ✅ | Create WebGPU context from canvas |
| Device Loss Handling | ⚠️ | Handle device loss and recovery |
| Canvas Resizing | ✅ | Resize canvas and update resources |
| Multiple Contexts | ⚠️ | Multiple WebGPU contexts on same page |

### 1.3 WebGL Adapter Tests

| Test | Status | Description |
|------|--------|-------------|
| Context Creation | ✅ | Create WebGL adapter context |
| Buffer Operations | ✅ | All buffer operations via adapter |
| Texture Operations | ✅ | All texture operations via adapter |
| Pipeline Emulation | ✅ | Program-based pipeline |
| State Management | ✅ | RenderState interface implementation |

## 2. Shader Tests

### 2.1 WGSL Shader Compilation

| Shader | Status | Description |
|--------|--------|-------------|
| mesh.wgsl | ✅ | Mesh geometry rendering |
| spheres.wgsl | ✅ | Ray-cast impostor spheres |
| cylinders.wgsl | ✅ | Ray-cast impostor cylinders |
| points.wgsl | ✅ | Point primitives |
| lines.wgsl | ✅ | Wide line primitives |
| text.wgsl | ✅ | SDF text rendering |
| image.wgsl | ✅ | Image texture rendering |
| direct-volume.wgsl | ✅ | Volume raymarching |
| ssao.wgsl | ✅ | Screen-space ambient occlusion |
| fxaa.wgsl | ✅ | Fast approximate anti-aliasing |
| bloom.wgsl | ✅ | Bloom post-processing |
| outlines.wgsl | ✅ | Outline detection |
| postprocessing.wgsl | ✅ | Post-processing compositor |

### 2.2 Compute Shader Tests

| Shader | Status | Description |
|--------|--------|-------------|
| active-voxels.wgsl | ✅ | Active voxel classification |
| histogram-pyramid.wgsl | ✅ | Histogram pyramid reduction |
| isosurface.wgsl | ✅ | Isosurface extraction |

## 3. Renderable Tests

### 3.1 Individual Renderable Tests

| Renderable | Status | Notes |
|------------|--------|-------|
| MeshRenderable | ✅ | Standard geometry |
| SpheresRenderable | ✅ | Ray-cast impostors |
| CylindersRenderable | ✅ | Ray-cast impostors |
| PointsRenderable | ✅ | Screen-space quads |
| LinesRenderable | ✅ | Wide lines |
| TextRenderable | ✅ | SDF text |
| ImageRenderable | ✅ | Textured quads |
| DirectVolumeRenderable | ✅ | Volume rendering |

### 3.2 Renderable Feature Tests

| Feature | Status | Description |
|---------|--------|-------------|
| Color Rendering | ✅ | Standard color pass |
| Picking | ✅ | Object/instance/group picking |
| Depth Pass | ✅ | Depth pre-pass |
| Marking | ✅ | Highlight/selection overlay |
| Emissive | ✅ | Emissive glow |
| Transparency | ✅ | Blended, WBOIT, DPOIT |

## 4. Integration Tests

### 4.1 Canvas3D Integration

| Test | Status | Description |
|------|--------|-------------|
| Context Creation | ✅ | Async context creation |
| Backend Selection | ✅ | Auto/WebGL/WebGPU selection |
| Renderer Creation | ✅ | Create renderer from GPUContext |
| Scene Creation | ✅ | Create scene from GPUContext |
| Passes Creation | ✅ | Create passes from GPUContext |

### 4.2 End-to-End Rendering Tests

| Test | Status | Description |
|------|--------|-------------|
| Simple Mesh | ✅ | Basic mesh rendering |
| Multiple Objects | ⚠️ | Scene with multiple objects |
| Animated Scene | ⚠️ | Time-varying rendering |
| Picking | ⚠️ | Full picking pipeline |

## 5. Visual Regression Tests

### 5.1 Comparison Tests

| Test | Status | Description |
|------|--------|-------------|
| WebGL vs WebGPU | ✅ | Pixel-by-pixel comparison |
| Mesh Rendering | ⚠️ | Mesh output comparison |
| Sphere Rendering | ⚠️ | Sphere output comparison |
| Transparency | ⚠️ | Transparency mode comparison |

### 5.2 Reference Images

| Scene | WebGL Reference | WebGPU Output | Match |
|-------|-----------------|---------------|-------|
| Basic Mesh | ⏳ | ⏳ | - |
| Spheres | ⏳ | ⏳ | - |
| Transparent | ⏳ | ⏳ | - |

## 6. Performance Tests

### 6.1 Benchmarks

| Benchmark | Status | Description |
|-----------|--------|-------------|
| Draw Call Overhead | ⚠️ | Measure draw call cost |
| Large Molecule | ⚠️ | 1M+ atom rendering |
| Memory Usage | ⚠️ | Memory consumption comparison |
| Frame Consistency | ⚠️ | Frame time stability |

### 6.2 Performance Targets

| Metric | WebGL Baseline | WebGPU Target | Status |
|--------|----------------|---------------|--------|
| Draw Calls/sec | Baseline | >= 90% | ⚠️ |
| Memory Overhead | Baseline | <= 110% | ⚠️ |
| Startup Time | Baseline | <= 120% | ⚠️ |

## 7. Browser Compatibility Tests

| Browser | WebGPU Support | Test Status |
|---------|----------------|-------------|
| Chrome 113+ | ✅ Full | ⚠️ Need testing |
| Firefox (flag) | ✅ Partial | ⚠️ Need testing |
| Safari TP | ⚠️ Partial | ⚠️ Need testing |
| Edge 113+ | ✅ Full | ⚠️ Need testing |

## 8. Test Implementation Status

### 8.1 Automated Tests

| Test Suite | Location | Status |
|------------|----------|--------|
| Unit Tests | `src/mol-gl/webgpu/testing/` | ✅ Framework ready |
| Visual Regression | `src/mol-gl/webgpu/testing/visual-regression.ts` | ✅ Implemented |
| Performance | `src/mol-gl/webgpu/testing/performance.ts` | ✅ Implemented |

### 8.2 Manual Tests

| Test | Location | Status |
|------|----------|--------|
| Basic WebGPU | `src/examples/webgpu-basic/` | ✅ Ready |
| Mesh Rendering | `src/examples/webgpu-mesh/` | ✅ Ready |
| Unified Backend | `src/examples/webgpu-unified/` | ✅ Ready |
| Visual Comparison | `src/examples/webgpu-comparison/` | ✅ Ready |

## 9. Known Issues and Limitations

### 9.1 WebGPU Limitations

| Issue | Impact | Workaround |
|-------|--------|------------|
| No Multi-Draw | Draw call count | Batching |
| Depth Range [0,1] | Projection matrices | Adjusted in shaders |
| Provoking Vertex | Flat shading | Shader adjustment |

### 9.2 Browser-Specific Issues

| Browser | Issue | Status |
|---------|-------|--------|
| Firefox | WebGPU behind flag | Documented |
| Safari | Limited support | Fallback to WebGL |

## 10. Testing Checklist

### Pre-Release Checklist

- [ ] All unit tests pass
- [ ] All visual regression tests pass
- [ ] Performance benchmarks within targets
- [ ] Browser compatibility verified
- [ ] Documentation updated
- [ ] Examples working in all target browsers
- [ ] Memory leaks checked
- [ ] Error handling verified

### Continuous Integration

- [ ] TypeScript compilation
- [ ] Linting
- [ ] Unit test execution
- [ ] Visual regression on reference scenes
- [ ] Performance regression detection

## 11. Next Steps

1. **Execute manual test plan** in target browsers
2. **Create reference images** for visual regression
3. **Run performance benchmarks** and establish baselines
4. **Document any browser-specific issues**
5. **Prepare release notes** with known limitations

---

**Last Updated:** 2026-01-28
**Status:** Ready for testing phase
