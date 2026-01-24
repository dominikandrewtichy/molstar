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
import { LinesShader } from '../../shader/wgsl/lines.wgsl';

/**
 * Values for WebGPU lines renderable.
 * Lines are rendered as screen-space quads with proper width calculation.
 */
export interface WebGPULinesValues extends WebGPURenderableValues {
    // Line data textures
    tStart: ValueCell<Float32Array>; // start position.xyz + w
    tEnd: ValueCell<Float32Array>; // end position.xyz + w
    tSizeGroup: ValueCell<Float32Array>; // size, group
    uTexDim: ValueCell<Float32Array>; // [width, height]

    // Instance data
    aTransform: ValueCell<Float32Array>;
    aInstance: ValueCell<Float32Array>;

    // Counts
    drawCount: ValueCell<number>; // Number of line segments
    instanceCount: ValueCell<number>;

    // Lines-specific uniforms
    uModelView: ValueCell<Float32Array>; // mat4
    uPixelRatio: ValueCell<number>;
    uLineSizeAttenuation: ValueCell<boolean>;
    uModelScale: ValueCell<number>;
    uViewport: ValueCell<Float32Array>; // vec4 [x, y, width, height]

    // Material properties
    uColor: ValueCell<Float32Array>; // vec4
    uAlpha: ValueCell<number>;

    // Object properties
    uObjectId: ValueCell<number>;
}

/**
 * Create initial lines values.
 */
export function createWebGPULinesValues(): WebGPULinesValues {
    return {
        tStart: ValueCell.create(new Float32Array(0)),
        tEnd: ValueCell.create(new Float32Array(0)),
        tSizeGroup: ValueCell.create(new Float32Array(0)),
        uTexDim: ValueCell.create(new Float32Array([1, 1])),

        aTransform: ValueCell.create(new Float32Array(16)),
        aInstance: ValueCell.create(new Float32Array(0)),

        drawCount: ValueCell.create(0),
        instanceCount: ValueCell.create(1),

        uModelView: ValueCell.create(new Float32Array(16)),
        uPixelRatio: ValueCell.create(1),
        uLineSizeAttenuation: ValueCell.create(false),
        uModelScale: ValueCell.create(1),
        uViewport: ValueCell.create(new Float32Array([0, 0, 1, 1])),

        uColor: ValueCell.create(new Float32Array([1, 1, 1, 1])),
        uAlpha: ValueCell.create(1),

        uObjectId: ValueCell.create(0),
    };
}

/**
 * WebGPU lines renderable implementation.
 */
export class WebGPULinesRenderable extends WebGPURenderableBase<WebGPULinesValues> {
    // Textures
    private startTexture: Texture | null = null;
    private startSampler: Sampler | null = null;
    private endTexture: Texture | null = null;
    private endSampler: Sampler | null = null;
    private sizeGroupTexture: Texture | null = null;
    private sizeGroupSampler: Sampler | null = null;

    // Buffers
    private instanceStorageBuffer: Buffer | null = null;
    private frameUniformBuffer: Buffer | null = null;
    private materialUniformBuffer: Buffer | null = null;
    private objectUniformBuffer: Buffer | null = null;
    private linesUniformBuffer: Buffer | null = null;

    // Bind group layouts
    private frameBindGroupLayout: BindGroupLayout | null = null;
    private materialBindGroupLayout: BindGroupLayout | null = null;
    private objectBindGroupLayout: BindGroupLayout | null = null;

    private shaderModules: Map<WebGPURenderVariant, ShaderModule> = new Map();

    protected createPipelines(descriptor: WebGPURenderableDescriptor<WebGPULinesValues>): void {
        const vertexModule = this.context.createShaderModule({
            code: LinesShader.vertex,
            label: 'lines-vertex',
        });

        const colorModule = this.context.createShaderModule({
            code: LinesShader.fragment.color,
            label: 'lines-fragment-color',
        });
        const pickModule = this.context.createShaderModule({
            code: LinesShader.fragment.pick,
            label: 'lines-fragment-pick',
        });
        const depthModule = this.context.createShaderModule({
            code: LinesShader.fragment.depth,
            label: 'lines-fragment-depth',
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
            label: 'lines-pipeline-layout',
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
            label: 'lines-frame-bind-group-layout',
        });

        this.materialBindGroupLayout = this.context.createBindGroupLayout({
            entries: [
                {
                    binding: 0,
                    visibility: ['fragment'] as ShaderStage[],
                    buffer: { type: 'uniform' },
                },
            ],
            label: 'lines-material-bind-group-layout',
        });

        this.objectBindGroupLayout = this.context.createBindGroupLayout({
            entries: [
                {
                    binding: 0,
                    visibility: ['vertex', 'fragment'] as ShaderStage[],
                    buffer: { type: 'uniform' }, // ObjectUniforms
                },
                {
                    binding: 1,
                    visibility: ['vertex'] as ShaderStage[],
                    buffer: { type: 'uniform' }, // LinesUniforms
                },
                {
                    binding: 2,
                    visibility: ['vertex'] as ShaderStage[],
                    texture: { sampleType: 'unfilterable-float', viewDimension: '2d' }, // tStart
                },
                {
                    binding: 3,
                    visibility: ['vertex'] as ShaderStage[],
                    sampler: { type: 'non-filtering' },
                },
                {
                    binding: 4,
                    visibility: ['vertex'] as ShaderStage[],
                    texture: { sampleType: 'unfilterable-float', viewDimension: '2d' }, // tEnd
                },
                {
                    binding: 5,
                    visibility: ['vertex'] as ShaderStage[],
                    sampler: { type: 'non-filtering' },
                },
                {
                    binding: 6,
                    visibility: ['vertex'] as ShaderStage[],
                    texture: { sampleType: 'unfilterable-float', viewDimension: '2d' }, // tSizeGroup
                },
                {
                    binding: 7,
                    visibility: ['vertex'] as ShaderStage[],
                    sampler: { type: 'non-filtering' },
                },
                {
                    binding: 8,
                    visibility: ['vertex'] as ShaderStage[],
                    buffer: { type: 'read-only-storage' }, // instances
                },
            ],
            label: 'lines-object-bind-group-layout',
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
                label: 'lines-frame-uniforms',
            });
        }

        if (!this.materialUniformBuffer) {
            this.materialUniformBuffer = this.context.createBuffer({
                size: 256,
                usage: ['uniform', 'copy-dst'],
                label: 'lines-material-uniforms',
            });
        }

        if (!this.objectUniformBuffer) {
            this.objectUniformBuffer = this.context.createBuffer({
                size: 256,
                usage: ['uniform', 'copy-dst'],
                label: 'lines-object-uniforms',
            });
        }

        if (!this.linesUniformBuffer) {
            this.linesUniformBuffer = this.context.createBuffer({
                size: 256,
                usage: ['uniform', 'copy-dst'],
                label: 'lines-uniforms',
            });
        }

        this.createLinesTextures();
        this.createInstanceStorageBuffer();
    }

    private createLinesTextures(): void {
        const texDim = this.values.uTexDim.ref.value;
        const width = Math.max(1, Math.floor(texDim[0]));
        const height = Math.max(1, Math.floor(texDim[1]));

        // Start texture
        const startData = this.values.tStart.ref.value;
        if (!this.startTexture ||
            this.startTexture.width !== width ||
            this.startTexture.height !== height) {

            if (this.startTexture) this.startTexture.destroy();

            this.startTexture = this.context.createTexture({
                size: [width, height],
                format: 'rgba32float',
                usage: ['texture-binding', 'copy-dst'],
                label: 'lines-start-texture',
            });

            if (!this.startSampler) {
                this.startSampler = this.context.createSampler({
                    magFilter: 'nearest',
                    minFilter: 'nearest',
                    addressModeU: 'clamp-to-edge',
                    addressModeV: 'clamp-to-edge',
                    label: 'lines-start-sampler',
                });
            }
        }

        if (startData.length > 0) {
            this.startTexture.write(startData, {
                size: [width, height, 1],
            });
        }

        // End texture
        const endData = this.values.tEnd.ref.value;
        if (!this.endTexture ||
            this.endTexture.width !== width ||
            this.endTexture.height !== height) {

            if (this.endTexture) this.endTexture.destroy();

            this.endTexture = this.context.createTexture({
                size: [width, height],
                format: 'rgba32float',
                usage: ['texture-binding', 'copy-dst'],
                label: 'lines-end-texture',
            });

            if (!this.endSampler) {
                this.endSampler = this.context.createSampler({
                    magFilter: 'nearest',
                    minFilter: 'nearest',
                    addressModeU: 'clamp-to-edge',
                    addressModeV: 'clamp-to-edge',
                    label: 'lines-end-sampler',
                });
            }
        }

        if (endData.length > 0) {
            this.endTexture.write(endData, {
                size: [width, height, 1],
            });
        }

        // Size/Group texture
        const sizeGroupData = this.values.tSizeGroup.ref.value;
        if (!this.sizeGroupTexture ||
            this.sizeGroupTexture.width !== width ||
            this.sizeGroupTexture.height !== height) {

            if (this.sizeGroupTexture) this.sizeGroupTexture.destroy();

            this.sizeGroupTexture = this.context.createTexture({
                size: [width, height],
                format: 'rg32float',
                usage: ['texture-binding', 'copy-dst'],
                label: 'lines-size-group-texture',
            });

            if (!this.sizeGroupSampler) {
                this.sizeGroupSampler = this.context.createSampler({
                    magFilter: 'nearest',
                    minFilter: 'nearest',
                    addressModeU: 'clamp-to-edge',
                    addressModeV: 'clamp-to-edge',
                    label: 'lines-size-group-sampler',
                });
            }
        }

        if (sizeGroupData.length > 0) {
            this.sizeGroupTexture.write(sizeGroupData, {
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
                label: 'lines-instance-storage',
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
        this.createLinesTextures();
        this.createInstanceStorageBuffer();
        this.uploadUniformBuffers();
    }

    private uploadUniformBuffers(): void {
        // Upload lines uniforms
        if (this.linesUniformBuffer) {
            const data = new Float32Array(64);

            const modelView = this.values.uModelView.ref.value;
            for (let i = 0; i < 16; i++) {
                data[i] = modelView[i] || 0;
            }

            data[16] = this.values.uPixelRatio.ref.value;
            data[17] = this.values.uLineSizeAttenuation.ref.value ? 1.0 : 0.0;
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

            this.linesUniformBuffer.write(data);
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
        // 6 vertices per line segment
        return this.values.drawCount.ref.value * 6;
    }

    protected getInstanceCount(): number {
        return this.values.instanceCount.ref.value;
    }

    dispose(): void {
        super.dispose();

        if (this.startTexture) this.startTexture.destroy();
        if (this.startSampler) this.startSampler.destroy();
        if (this.endTexture) this.endTexture.destroy();
        if (this.endSampler) this.endSampler.destroy();
        if (this.sizeGroupTexture) this.sizeGroupTexture.destroy();
        if (this.sizeGroupSampler) this.sizeGroupSampler.destroy();
        if (this.instanceStorageBuffer) this.instanceStorageBuffer.destroy();
        if (this.frameUniformBuffer) this.frameUniformBuffer.destroy();
        if (this.materialUniformBuffer) this.materialUniformBuffer.destroy();
        if (this.objectUniformBuffer) this.objectUniformBuffer.destroy();
        if (this.linesUniformBuffer) this.linesUniformBuffer.destroy();

        this.shaderModules.clear();
    }
}

/**
 * Create a WebGPU lines renderable.
 */
export function createWebGPULinesRenderable(
    context: GPUContext,
    values: WebGPULinesValues,
    state?: WebGPURenderableState,
    materialId?: number,
    transparency?: WebGPUTransparency
): WebGPULinesRenderable {
    const descriptor: WebGPURenderableDescriptor<WebGPULinesValues> = {
        context,
        materialId: materialId ?? 0,
        topology: 'triangle-list',
        values,
        state: state ?? createWebGPURenderableState(),
        transparency: transparency ?? 'opaque',
        vertexShader: LinesShader.vertex,
        fragmentShaders: {
            color: LinesShader.fragment.color,
            pick: LinesShader.fragment.pick,
            depth: LinesShader.fragment.depth,
            marking: LinesShader.fragment.color,
            emissive: LinesShader.fragment.color,
            tracing: LinesShader.fragment.color,
        },
        vertexBufferLayouts: [],
        bindGroupLayouts: [],
    };

    return new WebGPULinesRenderable(descriptor);
}
