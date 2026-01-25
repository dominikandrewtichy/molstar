/**
 * Copyright (c) 2025 mol* contributors, licensed under MIT, See LICENSE file for more info.
 *
 * @author Alexander Rose <alexander.rose@weirdbyte.de>
 */

/**
 * Abstract render state interface for GPU-agnostic state management.
 *
 * In WebGL, render state is managed via a mutable state machine (gl.enable, gl.blendFunc, etc.)
 * In WebGPU, render state is baked into immutable pipeline objects.
 *
 * This interface provides a unified API that:
 * - In WebGL: applies state changes immediately via WebGLState
 * - In WebGPU: accumulates state for pipeline creation/selection
 */

// Re-export types from pipeline.ts and texture.ts for convenience
// These are the canonical definitions for render state types
import type {
    BlendFactor,
    BlendOperation,
    BlendComponent,
    BlendState,
    CullMode,
    FrontFace,
    StencilOperation,
    StencilFaceState,
} from './pipeline';

import type { CompareFunction } from './texture';

// Re-export for convenience
export type {
    BlendFactor,
    BlendOperation,
    BlendComponent,
    BlendState,
    CullMode,
    FrontFace,
    StencilOperation,
    StencilFaceState,
    CompareFunction,
};

//
// Additional state descriptor types (not in pipeline.ts)
//

export interface DepthStencilStateDescriptor {
    depthWriteEnabled: boolean;
    depthCompare: CompareFunction;
    stencilFront?: StencilFaceState;
    stencilBack?: StencilFaceState;
    stencilReadMask?: number;
    stencilWriteMask?: number;
}

//
// Render state interface
//

/**
 * Render state management interface.
 * Provides methods to control blend, depth, stencil, and rasterization state.
 */
export interface RenderState {
    // Current IDs for caching
    currentProgramId: number;
    currentMaterialId: number;
    currentRenderItemId: number;

    //
    // Feature enable/disable
    //

    /** Enable blending */
    enableBlend(): void;
    /** Disable blending */
    disableBlend(): void;

    /** Enable depth testing */
    enableDepthTest(): void;
    /** Disable depth testing */
    disableDepthTest(): void;

    /** Enable stencil testing */
    enableStencilTest(): void;
    /** Disable stencil testing */
    disableStencilTest(): void;

    /** Enable face culling */
    enableCullFace(): void;
    /** Disable face culling */
    disableCullFace(): void;

    /** Enable scissor test */
    enableScissorTest(): void;
    /** Disable scissor test */
    disableScissorTest(): void;

    /** Enable polygon offset fill */
    enablePolygonOffsetFill(): void;
    /** Disable polygon offset fill */
    disablePolygonOffsetFill(): void;

    //
    // Blend state
    //

    /** Set blend function for both RGB and alpha */
    blendFunc(src: BlendFactor, dst: BlendFactor): void;
    /** Set blend function separately for RGB and alpha */
    blendFuncSeparate(srcRGB: BlendFactor, dstRGB: BlendFactor, srcAlpha: BlendFactor, dstAlpha: BlendFactor): void;
    /** Set blend equation for both RGB and alpha */
    blendEquation(mode: BlendOperation): void;
    /** Set blend equation separately for RGB and alpha */
    blendEquationSeparate(modeRGB: BlendOperation, modeAlpha: BlendOperation): void;
    /** Set blend constant color */
    blendColor(red: number, green: number, blue: number, alpha: number): void;

    //
    // Depth state
    //

    /** Enable or disable writing to the depth buffer */
    depthMask(flag: boolean): void;
    /** Set the depth comparison function */
    depthFunc(func: CompareFunction): void;
    /** Set the depth clear value */
    clearDepth(depth: number): void;

    //
    // Stencil state
    //

    /** Set stencil function for front and back faces */
    stencilFunc(func: CompareFunction, ref: number, mask: number): void;
    /** Set stencil function separately for front and back faces */
    stencilFuncSeparate(face: 'front' | 'back' | 'front-and-back', func: CompareFunction, ref: number, mask: number): void;
    /** Set stencil write mask for front and back faces */
    stencilMask(mask: number): void;
    /** Set stencil write mask separately for front and back faces */
    stencilMaskSeparate(face: 'front' | 'back' | 'front-and-back', mask: number): void;
    /** Set stencil operations for front and back faces */
    stencilOp(fail: StencilOperation, zfail: StencilOperation, zpass: StencilOperation): void;
    /** Set stencil operations separately for front and back faces */
    stencilOpSeparate(face: 'front' | 'back' | 'front-and-back', fail: StencilOperation, zfail: StencilOperation, zpass: StencilOperation): void;

    //
    // Rasterization state
    //

    /** Set front face winding order */
    frontFace(mode: FrontFace): void;
    /** Set which face to cull */
    cullFace(mode: CullMode): void;
    /** Set polygon offset */
    polygonOffset(factor: number, units: number): void;

    //
    // Color state
    //

    /** Set color write mask */
    colorMask(red: boolean, green: boolean, blue: boolean, alpha: boolean): void;
    /** Set clear color */
    clearColor(red: number, green: number, blue: number, alpha: number): void;

    //
    // Viewport and scissor
    //

    /** Set the viewport */
    viewport(x: number, y: number, width: number, height: number): void;
    /** Set the scissor rectangle */
    scissor(x: number, y: number, width: number, height: number): void;

    //
    // Vertex attribute state
    //

    /** Enable a vertex attribute */
    enableVertexAttrib(index: number): void;
    /** Clear vertex attribute state */
    clearVertexAttribsState(): void;
    /** Disable unused vertex attributes */
    disableUnusedVertexAttribs(): void;

    //
    // State snapshot (for WebGPU pipeline key generation)
    //

    /** Get current blend state for pipeline creation */
    getBlendState(): BlendState | null;
    /** Get current depth/stencil state for pipeline creation */
    getDepthStencilState(): DepthStencilStateDescriptor | null;
    /** Get current cull mode for pipeline creation */
    getCullMode(): CullMode;
    /** Get current front face for pipeline creation */
    getFrontFace(): FrontFace;
    /** Check if blending is enabled */
    isBlendEnabled(): boolean;
    /** Check if depth testing is enabled */
    isDepthTestEnabled(): boolean;
    /** Check if stencil testing is enabled */
    isStencilTestEnabled(): boolean;

    //
    // Reset state
    //

    /** Reset all state to defaults */
    reset(): void;
}

//
// Helper functions for converting between WebGL and abstract state
//

/** Convert abstract blend factor to WebGL constant */
export function blendFactorToGL(gl: WebGLRenderingContext, factor: BlendFactor): number {
    switch (factor) {
        case 'zero': return gl.ZERO;
        case 'one': return gl.ONE;
        case 'src': return gl.SRC_COLOR;
        case 'one-minus-src': return gl.ONE_MINUS_SRC_COLOR;
        case 'src-alpha': return gl.SRC_ALPHA;
        case 'one-minus-src-alpha': return gl.ONE_MINUS_SRC_ALPHA;
        case 'dst': return gl.DST_COLOR;
        case 'one-minus-dst': return gl.ONE_MINUS_DST_COLOR;
        case 'dst-alpha': return gl.DST_ALPHA;
        case 'one-minus-dst-alpha': return gl.ONE_MINUS_DST_ALPHA;
        case 'src-alpha-saturated': return gl.SRC_ALPHA_SATURATE;
        case 'constant': return gl.CONSTANT_COLOR;
        case 'one-minus-constant': return gl.ONE_MINUS_CONSTANT_COLOR;
    }
}

/** Convert WebGL blend factor constant to abstract type */
export function glToBlendFactor(gl: WebGLRenderingContext, value: number): BlendFactor {
    switch (value) {
        case gl.ZERO: return 'zero';
        case gl.ONE: return 'one';
        case gl.SRC_COLOR: return 'src';
        case gl.ONE_MINUS_SRC_COLOR: return 'one-minus-src';
        case gl.SRC_ALPHA: return 'src-alpha';
        case gl.ONE_MINUS_SRC_ALPHA: return 'one-minus-src-alpha';
        case gl.DST_COLOR: return 'dst';
        case gl.ONE_MINUS_DST_COLOR: return 'one-minus-dst';
        case gl.DST_ALPHA: return 'dst-alpha';
        case gl.ONE_MINUS_DST_ALPHA: return 'one-minus-dst-alpha';
        case gl.SRC_ALPHA_SATURATE: return 'src-alpha-saturated';
        case gl.CONSTANT_COLOR: return 'constant';
        case gl.ONE_MINUS_CONSTANT_COLOR: return 'one-minus-constant';
        default: return 'one';
    }
}

/** Convert abstract blend operation to WebGL constant */
export function blendOperationToGL(gl: WebGLRenderingContext, op: BlendOperation): number {
    switch (op) {
        case 'add': return gl.FUNC_ADD;
        case 'subtract': return gl.FUNC_SUBTRACT;
        case 'reverse-subtract': return gl.FUNC_REVERSE_SUBTRACT;
        case 'min': return (gl as WebGL2RenderingContext).MIN ?? gl.FUNC_ADD;
        case 'max': return (gl as WebGL2RenderingContext).MAX ?? gl.FUNC_ADD;
    }
}

/** Convert WebGL blend operation constant to abstract type */
export function glToBlendOperation(gl: WebGLRenderingContext, value: number): BlendOperation {
    switch (value) {
        case gl.FUNC_ADD: return 'add';
        case gl.FUNC_SUBTRACT: return 'subtract';
        case gl.FUNC_REVERSE_SUBTRACT: return 'reverse-subtract';
        case (gl as WebGL2RenderingContext).MIN: return 'min';
        case (gl as WebGL2RenderingContext).MAX: return 'max';
        default: return 'add';
    }
}

/** Convert abstract compare function to WebGL constant */
export function compareFunctionToGL(gl: WebGLRenderingContext, func: CompareFunction): number {
    switch (func) {
        case 'never': return gl.NEVER;
        case 'less': return gl.LESS;
        case 'equal': return gl.EQUAL;
        case 'less-equal': return gl.LEQUAL;
        case 'greater': return gl.GREATER;
        case 'not-equal': return gl.NOTEQUAL;
        case 'greater-equal': return gl.GEQUAL;
        case 'always': return gl.ALWAYS;
    }
}

/** Convert WebGL compare function constant to abstract type */
export function glToCompareFunction(gl: WebGLRenderingContext, value: number): CompareFunction {
    switch (value) {
        case gl.NEVER: return 'never';
        case gl.LESS: return 'less';
        case gl.EQUAL: return 'equal';
        case gl.LEQUAL: return 'less-equal';
        case gl.GREATER: return 'greater';
        case gl.NOTEQUAL: return 'not-equal';
        case gl.GEQUAL: return 'greater-equal';
        case gl.ALWAYS: return 'always';
        default: return 'less';
    }
}

/** Convert abstract stencil operation to WebGL constant */
export function stencilOperationToGL(gl: WebGLRenderingContext, op: StencilOperation): number {
    switch (op) {
        case 'keep': return gl.KEEP;
        case 'zero': return gl.ZERO;
        case 'replace': return gl.REPLACE;
        case 'invert': return gl.INVERT;
        case 'increment-clamp': return gl.INCR;
        case 'decrement-clamp': return gl.DECR;
        case 'increment-wrap': return gl.INCR_WRAP;
        case 'decrement-wrap': return gl.DECR_WRAP;
    }
}

/** Convert WebGL stencil operation constant to abstract type */
export function glToStencilOperation(gl: WebGLRenderingContext, value: number): StencilOperation {
    switch (value) {
        case gl.KEEP: return 'keep';
        case gl.ZERO: return 'zero';
        case gl.REPLACE: return 'replace';
        case gl.INVERT: return 'invert';
        case gl.INCR: return 'increment-clamp';
        case gl.DECR: return 'decrement-clamp';
        case gl.INCR_WRAP: return 'increment-wrap';
        case gl.DECR_WRAP: return 'decrement-wrap';
        default: return 'keep';
    }
}

/** Convert abstract face value to WebGL constant */
export function faceToGL(gl: WebGLRenderingContext, face: 'front' | 'back' | 'front-and-back'): number {
    switch (face) {
        case 'front': return gl.FRONT;
        case 'back': return gl.BACK;
        case 'front-and-back': return gl.FRONT_AND_BACK;
    }
}

/** Create default blend state */
export function createDefaultBlendState(): BlendState {
    return {
        color: {
            operation: 'add',
            srcFactor: 'one',
            dstFactor: 'zero',
        },
        alpha: {
            operation: 'add',
            srcFactor: 'one',
            dstFactor: 'zero',
        },
    };
}

/** Create premultiplied alpha blend state (for transparent backgrounds) */
export function createPremultipliedAlphaBlendState(): BlendState {
    return {
        color: {
            operation: 'add',
            srcFactor: 'one',
            dstFactor: 'one-minus-src-alpha',
        },
        alpha: {
            operation: 'add',
            srcFactor: 'one',
            dstFactor: 'one-minus-src-alpha',
        },
    };
}

/** Create standard alpha blend state */
export function createAlphaBlendState(): BlendState {
    return {
        color: {
            operation: 'add',
            srcFactor: 'src-alpha',
            dstFactor: 'one-minus-src-alpha',
        },
        alpha: {
            operation: 'add',
            srcFactor: 'one',
            dstFactor: 'one-minus-src-alpha',
        },
    };
}
