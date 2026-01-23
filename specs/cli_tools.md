# Mol* CLI Tools

The `src/cli` directory contains standalone Node.js tools for processing molecular data. These are typically used for data preparation or server-side tasks.

## 1. CIF to BinaryCIF Converter (`cif2bcif`)

Converts text-based CIF files to the optimized BinaryCIF (`.bcif`) format.

-   **Location**: `src/cli/cif2bcif`
-   **Usage**:
    ```bash
    node lib/commonjs/cli/cif2bcif/index.js src.cif out.bcif
    ```
-   **Arguments**:
    -   `src`: Input file path.
    -   `out`: Output file path.
    -   `-c, --config`: Optional JSON config for encoding strategies.
    -   `-f, --filter`: Optional filter file.

## 2. Chemical Component Dictionary (`chem-comp-dict`)

Tools for handling the PDBe ChemComp dictionary.

-   **Location**: `src/cli/chem-comp-dict`
-   **Purpose**: managing and querying chemical component definitions.
-   **Sub-tools**:
    -   `create-ions.ts`: Generates ion definitions.
    -   `create-saccharides.ts`: Generates saccharide definitions.
    -   `create-table.ts`: Creates the chemical component table.

## 3. CIF Schema (`cifschema`)

Generates TypeScript interfaces and schema definitions from CIF dictionary files.

-   **Location**: `src/cli/cifschema`
-   **Purpose**: Used during development to ensure type safety when working with CIF data.

## 4. MolViewSpec (`mvs`)

Tools for MolViewSpec (MVS), a standard for defining molecular scenes.

-   **Location**: `src/cli/mvs`
-   **Sub-tools**:
    -   `mvs-validate`: Validates MVS data against the schema.
    -   `mvs-render`: Renders an MVS state (likely for screenshotting or testing).
    -   `mvs-print-schema`: Prints the MVS schema.

## 5. State Docs (`state-docs`)

Generates documentation for State Transforms.

-   **Location**: `src/cli/state-docs`
-   **Purpose**: Automated documentation generation for the available operations in the Mol* state tree.

## 6. Structure Info (`structure-info`)

Extracts information from a structure file.

-   **Location**: `src/cli/structure-info`
-   **Purpose**: Quick inspection of structure files from the command line.

## 7. Lipid Parameters (`lipid-params`)

Tools for generating lipid parameter definitions.

-   **Location**: `src/cli/lipid-params`
-   **Purpose**: Fetches lipid parameters (specifically Martini v3.0.0 phospholipids) and aggregates them with other known lipid names (Martini v2, Amber, etc.) to generate a TypeScript file containing a `Set` of all known lipid names.
-   **Usage**:
    ```bash
    node lib/commonjs/cli/lipid-params/index.js -o src/mol-model/structure/model/types/lipids.ts
    ```
-   **Arguments**:
    -   `-o, --out`: Output file path. If not provided, prints to stdout.
    -   `-f, --forceDownload`: Force download of the Martini lipids `.itp` file even if it exists locally.
