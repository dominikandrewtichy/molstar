# Mol* Core Modules

The `src/` directory contains several core modules prefixed with `mol-`. Each module is a separate package responsible for a specific domain.

## Foundation & Utilities

-   **`mol-util`**: General-purpose utilities, including:
    -   `Color`: Color manipulation and palettes.
    -   `BitFlags`: Efficient bitwise operations.
    -   `RxJS` extensions: For reactive programming.
    -   `Input/Output`: File handling abstractions.

-   **`mol-math`**: Mathematical primitives and algorithms.
    -   Linear algebra (Vectors, Matrices, Quaternions).
    -   Geometry (Spheres, Boxes, Frustums).

-   **`mol-io`**: Input/Output handling for various file formats.
    -   CIF/mmCIF parsing and writing.
    -   BinaryCIF (BCIF) support.

## Data & Model

-   **`mol-data`**: The database layer.
    -   `db`: Columnar database implementation (`Table`, `Column`).
    -   `int`: Integer utilities for efficient data indexing.

-   **`mol-model`**: Scientific domain model.
    -   `structure`: Representations of molecular structures (`Model`, `Structure`, `Unit`, `Atom`, `Residue`).
    -   `volume`: Representations of volumetric data (`Grid`, `Isovalue`).
    -   `shape`: Generic 3D shapes.

-   **`mol-model-formats`**: Converters from raw file formats (mmCIF, PDB, SDF) to the internal `mol-model` representations.

-   **`mol-model-props`**: Computed properties for models, such as secondary structure, solvent accessibility, etc.

## State & Logic

-   **`mol-state`**: The state management system.
    -   `StateObject`: Base class for all data objects in the state tree.
    -   `StateTransform`: Defines operations that transform data.
    -   `StateTree`: The immutable tree structure holding the application state.

-   **`mol-task`**: Task execution and progress tracking system. Allows for asynchronous, cancellable operations.

-   **`mol-script`**: A scripting language for selecting atoms and defining visual representations (MolScript).

## Rendering

-   **`mol-gl`**: Low-level WebGL 1/2 wrapper.
    -   `Shader`: Shader management.
    -   `Buffer`: Vertex and index buffer management.

-   **`mol-geo`**: Geometry generation.
    -   Creates meshes, spheres, cylinders, and text primitives from data.

-   **`mol-repr`**: Representation logic.
    -   Defines how to map `Structure` or `Volume` data to `mol-geo` primitives (e.g., Cartoon, Ball & Stick).

-   **`mol-theme`**: Coloring and sizing logic.
    -   `ColorTheme`: Defines how to color visual elements (e.g., by chain, by element).
    -   `SizeTheme`: Defines how to size visual elements.

-   **`mol-canvas3d`**: The 3D renderer.
    -   Manages the scene, camera, lighting, and post-processing effects.

## Application Framework

-   **`mol-plugin`**: The core application logic.
    -   `PluginContext`: Central controller.
    -   `Command`: Event-based command system.
    -   `Manager`: Specialized managers for focus, selection, camera, etc.

-   **`mol-plugin-state`**: Pre-defined state transforms and objects used by the plugin.

-   **`mol-plugin-ui`**: React components for the user interface.
    -   `Viewport`: The 3D canvas container.
    -   `Controls`: Sidebars and setting panels.
