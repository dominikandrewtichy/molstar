/**
 * Copyright (c) 2025 mol* contributors, licensed under MIT, See LICENSE file for more info.
 *
 * @author Alexander Rose <alexander.rose@weirdbyte.de>
 */

import { ValueCell } from '../../../mol-util/value-cell';
import { GPUContext, Buffer, BindGroupLayout, PipelineLayout, ShaderModule, TextureFormat, ShaderStage, Texture } from '../../gpu';
import {
    WebGPURenderableBase,
    WebGPURenderableDescriptor,
    WebGPURenderableState,
    WebGPURenderableValues,
    WebGPURenderVariant,
    WebGPUTransparency,
    createWebGPURenderableState,
} from '../renderable';
import { DirectVolumeShader } from '../../shader/wgsl/direct-volume.wgsl';

/**
 * Values for WebGPU direct volume renderable.
 */
export interface WebGPUDirectVolumeValues extends WebGPURenderableValues {
    // Geometry (bounding box vertices)
    aPosition: ValueCell<Float32Array>;
    elements: ValueCell<Uint32Array>;

    // Instance data
    aTransform: ValueCell<Float32Array>;
    aInstance: ValueCell<Float32Array>;

    // Counts
    drawCount: ValueCell<number>;
    instanceCount: ValueCell<number>;

    // Volume bounding box
    uBboxMin: ValueCell<Float32Array>;
    uBboxMax: ValueCell<Float32Array>;
    uBboxSize: ValueCell<Float32Array>;

    // Volume grid parameters
    uGridDim: ValueCell<Float32Array>;
    uGridTexDim: ValueCell<Float32Array>;
    uCellDim: ValueCell<Float32Array>;

    // Raymarching parameters
    uMaxSteps: ValueCell<number>;
    uStepScale: ValueCell<number>;
    uJumpLength: ValueCell<number>;

    // Transfer function
    tTransferTex: ValueCell<Uint8Array>;
    uTransferScale: ValueCell<number>;

    // Volume data texture
    tGridTex: ValueCell<Uint8Array | Float32Array>;

    // Grid statistics [min, max, mean, sigma]
    uGridStats: ValueCell<Float32Array>;

    // Transform matrices
    uTransform: ValueCell<Float32Array>;
    uCartnToUnit: ValueCell<Float32Array>;
    uUnitToCartn: ValueCell<Float32Array>;

    // Bounding sphere
    uInvariantBoundingSphere: ValueCell<Float32Array>;
    uModelScale: ValueCell<number>;

    // Rendering options
    dIgnoreLight: ValueCell<boolean>;
    dCelShaded: ValueCell<boolean>;
    dXrayShaded: ValueCell<string>;

    // Material properties
    uColor: ValueCell<Float32Array>;
    uAlpha: ValueCell<number>;
    uMetalness: ValueCell<number>;
    uRoughness: ValueCell<number>;
    uEmissive: ValueCell<number>;

    // Object properties
    uObjectId: ValueCell<number>;
}

/**
 * Create initial direct volume values.
 */
export function createWebGPUDirectVolumeValues(): WebGPUDirectVolumeValues {
    return {
        aPosition: ValueCell.create(new Float32Array(0)),
        elements: ValueCell.create(new Uint32Array(0)),

        aTransform: ValueCell.create(new Float32Array(16)),
        aInstance: ValueCell.create(new Float32Array(0)),

        drawCount: ValueCell.create(0),
        instanceCount: ValueCell.create(1),

        uBboxMin: ValueCell.create(new Float32Array([0, 0, 0])),
        uBboxMax: ValueCell.create(new Float32Array([1, 1, 1])),
        uBboxSize: ValueCell.create(new Float32Array([1, 1, 1])),

        uGridDim: ValueCell.create(new Float32Array([1, 1, 1])),
        uGridTexDim: ValueCell.create(new Float32Array([1, 1, 1])),
        uCellDim: ValueCell.create(new Float32Array([1, 1, 1])),

        uMaxSteps: ValueCell.create(256),
        uStepScale: ValueCell.create(1),
        uJumpLength: ValueCell.create(0),

        tTransferTex: ValueCell.create(new Uint8Array(256)),
        uTransferScale: ValueCell.create(1),

        tGridTex: ValueCell.create(new Uint8Array(0)),

        uGridStats: ValueCell.create(new Float32Array([0, 1, 0.5, 0.25])),

        uTransform: ValueCell.create(new Float32Array(16)),
        uCartnToUnit: ValueCell.create(new Float32Array(16)),
        uUnitToCartn: ValueCell.create(new Float32Array(16)),

        uInvariantBoundingSphere: ValueCell.create(new Float32Array([0, 0, 0, 1])),
        uModelScale: ValueCell.create(1),

        dIgnoreLight: ValueCell.create(false),
        dCelShaded: ValueCell.create(false),
        dXrayShaded: ValueCell.create('off'),

        uColor: ValueCell.create(new Float32Array([1, 1, 1, 1])),
        uAlpha: ValueCell.create(1),
        uMetalness: ValueCell.create(0),
        uRoughness: ValueCell.create(0.5),
        uEmissive: ValueCell.create(0),

        uObjectId: ValueCell.create(0),
    };
}

/**
 * WebGPU direct volume renderable implementation.
 */
export class WebGPUDirectVolumeRenderable extends WebGPURenderableBase<WebGPUDirectVolumeValues> {
    private positionBuffer: Buffer | null = null;
    private indexBuffer_: Buffer | null = null;
    private uniformBuffer: Buffer | null = null;
    private volumeVertUniformBuffer: Buffer | null = null;
    private volumeFragUniformBuffer: Buffer | null = null;
    private instanceBuffer: Buffer | null = null;

    private gridTexture: Texture | null = null;
    private transferTexture: Texture | null = null;
    private depthTexture: Texture | null = null;
    private frameBindGroupLayout: BindGroupLayout | null = null;
    private materialBindGroupLayout: BindGroupLayout | null = null;
    private objectBindGroupLayout: BindGroupLayout | null = null;

    private shaderModules: Map<WebGPURenderVariant, ShaderModule> = new Map();

    protected createPipelines(descriptor: WebGPURenderableDescriptor<WebGPUDirectVolumeValues>): void {
        // Create shader modules
        const vertexModule = this.context.createShaderModule({
            code: DirectVolumeShader.vertex,
        });

        // Create shader modules for each variant
        const colorModule = this.context.createShaderModule({
            code: DirectVolumeShader.fragment.color,
        });
        const pickModule = this.context.createShaderModule({
            code: DirectVolumeShader.fragment.pick,
        });
        const depthModule = this.context.createShaderModule({
            code: DirectVolumeShader.fragment.depth,
        });

        this.shaderModules.set('color', colorModule);
        this.shaderModules.set('pick', pickModule);
        this.shaderModules.set('depth', depthModule);

        // Create bind group layouts
        this.createBindGroupLayouts();

        // Create pipeline layout
        const pipelineLayout = this.context.createPipelineLayout({
            bindGroupLayouts: [
                this.frameBindGroupLayout!,
                this.materialBindGroupLayout!,
                this.objectBindGroupLayout!,
            ],
        });

        // Create pipelines for each variant
        this.createPipelineForVariant('color', vertexModule, colorModule, pipelineLayout);
        this.createPipelineForVariant('pick', vertexModule, pickModule, pipelineLayout);
        this.createPipelineForVariant('depth', vertexModule, depthModule, pipelineLayout);
    }

    private createBindGroupLayouts(): void {
        // Frame bind group layout (group 0)
        this.frameBindGroupLayout = this.context.createBindGroupLayout({
            entries: [
                {
                    binding: 0,
                    visibility: ['vertex', 'fragment'] as ShaderStage[],
                    buffer: { type: 'uniform' },
                },
                {
                    binding: 1,
                    visibility: ['fragment'] as ShaderStage[],
                    buffer: { type: 'uniform' },
                },
            ],
        });

        // Material bind group layout (group 1)
        this.materialBindGroupLayout = this.context.createBindGroupLayout({
            entries: [
                {
                    binding: 0,
                    visibility: ['fragment'] as ShaderStage[],
                    buffer: { type: 'uniform' },
                },
            ],
        });

        // Object bind group layout (group 2) - more complex for volume rendering
        this.objectBindGroupLayout = this.context.createBindGroupLayout({
            entries: [
                // Object uniforms
                {
                    binding: 0,
                    visibility: ['vertex', 'fragment'] as ShaderStage[],
                    buffer: { type: 'uniform' },
                },
                // Volume vertex uniforms
                {
                    binding: 1,
                    visibility: ['vertex'] as ShaderStage[],
                    buffer: { type: 'uniform' },
                },
                // Instance data
                {
                    binding: 2,
                    visibility: ['vertex', 'fragment'] as ShaderStage[],
                    buffer: { type: 'read-only-storage' },
                },
                // Volume fragment uniforms
                {
                    binding: 3,
                    visibility: ['fragment'] as ShaderStage[],
                    buffer: { type: 'uniform' },
                },
                // Grid texture
                {
                    binding: 4,
                    visibility: ['fragment'] as ShaderStage[],
                    texture: { sampleType: 'float' },
                },
                {
                    binding: 5,
                    visibility: ['fragment'] as ShaderStage[],
                    sampler: { type: 'filtering' },
                },
                // Transfer texture
                {
                    binding: 6,
                    visibility: ['fragment'] as ShaderStage[],
                    texture: { sampleType: 'float' },
                },
                {
                    binding: 7,
                    visibility: ['fragment'] as ShaderStage[],
                    sampler: { type: 'filtering' },
                },
                // Depth texture
                {
                    binding: 8,
                    visibility: ['fragment'] as ShaderStage[],
                    texture: { sampleType: 'unfilterable-float' },
                },
                {
                    binding: 9,
                    visibility: ['fragment'] as ShaderStage[],
                    sampler: { type: 'non-filtering' },
                },
            ],
        });
    }

    private createPipelineForVariant(
        variant: WebGPURenderVariant,
        vertexModule: ShaderModule,
        fragmentModule: ShaderModule,
        layout: PipelineLayout
    ): void {
        const colorTargets = this.getColorTargets(variant);
        const depthStencilState = this.getDepthStencilState(variant);
        const blendState = this.getBlendState(variant);

        const pipeline = this.context.createRenderPipeline({
            layout,
            vertex: {
                module: vertexModule,
                entryPoint: 'main',
                buffers: [
                    // Position buffer (bounding box vertices)
                    {
                        arrayStride: 12, // vec3<f32>
                        stepMode: 'vertex',
                        attributes: [
                            { format: 'float32x3', offset: 0, shaderLocation: 0 },
                        ],
                    },
                ],
            },
            fragment: {
                module: fragmentModule,
                entryPoint: 'main',
                targets: colorTargets.map(target => ({
                    format: target.format,
                    blend: target.blend || blendState,
                })),
            },
            primitive: {
                topology: 'triangle-list',
                // Render back faces for volume rendering
                cullMode: 'front',
                frontFace: 'ccw',
            },
            depthStencil: depthStencilState,
        });

        this.pipelines.set(variant, pipeline);
    }

    private getColorTargets(variant: WebGPURenderVariant): { format: TextureFormat; blend?: any }[] {
        switch (variant) {
            case 'color':
                return [{ format: 'bgra8unorm' as TextureFormat }];
            case 'pick':
                return [
                    { format: 'rgba8unorm' as TextureFormat },
                    { format: 'rgba8unorm' as TextureFormat },
                    { format: 'rgba8unorm' as TextureFormat },
                    { format: 'rgba8unorm' as TextureFormat },
                ];
            case 'depth':
                return [{ format: 'rgba8unorm' as TextureFormat }];
            default:
                return [{ format: 'bgra8unorm' as TextureFormat }];
        }
    }

    private getDepthStencilState(variant: WebGPURenderVariant): any {
        return {
            format: 'depth24plus',
            // Volume rendering writes depth based on raymarched result
            depthWriteEnabled: false,
            depthCompare: 'always',
        };
    }

    private getBlendState(variant: WebGPURenderVariant): any {
        // Volume rendering typically uses blending
        if (variant === 'color') {
            return {
                color: {
                    srcFactor: 'one',
                    dstFactor: 'one-minus-src-alpha',
                    operation: 'add',
                },
                alpha: {
                    srcFactor: 'one',
                    dstFactor: 'one-minus-src-alpha',
                    operation: 'add',
                },
            };
        }
        return undefined;
    }

    protected createBindGroups(): void {
        if (!this.uniformBuffer) {
            this.uniformBuffer = this.context.createBuffer({
                size: 512,
                usage: ['uniform', 'copy-dst'],
            });
        }

        if (!this.volumeVertUniformBuffer) {
            // Size for DirectVolumeVertUniforms
            this.volumeVertUniformBuffer = this.context.createBuffer({
                size: 256,
                usage: ['uniform', 'copy-dst'],
            });
        }

        if (!this.volumeFragUniformBuffer) {
            // Size for DirectVolumeFragUniforms
            this.volumeFragUniformBuffer = this.context.createBuffer({
                size: 512,
                usage: ['uniform', 'copy-dst'],
            });
        }
    }

    protected uploadValues(): void {
        // Upload position data (bounding box vertices)
        const positions = this.values.aPosition.ref.value;
        if (positions.length > 0) {
            if (!this.positionBuffer || this.positionBuffer.size < positions.byteLength) {
                if (this.positionBuffer) this.positionBuffer.destroy();
                this.positionBuffer = this.context.createBuffer({
                    size: positions.byteLength,
                    usage: ['vertex', 'copy-dst'],
                });
            }
            this.positionBuffer.write(positions);

            const vb = this.vertexBuffers.get('aPosition');
            if (vb) {
                vb.version = this.values.aPosition.ref.version;
            } else {
                this.vertexBuffers.set('aPosition', {
                    buffer: this.positionBuffer,
                    version: this.values.aPosition.ref.version,
                });
            }
        }

        // Upload index data
        const elements = this.values.elements.ref.value;
        if (elements.length > 0) {
            if (!this.indexBuffer_ || this.indexBuffer_.size < elements.byteLength) {
                if (this.indexBuffer_) this.indexBuffer_.destroy();
                this.indexBuffer_ = this.context.createBuffer({
                    size: elements.byteLength,
                    usage: ['index', 'copy-dst'],
                });
            }
            this.indexBuffer_.write(elements);

            this.indexBuffer = {
                buffer: this.indexBuffer_,
                version: this.values.elements.ref.version,
            };
        }

        // Upload instance data
        const transforms = this.values.aTransform.ref.value;
        if (transforms.length > 0) {
            const instanceDataSize = transforms.byteLength + this.values.aInstance.ref.value.byteLength;
            if (!this.instanceBuffer || this.instanceBuffer.size < instanceDataSize) {
                if (this.instanceBuffer) this.instanceBuffer.destroy();
                this.instanceBuffer = this.context.createBuffer({
                    size: instanceDataSize,
                    usage: ['storage', 'copy-dst'],
                });
            }
            // Interleave transform and instance data
            this.instanceBuffer.write(transforms);
        }

        // Upload grid texture
        const gridData = this.values.tGridTex.ref.value;
        const gridTexDim = this.values.uGridTexDim.ref.value;
        if (gridData.length > 0) {
            const width = Math.max(1, Math.floor(gridTexDim[0]));
            const height = Math.max(1, Math.floor(gridTexDim[1]));

            if (!this.gridTexture) {
                this.gridTexture = this.context.createTexture({
                    size: [width, height],
                    format: 'rgba8unorm',
                    usage: ['texture-binding', 'copy-dst'],
                });
            }
            this.gridTexture.write(gridData instanceof Uint8Array ? gridData : new Uint8Array(gridData.buffer));
        }

        // Upload transfer function texture
        const transferData = this.values.tTransferTex.ref.value;
        if (transferData.length > 0) {
            if (!this.transferTexture) {
                this.transferTexture = this.context.createTexture({
                    size: [256, 1],
                    format: 'r8unorm',
                    usage: ['texture-binding', 'copy-dst'],
                });
            }
            this.transferTexture.write(transferData);
        }

        // Upload volume uniforms
        this.uploadVolumeUniforms();
    }

    private uploadVolumeUniforms(): void {
        if (!this.volumeVertUniformBuffer || !this.volumeFragUniformBuffer) return;

        // Vertex uniforms
        const vertData = new Float32Array(64); // 256 bytes
        const bboxMin = this.values.uBboxMin.ref.value;
        const bboxMax = this.values.uBboxMax.ref.value;
        const bboxSize = this.values.uBboxSize.ref.value;
        const gridDim = this.values.uGridDim.ref.value;
        const unitToCartn = this.values.uUnitToCartn.ref.value;
        const boundingSphere = this.values.uInvariantBoundingSphere.ref.value;

        let offset = 0;
        vertData.set(bboxMin, offset); offset += 4;
        vertData.set(bboxMax, offset); offset += 4;
        vertData.set(bboxSize, offset); offset += 4;
        vertData.set(gridDim, offset); offset += 3;
        vertData[offset++] = this.values.uModelScale.ref.value;
        vertData.set(unitToCartn, offset); offset += 16;
        vertData.set(boundingSphere, offset);

        this.volumeVertUniformBuffer.write(vertData);

        // Fragment uniforms
        const fragData = new Float32Array(128); // 512 bytes
        const gridTexDim = this.values.uGridTexDim.ref.value;
        const cellDim = this.values.uCellDim.ref.value;
        const cartnToUnit = this.values.uCartnToUnit.ref.value;

        offset = 0;
        fragData.set(bboxMin, offset); offset += 4;
        fragData.set(bboxMax, offset); offset += 4;
        fragData.set(bboxSize, offset); offset += 4;
        fragData.set(gridDim, offset); offset += 3;
        fragData[offset++] = this.values.uMaxSteps.ref.value;
        fragData.set(cellDim, offset); offset += 3;
        fragData[offset++] = this.values.uStepScale.ref.value;
        fragData[offset++] = this.values.uJumpLength.ref.value;
        fragData[offset++] = this.values.uTransferScale.ref.value;
        fragData[offset++] = this.values.uModelScale.ref.value;
        fragData[offset++] = this.values.dIgnoreLight.ref.value ? 0 : 1;
        fragData.set(gridTexDim, offset); offset += 3;
        fragData[offset++] = 0; // gridTexType (0 = 2D)
        fragData.set(cartnToUnit, offset); offset += 16;
        fragData.set(unitToCartn, offset);

        this.volumeFragUniformBuffer.write(fragData);
    }

    protected getDrawCount(): number {
        return this.values.drawCount.ref.value;
    }

    protected getInstanceCount(): number {
        return this.values.instanceCount.ref.value;
    }

    dispose(): void {
        super.dispose();

        if (this.positionBuffer) this.positionBuffer.destroy();
        if (this.indexBuffer_) this.indexBuffer_.destroy();
        if (this.uniformBuffer) this.uniformBuffer.destroy();
        if (this.volumeVertUniformBuffer) this.volumeVertUniformBuffer.destroy();
        if (this.volumeFragUniformBuffer) this.volumeFragUniformBuffer.destroy();
        if (this.instanceBuffer) this.instanceBuffer.destroy();

        if (this.gridTexture) this.gridTexture.destroy();
        if (this.transferTexture) this.transferTexture.destroy();
        if (this.depthTexture) this.depthTexture.destroy();

        this.shaderModules.clear();
    }
}

/**
 * Create a WebGPU direct volume renderable.
 */
export function createWebGPUDirectVolumeRenderable(
    context: GPUContext,
    values: WebGPUDirectVolumeValues,
    state?: WebGPURenderableState,
    materialId?: number,
    transparency?: WebGPUTransparency
): WebGPUDirectVolumeRenderable {
    const descriptor: WebGPURenderableDescriptor<WebGPUDirectVolumeValues> = {
        context,
        materialId: materialId ?? 0,
        topology: 'triangle-list',
        values,
        state: state ?? createWebGPURenderableState(),
        transparency: transparency ?? 'blended', // Volume rendering typically uses blending
        vertexShader: DirectVolumeShader.vertex,
        fragmentShaders: {
            color: DirectVolumeShader.fragment.color,
            pick: DirectVolumeShader.fragment.pick,
            depth: DirectVolumeShader.fragment.depth,
            marking: DirectVolumeShader.fragment.color,
            emissive: DirectVolumeShader.fragment.color,
            tracing: DirectVolumeShader.fragment.color,
        },
        vertexBufferLayouts: [],
        bindGroupLayouts: [],
    };

    return new WebGPUDirectVolumeRenderable(descriptor);
}
