# Computation and Task Management

Mol* employs a robust task management system to handle computations, ensuring the application remains responsive even during heavy processing. This document outlines the architecture and best practices for managing computations.

## Core Concepts

The system is built around the `mol-task` module, which provides abstractions for defining and executing asynchronous operations.

### Task

A `Task<T>` represents a lazy computation that produces a value of type `T`. Tasks are:
-   **Hierarchical**: Tasks can spawn child tasks, creating a progress tree.
-   **Abortable**: Computations can be cancelled at any point.
-   **Progress Tracking**: Tasks report progress (current/max) and status messages.

### RuntimeContext

The `RuntimeContext` is the execution environment provided to a running task. It is the bridge between the computation and the execution engine.

```typescript
interface RuntimeContext {
    readonly shouldUpdate: boolean;
    readonly isSynchronous: boolean;

    update(progress?: string | Partial<ProgressUpdate>, dontNotify?: boolean): Promise<void> | void;
}
```

-   **`shouldUpdate`**: A flag indicating if the task should report progress and yield control. This is typically true every ~250ms (configurable).
-   **`update()`**: Updates the progress and, critically, yields control back to the event loop (if running on the main thread) to allow for UI updates and user interaction.

## Execution Models

### 1. Cooperative Multitasking (Observable)

This is the primary model for long-running tasks on the client (browser).
-   **Mechanism**: The task runs on the main thread but chunked.
-   **Responsiveness**: By periodically calling `await ctx.update()`, the task pauses, allowing the browser to render frames and handle events.
-   **Usage**: Used for parsing, model construction, and property computation.

### 2. Synchronous

For tasks that must complete immediately or are known to be fast.
-   **Mechanism**: `await ctx.update()` is a no-op or synchronous.
-   **Usage**: Small data processing or when running in a non-interactive environment (CLI).

### 3. Parallelism (Workers & Cluster)

-   **Web Workers (Client)**: While supported at a low level (messaging), the core architecture prefers cooperative multitasking on the main thread for simplicity and shared state access. Specific modules (e.g., specific loaders) *may* use workers, but it is not the default for `mol-task`.
-   **Node.js Cluster (Server)**: The model server (`src/servers/model`) utilizes the Node.js `cluster` module to fork processes for parallel data preprocessing.

## Best Practices for Heavy Computations

When implementing a computationally intensive function (e.g., a custom property provider):

1.  **Accept `RuntimeContext`**: Always pass `ctx` to your compute function.
2.  **Check `shouldUpdate`**: Inside your main loop, check `ctx.shouldUpdate`.
3.  **Yield Control**: If `shouldUpdate` is true, call `await ctx.update({ ... })`.

**Example:**

```typescript
async function heavyCompute(ctx: RuntimeContext, data: LargeData) {
    for (let i = 0; i < data.length; i++) {
        // Perform chunk of work
        process(data[i]);

        // Check if we need to yield
        if (ctx.shouldUpdate) {
            await ctx.update({ current: i, max: data.length, message: 'Processing...' });
        }
    }
}
```

## Architecture

-   **`src/mol-task`**: Core task definitions and execution logic.
-   **`src/mol-plugin/util/task-manager.ts`**: Manages the list of running tasks in the plugin, handles progress reporting events, and UI overlays.
-   **`src/mol-model-props`**: Example usage where properties (like Secondary Structure) are computed via `CustomProperty.Provider` which utilizes `RuntimeContext`.
