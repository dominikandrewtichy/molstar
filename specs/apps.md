# Mol* Applications

The `src/apps` directory contains standalone applications built on top of the Mol* plugin framework. Each application is tailored for a specific use case, ranging from general-purpose visualization to specialized domains like mesoscale modeling and storytelling.

## 1. Mol* Viewer (`viewer`)

The standard, full-featured Mol* application. This is the primary entry point for general users and provides the most comprehensive set of features.

-   **Location**: `src/apps/viewer/`
-   **Entry Point**: `src/apps/viewer/app.ts`
-   **Key Features**:
    -   **Full Extension Support**: Includes standard extensions like RCSB Validation, PDBe Structure Quality, Volume Streaming, and more.
    -   **Comprehensive UI**: Offers the complete set of Mol* UI controls for structure manipulation, representation customization, and measurements.
    -   **Versatility**: Capable of handling a wide variety of data formats (mmCIF, PDB, SDF, Volume Data, Trajectories).

## 2. Docking Viewer (`docking-viewer`)

A specialized application designed for visualizing molecular docking results. It streamlines the process of comparing ligand poses and analyzing interactions.

-   **Location**: `src/apps/docking-viewer/`
-   **Entry Point**: `src/apps/docking-viewer/index.ts`
-   **Key Features**:
    -   **`MergeStructures` Transform**: A custom state transform (`MergeStructures`) that combines multiple structure files (e.g., a receptor and multiple ligands) into a single unified view.
    -   **Simplified UI**: A cleaner user interface with a white background by default, focused on clarity.
    -   **Custom Viewport Controls**: Specialized buttons for quick switching between presets:
        -   **Illustrative**: Simplified rendering for publication-quality figures.
        -   **Surface**: Molecular surface representation.
        -   **Interactions**: Visualizes non-covalent interactions between the ligand and receptor.

## 3. Mesoscale Explorer (`mesoscale-explorer`)

An application optimized for the visualization of large-scale biological systems ("mesoscale"), such as entire viruses, organelles, or cellular environments.

-   **Location**: `src/apps/mesoscale-explorer/`
-   **Entry Point**: `src/apps/mesoscale-explorer/app.ts`
-   **Key Features**:
    -   **Performance Optimization**: Restricts representations primarily to efficient `Spacefill` (spheres) to handle massive instance counts.
    -   **Custom Behaviors**:
        -   `MesoFocusLoci` & `MesoSelectLoci`: Specialized interaction behaviors optimized for dense scenes.
    -   **Graphics Modes**: offers specific "Quality" and "Performance" profiles to balance visual fidelity with rendering speed.
    -   **Specialized UI**: A custom layout with dedicated `LeftPanel` and `RightPanel` components to manage the complexity of mesoscale datasets (e.g., managing hundreds of distinct entity types).

## 4. MVS Stories (`mvs-stories`)

A tool for creating and viewing interactive molecular "stories" based on the MolViewSpec (MVS) standard.

-   **Location**: `src/apps/mvs-stories/`
-   **Entry Point**: `src/apps/mvs-stories/index.tsx`
-   **Key Features**:
    -   **MVS Integration**: Directly interprets MolViewSpec state files to drive the scene.
    -   **Narrative Flow**: Designed to present a sequence of views or states, allowing for guided tours or educational presentations.
    -   **React-based UI**: Uses React to render controls for navigating through the story steps.
