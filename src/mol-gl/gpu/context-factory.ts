/**
 * Copyright (c) 2025 mol* contributors, licensed under MIT, See LICENSE file for more info.
 *
 * @author Alexander Rose <alexander.rose@weirdbyte.de>
 */

import { GPUContext, GPUContextDescriptor, GPUBackend, isWebGPUSupported, getBestAvailableBackend } from './context';
import { createWebGPUContext, WebGPUContextOptions } from '../webgpu/context';
import { createWebGLAdapterContext, WebGLAdapterContextOptions } from '../webgl/context-adapter';

/**
 * Options for creating a GPU context.
 */
export interface CreateContextOptions {
    /** WebGPU-specific options */
    webgpu?: WebGPUContextOptions;
    /** WebGL-specific context attributes */
    webgl?: WebGLAdapterContextOptions;
}

/**
 * Result of context creation attempt.
 */
export interface CreateContextResult {
    context: GPUContext;
    backend: GPUBackend;
    fallbackUsed: boolean;
}

/**
 * Create a GPU context with automatic backend selection.
 *
 * @param descriptor Context descriptor including canvas and preferences
 * @param options Backend-specific options
 * @returns Promise resolving to the created context and metadata
 */
export async function createGPUContext(
    descriptor: GPUContextDescriptor,
    options?: CreateContextOptions
): Promise<CreateContextResult> {
    const preferredBackend = descriptor.preferredBackend ?? 'auto';
    const targetBackend = preferredBackend === 'auto' ? getBestAvailableBackend() : preferredBackend;

    let fallbackUsed = false;

    // Try to create the preferred backend
    if (targetBackend === 'webgpu') {
        if (isWebGPUSupported()) {
            try {
                const context = await createWebGPUContext(descriptor, options?.webgpu);
                return { context, backend: 'webgpu', fallbackUsed };
            } catch (error) {
                console.warn('Failed to create WebGPU context, falling back to WebGL:', error);
                fallbackUsed = true;
            }
        } else {
            console.warn('WebGPU not supported, falling back to WebGL');
            fallbackUsed = true;
        }
    }

    // Create WebGL context (either as primary choice or fallback)
    try {
        const context = createWebGLAdapterContext(descriptor, options?.webgl);
        return { context, backend: 'webgl', fallbackUsed };
    } catch (error) {
        throw new Error(`Failed to create GPU context: ${error}`);
    }
}

/**
 * Create a WebGL context synchronously (when you specifically need WebGL).
 * Use this when you don't need async initialization and want direct WebGL access.
 *
 * @param descriptor Context descriptor including canvas and preferences
 * @param options WebGL-specific options
 * @returns The created WebGL context
 */
export function createWebGLContext(
    descriptor: GPUContextDescriptor,
    options?: WebGLAdapterContextOptions
): GPUContext {
    return createWebGLAdapterContext(descriptor, options);
}

/**
 * Check which GPU backends are available in the current environment.
 */
export function getAvailableBackends(): GPUBackend[] {
    const backends: GPUBackend[] = [];

    // WebGL is generally always available in browsers
    if (typeof document !== 'undefined') {
        const canvas = document.createElement('canvas');
        if (canvas.getContext('webgl2') || canvas.getContext('webgl')) {
            backends.push('webgl');
        }
    }

    // Check WebGPU
    if (isWebGPUSupported()) {
        backends.push('webgpu');
    }

    return backends;
}

/**
 * Get information about GPU backend support.
 */
export interface BackendSupportInfo {
    webgl: {
        supported: boolean;
        version: 1 | 2 | null;
    };
    webgpu: {
        supported: boolean;
    };
    recommended: GPUBackend;
}

/**
 * Get detailed information about GPU backend support.
 */
export function getBackendSupportInfo(): BackendSupportInfo {
    let webglSupported = false;
    let webglVersion: 1 | 2 | null = null;

    if (typeof document !== 'undefined') {
        const canvas = document.createElement('canvas');
        if (canvas.getContext('webgl2')) {
            webglSupported = true;
            webglVersion = 2;
        } else if (canvas.getContext('webgl')) {
            webglSupported = true;
            webglVersion = 1;
        }
    }

    const webgpuSupported = isWebGPUSupported();

    return {
        webgl: {
            supported: webglSupported,
            version: webglVersion,
        },
        webgpu: {
            supported: webgpuSupported,
        },
        recommended: webgpuSupported ? 'webgpu' : 'webgl',
    };
}

/**
 * Feature flags for GPU capabilities.
 */
export interface GPUFeatures {
    /** Compute shader support */
    compute: boolean;
    /** Storage buffer support */
    storageBuffers: boolean;
    /** Storage textures support */
    storageTextures: boolean;
    /** Timestamp queries support */
    timestampQueries: boolean;
    /** Indirect drawing support */
    indirectDraw: boolean;
    /** Multi-draw indirect support */
    multiDrawIndirect: boolean;
    /** 32-bit float textures with filtering */
    float32Filterable: boolean;
    /** BC texture compression */
    bcCompression: boolean;
    /** ETC2 texture compression */
    etc2Compression: boolean;
    /** ASTC texture compression */
    astcCompression: boolean;
}

/**
 * Get feature support for a specific backend.
 */
export function getBackendFeatures(backend: GPUBackend): GPUFeatures {
    if (backend === 'webgpu') {
        return {
            compute: true,
            storageBuffers: true,
            storageTextures: true,
            timestampQueries: true, // May require feature request
            indirectDraw: true,
            multiDrawIndirect: false, // Not yet in WebGPU spec
            float32Filterable: true, // May require feature request
            bcCompression: true, // May require feature request
            etc2Compression: true, // May require feature request
            astcCompression: true, // May require feature request
        };
    } else {
        // WebGL2 features (WebGL1 would have fewer)
        return {
            compute: false, // No compute shaders in WebGL
            storageBuffers: false,
            storageTextures: false,
            timestampQueries: true, // Via EXT_disjoint_timer_query
            indirectDraw: false, // Limited extension support
            multiDrawIndirect: true, // Via WEBGL_multi_draw extension
            float32Filterable: true, // Via OES_texture_float_linear
            bcCompression: true, // Via WEBGL_compressed_texture_s3tc
            etc2Compression: true, // Native in WebGL2
            astcCompression: true, // Via WEBGL_compressed_texture_astc
        };
    }
}
