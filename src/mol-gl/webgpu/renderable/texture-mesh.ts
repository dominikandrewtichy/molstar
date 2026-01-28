/**
 * Copyright (c) 2025 mol* contributors, licensed under MIT, See LICENSE file for more info.
 *
 * @author Alexander Rose <alexander.rose@weirdbyte.de>
 *
 * WebGPU texture-mesh renderable implementation.
 * Geometry is stored in textures rather than vertex buffers.
 */

import { ValueCell } from '../../../mol-util/value-cell';
import { GPUContext, Buffer, BindGroupLayout, PipelineLayout, ShaderModule, TextureFormat, ShaderStage, Texture, Sampler } from '../../gpu';
import {
    WebGPURenderableBase,
    WebGPURenderableDescriptor,
    WebGPURenderableState,
    WebGPURenderableValues,
    WebGPURenderVariant,
    WebGPUTransparency,
    createWebGPURenderableState,
} from '../renderable';
import { TextureMeshShader } from '../../shader/wgsl/texture-mesh.wgsl';

/**
 * Values for WebGPU texture-mesh renderable.
 * Geometry is stored in textures rather than vertex buffers.
 */
export interface WebGPUTextureMeshValues extends WebGPURenderableValues {
    // Geometry textures
    tPosition: ValueCell<Texture | null>;
    tNormal: ValueCell<Texture | null>;
    tGroup: ValueCell<Texture | null>;

    // Texture dimensions
    uGeoTexDim: ValueCell<Float32Array>;

    // Instance data
    aTransform: ValueCell<Float32Array>;
    aInstance: ValueCell<Float32Array>;

    // Counts
    drawCount: ValueCell<number>;
    instanceCount: ValueCell<number>;

    // Material properties
    uColor: ValueCell<Float32Array>;
    uAlpha: ValueCell<number>;
    uMetalness: ValueCell<number>;
    uRoughness: ValueCell<number>;

    // Object properties
    uObjectId: ValueCell<number>;

    // Double sided
    uDoubleSided: ValueCell<number>;
}

/**
 * Create initial texture-mesh values.
 */
export function createWebGPUTextureMeshValues(): WebGPUTextureMeshValues {
    return {
        tPosition: ValueCell.create(null),
        tNormal: ValueCell.create(null),
        tGroup: ValueCell.create(null),

        uGeoTexDim: ValueCell.create(new Float32Array([1, 1])),

        aTransform: ValueCell.create(new Float32Array(16)),
        aInstance: ValueCell.create(new Float32Array(0)),

        drawCount: ValueCell.create(0),
        instanceCount: ValueCell.create(1),

        uColor: ValueCell.create(new Float32Array([1, 1, 1, 1])),
        uAlpha: ValueCell.create(1),
        uMetalness: ValueCell.create(0),
        uRoughness: ValueCell.create(0.5),

        uObjectId: ValueCell.create(0),

        uDoubleSided: ValueCell.create(0),
    };
}

/**
 * WebGPU texture-mesh renderable implementation.
 * Geometry data is sampled from textures in the vertex shader.
 */
export class WebGPUTextureMeshRenderable extends WebGPURenderableBase<WebGPUTextureMeshValues> {
    private geometryUniformBuffer: Buffer | null = null;
    private objectUniformBuffer: Buffer | null = null;
    private instanceBuffer: Buffer | null = null;

    private frameBindGroupLayout: BindGroupLayout | null = null;
    private materialBindGroupLayout: BindGroupLayout | null = null;
    private objectBindGroupLayout: BindGroupLayout | null = null;

    private shaderModules: Map<WebGPURenderVariant, ShaderModule> = new Map();

    // Texture and sampler cache
    private positionTexture: Texture | null = null;
    private normalTexture: Texture | null = null;
    private groupTexture: Texture | null = null;
    private textureSampler: Sampler | null = null;

    protected createPipelines(descriptor: WebGPURenderableDescriptor<WebGPUTextureMeshValues>): void {
        // Create shader modules
        const vertexModule = this.context.createShaderModule({
            code: TextureMeshShader.vertex,
        });

        // Create shader modules for each variant
        const colorModule = this.context.createShaderModule({
            code: TextureMeshShader.fragment.color,
        });
        const pickModule = this.context.createShaderModule({
            code: TextureMeshShader.fragment.pick,
        });
        const depthModule = this.context.createShaderModule({
            code: TextureMeshShader.fragment.depth,
        });
        const markingModule = this.context.createShaderModule({
            code: TextureMeshShader.fragment.marking,
        });
        const emissiveModule = this.context.createShaderModule({
            code: TextureMeshShader.fragment.emissive,
        });
        const tracingModule = this.context.createShaderModule({
            code: TextureMeshShader.fragment.tracing,
        });

        this.shaderModules.set('color', colorModule);
        this.shaderModules.set('pick', pickModule);
        this.shaderModules.set('depth', depthModule);
        this.shaderModules.set('marking', markingModule);
        this.shaderModules.set('emissive', emissiveModule);
        this.shaderModules.set('tracing', tracingModule);

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
        this.createPipelineForVariant('marking', vertexModule, markingModule, pipelineLayout);
        this.createPipelineForVariant('emissive', vertexModule, emissiveModule, pipelineLayout);
        this.createPipelineForVariant('tracing', vertexModule, tracingModule, pipelineLayout);
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

        // Object bind group layout (group 2) - includes textures and geometry data
        this.objectBindGroupLayout = this.context.createBindGroupLayout({
            entries: [
                // Object uniform buffer (model matrix, object ID)
                {
                    binding: 0,
                    visibility: ['vertex', 'fragment'] as ShaderStage[],
                    buffer: { type: 'uniform' },
                },
                // Geometry uniform buffer (texture dimensions)
                {
                    binding: 1,
                    visibility: ['vertex'] as ShaderStage[],
                    buffer: { type: 'uniform' },
                },
                // Position texture
                {
                    binding: 2,
                    visibility: ['vertex'] as ShaderStage[],
                    texture: { sampleType: 'float' },
                },
                // Group texture (also provides sampler)
                {
                    binding: 3,
                    visibility: ['vertex'] as ShaderStage[],
                    texture: { sampleType: 'float' },
                },
                // Normal texture
                {
                    binding: 4,
                    visibility: ['vertex'] as ShaderStage[],
                    texture: { sampleType: 'float' },
                },
                // Instance storage buffer
                {
                    binding: 5,
                    visibility: ['vertex'] as ShaderStage[],
                    buffer: { type: 'read-only-storage' },
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
        // Determine color targets based on variant
        const colorTargets = this.getColorTargets(variant);
        const depthStencilState = this.getDepthStencilState(variant);
        const blendState = this.getBlendState(variant);

        // Texture-mesh doesn't use vertex buffers - data comes from textures
        const pipeline = this.context.createRenderPipeline({
            layout,
            vertex: {
                module: vertexModule,
                entryPoint: 'main',
                buffers: [], // No vertex buffers - data from textures
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
                cullMode: 'back',
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
                // Multiple render targets for picking
                return [
                    { format: 'rgba8unorm' as TextureFormat }, // Object ID
                    { format: 'rgba8unorm' as TextureFormat }, // Instance ID
                    { format: 'rgba8unorm' as TextureFormat }, // Group ID
                    { format: 'rgba8unorm' as TextureFormat }, // Depth
                ];
            case 'depth':
                return [{ format: 'rgba8unorm' as TextureFormat }];
            case 'marking':
                return [{ format: 'rgba8unorm' as TextureFormat }];
            case 'emissive':
                return [{ format: 'rgba8unorm' as TextureFormat }];
            case 'tracing':
                return [{ format: 'bgra8unorm' as TextureFormat }];
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
        return undefined; // No blending for opaque
    }

    protected createBindGroups(): void {
        // Create geometry uniform buffer (texture dimensions)
        if (!this.geometryUniformBuffer) {
            this.geometryUniformBuffer = this.context.createBuffer({
                size: 16, // vec2 tex_dim + vec2 inv_tex_dim
                usage: ['uniform', 'copy-dst'],
            });
        }

        // Create object uniform buffer
        if (!this.objectUniformBuffer) {
            this.objectUniformBuffer = this.context.createBuffer({
                size: 128, // mat4 model + object ID + padding
                usage: ['uniform', 'copy-dst'],
            });
        }

        // Create texture sampler if needed
        if (!this.textureSampler) {
            this.textureSampler = this.context.createSampler({
                magFilter: 'nearest',
                minFilter: 'nearest',
                addressModeU: 'clamp-to-edge',
                addressModeV: 'clamp-to-edge',
            });
        }
    }

    protected uploadValues(): void {
        // Upload geometry texture references
        const posTex = this.values.tPosition.ref.value;
        if (posTex) {
            this.positionTexture = posTex;
        }

        const normTex = this.values.tNormal.ref.value;
        if (normTex) {
            this.normalTexture = normTex;
        }

        const groupTex = this.values.tGroup.ref.value;
        if (groupTex) {
            this.groupTexture = groupTex;
        }

        // Upload geometry uniform data (texture dimensions)
        if (this.geometryUniformBuffer) {
            const texDim = this.values.uGeoTexDim.ref.value;
            const geoData = new Float32Array(4);
            geoData[0] = texDim[0]; // tex_dim.x
            geoData[1] = texDim[1]; // tex_dim.y
            geoData[2] = 1.0 / texDim[0]; // inv_tex_dim.x
            geoData[3] = 1.0 / texDim[1]; // inv_tex_dim.y
            this.geometryUniformBuffer.write(geoData);
        }

        // Upload instance data
        const instances = this.values.aTransform.ref.value;
        if (instances.length > 0) {
            if (!this.instanceBuffer || this.instanceBuffer.size < instances.byteLength) {
                if (this.instanceBuffer) this.instanceBuffer.destroy();
                this.instanceBuffer = this.context.createBuffer({
                    size: instances.byteLength,
                    usage: ['storage', 'copy-dst'],
                });
            }
            this.instanceBuffer.write(instances);
        }
    }

    protected getDrawCount(): number {
        return this.values.drawCount.ref.value;
    }

    protected getInstanceCount(): number {
        return this.values.instanceCount.ref.value;
    }

    /**
     * Get the object bind group with textures.
     * This needs to be called during render to set up the bind group.
     */
    getObjectBindGroup(): { layout: BindGroupLayout; entries: any[] } {
        return {
            layout: this.objectBindGroupLayout!,
            entries: [
                { binding: 0, resource: { buffer: this.objectUniformBuffer } },
                { binding: 1, resource: { buffer: this.geometryUniformBuffer } },
                { binding: 2, resource: this.positionTexture?.createView() },
                { binding: 3, resource: this.groupTexture?.createView() },
                { binding: 4, resource: this.normalTexture?.createView() },
                { binding: 5, resource: { buffer: this.instanceBuffer } },
            ],
        };
    }

    dispose(): void {
        super.dispose();

        // Clean up specific resources
        if (this.geometryUniformBuffer) this.geometryUniformBuffer.destroy();
        if (this.objectUniformBuffer) this.objectUniformBuffer.destroy();
        if (this.instanceBuffer) this.instanceBuffer.destroy();

        this.shaderModules.clear();
    }
}

/**
 * Create a WebGPU texture-mesh renderable.
 */
export function createWebGPUTextureMeshRenderable(
    context: GPUContext,
    values: WebGPUTextureMeshValues,
    state?: WebGPURenderableState,
    materialId?: number,
    transparency?: WebGPUTransparency
): WebGPUTextureMeshRenderable {
    const descriptor: WebGPURenderableDescriptor<WebGPUTextureMeshValues> = {
        context,
        materialId: materialId ?? 0,
        topology: 'triangle-list',
        values,
        state: state ?? createWebGPURenderableState(),
        transparency: transparency ?? 'opaque',
        vertexShader: TextureMeshShader.vertex,
        fragmentShaders: {
            color: TextureMeshShader.fragment.color,
            pick: TextureMeshShader.fragment.pick,
            depth: TextureMeshShader.fragment.depth,
            marking: TextureMeshShader.fragment.marking,
            emissive: TextureMeshShader.fragment.emissive,
            tracing: TextureMeshShader.fragment.tracing,
        },
        vertexBufferLayouts: [],
        bindGroupLayouts: [],
    };

    return new WebGPUTextureMeshRenderable(descriptor);
}
