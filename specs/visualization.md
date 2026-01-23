# Mol* Visualization Specification

This document details the architecture and implementation of the visualization subsystem in Mol*. It explains how the engine transforms abstract data into interactive 3D graphics.

## 1. Architecture Overview

The visualization pipeline acts as a bridge between the State (data) and the Screen (pixels).

**Data Flow:**
`State` -> `Representation` (Visuals) -> `Geometry` (`mol-geo`) -> `RenderObject` -> `Renderable` (`mol-gl`) -> `WebGL`

### Key Modules

*   **`src/mol-canvas3d`**: The high-level orchestrator. Manages the scene, camera, input, and the main render loop.
*   **`src/mol-gl`**: The low-level rendering engine. Handles WebGL context, shaders, buffers, and draw calls.
*   **`src/mol-geo`**: Defines geometric primitives (Mesh, Spheres, etc.) and their attributes.
*   **`src/mol-repr`**: Defines how biological data (Structures, Volumes) maps to Geometry.
*   **`src/mol-theme`**: Defines visual properties like coloring and sizing.

---

## 2. The Rendering Loop (`mol-canvas3d`)

The `Canvas3D` class (`src/mol-canvas3d/canvas3d.ts`) is the entry point for 3D visualization. It initializes the WebGL context and manages the frame loop.

### The `Scene`
`Canvas3D` maintains a `Scene` object which holds lists of `RenderObject`s.
*   Objects are grouped by their rendering requirements (e.g., Opaque, Transparent/Blended).
*   The Scene is updated whenever Representations are created, updated, or destroyed.

### The Renderer (`src/mol-gl/renderer.ts`)
The `Renderer` executes the actual draw calls. It supports multiple passes:
1.  **Depth Pass**: Renders depth for occlusion culling or depth-aware effects.
2.  **Opaque Pass**: Renders solid geometry.
3.  **Blended Pass**: Renders transparent geometry. Supports Weighted Blended Order-Independent Transparency (WBOIT) or Depth Peeling (DPOIT).
4.  **Pick Pass**: Renders object IDs to an off-screen buffer for interaction (see Section 6).
5.  **Post-Processing**: Applies effects like Outline, SSAO (Screen Space Ambient Occlusion), and FXAA.

---

## 3. Geometry & Data (`mol-geo` & `mol-gl`)

### Geometric Primitives
`mol-geo` defines the shapes that can be rendered. These are highly optimized for molecular data:
*   **`Mesh`**: Generic triangle meshes (surfaces, ribbons).
*   **`Spheres`**: Ray-casted sphere impostors. Extremely efficient for rendering thousands of atoms.
*   **`Cylinders`**: Ray-casted cylinder impostors (bonds).
*   **`Text`**: SDF (Signed Distance Field) text for high-quality labels at any zoom level.
*   **`DirectVolume`**: Volume rendering via raymarching.

### RenderObject vs. Renderable
*   **`GraphicsRenderObject`**: A plain JavaScript object describing *what* to render. It contains `Values` (uniforms, attributes), `state` (depth test, blending), and a reference to the `Shader`.
*   **`Renderable`**: The WebGL-resource-backed version of a RenderObject. When a RenderObject is added to the Scene, `mol-gl` compiles the shader and creates the necessary WebGL buffers (VBOs, VAOs) to create a `Renderable`.

---

## 4. Representations & Visuals (`mol-repr`)

`Representation` is the logic layer that decides *how* to represent data.

### Hierarchy
*   **`Representation`**: The top-level container (e.g., "Cartoon Representation"). Manages one or more Visuals.
*   **`Visual`**: The worker unit. A single representation might need multiple visuals (e.g., a "Ball & Stick" representation uses a `SpheresVisual` for atoms and a `CylindersVisual` for bonds).

### Lifecycle (`createOrUpdate`)
Visuals are stateful. The `createOrUpdate` method determines the most efficient way to reflect changes:
1.  **New Data**: Rebuild the geometry from scratch (Expensive).
2.  **New Color/Size**: Update only the attribute buffers (Fast).
3.  **New Transform**: Update the transform uniform (Instant).

---

## 5. Theming (`mol-theme`)

Theming separates the "shape" of data from its "look".

*   **`LocationIterator`**: An abstraction to iterate over the semantic elements of the data (e.g., atoms, residues).
*   **`ColorTheme`**: A function mapping a `Location` to a `Color`.
*   **`SizeTheme`**: A function mapping a `Location` to a generic size factor.

**Integration**:
When a Visual builds geometry, it iterates over the data using the `LocationIterator`. For each element, it samples the Color and Size themes and writes the values to the corresponding geometry attribute arrays (or textures for large datasets).

---

## 6. Interaction (`picking`)

Mol* uses a GPU-based picking system for precise interaction, handled by `PickHelper` and `Canvas3dInteractionHelper`.

### The ID Buffer
Every renderable element is assigned a unique 3-part ID:
1.  **`objectId`**: Identifies the specific `RenderObject`.
2.  **`instanceId`**: Identifies the instance (if using GPU instancing).
3.  **`groupId`**: Identifies the primitive within the geometry (e.g., the specific atom index).

### The Pick Pass
1.  When the mouse moves, the scene is rendered to a small off-screen framebuffer.
2.  Instead of colors, the shader outputs the 3-part ID encoded as a color.
3.  The engine reads the pixel under the cursor.
4.  The color is decoded back into the ID.

### Loci Resolution
The ID is passed back to the `Representation` which created the object. The Representation translates the ID (specifically the `groupId`) back into a semantic **`Loci`** (Location of Interest).
*   *Example*: `groupId: 42` -> "Residue 10, Atom CA".

This `Loci` is then used for:
*   **Highlighting**: A temporary visual overlay.
*   **Selection**: Permanent selection state.
*   **Tooltips**: Displaying information labels.