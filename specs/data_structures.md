# Mol* Key Data Structures

Understanding the data structures in `mol-model` is crucial for working with Mol*.

## 1. Model (`src/mol-model/structure/model/model.ts`)

The `Model` represents the "static" data loaded from a file (like a PDB or mmCIF file). It contains the raw atomic coordinates, topology, and annotations.

-   **Immutable**: Once created, it is typically not modified.
-   **Content**:
    -   `atomicHierarchy`: Access to chains, residues, and atoms.
    -   `atomicConformation`: Access to x, y, z coordinates.
    -   `properties`: Additional data like secondary structure, symmetry assemblies, etc.

## 2. Structure (`src/mol-model/structure/structure/structure.ts`)

The `Structure` is the dynamic object used for rendering and analysis. It is a subset or assembly of a `Model`.

-   **Composition**: A `Structure` is composed of one or more `Unit`s.
-   **Dynamic**: You can create new structures by filtering (selection), assembling (symmetry), or superimposing existing ones.
-   **Loci**: Used for interaction (picking, highlighting). A `Loci` identifies a specific part of a `Structure`.

## 3. Unit (`src/mol-model/structure/structure/unit.ts`)

A `Unit` represents a group of atoms (typically a chain or part of a chain) that share the same transformation operator.

-   **Types**:
    -   `Unit.Atomic`: Standard atomic resolution data.
    -   `Unit.Coarse`: Coarse-grained representations (beads).
-   **Conformation**: Contains the `invariantId` (reference to the original data in `Model`) and the `operator` (symmetry transformation matrix).
-   **Optimization**: `Unit`s allow Mol* to render massive assemblies efficiently by instancing the same geometry multiple times with different transforms.

## 4. Column (`src/mol-data/db/column.ts`)

The fundamental storage unit.

-   **Typed**: Can store integers, floats, strings, etc.
-   **Memory Mapped**: Often backed by `TypedArray`s for performance.
-   **Access**: Provides `value(i)` to get the value at row `i`.

## Hierarchy Relationship

```mermaid
graph TD
    File[Input File] --> Model
    Model --> |Selection/Assembly| Structure
    Structure --> Unit1[Unit A (Transform 1)]
    Structure --> Unit2[Unit A (Transform 2)]
    Unit1 -.-> |Reference| Model
    Unit2 -.-> |Reference| Model
```
