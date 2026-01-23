# Mol* Architecture Overview

Mol* (molstar) is a comprehensive macromolecular library and application framework. It is designed to be modular, performant, and data-driven.

## Directory Structure

The project follows a monorepo-like structure where the source code is located in `src/` and compiled output in `lib/`.

-   `src/`: TypeScript source code.
    -   `mol-*`: Core modules (packages) that make up the library.
    -   `apps/`: Application entry points (e.g., Viewer, Docking Viewer).
    -   `cli/`: Command-line interface tools.
    -   `extensions/`: Optional extensions that add functionality to the plugin.
    -   `servers/`: Server-side implementations (Model Server, Volume Server).

## Core Layers

The architecture can be visualized as a stack of layers:

1.  **Data Layer (`mol-data`)**:
    -   Provides efficient, in-memory storage for large datasets using a columnar database approach (`Table`, `Column`).
    -   Handles parsing and encoding of data formats.

2.  **Scientific Model Layer (`mol-model`)**:
    -   Builds upon the data layer to represent physical concepts.
    -   **Model**: Represents raw molecular data (atoms, residues, chains) as imported from files.
    -   **Structure**: A higher-level representation suitable for analysis and rendering. It consists of one or more `Unit`s.
    -   **Volume**: Represents volumetric data (e.g., electron microscopy density maps).

3.  **State Management Layer (`mol-state`)**:
    -   Manages the application state as a tree of transformations.
    -   Every object in the scene (data, structure, representation) is a node in this tree.
    -   Transforms define how to go from one state to another (e.g., "Parse CIF" -> "Create Model" -> "Create Structure" -> "Create Visual").

4.  **Rendering Layer (`mol-canvas3d` & `mol-gl`)**:
    -   A specialized WebGL 1/2 rendering engine.
    -   `mol-gl`: Low-level WebGL abstractions.
    -   `mol-canvas3d`: High-level scene graph and rendering logic specific to molecular graphics.

5.  **Plugin Layer (`mol-plugin` & `mol-plugin-ui`)**:
    -   **PluginContext**: The central coordinator that ties state, rendering, and UI together.
    -   **PluginUI**: React-based user interface components.
    -   **Behaviors**: Logic that reacts to state changes or user input.

## Application Entry Points

-   **Viewer (`src/apps/viewer`)**: The primary web-based visualization tool. It initializes the `PluginUIContext` and exposes a `Viewer` class for external control.
-   **CLI Tools (`src/cli`)**: Standalone Node.js scripts for data processing (e.g., `cif2bcif`).

## Data Flow

1.  **Input**: Data is loaded from a URL or file (e.g., mmCIF, `.bcif`).
2.  **Parsing**: The data is parsed into a `Model` object.
3.  **Structure Creation**: A `Structure` is built from the `Model`, potentially applying symmetry or biological assembly rules.
4.  **Representation**: Visual representations (Cartoons, Ball-and-Stick, Surfaces) are generated from the `Structure`.
5.  **Rendering**: The representations are passed to the `Canvas3D` engine for drawing.

## Documentation Index

For more detailed information, please refer to the following specifications:

-   [Modules](./modules.md): Detailed breakdown of `mol-*` packages.
-   [Data Structures](./data_structures.md): Key classes like `Model`, `Structure`, and `Column`.
-   [CLI Tools](./cli_tools.md): Documentation for command-line utilities.
-   [Development](./development.md): Setup, build, test, and release workflows.
-   [Extensions](./extensions.md): Overview of the plugin extension system.
-   [Visualization](./visualization.md): Detailed pipeline from data to pixels.
-   [Computation](./computation.md): Task management, parallelism, and performance strategies.
