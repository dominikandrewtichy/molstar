# Development Specification

This document outlines the development workflows, scripts, and environment setup for the Mol* project.

## Prerequisites

-   **Node.js**: Version 20.0.0 or higher is required.
-   **npm**: Used for dependency management and script execution.

## Setup

1.  Clone the repository.
2.  Install dependencies:
    ```bash
    npm install
    ```
    *Note: The `test` script installs `gl` (headless WebGL) on demand.*

## Build System

The project uses `tsc` (TypeScript Compiler) and custom scripts for building.

### Key Scripts

-   **`npm run build`**: Builds both applications and the library.
-   **`npm run build:lib`**: Builds the core library (`lib/`). Uses `tsc --incremental` and `tsc --build tsconfig.commonjs.json`.
-   **`npm run build:apps`**: Builds the applications (Viewer, etc.) into `build/`. Uses `scripts/build.mjs`.
-   **`npm run clean`**: Cleans the `lib/` and `build/` directories.
-   **`npm run rebuild`**: Performs a clean build (`clean` + `build`).

### Development Server

-   **`npm run dev`**: Watch mode for development.
-   **`npm run serve`**: Starts a simple HTTP server on port 1338 to serve the `build/` directory.

## Quality Assurance

### Testing
-   **Framework**: Jest.
-   **Command**: `npm test` or `npm run jest`.
-   **Configuration**: Defined in `package.json` under `jest`. Transforms TypeScript using `esbuild-jest-transform`.

### Linting
-   **Tool**: ESLint.
-   **Command**: `npm run lint`.
-   **Fix**: `npm run lint-fix`.

### Performance Testing
-   **Framework**: Benchmark.js.
-   **Location**: `src/perf-tests`.
-   **Execution**: Tests are compiled to CommonJS and run via Node.js.
    ```bash
    # Build the library first
    npm run build:lib
    # Run a specific benchmark
    node lib/commonjs/perf-tests/structure/selection.js
    ```
    *Note: There is no unified runner script; tests are run individually.*

## Deployment

-   **`npm run deploy:local`**: Deploys to a local directory.
-   **`npm run deploy:remote`**: Deploys to a remote server (details in `scripts/deploy.js`).

## Continuous Integration (CI)

The project uses GitHub Actions for CI/CD, defined in `.github/workflows/`.

-   **Build Workflow (`node.yml`)**:
    -   Triggers on push/PR to `master`.
    -   Sets up Node.js 20.
    -   Runs `npm ci` to install dependencies.
    -   Installs `xvfb` (X virtual framebuffer) for headless WebGL testing.
    -   Runs Lint (`npm run lint`).
    -   Runs Tests (`npm test`) using `xvfb-run` and `gl` (headless WebGL).
    -   Runs Build (`npm run build`).

## Project Structure (Build Artifacts)

-   `src/`: Source code.
-   `lib/`: Compiled JavaScript (CommonJS and ES modules) and type definitions.
    -   `lib/commonjs`: CommonJS output.
-   `build/`: Bundled applications (e.g., `build/viewer/`).

## Key Dependencies

-   **Runtime**:
    -   `react`, `react-dom`: UI rendering.
    -   `rxjs`: Reactive extensions for event handling.
    -   `immutable`: Immutable data structures.
-   **Dev**:
    -   `typescript`: The language.
    -   `esbuild`: Fast bundler/transformer.
    -   `gl`: Headless WebGL for testing.
