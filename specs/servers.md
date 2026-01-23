# Mol* Servers

The `src/servers` directory contains standalone Node.js server applications that provide data and services to Mol* clients.

## 1. Model Server (`src/servers/model`)

The Model Server is responsible for serving subsets of macromolecular models. It optimizes data delivery by allowing clients to request only specific parts of a structure (e.g., specific chains, residues, or atoms) rather than downloading the entire file.

-   **Entry Point**: `src/servers/model/server.ts`
-   **Key Features**:
    -   **Efficient Data Delivery**: Serves data in the binary CIF (BCIF) format.
    -   **Query System**: Supports complex queries to filter structure data.
    -   **Configuration**: Configurable via `ModelServerConfig` (port, timeouts, etc.).
    -   **Compression**: Uses `compression` middleware for efficient transfer.

## 2. Volume Server (`src/servers/volume`)

The Volume Server is designed to serve volumetric data, such as electron density maps from cryo-EM or X-ray crystallography. It is adapted from the `DensityServer`.

-   **Entry Point**: `src/servers/volume/server.ts`
-   **Key Features**:
    -   **Downsampling**: Can serve downsampled versions of volume data for faster visualization at lower zoom levels.
    -   **Region Extraction**: specific sub-regions of the volume can be requested.
    -   **Format**: typically serves data in the specialized implementation of the BCIF format for volumetric data.

## 3. Plugin State Server (`src/servers/plugin-state`)

The Plugin State Server provides a mechanism to save, list, and retrieve Mol* plugin states. This is useful for sharing sessions or persisting user work.

-   **Entry Point**: `src/servers/plugin-state/index.ts`
-   **Functionality**:
    -   **Storage**: Saves state snapshots (JSON) to a configurable local directory (default: `build/state`).
    -   **Indexing**: Maintains an `index.json` to track available states.
    -   **Management**: Supports `max_states` to limit storage usage, automatically removing old states.
    -   **API**:
        -   `POST /set`: Save a new state.
        -   `GET /get/:id`: Retrieve a state by ID.
        -   `GET /list`: List all available states.
        -   `GET /remove/:id`: Delete a state.
    -   **Documentation**: Includes Swagger UI at the root (`/`) for API exploration.

## 4. Membrane Orientation Server (`src/servers/membrane-orientation`)

A specialized server for calculating or serving membrane orientation data for protein structures.

-   **Location**: `src/servers/membrane-orientation/`
-   **Entry Point**: `src/servers/membrane-orientation/server.ts`
-   **Purpose**: Facilitates the visualization of proteins within the context of a lipid membrane by providing the necessary position and orientation parameters.

## Running Servers

Most servers can be run directly via `node` or using npm scripts defined in `package.json`.

```bash
# Example: Run Model Server
npm run model-server

# Example: Run Plugin State Server
npm run plugin-state
```
