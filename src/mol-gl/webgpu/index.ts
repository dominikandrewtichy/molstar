/**
 * Copyright (c) 2025 mol* contributors, licensed under MIT, See LICENSE file for more info.
 *
 * @author Alexander Rose <alexander.rose@weirdbyte.de>
 */

export * from './context';
export * from './pipeline-cache';
export * from './renderable';
export * from './renderable/index';
export * from './renderer';
export * from './scene';
// Export transparency module selectively to avoid TransparencyMode conflict
export { TransparencyPassManager } from './transparency';
export type {
    TransparencyPassConfig,
    WboitTargets,
    DpoitTargets,
    TransparencyMode as TransparencyPassMode
} from './transparency';
export * from './picking';
export * from './passes';
export * from './postprocessing';
export * from './compute';
export * from './testing';
export * from './renderable-factory';

// WebGPU MultiSample exports
export {
    WebGPUMultiSamplePass,
    WebGPUMultiSampleHelper,
    WebGPUMultiSampleParams,
    WebGPUJitterVectors,
} from './passes';
export type {
    WebGPUMultiSampleProps,
} from './passes';

// WebGPU Postprocessing exports
export {
    WebGPUPostprocessingPass,
    WebGPUSsaoPass,
    WebGPUOutlinePass,
    WebGPUShadowPass,
    PostprocessingParams,
    SsaoParams,
    OutlineParams,
    ShadowParams,
} from './postprocessing';
export type {
    PostprocessingProps,
    SsaoProps,
    OutlineProps,
    ShadowProps,
} from './postprocessing';
