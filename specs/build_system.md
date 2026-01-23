# Mol* Build System Specification

This document details the build system used in Mol*, which relies primarily on `esbuild` and custom Node.js scripts.

## Overview

The build process is managed by `scripts/build.mjs`. It handles:
1.  Bundling applications and examples.
2.  Compiling SASS/CSS themes.
3.  Managing static assets.
4.  Serving the application in development mode.

The core library (`lib/`) is built separately using TypeScript (`tsc`), as described in [Development](./development.md).

## Build Script (`scripts/build.mjs`)

The script is a CLI wrapper around the `esbuild` API.

### Usage

```bash
node scripts/build.mjs [options]
```

### Arguments

-   `--prd`: Create a production build (minified, no source maps by default).
-   `--no-src-map`: Disable source maps.
-   `-a, --apps [names]`: Build specific applications. If no names are provided, builds all apps.
-   `-e, --examples [names]`: Build specific examples.
-   `-bt, --browser-tests [names]`: Build specific browser tests.
-   `-p, --port [number]`: Port for the development server (default: 1338).
-   `--host`: Display all available host addresses.

### Configuration

The script defines lists of targets:
-   **Apps**: `viewer`, `docking-viewer`, `mesoscale-explorer`, `mvs-stories`.
-   **Examples**: `proteopedia-wrapper`, `basic-wrapper`, `lighting`, etc.

### Output Structure

The build artifacts are placed in the `build/` directory:

```text
build/
├── viewer/
│   ├── molstar.js      # Bundled JS
│   ├── index.html      # Copied from src/apps/viewer
│   └── images/         # Copied assets
├── examples/
│   └── [example-name]/
│       └── index.js
└── ...
```

## Esbuild Configuration

The build configuration uses several plugins and settings:

### Plugins
1.  **`file-loader`**: Handles static assets.
    -   Copies `.jpg` files to an `images/` subdirectory.
    -   Copies `.html` and `.ico` files to the output root.
2.  **`esbuild-sass-plugin`**: Compiles SASS files to CSS.
3.  **`examplesCssRenamePlugin`**: Renames `index.css` to `molstar.css` for examples.

### Key Settings
-   **`bundle: true`**: Bundles all dependencies.
-   **`minify`**: Enabled if `--prd` is passed.
-   **`sourcemap`**: Enabled unless `--no-src-map` is passed.
-   **`globalName`**: Sets the global variable name for the bundle (default: `molstar`).
-   **`define`**: Injects build-time constants:
    -   `process.env.NODE_ENV`: 'production' or 'development'.
    -   `__MOLSTAR_PLUGIN_VERSION__`: From `package.json`.
    -   `__MOLSTAR_BUILD_TIMESTAMP__`: Current timestamp.

## Development Server

When run without specific build targets (or with `npm run dev`), the script:
1.  Performs an initial build of the requested targets.
2.  Starts a local HTTP server using `esbuild.context().serve()`.
3.  Serves files from the project root (`./`).
4.  Watches for file changes and rebuilds automatically.
5.  Supports HTTPS if `dev.pem` and `dev-key.pem` are present.

## Theme Building

For apps that support themes (like `viewer`), the script also builds theme-specific JS files (e.g., `build/viewer/theme/light.js`). These are built separately from the main bundle.
