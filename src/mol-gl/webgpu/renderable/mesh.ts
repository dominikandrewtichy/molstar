/**
 * Copyright (c) 2025 mol* contributors, licensed under MIT, See LICENSE file for more info.
 *
 * @author Alexander Rose <alexander.rose@weirdbyte.de>
 */

import { ValueCell } from '../../../mol-util/value-cell';
import { GPUContext, Buffer, BindGroupLayout, PipelineLayout, ShaderModule, TextureFormat, ShaderStage } from '../../gpu';
import {
    WebGPURenderableBase,
    WebGPURenderableDescriptor,
    WebGPURenderableState,
    WebGPURenderableValues,
    WebGPURenderVariant,
    WebGPUTransparency,
    createWebGPURenderableState,
} from '../renderable';
import { MeshShader } from '../../shader/wgsl/mesh.wgsl';

/**
 * Values for WebGPU mesh renderable.
 */
export interface WebGPUMeshValues extends WebGPURenderableValues {
    // Geometry
    aPosition: ValueCell<Float32Array>;
    aNormal: ValueCell<Float32Array>;
    aGroup: ValueCell<Float32Array>;
    elements: ValueCell<Uint32Array>;

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
}

/**
 * Create initial mesh values.
 */
export function createWebGPUMeshValues(): WebGPUMeshValues {
    return {
        aPosition: ValueCell.create(new Float32Array(0)),
        aNormal: ValueCell.create(new Float32Array(0)),
        aGroup: ValueCell.create(new Float32Array(0)),
        elements: ValueCell.create(new Uint32Array(0)),

        aTransform: ValueCell.create(new Float32Array(16)),
        aInstance: ValueCell.create(new Float32Array(0)),

        drawCount: ValueCell.create(0),
        instanceCount: ValueCell.create(1),

        uColor: ValueCell.create(new Float32Array([1, 1, 1, 1])),
        uAlpha: ValueCell.create(1),
        uMetalness: ValueCell.create(0),
        uRoughness: ValueCell.create(0.5),

        uObjectId: ValueCell.create(0),
    };
}

/**
 * WebGPU mesh renderable implementation.
 */
export class WebGPUMeshRenderable extends WebGPURenderableBase<WebGPUMeshValues> {
    private positionBuffer: Buffer | null = null;
    private normalBuffer: Buffer | null = null;
    private groupBuffer: Buffer | null = null;
    private indexBuffer_: Buffer | null = null;
    private uniformBuffer: Buffer | null = null;

    private frameBindGroupLayout: BindGroupLayout | null = null;
    private materialBindGroupLayout: BindGroupLayout | null = null;
    private objectBindGroupLayout: BindGroupLayout | null = null;

    private shaderModules: Map<WebGPURenderVariant, ShaderModule> = new Map();

    protected createPipelines(descriptor: WebGPURenderableDescriptor<WebGPUMeshValues>): void {
        // Create shader modules
        const vertexModule = this.context.createShaderModule({
            code: MeshShader.vertex,
        });

        // Create shader modules for each variant
        const colorModule = this.context.createShaderModule({
            code: MeshShader.fragment.color,
        });
        const pickModule = this.context.createShaderModule({
            code: MeshShader.fragment.pick,
        });
        const depthModule = this.context.createShaderModule({
            code: MeshShader.fragment.depth,
        });
        const markingModule = this.context.createShaderModule({
            code: MeshShader.fragment.marking,
        });
        const emissiveModule = this.context.createShaderModule({
            code: MeshShader.fragment.emissive,
        });
        const tracingModule = this.context.createShaderModule({
            code: MeshShader.fragment.tracing,
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

        // Object bind group layout (group 2)
        this.objectBindGroupLayout = this.context.createBindGroupLayout({
            entries: [
                {
                    binding: 0,
                    visibility: ['vertex', 'fragment'] as ShaderStage[],
                    buffer: { type: 'uniform' },
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
                    // Normal buffer
                    {
                        arrayStride: 12,
                        stepMode: 'vertex',
                        attributes: [
                            { format: 'float32x3', offset: 0, shaderLocation: 1 },
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
        // This will be called when bind groups need to be created/updated
        // with actual uniform buffer data

        if (!this.uniformBuffer) {
            // Create uniform buffer with appropriate size
            this.uniformBuffer = this.context.createBuffer({
                size: 256, // Enough for basic uniforms
                usage: ['uniform', 'copy-dst'],
            });
        }

        // Create bind groups...
        // (Implementation depends on actual uniform layout)
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

        // Upload normal data
        const normals = this.values.aNormal.ref.value;
        if (normals.length > 0) {
            if (!this.normalBuffer || this.normalBuffer.size < normals.byteLength) {
                if (this.normalBuffer) this.normalBuffer.destroy();
                this.normalBuffer = this.context.createBuffer({
                    size: normals.byteLength,
                    usage: ['vertex', 'copy-dst'],
                });
            }
            this.normalBuffer.write(normals);

            const vb = this.vertexBuffers.get('aNormal');
            if (vb) {
                vb.version = this.values.aNormal.ref.version;
            } else {
                this.vertexBuffers.set('aNormal', {
                    buffer: this.normalBuffer,
                    version: this.values.aNormal.ref.version,
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
    }

    protected getDrawCount(): number {
        return this.values.drawCount.ref.value;
    }

    protected getInstanceCount(): number {
        return this.values.instanceCount.ref.value;
    }

    dispose(): void {
        super.dispose();

        // Clean up specific resources
        if (this.positionBuffer) this.positionBuffer.destroy();
        if (this.normalBuffer) this.normalBuffer.destroy();
        if (this.groupBuffer) this.groupBuffer.destroy();
        if (this.indexBuffer_) this.indexBuffer_.destroy();
        if (this.uniformBuffer) this.uniformBuffer.destroy();

        this.shaderModules.clear();
    }
}

/**
 * Create a WebGPU mesh renderable.
 */
export function createWebGPUMeshRenderable(
    context: GPUContext,
    values: WebGPUMeshValues,
    state?: WebGPURenderableState,
    materialId?: number,
    transparency?: WebGPUTransparency
): WebGPUMeshRenderable {
    const descriptor: WebGPURenderableDescriptor<WebGPUMeshValues> = {
        context,
        materialId: materialId ?? 0,
        topology: 'triangle-list',
        values,
        state: state ?? createWebGPURenderableState(),
        transparency: transparency ?? 'opaque',
        vertexShader: MeshShader.vertex,
        fragmentShaders: {
            color: MeshShader.fragment.color,
            pick: MeshShader.fragment.pick,
            depth: MeshShader.fragment.depth,
            marking: MeshShader.fragment.marking,
            emissive: MeshShader.fragment.emissive,
            tracing: MeshShader.fragment.tracing,
        },
        vertexBufferLayouts: [],
        bindGroupLayouts: [],
    };

    return new WebGPUMeshRenderable(descriptor);
}
