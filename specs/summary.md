# Mol* Project Specification Summary

This folder contains the technical specifications and documentation for the Mol* (molstar) project.

## What is Mol*?

Mol* is a modern, comprehensive, and performant library for molecular visualization and analysis. It is built with TypeScript and WebGL, designed to handle large macromolecular assemblies and volumetric data directly in the browser.

## Documentation Index

The specification is split into several documents to cover different aspects of the system:

### 1. High-Level Architecture
-   **[Architecture](./architecture.md)**: Overview of the system layers, directory structure, and main entry points. Start here to understand the big picture.

### 2. Core Components
-   **[Modules](./modules.md)**: Detailed breakdown of the core packages (`mol-data`, `mol-model`, `mol-gl`, etc.) and their responsibilities.
-   **[Data Structures](./data_structures.md)**: Explanation of key classes like `Model`, `Structure`, and `Column` that form the backbone of the data layer.
-   **[State Management](./state_management.md)**: Deep dive into the `mol-state` reactive data flow system, including Transforms, Objects, and the State Tree.
-   **[Visualization](./visualization.md)**: Detailed pipeline from data to pixels, covering `mol-repr`, `mol-geo`, and `mol-gl`.
-   **[Computation](./computation.md)**: Task management, parallelism, and performance strategies (`mol-task`).
-   **[MolQL Query Language](./molql.md)**: Specification of the Mol* Query Language, its AST, and how to write and compile selection queries.

### 3. Application & Tools
-   **[Applications](./apps.md)**: Documentation for the various applications found in `src/apps` (Viewer, Docking Viewer, Mesoscale Explorer, etc.).
-   **[UI Components](./ui_components.md)**: Architecture and key components of the React-based user interface (`mol-plugin-ui`).
-   **[CLI Tools](./cli_tools.md)**: Documentation for the standalone command-line utilities found in `src/cli`.
-   **[Servers](./servers.md)**: Documentation for the server-side components found in `src/servers`.
-   **[Extensions](./extensions.md)**: A guide to the plugin's extension system and a list of available standard extensions (e.g., `pdbe`, `mvs`, `meshes`).

### 4. Developer Guide
-   **[Development](./development.md)**: Instructions for setting up the environment, running tests, and deployment.
-   **[Build System](./build_system.md)**: Detailed specification of the build scripts, configuration, and bundling process.

## Key Directories

-   `src/`: Source code.
-   `lib/`: Compiled output (CommonJS).
-   `build/`: Bundled applications.
-   `examples/`: Usage examples and scripts.
