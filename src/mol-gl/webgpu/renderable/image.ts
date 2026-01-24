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
import { ImageShader } from '../../shader/wgsl/image.wgsl';

/**
 * Values for WebGPU image renderable.
 */
export interface WebGPUImageValues extends WebGPURenderableValues {
    // Geometry
    aPosition: ValueCell<Float32Array>;
    aUv: ValueCell<Float32Array>;
    aGroup: ValueCell<Float32Array>;
    elements: ValueCell<Uint32Array>;

    // Instance data
    aTransform: ValueCell<Float32Array>;
    aInstance: ValueCell<Float32Array>;

    // Counts
    drawCount: ValueCell<number>;
    instanceCount: ValueCell<number>;

    // Image texture
    tImageTex: ValueCell<Uint8Array | Float32Array>;
    uImageTexDim: ValueCell<Float32Array>; // [width, height]

    // Group texture
    tGroupTex: ValueCell<Uint8Array>;

    // Value texture (for iso-level)
    tValueTex: ValueCell<Float32Array>;

    // Uniforms
    uIsoLevel: ValueCell<number>;
    uInterpolation: ValueCell<number>; // 0 = nearest, 1 = catmulrom, 2 = mitchell, 3 = bspline

    // Material properties
    uColor: ValueCell<Float32Array>;
    uAlpha: ValueCell<number>;

    // Object properties
    uObjectId: ValueCell<number>;
}

/**
 * Create initial image values.
 */
export function createWebGPUImageValues(): WebGPUImageValues {
    return {
        aPosition: ValueCell.create(new Float32Array(0)),
        aUv: ValueCell.create(new Float32Array(0)),
        aGroup: ValueCell.create(new Float32Array(0)),
        elements: ValueCell.create(new Uint32Array(0)),

        aTransform: ValueCell.create(new Float32Array(16)),
        aInstance: ValueCell.create(new Float32Array(0)),

        drawCount: ValueCell.create(0),
        instanceCount: ValueCell.create(1),

        tImageTex: ValueCell.create(new Uint8Array(0)),
        uImageTexDim: ValueCell.create(new Float32Array([1, 1])),

        tGroupTex: ValueCell.create(new Uint8Array(0)),
        tValueTex: ValueCell.create(new Float32Array(0)),

        uIsoLevel: ValueCell.create(-1),
        uInterpolation: ValueCell.create(0),

        uColor: ValueCell.create(new Float32Array([1, 1, 1, 1])),
        uAlpha: ValueCell.create(1),

        uObjectId: ValueCell.create(0),
    };
}

/**
 * WebGPU image renderable implementation.
 */
export class WebGPUImageRenderable extends WebGPURenderableBase<WebGPUImageValues> {
    private positionBuffer: Buffer | null = null;
    private uvBuffer: Buffer | null = null;
    private groupBuffer: Buffer | null = null;
    private indexBuffer_: Buffer | null = null;
    private uniformBuffer: Buffer | null = null;
    private imageUniformBuffer: Buffer | null = null;

    private imageTexture: Texture | null = null;
    private groupTexture: Texture | null = null;
    private valueTexture: Texture | null = null;
    private frameBindGroupLayout: BindGroupLayout | null = null;
    private materialBindGroupLayout: BindGroupLayout | null = null;
    private objectBindGroupLayout: BindGroupLayout | null = null;

    private shaderModules: Map<WebGPURenderVariant, ShaderModule> = new Map();

    protected createPipelines(descriptor: WebGPURenderableDescriptor<WebGPUImageValues>): void {
        // Create shader modules
        const vertexModule = this.context.createShaderModule({
            code: ImageShader.vertex,
        });

        // Create shader modules for each variant
        const colorModule = this.context.createShaderModule({
            code: ImageShader.fragment.color,
        });
        const pickModule = this.context.createShaderModule({
            code: ImageShader.fragment.pick,
        });
        const depthModule = this.context.createShaderModule({
            code: ImageShader.fragment.depth,
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

        // Object bind group layout (group 2)
        this.objectBindGroupLayout = this.context.createBindGroupLayout({
            entries: [
                {
                    binding: 0,
                    visibility: ['vertex', 'fragment'] as ShaderStage[],
                    buffer: { type: 'uniform' },
                },
                {
                    binding: 1,
                    visibility: ['vertex'] as ShaderStage[],
                    buffer: { type: 'read-only-storage' },
                },
                // Image uniforms
                {
                    binding: 2,
                    visibility: ['fragment'] as ShaderStage[],
                    buffer: { type: 'uniform' },
                },
                // Image texture
                {
                    binding: 3,
                    visibility: ['fragment'] as ShaderStage[],
                    texture: { sampleType: 'float' },
                },
                {
                    binding: 4,
                    visibility: ['fragment'] as ShaderStage[],
                    sampler: { type: 'filtering' },
                },
                // Group texture
                {
                    binding: 5,
                    visibility: ['fragment'] as ShaderStage[],
                    texture: { sampleType: 'float' },
                },
                {
                    binding: 6,
                    visibility: ['fragment'] as ShaderStage[],
                    sampler: { type: 'filtering' },
                },
                // Value texture
                {
                    binding: 7,
                    visibility: ['fragment'] as ShaderStage[],
                    texture: { sampleType: 'unfilterable-float' },
                },
                {
                    binding: 8,
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
                    // Position buffer
                    {
                        arrayStride: 12, // vec3<f32>
                        stepMode: 'vertex',
                        attributes: [
                            { format: 'float32x3', offset: 0, shaderLocation: 0 },
                        ],
                    },
                    // UV buffer
                    {
                        arrayStride: 8, // vec2<f32>
                        stepMode: 'vertex',
                        attributes: [
                            { format: 'float32x2', offset: 0, shaderLocation: 1 },
                        ],
                    },
                    // Group buffer
                    {
                        arrayStride: 4,
                        stepMode: 'vertex',
                        attributes: [
                            { format: 'float32', offset: 0, shaderLocation: 2 },
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
                cullMode: 'none', // Images are typically double-sided
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
            depthWriteEnabled: this.state.writeDepth,
            depthCompare: 'less',
        };
    }

    private getBlendState(variant: WebGPURenderVariant): any {
        if (this.transparency === 'blended') {
            return {
                color: {
                    srcFactor: 'src-alpha',
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
                size: 256,
                usage: ['uniform', 'copy-dst'],
            });
        }

        if (!this.imageUniformBuffer) {
            this.imageUniformBuffer = this.context.createBuffer({
                size: 64,
                usage: ['uniform', 'copy-dst'],
            });
        }
    }

    protected uploadValues(): void {
        // Upload position data
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

        // Upload UV data
        const uvs = this.values.aUv.ref.value;
        if (uvs.length > 0) {
            if (!this.uvBuffer || this.uvBuffer.size < uvs.byteLength) {
                if (this.uvBuffer) this.uvBuffer.destroy();
                this.uvBuffer = this.context.createBuffer({
                    size: uvs.byteLength,
                    usage: ['vertex', 'copy-dst'],
                });
            }
            this.uvBuffer.write(uvs);

            const vb = this.vertexBuffers.get('aUv');
            if (vb) {
                vb.version = this.values.aUv.ref.version;
            } else {
                this.vertexBuffers.set('aUv', {
                    buffer: this.uvBuffer,
                    version: this.values.aUv.ref.version,
                });
            }
        }

        // Upload group data
        const groups = this.values.aGroup.ref.value;
        if (groups.length > 0) {
            if (!this.groupBuffer || this.groupBuffer.size < groups.byteLength) {
                if (this.groupBuffer) this.groupBuffer.destroy();
                this.groupBuffer = this.context.createBuffer({
                    size: groups.byteLength,
                    usage: ['vertex', 'copy-dst'],
                });
            }
            this.groupBuffer.write(groups);

            const vb = this.vertexBuffers.get('aGroup');
            if (vb) {
                vb.version = this.values.aGroup.ref.version;
            } else {
                this.vertexBuffers.set('aGroup', {
                    buffer: this.groupBuffer,
                    version: this.values.aGroup.ref.version,
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

        // Upload image texture
        const imageDim = this.values.uImageTexDim.ref.value;
        const width = Math.max(1, Math.floor(imageDim[0]));
        const height = Math.max(1, Math.floor(imageDim[1]));

        const imageData = this.values.tImageTex.ref.value;
        if (imageData.length > 0) {
            if (!this.imageTexture) {
                this.imageTexture = this.context.createTexture({
                    size: [width, height],
                    format: 'rgba8unorm',
                    usage: ['texture-binding', 'copy-dst'],
                });
            }
            this.imageTexture.write(imageData instanceof Uint8Array ? imageData : new Uint8Array(imageData.buffer));
        }
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
        if (this.uvBuffer) this.uvBuffer.destroy();
        if (this.groupBuffer) this.groupBuffer.destroy();
        if (this.indexBuffer_) this.indexBuffer_.destroy();
        if (this.uniformBuffer) this.uniformBuffer.destroy();
        if (this.imageUniformBuffer) this.imageUniformBuffer.destroy();

        if (this.imageTexture) this.imageTexture.destroy();
        if (this.groupTexture) this.groupTexture.destroy();
        if (this.valueTexture) this.valueTexture.destroy();

        this.shaderModules.clear();
    }
}

/**
 * Create a WebGPU image renderable.
 */
export function createWebGPUImageRenderable(
    context: GPUContext,
    values: WebGPUImageValues,
    state?: WebGPURenderableState,
    materialId?: number,
    transparency?: WebGPUTransparency
): WebGPUImageRenderable {
    const descriptor: WebGPURenderableDescriptor<WebGPUImageValues> = {
        context,
        materialId: materialId ?? 0,
        topology: 'triangle-list',
        values,
        state: state ?? createWebGPURenderableState(),
        transparency: transparency ?? 'opaque',
        vertexShader: ImageShader.vertex,
        fragmentShaders: {
            color: ImageShader.fragment.color,
            pick: ImageShader.fragment.pick,
            depth: ImageShader.fragment.depth,
            marking: ImageShader.fragment.color,
            emissive: ImageShader.fragment.color,
            tracing: ImageShader.fragment.color,
        },
        vertexBufferLayouts: [],
        bindGroupLayouts: [],
    };

    return new WebGPUImageRenderable(descriptor);
}
