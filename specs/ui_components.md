# Mol* UI Components Specification

This document details the architecture and implementation of the `mol-plugin-ui` library, which provides the React-based user interface for Mol*.

## Architecture Overview

The UI layer is built on top of React and RxJS. It follows a reactive pattern where UI components subscribe to changes in the `PluginContext` (state, layout, tasks) and re-render accordingly.

### Key Technologies
-   **React**: View layer. Mixed usage of Class components (legacy/complex) and Functional components with Hooks.
-   **RxJS**: State management and event propagation.
-   **SASS**: Styling and theming system.

## 1. Plugin UI Context

The `PluginUIContext` (`src/mol-plugin-ui/context.ts`) is the central object that ties the UI together. It extends the core `PluginContext` and adds:

-   **`layout`**: Manages the visibility and state of UI regions (left panel, controls, log, etc.).
-   **`customParamEditors`**: Registry for custom parameter editors for State Transforms.
-   **`managers`**: specialized managers for drag-and-drop, focus, etc.

## 2. Base Components

### `PluginUIComponent` (`src/mol-plugin-ui/base.tsx`)
A base class for React Class components that need to interact with the plugin.
-   **`this.plugin`**: Access to the `PluginUIContext`.
-   **`subscribe(observable, callback)`**: Helper to subscribe to RxJS streams. automatically unsubscribes on `componentWillUnmount`.

### Hooks
-   **`useBehavior(observable)`**: A custom hook that subscribes to an RxJS `BehaviorSubject` and returns its current value, triggering a re-render on changes.

## 3. Layout System

The `Layout` component (`src/mol-plugin-ui/plugin.tsx`) manages the application shell. It divides the screen into 5 regions:

1.  **Main**: The 3D Viewport.
2.  **Top**: Sequence View or other top-level tools.
3.  **Left**: Data tree, file upload, and hierarchy navigation.
4.  **Right**: Controls panel (structure tools, representation settings).
5.  **Bottom**: Log output.

The visibility of these regions is controlled by `plugin.layout.state`.

## 4. Key Components

### Viewport (`src/mol-plugin-ui/viewport.tsx`)
The container for the 3D canvas.
-   **`ViewportCanvas`**: The actual wrapper around the DOM canvas element. Handles resizing and mounting the `Canvas3D` instance.
-   **`ViewportControls`**: Overlay buttons for common actions:
    -   **Reset Camera**: Centers the view.
    -   **Screenshot**: Tools for capturing images.
    -   **Controls**: Toggle for sidebars.
    -   **Settings**: Quick access to rendering settings (background, occlusion, etc.).

### Controls (`src/mol-plugin-ui/controls/`)
A library of generic UI inputs used throughout the application.
-   **`ParameterControls`**: Automatically generates UI for `PD.Params` (Parameter Definitions). This is used extensively to auto-generate UI for State Transforms.
-   **`Slider`, `Select`, `ColorPicker`**: Standard input components.

### Structure Tools (`src/mol-plugin-ui/structure/`)
The default content for the Right Panel.
-   **`StructureComponent`**: Manages representations (Cartoons, Surfaces) for a specific structure.
-   **`Measurements`**: Tools for distance, angle, and dihedral measurements.
-   **`Volume`**: Controls for density map visualization (ISO levels).

## 5. Theming (`src/mol-plugin-ui/skin/`)
Mol* uses SASS for styling.
-   **`base.scss`**: Core structural styles.
-   **Themes**: `light.scss`, `dark.scss`, `blue.scss` define color variables.

## 6. Customization
The UI is designed to be embedded and customized.
-   **`PluginSpec`**: Passed to `createPluginUI`, allows defining which standard components (controls, viewport, layout) to use or replace.
-   **`PluginReactContext`**: The context provider that allows deep custom components to access the plugin instance.
