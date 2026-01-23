# Mol* Extensions Specification

Extensions are modular add-ons that enhance the functionality of the Mol* core plugin. They can provide new data loaders, custom visual representations, or integration with external services.

## Overview

-   **Location**: `src/extensions/`
-   **Mechanism**: Extensions typically register a `PluginBehavior` or add custom `StateTransform`s to the state tree.
-   **Activation**: Extensions can be enabled or disabled at runtime or during plugin initialization.

## Standard Extensions

The following extensions are included in the source tree:

### Visualization & Rendering
-   **`alpha-orbitals`**: Visualizes molecular orbitals.
-   **`dnatco`**: Visualizes nucleic acid conformers (Confal Pyramids).
-   **`interactions`**: Calculates and visualizes non-covalent interactions (H-bonds, halogen bonds, etc.).
-   **`assembly-symmetry`**: Visualizes biological assembly symmetry axes and cages.
-   **`backgrounds`**: Adds support for custom background rendering.
-   **`meshes`**: Tools for parsing and visualizing general mesh data from CIF files.

### Data Formats & IO
-   **`g3d`**: Support for the G3D file format.
-   **`json-cif`**: Utilities for handling CIF data in JSON format.
-   **`mvs`**: Implementation of the **MolViewSpec** standard for defining molecular scenes.
-   **`geo-export`**: Exports the 3D scene to geometry formats (e.g., OBJ, STL, GLTF) for use in other 3D software.
-   **`model-export`**: Exports molecular models to file formats like PDB or mmCIF.
-   **`mp4-export`**: Allows recording the canvas and exporting animations as MP4 videos.

### Domain Specific & Integrations
-   **`rcsb`**: RCSB PDB specific features, including validation report visualization.
-   **`pdbe`**: PDBe (Protein Data Bank in Europe) specific features.
-   **`wwpdb`**: WWPDB specific tools, such as Chemical Component Dictionary (CCD) handling.
-   **`sb-ncbr`**: Extensions for the South Bohemian National Centre for Biomodels and Research.
-   **`zenodo`**: Integration with Zenodo for loading datasets.
-   **`model-archive`**: Support for ModelArchive.org data loading.

### Volumetric
-   **`volumes-and-segmentations`**: specialized tools for handling and visualizing volumetric data and segmentations (e.g., from EMDB).
-   **`anvil`**: Implementation of the ANVIL algorithm for membrane assignment.

## creating an Extension

To create a new extension:
1.  Create a new directory in `src/extensions/`.
2.  Implement a `PluginBehavior` that defines the extension's lifecycle.
3.  Register any custom `StateTransform`, `Representation`, or `Theme`.
4.  Export the behavior for registration in the plugin.