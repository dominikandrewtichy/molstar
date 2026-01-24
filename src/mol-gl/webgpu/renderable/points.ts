/**
 * Copyright (c) 2025 mol* contributors, licensed under MIT, See LICENSE file for more info.
 *
 * @author Alexander Rose <alexander.rose@weirdbyte.de>
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
import { PointsShader } from '../../shader/wgsl/points.wgsl';

/**
 * Point style enumeration.
 */
export enum PointStyle {
    Square = 0,
    Circle = 1,
    Fuzzy = 2,
}

/**
 * Values for WebGPU points renderable.
 * Points are rendered as screen-aligned quads.
 */
export interface WebGPUPointsValues extends WebGPURenderableValues {
    // Point data textures
    tPositionGroup: ValueCell<Float32Array>; // position.xyz, group
    tSize: ValueCell<Float32Array>; // size (optional)
    uTexDim: ValueCell<Float32Array>; // [width, height]

    // Instance data
    aTransform: ValueCell<Float32Array>;
    aInstance: ValueCell<Float32Array>;

    // Counts
    drawCount: ValueCell<number>; // Number of points
    instanceCount: ValueCell<number>;

    // Points-specific uniforms
    uModelView: ValueCell<Float32Array>; // mat4
    uPixelRatio: ValueCell<number>;
    uPointSizeAttenuation: ValueCell<boolean>;
    uModelScale: ValueCell<number>;
    uViewport: ValueCell<Float32Array>; // vec4 [x, y, width, height]
    uPointStyle: ValueCell<PointStyle>;

    // Material properties
    uColor: ValueCell<Float32Array>; // vec4
    uAlpha: ValueCell<number>;

    // Object properties
    uObjectId: ValueCell<number>;
}

/**
 * Create initial points values.
 */
export function createWebGPUPointsValues(): WebGPUPointsValues {
    return {
        tPositionGroup: ValueCell.create(new Float32Array(0)),
        tSize: ValueCell.create(new Float32Array(0)),
        uTexDim: ValueCell.create(new Float32Array([1, 1])),

        aTransform: ValueCell.create(new Float32Array(16)),
        aInstance: ValueCell.create(new Float32Array(0)),

        drawCount: ValueCell.create(0),
        instanceCount: ValueCell.create(1),

        uModelView: ValueCell.create(new Float32Array(16)),
        uPixelRatio: ValueCell.create(1),
        uPointSizeAttenuation: ValueCell.create(true),
        uModelScale: ValueCell.create(1),
        uViewport: ValueCell.create(new Float32Array([0, 0, 1, 1])),
        uPointStyle: ValueCell.create(PointStyle.Circle),

        uColor: ValueCell.create(new Float32Array([1, 1, 1, 1])),
        uAlpha: ValueCell.create(1),

        uObjectId: ValueCell.create(0),
    };
}

/**
 * WebGPU points renderable implementation.
 */
export class WebGPUPointsRenderable extends WebGPURenderableBase<WebGPUPointsValues> {
    // Textures
    private positionGroupTexture: Texture | null = null;
    private positionGroupSampler: Sampler | null = null;
    private sizeTexture: Texture | null = null;
    private sizeSampler: Sampler | null = null;

    // Buffers
    private instanceStorageBuffer: Buffer | null = null;
    private frameUniformBuffer: Buffer | null = null;
    private materialUniformBuffer: Buffer | null = null;
    private objectUniformBuffer: Buffer | null = null;
    private pointsVertUniformBuffer: Buffer | null = null;
    private pointsFragUniformBuffer: Buffer | null = null;

    // Bind group layouts
    private frameBindGroupLayout: BindGroupLayout | null = null;
    private materialBindGroupLayout: BindGroupLayout | null = null;
    private objectBindGroupLayout: BindGroupLayout | null = null;

    private shaderModules: Map<WebGPURenderVariant, ShaderModule> = new Map();

    protected createPipelines(descriptor: WebGPURenderableDescriptor<WebGPUPointsValues>): void {
        const vertexModule = this.context.createShaderModule({
            code: PointsShader.vertex,
            label: 'points-vertex',
        });

        const colorModule = this.context.createShaderModule({
            code: PointsShader.fragment.color,
            label: 'points-fragment-color',
        });
        const pickModule = this.context.createShaderModule({
            code: PointsShader.fragment.pick,
            label: 'points-fragment-pick',
        });
        const depthModule = this.context.createShaderModule({
            code: PointsShader.fragment.depth,
            label: 'points-fragment-depth',
        });

        this.shaderModules.set('color', colorModule);
        this.shaderModules.set('pick', pickModule);
        this.shaderModules.set('depth', depthModule);

        this.createBindGroupLayouts();

        const pipelineLayout = this.context.createPipelineLayout({
            bindGroupLayouts: [
                this.frameBindGroupLayout!,
                this.materialBindGroupLayout!,
                this.objectBindGroupLayout!,
            ],
            label: 'points-pipeline-layout',
        });

        this.createPipelineForVariant('color', vertexModule, colorModule, pipelineLayout);
        this.createPipelineForVariant('pick', vertexModule, pickModule, pipelineLayout);
        this.createPipelineForVariant('depth', vertexModule, depthModule, pipelineLayout);
    }

    private createBindGroupLayouts(): void {
        this.frameBindGroupLayout = this.context.createBindGroupLayout({
            entries: [
                {
                    binding: 0,
                    visibility: ['vertex', 'fragment'] as ShaderStage[],
                    buffer: { type: 'uniform' },
                },
            ],
            label: 'points-frame-bind-group-layout',
        });

        this.materialBindGroupLayout = this.context.createBindGroupLayout({
            entries: [
                {
                    binding: 0,
                    visibility: ['fragment'] as ShaderStage[],
                    buffer: { type: 'uniform' },
                },
            ],
            label: 'points-material-bind-group-layout',
        });

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
                    buffer: { type: 'uniform' },
                },
                {
                    binding: 2,
                    visibility: ['vertex'] as ShaderStage[],
                    texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },
                },
                {
                    binding: 3,
                    visibility: ['vertex'] as ShaderStage[],
                    sampler: { type: 'non-filtering' },
                },
                {
                    binding: 4,
                    visibility: ['vertex'] as ShaderStage[],
                    texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },
                },
                {
                    binding: 5,
                    visibility: ['vertex'] as ShaderStage[],
                    sampler: { type: 'non-filtering' },
                },
                {
                    binding: 6,
                    visibility: ['vertex'] as ShaderStage[],
                    buffer: { type: 'read-only-storage' },
                },
            ],
            label: 'points-object-bind-group-layout',
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
                buffers: [],
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
                cullMode: 'none',
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
        if (!this.frameUniformBuffer) {
            this.frameUniformBuffer = this.context.createBuffer({
                size: 256,
                usage: ['uniform', 'copy-dst'],
                label: 'points-frame-uniforms',
            });
        }

        if (!this.materialUniformBuffer) {
            this.materialUniformBuffer = this.context.createBuffer({
                size: 256,
                usage: ['uniform', 'copy-dst'],
                label: 'points-material-uniforms',
            });
        }

        if (!this.objectUniformBuffer) {
            this.objectUniformBuffer = this.context.createBuffer({
                size: 256,
                usage: ['uniform', 'copy-dst'],
                label: 'points-object-uniforms',
            });
        }

        if (!this.pointsVertUniformBuffer) {
            this.pointsVertUniformBuffer = this.context.createBuffer({
                size: 256,
                usage: ['uniform', 'copy-dst'],
                label: 'points-vert-uniforms',
            });
        }

        if (!this.pointsFragUniformBuffer) {
            this.pointsFragUniformBuffer = this.context.createBuffer({
                size: 256,
                usage: ['uniform', 'copy-dst'],
                label: 'points-frag-uniforms',
            });
        }

        this.createPointsTextures();
        this.createInstanceStorageBuffer();
    }

    private createPointsTextures(): void {
        const texDim = this.values.uTexDim.ref.value;
        const width = Math.max(1, Math.floor(texDim[0]));
        const height = Math.max(1, Math.floor(texDim[1]));

        // Position/Group texture
        const positionGroupData = this.values.tPositionGroup.ref.value;
        if (!this.positionGroupTexture ||
            this.positionGroupTexture.width !== width ||
            this.positionGroupTexture.height !== height) {

            if (this.positionGroupTexture) this.positionGroupTexture.destroy();

            this.positionGroupTexture = this.context.createTexture({
                size: [width, height],
                format: 'rgba32float',
                usage: ['texture-binding', 'copy-dst'],
                label: 'points-position-group-texture',
            });

            if (!this.positionGroupSampler) {
                this.positionGroupSampler = this.context.createSampler({
                    magFilter: 'nearest',
                    minFilter: 'nearest',
                    addressModeU: 'clamp-to-edge',
                    addressModeV: 'clamp-to-edge',
                    label: 'points-position-group-sampler',
                });
            }
        }

        if (positionGroupData.length > 0) {
            this.positionGroupTexture.write(positionGroupData, {
                size: [width, height, 1],
            });
        }

        // Size texture
        const sizeData = this.values.tSize.ref.value;
        if (!this.sizeTexture ||
            this.sizeTexture.width !== width ||
            this.sizeTexture.height !== height) {

            if (this.sizeTexture) this.sizeTexture.destroy();

            this.sizeTexture = this.context.createTexture({
                size: [width, height],
                format: 'r32float',
                usage: ['texture-binding', 'copy-dst'],
                label: 'points-size-texture',
            });

            if (!this.sizeSampler) {
                this.sizeSampler = this.context.createSampler({
                    magFilter: 'nearest',
                    minFilter: 'nearest',
                    addressModeU: 'clamp-to-edge',
                    addressModeV: 'clamp-to-edge',
                    label: 'points-size-sampler',
                });
            }
        }

        if (sizeData.length > 0) {
            this.sizeTexture.write(sizeData, {
                size: [width, height, 1],
            });
        }
    }

    private createInstanceStorageBuffer(): void {
        const transforms = this.values.aTransform.ref.value;
        const instances = this.values.aInstance.ref.value;
        const instanceCount = this.values.instanceCount.ref.value;

        const instanceSize = 80;
        const bufferSize = Math.max(instanceSize, instanceCount * instanceSize);

        if (!this.instanceStorageBuffer || this.instanceStorageBuffer.size < bufferSize) {
            if (this.instanceStorageBuffer) this.instanceStorageBuffer.destroy();

            this.instanceStorageBuffer = this.context.createBuffer({
                size: bufferSize,
                usage: ['storage', 'copy-dst'],
                label: 'points-instance-storage',
            });
        }

        const instanceData = new Float32Array(instanceCount * 20);
        for (let i = 0; i < instanceCount; i++) {
            for (let j = 0; j < 16; j++) {
                const srcIdx = i * 16 + j;
                instanceData[i * 20 + j] = transforms.length > srcIdx ? transforms[srcIdx] : (j % 5 === 0 ? 1 : 0);
            }
            instanceData[i * 20 + 16] = instances.length > i ? instances[i] : i;
            instanceData[i * 20 + 17] = 0;
            instanceData[i * 20 + 18] = 0;
            instanceData[i * 20 + 19] = 0;
        }

        this.instanceStorageBuffer.write(instanceData);
    }

    protected uploadValues(): void {
        this.createPointsTextures();
        this.createInstanceStorageBuffer();
        this.uploadUniformBuffers();
    }

    private uploadUniformBuffers(): void {
        // Upload points vertex uniforms
        if (this.pointsVertUniformBuffer) {
            const data = new Float32Array(64);

            const modelView = this.values.uModelView.ref.value;
            for (let i = 0; i < 16; i++) {
                data[i] = modelView[i] || 0;
            }

            data[16] = this.values.uPixelRatio.ref.value;
            data[17] = this.values.uPointSizeAttenuation.ref.value ? 1.0 : 0.0;
            data[18] = this.values.uModelScale.ref.value;
            data[19] = 0;

            const viewport = this.values.uViewport.ref.value;
            for (let i = 0; i < 4; i++) {
                data[20 + i] = viewport[i] || 0;
            }

            const texDim = this.values.uTexDim.ref.value;
            data[24] = texDim[0];
            data[25] = texDim[1];
            data[26] = 0;
            data[27] = 0;

            this.pointsVertUniformBuffer.write(data);
        }

        // Upload points fragment uniforms
        if (this.pointsFragUniformBuffer) {
            const data = new Uint32Array(64);
            data[0] = this.values.uPointStyle.ref.value;
            this.pointsFragUniformBuffer.write(new Float32Array(data.buffer));
        }

        // Upload material uniforms
        if (this.materialUniformBuffer) {
            const data = new Float32Array(64);
            const color = this.values.uColor.ref.value;
            for (let i = 0; i < 4; i++) {
                data[i] = color[i] || 0;
            }
            data[4] = this.values.uAlpha.ref.value;
            this.materialUniformBuffer.write(data);
        }
    }

    protected getDrawCount(): number {
        return this.values.drawCount.ref.value * 6;
    }

    protected getInstanceCount(): number {
        return this.values.instanceCount.ref.value;
    }

    dispose(): void {
        super.dispose();

        if (this.positionGroupTexture) this.positionGroupTexture.destroy();
        if (this.positionGroupSampler) this.positionGroupSampler.destroy();
        if (this.sizeTexture) this.sizeTexture.destroy();
        if (this.sizeSampler) this.sizeSampler.destroy();
        if (this.instanceStorageBuffer) this.instanceStorageBuffer.destroy();
        if (this.frameUniformBuffer) this.frameUniformBuffer.destroy();
        if (this.materialUniformBuffer) this.materialUniformBuffer.destroy();
        if (this.objectUniformBuffer) this.objectUniformBuffer.destroy();
        if (this.pointsVertUniformBuffer) this.pointsVertUniformBuffer.destroy();
        if (this.pointsFragUniformBuffer) this.pointsFragUniformBuffer.destroy();

        this.shaderModules.clear();
    }
}

/**
 * Create a WebGPU points renderable.
 */
export function createWebGPUPointsRenderable(
    context: GPUContext,
    values: WebGPUPointsValues,
    state?: WebGPURenderableState,
    materialId?: number,
    transparency?: WebGPUTransparency
): WebGPUPointsRenderable {
    const descriptor: WebGPURenderableDescriptor<WebGPUPointsValues> = {
        context,
        materialId: materialId ?? 0,
        topology: 'triangle-list',
        values,
        state: state ?? createWebGPURenderableState(),
        transparency: transparency ?? 'opaque',
        vertexShader: PointsShader.vertex,
        fragmentShaders: {
            color: PointsShader.fragment.color,
            pick: PointsShader.fragment.pick,
            depth: PointsShader.fragment.depth,
            marking: PointsShader.fragment.color,
            emissive: PointsShader.fragment.color,
            tracing: PointsShader.fragment.color,
        },
        vertexBufferLayouts: [],
        bindGroupLayouts: [],
    };

    return new WebGPUPointsRenderable(descriptor);
}
