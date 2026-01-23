/**
 * Copyright (c) 2025 mol* contributors, licensed under MIT, See LICENSE file for more info.
 *
 * @author Alexander Rose <alexander.rose@weirdbyte.de>
 */

import { idFactory } from '../../mol-util/id-factory';

const getNextBufferId = idFactory();

/**
 * Buffer usage flags indicating how the buffer will be used.
 * Multiple usages can be combined.
 */
export type BufferUsage =
    | 'vertex'
    | 'index'
    | 'uniform'
    | 'storage'
    | 'copy-src'
    | 'copy-dst'
    | 'indirect'
    | 'query-resolve';

/**
 * Hint for how the buffer data will be updated.
 */
export type BufferUpdateHint = 'static' | 'dynamic' | 'stream';

/**
 * Descriptor for creating a buffer.
 */
export interface BufferDescriptor {
    /** Size of the buffer in bytes */
    size: number;
    /** Usage flags for the buffer */
    usage: BufferUsage[];
    /** Hint for update frequency (WebGL only, ignored in WebGPU) */
    updateHint?: BufferUpdateHint;
    /** If true, buffer can be mapped immediately after creation */
    mappedAtCreation?: boolean;
    /** Optional label for debugging */
    label?: string;
}

/**
 * Abstract buffer interface for GPU memory.
 */
export interface Buffer {
    readonly id: number;
    readonly size: number;
    readonly usage: BufferUsage[];

    /**
     * Write data to the buffer.
     * @param data The data to write
     * @param bufferOffset Offset in bytes from the start of the buffer
     * @param dataOffset Offset in elements from the start of the data array
     * @param size Number of elements to write (default: entire data array)
     */
    write(data: ArrayBufferView, bufferOffset?: number, dataOffset?: number, size?: number): void;

    /**
     * Read data from the buffer (WebGPU: requires async mapping).
     * Returns a promise that resolves with the buffer data.
     */
    read(): Promise<ArrayBuffer>;

    /**
     * Get byte count of the buffer.
     */
    getByteCount(): number;

    /**
     * Reset the buffer after context loss.
     */
    reset(): void;

    /**
     * Destroy the buffer and release GPU resources.
     */
    destroy(): void;
}

/**
 * Create a new buffer ID.
 */
export function createBufferId(): number {
    return getNextBufferId();
}

/**
 * Check if a buffer usage includes a specific flag.
 */
export function hasBufferUsage(usage: BufferUsage[], flag: BufferUsage): boolean {
    return usage.includes(flag);
}

/**
 * Get the typed array type for a buffer data type.
 */
export type BufferDataType = 'uint8' | 'int8' | 'uint16' | 'int16' | 'uint32' | 'int32' | 'float32';

export type BufferDataTypeArrayType = {
    'uint8': Uint8Array;
    'int8': Int8Array;
    'uint16': Uint16Array;
    'int16': Int16Array;
    'uint32': Uint32Array;
    'int32': Int32Array;
    'float32': Float32Array;
};

export type BufferArrayType = Uint8Array | Int8Array | Uint16Array | Int16Array | Uint32Array | Int32Array | Float32Array;

/**
 * Get bytes per element for a buffer data type.
 */
export function getBytesPerElement(dataType: BufferDataType): number {
    switch (dataType) {
        case 'uint8':
        case 'int8':
            return 1;
        case 'uint16':
        case 'int16':
            return 2;
        case 'uint32':
        case 'int32':
        case 'float32':
            return 4;
    }
}
