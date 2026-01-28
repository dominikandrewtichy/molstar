/**
 * Copyright (c) 2025-2026 mol* contributors, licensed under MIT, See LICENSE file for more info.
 *
 * @author Alexander Rose <alexander.rose@weirdbyte.de>
 *
 * Factory for creating WebGPU renderables from GraphicsRenderObject.
 */

import { GraphicsRenderObject, RenderObjectType } from '../render-object';
import { GPUContext } from '../gpu/context';
import { WebGPURenderable, WebGPURenderableState, WebGPUTransparency } from './renderable';
import { WebGPUMeshRenderable, createWebGPUMeshValues, WebGPUMeshValues } from './renderable/mesh';
import { WebGPUSpheresRenderable, createWebGPUSpheresValues, WebGPUSpheresValues } from './renderable/spheres';
import { WebGPUCylindersRenderable, createWebGPUCylindersValues, WebGPUCylindersValues } from './renderable/cylinders';
import { WebGPUPointsRenderable, createWebGPUPointsValues, WebGPUPointsValues } from './renderable/points';
import { WebGPULinesRenderable, createWebGPULinesValues, WebGPULinesValues } from './renderable/lines';
import { WebGPUTextRenderable, createWebGPUTextValues, WebGPUTextValues } from './renderable/text';
import { WebGPUImageRenderable, createWebGPUImageValues, WebGPUImageValues } from './renderable/image';
import { WebGPUDirectVolumeRenderable, createWebGPUDirectVolumeValues, WebGPUDirectVolumeValues } from './renderable/direct-volume';
import { WebGPUTextureMeshRenderable, createWebGPUTextureMeshValues, WebGPUTextureMeshValues } from './renderable/texture-mesh';
import { ValueCell } from '../../mol-util/value-cell';

/**
 * Convert WebGL-style transparency mode to WebGPU transparency.
 */
export function getWebGPUTransparency(transparency: 'blended' | 'wboit' | 'dpoit'): WebGPUTransparency {
    switch (transparency) {
        case 'wboit': return 'wboit';
        case 'dpoit': return 'dpoit';
        case 'blended':
        default:
            return 'blended';
    }
}

/**
 * Convert WebGL RenderableState to WebGPU RenderableState.
 */
export function convertRenderableState(state: import('../renderable').RenderableState): WebGPURenderableState {
    return {
        disposed: state.disposed ?? false,
        visible: state.visible ?? true,
        alphaFactor: state.alphaFactor ?? 1,
        pickable: state.pickable ?? true,
        colorOnly: state.colorOnly ?? false,
        opaque: state.opaque ?? true,
        writeDepth: state.writeDepth ?? true,
    };
}

/**
 * Helper to safely get array value from ValueCell.
 */
function getArrayValue(cell: any): Float32Array | null {
    if (!cell?.ref?.value) return null;
    const v = cell.ref.value;
    if (v instanceof Float32Array) return v;
    if (Array.isArray(v)) return new Float32Array(v);
    return null;
}

/**
 * Helper to safely get uint32 array value from ValueCell.
 */
function getUint32ArrayValue(cell: any): Uint32Array | null {
    if (!cell?.ref?.value) return null;
    const v = cell.ref.value;
    if (v instanceof Uint32Array) return v;
    if (v instanceof Uint16Array) return new Uint32Array(v);
    if (Array.isArray(v)) return new Uint32Array(v);
    return null;
}

/**
 * Helper to safely get number value from ValueCell.
 */
function getNumberValue(cell: any, defaultValue: number = 0): number {
    if (cell?.ref?.value === undefined) return defaultValue;
    return typeof cell.ref.value === 'number' ? cell.ref.value : defaultValue;
}

/**
 * Convert MeshValues to WebGPU format.
 */
function convertMeshValues(values: any): WebGPUMeshValues {
    const webgpuValues = createWebGPUMeshValues();

    // Copy geometry data
    const positions = getArrayValue(values.aPosition);
    if (positions) webgpuValues.aPosition = ValueCell.create(positions);

    const normals = getArrayValue(values.aNormal);
    if (normals) webgpuValues.aNormal = ValueCell.create(normals);

    const groups = getArrayValue(values.aGroup);
    if (groups) webgpuValues.aGroup = ValueCell.create(groups);

    const elements = getUint32ArrayValue(values.elements);
    if (elements) webgpuValues.elements = ValueCell.create(elements);

    // Copy instance data
    const transforms = getArrayValue(values.aTransform);
    if (transforms) webgpuValues.aTransform = ValueCell.create(transforms);

    const instances = getArrayValue(values.aInstance);
    if (instances) webgpuValues.aInstance = ValueCell.create(instances);

    // Copy counts
    if (values.drawCount?.ref?.value !== undefined) {
        webgpuValues.drawCount = ValueCell.create(values.drawCount.ref.value);
    }
    if (values.instanceCount?.ref?.value !== undefined) {
        webgpuValues.instanceCount = ValueCell.create(values.instanceCount.ref.value);
    }

    // Copy material properties
    const color = getArrayValue(values.uColor);
    if (color) webgpuValues.uColor = ValueCell.create(color);

    webgpuValues.uAlpha = ValueCell.create(getNumberValue(values.uAlpha, 1));
    webgpuValues.uMetalness = ValueCell.create(getNumberValue(values.uMetalness, 0));
    webgpuValues.uRoughness = ValueCell.create(getNumberValue(values.uRoughness, 0.5));

    // Copy bounding sphere if available
    if (values.boundingSphere?.ref?.value) {
        const bs = values.boundingSphere.ref.value;
        webgpuValues.boundingSphere = ValueCell.create({
            center: new Float32Array(bs.center || [0, 0, 0]),
            radius: bs.radius || 0,
        });
    }

    return webgpuValues;
}

/**
 * Convert SpheresValues to WebGPU format.
 */
function convertSpheresValues(values: any): WebGPUSpheresValues {
    const webgpuValues = createWebGPUSpheresValues();

    // Spheres uses texture-based position data
    if (values.tPositionGroup?.ref?.value) {
        webgpuValues.tPositionGroup = ValueCell.create(values.tPositionGroup.ref.value);
    }

    // Copy instance data
    const transforms = getArrayValue(values.aTransform);
    if (transforms) webgpuValues.aTransform = ValueCell.create(transforms);

    // Copy counts
    if (values.drawCount?.ref?.value !== undefined) {
        webgpuValues.drawCount = ValueCell.create(values.drawCount.ref.value);
    }
    if (values.instanceCount?.ref?.value !== undefined) {
        webgpuValues.instanceCount = ValueCell.create(values.instanceCount.ref.value);
    }

    // Copy material properties
    const color = getArrayValue(values.uColor);
    if (color) webgpuValues.uColor = ValueCell.create(color);

    webgpuValues.uAlpha = ValueCell.create(getNumberValue(values.uAlpha, 1));
    webgpuValues.uSize = ValueCell.create(getNumberValue(values.uSize, 1));

    if (values.dSizeType?.ref?.value !== undefined) {
        webgpuValues.dSizeType = ValueCell.create(values.dSizeType.ref.value);
    }

    // Copy bounding sphere
    if (values.boundingSphere?.ref?.value) {
        const bs = values.boundingSphere.ref.value;
        webgpuValues.boundingSphere = ValueCell.create({
            center: new Float32Array(bs.center || [0, 0, 0]),
            radius: bs.radius || 0,
        });
    }

    return webgpuValues;
}

/**
 * Convert CylindersValues to WebGPU format.
 */
function convertCylindersValues(values: any): WebGPUCylindersValues {
    const webgpuValues = createWebGPUCylindersValues();

    // Copy endpoints
    const starts = getArrayValue(values.aStart);
    if (starts) webgpuValues.aStart = ValueCell.create(starts);

    const ends = getArrayValue(values.aEnd);
    if (ends) webgpuValues.aEnd = ValueCell.create(ends);

    const groups = getArrayValue(values.aGroup);
    if (groups) webgpuValues.aGroup = ValueCell.create(groups);

    const mappings = getArrayValue(values.aMapping);
    if (mappings) webgpuValues.aMapping = ValueCell.create(mappings);

    const scales = getArrayValue(values.aScale);
    if (scales) webgpuValues.aScale = ValueCell.create(scales);

    const caps = getArrayValue(values.aCap);
    if (caps) webgpuValues.aCap = ValueCell.create(caps);

    const colorModes = getArrayValue(values.aColorMode);
    if (colorModes) webgpuValues.aColorMode = ValueCell.create(colorModes);

    // Copy instance data
    const transforms = getArrayValue(values.aTransform);
    if (transforms) webgpuValues.aTransform = ValueCell.create(transforms);

    // Copy counts
    if (values.drawCount?.ref?.value !== undefined) {
        webgpuValues.drawCount = ValueCell.create(values.drawCount.ref.value);
    }
    if (values.instanceCount?.ref?.value !== undefined) {
        webgpuValues.instanceCount = ValueCell.create(values.instanceCount.ref.value);
    }

    // Copy material properties
    const color = getArrayValue(values.uColor);
    if (color) webgpuValues.uColor = ValueCell.create(color);

    webgpuValues.uAlpha = ValueCell.create(getNumberValue(values.uAlpha, 1));
    webgpuValues.uSize = ValueCell.create(getNumberValue(values.uSize, 1));

    // Copy bounding sphere
    if (values.boundingSphere?.ref?.value) {
        const bs = values.boundingSphere.ref.value;
        webgpuValues.boundingSphere = ValueCell.create({
            center: new Float32Array(bs.center || [0, 0, 0]),
            radius: bs.radius || 0,
        });
    }

    return webgpuValues;
}

/**
 * Convert PointsValues to WebGPU format.
 */
function convertPointsValues(values: any): WebGPUPointsValues {
    const webgpuValues = createWebGPUPointsValues();

    const positions = getArrayValue(values.aPosition);
    if (positions) webgpuValues.aPosition = ValueCell.create(positions);

    const groups = getArrayValue(values.aGroup);
    if (groups) webgpuValues.aGroup = ValueCell.create(groups);

    // Copy counts
    if (values.drawCount?.ref?.value !== undefined) {
        webgpuValues.drawCount = ValueCell.create(values.drawCount.ref.value);
    }

    // Copy material properties
    const color = getArrayValue(values.uColor);
    if (color) webgpuValues.uColor = ValueCell.create(color);

    webgpuValues.uAlpha = ValueCell.create(getNumberValue(values.uAlpha, 1));
    webgpuValues.uSize = ValueCell.create(getNumberValue(values.uSize, 1));

    if (values.dPointStyle?.ref?.value !== undefined) {
        webgpuValues.dPointStyle = ValueCell.create(values.dPointStyle.ref.value);
    }

    // Copy bounding sphere
    if (values.boundingSphere?.ref?.value) {
        const bs = values.boundingSphere.ref.value;
        webgpuValues.boundingSphere = ValueCell.create({
            center: new Float32Array(bs.center || [0, 0, 0]),
            radius: bs.radius || 0,
        });
    }

    return webgpuValues;
}

/**
 * Convert LinesValues to WebGPU format.
 */
function convertLinesValues(values: any): WebGPULinesValues {
    const webgpuValues = createWebGPULinesValues();

    const starts = getArrayValue(values.aStart);
    if (starts) webgpuValues.aStart = ValueCell.create(starts);

    const ends = getArrayValue(values.aEnd);
    if (ends) webgpuValues.aEnd = ValueCell.create(ends);

    const groups = getArrayValue(values.aGroup);
    if (groups) webgpuValues.aGroup = ValueCell.create(groups);

    const mappings = getArrayValue(values.aMapping);
    if (mappings) webgpuValues.aMapping = ValueCell.create(mappings);

    const elements = getUint32ArrayValue(values.elements);
    if (elements) webgpuValues.elements = ValueCell.create(elements);

    // Copy counts
    if (values.drawCount?.ref?.value !== undefined) {
        webgpuValues.drawCount = ValueCell.create(values.drawCount.ref.value);
    }

    // Copy material properties
    const color = getArrayValue(values.uColor);
    if (color) webgpuValues.uColor = ValueCell.create(color);

    webgpuValues.uAlpha = ValueCell.create(getNumberValue(values.uAlpha, 1));
    webgpuValues.uSize = ValueCell.create(getNumberValue(values.uSize, 1));

    // Copy bounding sphere
    if (values.boundingSphere?.ref?.value) {
        const bs = values.boundingSphere.ref.value;
        webgpuValues.boundingSphere = ValueCell.create({
            center: new Float32Array(bs.center || [0, 0, 0]),
            radius: bs.radius || 0,
        });
    }

    return webgpuValues;
}

/**
 * Convert TextValues to WebGPU format.
 */
function convertTextValues(values: any): WebGPUTextValues {
    const webgpuValues = createWebGPUTextValues();

    const positions = getArrayValue(values.aPosition);
    if (positions) webgpuValues.aPosition = ValueCell.create(positions);

    const groups = getArrayValue(values.aGroup);
    if (groups) webgpuValues.aGroup = ValueCell.create(groups);

    const mappings = getArrayValue(values.aMapping);
    if (mappings) webgpuValues.aMapping = ValueCell.create(mappings);

    const depths = getArrayValue(values.aDepth);
    if (depths) webgpuValues.aDepth = ValueCell.create(depths);

    const texCoords = getArrayValue(values.aTexCoord);
    if (texCoords) webgpuValues.aTexCoord = ValueCell.create(texCoords);

    const elements = getUint32ArrayValue(values.elements);
    if (elements) webgpuValues.elements = ValueCell.create(elements);

    // Copy counts
    if (values.drawCount?.ref?.value !== undefined) {
        webgpuValues.drawCount = ValueCell.create(values.drawCount.ref.value);
    }

    // Copy material properties
    const color = getArrayValue(values.uColor);
    if (color) webgpuValues.uColor = ValueCell.create(color);

    webgpuValues.uAlpha = ValueCell.create(getNumberValue(values.uAlpha, 1));

    // Copy font texture
    if (values.tFont?.ref?.value !== undefined) {
        webgpuValues.tFont = ValueCell.create(values.tFont.ref.value);
    }

    // Copy text-specific properties
    webgpuValues.uBorderWidth = ValueCell.create(getNumberValue(values.uBorderWidth, 0));

    const borderColor = getArrayValue(values.uBorderColor);
    if (borderColor) webgpuValues.uBorderColor = ValueCell.create(borderColor);

    webgpuValues.uOffsetX = ValueCell.create(getNumberValue(values.uOffsetX, 0));
    webgpuValues.uOffsetY = ValueCell.create(getNumberValue(values.uOffsetY, 0));
    webgpuValues.uOffsetZ = ValueCell.create(getNumberValue(values.uOffsetZ, 0));

    const bgColor = getArrayValue(values.uBackgroundColor);
    if (bgColor) webgpuValues.uBackgroundColor = ValueCell.create(bgColor);

    webgpuValues.uBackgroundOpacity = ValueCell.create(getNumberValue(values.uBackgroundOpacity, 0));

    // Copy bounding sphere
    if (values.boundingSphere?.ref?.value) {
        const bs = values.boundingSphere.ref.value;
        webgpuValues.boundingSphere = ValueCell.create({
            center: new Float32Array(bs.center || [0, 0, 0]),
            radius: bs.radius || 0,
        });
    }

    return webgpuValues;
}

/**
 * Convert ImageValues to WebGPU format.
 */
function convertImageValues(values: any): WebGPUImageValues {
    const webgpuValues = createWebGPUImageValues();

    const positions = getArrayValue(values.aPosition);
    if (positions) webgpuValues.aPosition = ValueCell.create(positions);

    const groups = getArrayValue(values.aGroup);
    if (groups) webgpuValues.aGroup = ValueCell.create(groups);

    const uvs = getArrayValue(values.aUv);
    if (uvs) webgpuValues.aUv = ValueCell.create(uvs);

    const elements = getUint32ArrayValue(values.elements);
    if (elements) webgpuValues.elements = ValueCell.create(elements);

    // Copy counts
    if (values.drawCount?.ref?.value !== undefined) {
        webgpuValues.drawCount = ValueCell.create(values.drawCount.ref.value);
    }

    // Copy material properties
    const color = getArrayValue(values.uColor);
    if (color) webgpuValues.uColor = ValueCell.create(color);

    webgpuValues.uAlpha = ValueCell.create(getNumberValue(values.uAlpha, 1));

    // Copy image textures
    if (values.tImageTex?.ref?.value !== undefined) {
        webgpuValues.tImage = ValueCell.create(values.tImageTex.ref.value);
    }

    // Copy bounding sphere
    if (values.boundingSphere?.ref?.value) {
        const bs = values.boundingSphere.ref.value;
        webgpuValues.boundingSphere = ValueCell.create({
            center: new Float32Array(bs.center || [0, 0, 0]),
            radius: bs.radius || 0,
        });
    }

    return webgpuValues;
}

/**
 * Convert DirectVolumeValues to WebGPU format.
 */
function convertDirectVolumeValues(values: any): WebGPUDirectVolumeValues {
    const webgpuValues = createWebGPUDirectVolumeValues();

    const positions = getArrayValue(values.aPosition);
    if (positions) webgpuValues.aPosition = ValueCell.create(positions);

    const elements = getUint32ArrayValue(values.elements);
    if (elements) webgpuValues.elements = ValueCell.create(elements);

    // Copy counts
    if (values.drawCount?.ref?.value !== undefined) {
        webgpuValues.drawCount = ValueCell.create(values.drawCount.ref.value);
    }

    // Copy material properties
    const color = getArrayValue(values.uColor);
    if (color) webgpuValues.uColor = ValueCell.create(color);

    webgpuValues.uAlpha = ValueCell.create(getNumberValue(values.uAlpha, 1));

    // Copy volume textures
    if (values.tGridTex?.ref?.value !== undefined) {
        webgpuValues.tVolume = ValueCell.create(values.tGridTex.ref.value);
    }

    // Copy grid dimensions
    const gridDim = getArrayValue(values.uGridDim);
    if (gridDim) {
        webgpuValues.uGridDimensions = ValueCell.create(gridDim);
    }

    // Copy bbox properties
    const bboxMin = getArrayValue(values.uBboxMin);
    if (bboxMin) webgpuValues.uBboxMin = ValueCell.create(bboxMin);

    const bboxMax = getArrayValue(values.uBboxMax);
    if (bboxMax) webgpuValues.uBboxMax = ValueCell.create(bboxMax);

    // Copy bounding sphere
    if (values.boundingSphere?.ref?.value) {
        const bs = values.boundingSphere.ref.value;
        webgpuValues.boundingSphere = ValueCell.create({
            center: new Float32Array(bs.center || [0, 0, 0]),
            radius: bs.radius || 0,
        });
    }

    return webgpuValues;
}

/**
 * Create a WebGPU renderable from a GraphicsRenderObject.
 */
export function createWebGPURenderableFromObject(
    context: GPUContext,
    object: GraphicsRenderObject,
    transparency: WebGPUTransparency = 'blended'
): WebGPURenderable | null {
    const state = convertRenderableState(object.state);
    const materialId = object.materialId;
    const values = object.values as any;

    try {
        switch (object.type) {
            case 'mesh': {
                const webgpuValues = convertMeshValues(values);
                return new WebGPUMeshRenderable({
                    context,
                    materialId,
                    topology: 'triangle-list',
                    values: webgpuValues,
                    state,
                    transparency,
                    vertexShader: '',
                    fragmentShaders: { color: '', pick: '', depth: '', marking: '', emissive: '', tracing: '' },
                    vertexBufferLayouts: [],
                    bindGroupLayouts: [],
                });
            }

            case 'spheres': {
                const webgpuValues = convertSpheresValues(values);
                return new WebGPUSpheresRenderable({
                    context,
                    materialId,
                    topology: 'triangle-list',
                    values: webgpuValues,
                    state,
                    transparency,
                    vertexShader: '',
                    fragmentShaders: { color: '', pick: '', depth: '', marking: '', emissive: '', tracing: '' },
                    vertexBufferLayouts: [],
                    bindGroupLayouts: [],
                });
            }

            case 'cylinders': {
                const webgpuValues = convertCylindersValues(values);
                return new WebGPUCylindersRenderable({
                    context,
                    materialId,
                    topology: 'triangle-list',
                    values: webgpuValues,
                    state,
                    transparency,
                    vertexShader: '',
                    fragmentShaders: { color: '', pick: '', depth: '', marking: '', emissive: '', tracing: '' },
                    vertexBufferLayouts: [],
                    bindGroupLayouts: [],
                });
            }

            case 'points': {
                const webgpuValues = convertPointsValues(values);
                return new WebGPUPointsRenderable({
                    context,
                    materialId,
                    topology: 'point-list',
                    values: webgpuValues,
                    state,
                    transparency,
                    vertexShader: '',
                    fragmentShaders: { color: '', pick: '', depth: '', marking: '', emissive: '', tracing: '' },
                    vertexBufferLayouts: [],
                    bindGroupLayouts: [],
                });
            }

            case 'lines': {
                const webgpuValues = convertLinesValues(values);
                return new WebGPULinesRenderable({
                    context,
                    materialId,
                    topology: 'triangle-list',
                    values: webgpuValues,
                    state,
                    transparency,
                    vertexShader: '',
                    fragmentShaders: { color: '', pick: '', depth: '', marking: '', emissive: '', tracing: '' },
                    vertexBufferLayouts: [],
                    bindGroupLayouts: [],
                });
            }

            case 'text': {
                const webgpuValues = convertTextValues(values);
                return new WebGPUTextRenderable({
                    context,
                    materialId,
                    topology: 'triangle-list',
                    values: webgpuValues,
                    state,
                    transparency,
                    vertexShader: '',
                    fragmentShaders: { color: '', pick: '', depth: '', marking: '', emissive: '', tracing: '' },
                    vertexBufferLayouts: [],
                    bindGroupLayouts: [],
                });
            }

            case 'image': {
                const webgpuValues = convertImageValues(values);
                return new WebGPUImageRenderable({
                    context,
                    materialId,
                    topology: 'triangle-list',
                    values: webgpuValues,
                    state,
                    transparency,
                    vertexShader: '',
                    fragmentShaders: { color: '', pick: '', depth: '', marking: '', emissive: '', tracing: '' },
                    vertexBufferLayouts: [],
                    bindGroupLayouts: [],
                });
            }

            case 'direct-volume': {
                const webgpuValues = convertDirectVolumeValues(values);
                return new WebGPUDirectVolumeRenderable({
                    context,
                    materialId,
                    topology: 'triangle-list',
                    values: webgpuValues,
                    state,
                    transparency,
                    vertexShader: '',
                    fragmentShaders: { color: '', pick: '', depth: '', marking: '', emissive: '', tracing: '' },
                    vertexBufferLayouts: [],
                    bindGroupLayouts: [],
                });
            }

            case 'texture-mesh': {
                const webgpuValues = convertTextureMeshValues(values);
                return new WebGPUTextureMeshRenderable({
                    context,
                    materialId,
                    topology: 'triangle-list',
                    values: webgpuValues,
                    state,
                    transparency,
                    vertexShader: '',
                    fragmentShaders: { color: '', pick: '', depth: '', marking: '', emissive: '', tracing: '' },
                    vertexBufferLayouts: [],
                    bindGroupLayouts: [],
                });
            }

            default:
                console.warn(`Unknown render object type: ${(object as any).type}`);
                return null;
        }
    } catch (error) {
        console.error(`Error creating WebGPU renderable for ${object.type}:`, error);
        return null;
    }
}

/**
 * Check if a render object type is supported by the WebGPU backend.
 */
/**
 * Convert TextureMeshValues to WebGPU format.
 */
function convertTextureMeshValues(values: any): WebGPUTextureMeshValues {
    const webgpuValues = createWebGPUTextureMeshValues();

    // Copy texture references
    if (values.tPosition?.ref?.value) {
        webgpuValues.tPosition = ValueCell.create(values.tPosition.ref.value);
    }

    if (values.tNormal?.ref?.value) {
        webgpuValues.tNormal = ValueCell.create(values.tNormal.ref.value);
    }

    if (values.tGroup?.ref?.value) {
        webgpuValues.tGroup = ValueCell.create(values.tGroup.ref.value);
    }

    // Copy texture dimensions
    const texDim = getArrayValue(values.uGeoTexDim);
    if (texDim) webgpuValues.uGeoTexDim = ValueCell.create(texDim);

    // Copy instance data
    const transforms = getArrayValue(values.aTransform);
    if (transforms) webgpuValues.aTransform = ValueCell.create(transforms);

    // Copy counts
    if (values.drawCount?.ref?.value !== undefined) {
        webgpuValues.drawCount = ValueCell.create(values.drawCount.ref.value);
    }
    if (values.instanceCount?.ref?.value !== undefined) {
        webgpuValues.instanceCount = ValueCell.create(values.instanceCount.ref.value);
    }

    // Copy material properties
    const color = getArrayValue(values.uColor);
    if (color) webgpuValues.uColor = ValueCell.create(color);

    webgpuValues.uAlpha = ValueCell.create(getNumberValue(values.uAlpha, 1));
    webgpuValues.uMetalness = ValueCell.create(getNumberValue(values.uMetalness, 0));
    webgpuValues.uRoughness = ValueCell.create(getNumberValue(values.uRoughness, 0.5));

    // Copy double-sided flag
    webgpuValues.uDoubleSided = ValueCell.create(getNumberValue(values.uDoubleSided, 0));

    // Copy bounding sphere
    if (values.boundingSphere?.ref?.value) {
        const bs = values.boundingSphere.ref.value;
        webgpuValues.boundingSphere = ValueCell.create({
            center: new Float32Array(bs.center || [0, 0, 0]),
            radius: bs.radius || 0,
        });
    }

    return webgpuValues;
}

export function isWebGPURenderObjectTypeSupported(type: RenderObjectType): boolean {
    switch (type) {
        case 'mesh':
        case 'spheres':
        case 'cylinders':
        case 'points':
        case 'lines':
        case 'text':
        case 'image':
        case 'direct-volume':
        case 'texture-mesh':
            return true;
        default:
            return false;
    }
}
