# State Management System

The `mol-state` module is the heart of the Mol* application framework. It manages the application's data flow, ensuring that derived data (like visual representations) is automatically updated when the source data (like a loaded file) changes.

## Core Concepts

The system is built around a few key abstractions:

### 1. StateObject
A `StateObject` represents a piece of data in the application. It acts as a wrapper around the actual data (e.g., a `Model`, `Structure`, or `Mesh`) and provides metadata like `type`, `label`, and `description`.

-   **Type**: Defines the kind of data (e.g., `PluginStateObject.Molecule.Structure`).
-   **Data**: The actual payload.

### 2. StateTransform
A `StateTransform` represents the *definition* or *intent* to create a `StateObject`. It is a node in the state tree.

-   **Transformer**: The "function" logic that performs the work (e.g., "Parse CIF", "Create Cartoon").
-   **Params**: The arguments for the transformer.
-   **Ref**: A unique identifier for this node in the tree.

### 3. StateTree
The `StateTree` is an immutable data structure that describes the hierarchy of transforms. It does not hold the data itself, but rather the recipe for creating it.

### 4. StateObjectCell
The `StateObjectCell` binds a `StateTransform` (the recipe) to its resulting `StateObject` (the data). It tracks the status of the object:
-   `Pending`: Being calculated.
-   `Ok`: Successfully created.
-   `Error`: Failed to create.

## The State Lifecycle

The `State` class manages the lifecycle of transforms and objects.

1.  **Reconciliation**: When the `StateTree` is modified, the system calculates the difference (diff) between the old tree and the new one.
2.  **Apply**: For new nodes, the `Transformer.apply` method is called to create the initial `StateObject`.
3.  **Update**: For modified nodes (where `params` changed), the `Transformer.update` method is called.
    -   **UpdateResult.Unchanged**: The object remains as is.
    -   **UpdateResult.Updated**: The object was modified in-place (fast).
    -   **UpdateResult.Recreate**: The object must be destroyed and re-created (slow).
4.  **Dispose**: When a node is removed, the `Transformer.dispose` method is called to free resources (e.g., WebGL buffers).

## StateBuilder

The `StateBuilder` provides a fluent API for modifying the state tree. It allows you to "draft" a sequence of changes and apply them atomically.

```typescript
const update = state.build();

update
    .to(root)
    .apply(ParseCif, { ... })
    .apply(TrajectoryFromMmCif)
    .apply(ModelFromTrajectory)
    .apply(StructureFromModel);

await update.commit();
```

## Transformers

A `Transformer` is the definition of an operation. It defines:
-   **from**: The input `StateObject` type.
-   **to**: The output `StateObject` type.
-   **params**: The schema for the parameters.
-   **apply**: The async function that performs the work.

This strict typing allows the system to validate the state tree and ensure that only compatible operations are chained together.
