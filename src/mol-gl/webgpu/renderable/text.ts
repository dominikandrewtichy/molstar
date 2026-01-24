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
import { TextShader } from '../../shader/wgsl/text.wgsl';

/**
 * Values for WebGPU text renderable.
 * Text is rendered as screen-aligned quads with SDF-based alpha testing.
 */
export interface WebGPUTextValues extends WebGPURenderableValues {
    // Text data textures
    tPosition: ValueCell<Float32Array>; // position.xyz, depth
    tMappingTexcoord: ValueCell<Float32Array>; // mapping.xy, texcoord.zw
    tSizeGroup: ValueCell<Float32Array>; // size, group
    tFont: ValueCell<ImageData | HTMLCanvasElement | HTMLImageElement | null>; // Font atlas texture
    uTexDim: ValueCell<Float32Array>; // [width, height]

    // Instance data
    aTransform: ValueCell<Float32Array>;
    aInstance: ValueCell<Float32Array>;

    // Counts
    drawCount: ValueCell<number>; // Number of glyphs
    instanceCount: ValueCell<number>;

    // Text-specific uniforms
    uModelView: ValueCell<Float32Array>; // mat4
    uModelViewEye: ValueCell<Float32Array>; // mat4
    uInvModelViewEye: ValueCell<Float32Array>; // mat4
    uInvHeadRotation: ValueCell<Float32Array>; // mat4
    uOffset: ValueCell<Float32Array>; // vec3
    uModelScale: ValueCell<number>;
    uPixelRatio: ValueCell<number>;
    uIsOrtho: ValueCell<number>;
    uHasHeadRotation: ValueCell<boolean>;
    uHasEyeCamera: ValueCell<boolean>;
    uViewport: ValueCell<Float32Array>; // vec4

    // Text style uniforms
    uBorderColor: ValueCell<Float32Array>; // vec3
    uBorderWidth: ValueCell<number>;
    uBackgroundColor: ValueCell<Float32Array>; // vec3
    uBackgroundOpacity: ValueCell<number>;

    // Material properties
    uColor: ValueCell<Float32Array>; // vec4
    uAlpha: ValueCell<number>;

    // Object properties
    uObjectId: ValueCell<number>;
}

/**
 * Create initial text values.
 */
export function createWebGPUTextValues(): WebGPUTextValues {
    return {
        tPosition: ValueCell.create(new Float32Array(0)),
        tMappingTexcoord: ValueCell.create(new Float32Array(0)),
        tSizeGroup: ValueCell.create(new Float32Array(0)),
        tFont: ValueCell.create(null),
        uTexDim: ValueCell.create(new Float32Array([1, 1])),

        aTransform: ValueCell.create(new Float32Array(16)),
        aInstance: ValueCell.create(new Float32Array(0)),

        drawCount: ValueCell.create(0),
        instanceCount: ValueCell.create(1),

        uModelView: ValueCell.create(new Float32Array(16)),
        uModelViewEye: ValueCell.create(new Float32Array(16)),
        uInvModelViewEye: ValueCell.create(new Float32Array(16)),
        uInvHeadRotation: ValueCell.create(new Float32Array(16)),
        uOffset: ValueCell.create(new Float32Array([0, 0, 0])),
        uModelScale: ValueCell.create(1),
        uPixelRatio: ValueCell.create(1),
        uIsOrtho: ValueCell.create(0),
        uHasHeadRotation: ValueCell.create(false),
        uHasEyeCamera: ValueCell.create(false),
        uViewport: ValueCell.create(new Float32Array([0, 0, 1, 1])),

        uBorderColor: ValueCell.create(new Float32Array([0, 0, 0])),
        uBorderWidth: ValueCell.create(0),
        uBackgroundColor: ValueCell.create(new Float32Array([1, 1, 1])),
        uBackgroundOpacity: ValueCell.create(0),

        uColor: ValueCell.create(new Float32Array([1, 1, 1, 1])),
        uAlpha: ValueCell.create(1),

        uObjectId: ValueCell.create(0),
    };
}

/**
 * WebGPU text renderable implementation.
 */
export class WebGPUTextRenderable extends WebGPURenderableBase<WebGPUTextValues> {
    // Textures
    private positionTexture: Texture | null = null;
    private positionSampler: Sampler | null = null;
    private mappingTexcoordTexture: Texture | null = null;
    private mappingTexcoordSampler: Sampler | null = null;
    private sizeGroupTexture: Texture | null = null;
    private sizeGroupSampler: Sampler | null = null;
    private fontTexture: Texture | null = null;
    private fontSampler: Sampler | null = null;

    // Buffers
    private instanceStorageBuffer: Buffer | null = null;
    private frameUniformBuffer: Buffer | null = null;
    private materialUniformBuffer: Buffer | null = null;
    private objectUniformBuffer: Buffer | null = null;
    private textVertUniformBuffer: Buffer | null = null;
    private textFragUniformBuffer: Buffer | null = null;

    // Bind group layouts
    private frameBindGroupLayout: BindGroupLayout | null = null;
    private materialBindGroupLayout: BindGroupLayout | null = null;
    private objectBindGroupLayout: BindGroupLayout | null = null;

    private shaderModules: Map<WebGPURenderVariant, ShaderModule> = new Map();

    protected createPipelines(descriptor: WebGPURenderableDescriptor<WebGPUTextValues>): void {
        const vertexModule = this.context.createShaderModule({
            code: TextShader.vertex,
            label: 'text-vertex',
        });

        const colorModule = this.context.createShaderModule({
            code: TextShader.fragment.color,
            label: 'text-fragment-color',
        });
        const pickModule = this.context.createShaderModule({
            code: TextShader.fragment.pick,
            label: 'text-fragment-pick',
        });
        const depthModule = this.context.createShaderModule({
            code: TextShader.fragment.depth,
            label: 'text-fragment-depth',
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
            label: 'text-pipeline-layout',
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
            label: 'text-frame-bind-group-layout',
        });

        this.materialBindGroupLayout = this.context.createBindGroupLayout({
            entries: [
                {
                    binding: 0,
                    visibility: ['fragment'] as ShaderStage[],
                    buffer: { type: 'uniform' },
                },
            ],
            label: 'text-material-bind-group-layout',
        });

        this.objectBindGroupLayout = this.context.createBindGroupLayout({
            entries: [
                {
                    binding: 0,
                    visibility: ['vertex', 'fragment'] as ShaderStage[],
                    buffer: { type: 'uniform' }, // ObjectUniforms / TextFragUniforms
                },
                {
                    binding: 1,
                    visibility: ['vertex'] as ShaderStage[],
                    buffer: { type: 'uniform' }, // TextUniforms
                },
                {
                    binding: 2,
                    visibility: ['vertex'] as ShaderStage[],
                    texture: { sampleType: 'unfilterable-float', viewDimension: '2d' }, // tPosition
                },
                {
                    binding: 3,
                    visibility: ['vertex'] as ShaderStage[],
                    sampler: { type: 'non-filtering' },
                },
                {
                    binding: 4,
                    visibility: ['vertex'] as ShaderStage[],
                    texture: { sampleType: 'unfilterable-float', viewDimension: '2d' }, // tMappingTexcoord
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
                {
                    binding: 9,
                    visibility: ['fragment'] as ShaderStage[],
                    texture: { sampleType: 'float', viewDimension: '2d' }, // tFont
                },
                {
                    binding: 10,
                    visibility: ['fragment'] as ShaderStage[],
                    sampler: { type: 'filtering' }, // Font sampler (linear filtering for SDF)
                },
            ],
            label: 'text-object-bind-group-layout',
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
                cullMode: 'none', // Text billboards need both faces
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
        // Text typically needs blending for smooth edges
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

    protected createBindGroups(): void {
        if (!this.frameUniformBuffer) {
            this.frameUniformBuffer = this.context.createBuffer({
                size: 256,
                usage: ['uniform', 'copy-dst'],
                label: 'text-frame-uniforms',
            });
        }

        if (!this.materialUniformBuffer) {
            this.materialUniformBuffer = this.context.createBuffer({
                size: 256,
                usage: ['uniform', 'copy-dst'],
                label: 'text-material-uniforms',
            });
        }

        if (!this.objectUniformBuffer) {
            this.objectUniformBuffer = this.context.createBuffer({
                size: 256,
                usage: ['uniform', 'copy-dst'],
                label: 'text-object-uniforms',
            });
        }

        if (!this.textVertUniformBuffer) {
            this.textVertUniformBuffer = this.context.createBuffer({
                size: 512, // Large enough for all text uniforms
                usage: ['uniform', 'copy-dst'],
                label: 'text-vert-uniforms',
            });
        }

        if (!this.textFragUniformBuffer) {
            this.textFragUniformBuffer = this.context.createBuffer({
                size: 256,
                usage: ['uniform', 'copy-dst'],
                label: 'text-frag-uniforms',
            });
        }

        this.createTextTextures();
        this.createInstanceStorageBuffer();
    }

    private createTextTextures(): void {
        const texDim = this.values.uTexDim.ref.value;
        const width = Math.max(1, Math.floor(texDim[0]));
        const height = Math.max(1, Math.floor(texDim[1]));

        // Position texture
        const positionData = this.values.tPosition.ref.value;
        if (!this.positionTexture ||
            this.positionTexture.width !== width ||
            this.positionTexture.height !== height) {

            if (this.positionTexture) this.positionTexture.destroy();

            this.positionTexture = this.context.createTexture({
                size: [width, height],
                format: 'rgba32float',
                usage: ['texture-binding', 'copy-dst'],
                label: 'text-position-texture',
            });

            if (!this.positionSampler) {
                this.positionSampler = this.context.createSampler({
                    magFilter: 'nearest',
                    minFilter: 'nearest',
                    addressModeU: 'clamp-to-edge',
                    addressModeV: 'clamp-to-edge',
                    label: 'text-position-sampler',
                });
            }
        }

        if (positionData.length > 0) {
            this.positionTexture.write(positionData, {
                size: [width, height, 1],
            });
        }

        // Mapping/Texcoord texture
        const mappingTexcoordData = this.values.tMappingTexcoord.ref.value;
        if (!this.mappingTexcoordTexture ||
            this.mappingTexcoordTexture.width !== width ||
            this.mappingTexcoordTexture.height !== height) {

            if (this.mappingTexcoordTexture) this.mappingTexcoordTexture.destroy();

            this.mappingTexcoordTexture = this.context.createTexture({
                size: [width, height],
                format: 'rgba32float',
                usage: ['texture-binding', 'copy-dst'],
                label: 'text-mapping-texcoord-texture',
            });

            if (!this.mappingTexcoordSampler) {
                this.mappingTexcoordSampler = this.context.createSampler({
                    magFilter: 'nearest',
                    minFilter: 'nearest',
                    addressModeU: 'clamp-to-edge',
                    addressModeV: 'clamp-to-edge',
                    label: 'text-mapping-texcoord-sampler',
                });
            }
        }

        if (mappingTexcoordData.length > 0) {
            this.mappingTexcoordTexture.write(mappingTexcoordData, {
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
                label: 'text-size-group-texture',
            });

            if (!this.sizeGroupSampler) {
                this.sizeGroupSampler = this.context.createSampler({
                    magFilter: 'nearest',
                    minFilter: 'nearest',
                    addressModeU: 'clamp-to-edge',
                    addressModeV: 'clamp-to-edge',
                    label: 'text-size-group-sampler',
                });
            }
        }

        if (sizeGroupData.length > 0) {
            this.sizeGroupTexture.write(sizeGroupData, {
                size: [width, height, 1],
            });
        }

        // Font atlas texture - create placeholder if no font provided
        this.createFontTexture();
    }

    private createFontTexture(): void {
        // Create a default 1x1 font texture if none provided
        if (!this.fontTexture) {
            this.fontTexture = this.context.createTexture({
                size: [1, 1],
                format: 'rgba8unorm',
                usage: ['texture-binding', 'copy-dst'],
                label: 'text-font-texture',
            });

            // Write white pixel as default
            this.fontTexture.write(new Uint8Array([255, 255, 255, 255]), {
                size: [1, 1, 1],
            });

            this.fontSampler = this.context.createSampler({
                magFilter: 'linear',
                minFilter: 'linear',
                addressModeU: 'clamp-to-edge',
                addressModeV: 'clamp-to-edge',
                label: 'text-font-sampler',
            });
        }

        // TODO: Handle actual font atlas upload from tFont value
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
                label: 'text-instance-storage',
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
        this.createTextTextures();
        this.createInstanceStorageBuffer();
        this.uploadUniformBuffers();
    }

    private uploadUniformBuffers(): void {
        // Upload text vertex uniforms
        if (this.textVertUniformBuffer) {
            const data = new Float32Array(128);

            // model_view (16 floats)
            const modelView = this.values.uModelView.ref.value;
            for (let i = 0; i < 16; i++) {
                data[i] = modelView[i] || 0;
            }

            // model_view_eye (16 floats)
            const modelViewEye = this.values.uModelViewEye.ref.value;
            for (let i = 0; i < 16; i++) {
                data[16 + i] = modelViewEye[i] || 0;
            }

            // inv_model_view_eye (16 floats)
            const invModelViewEye = this.values.uInvModelViewEye.ref.value;
            for (let i = 0; i < 16; i++) {
                data[32 + i] = invModelViewEye[i] || 0;
            }

            // inv_head_rotation (16 floats)
            const invHeadRotation = this.values.uInvHeadRotation.ref.value;
            for (let i = 0; i < 16; i++) {
                data[48 + i] = invHeadRotation[i] || 0;
            }

            // offset (3 floats) + model_scale
            const offset = this.values.uOffset.ref.value;
            data[64] = offset[0] || 0;
            data[65] = offset[1] || 0;
            data[66] = offset[2] || 0;
            data[67] = this.values.uModelScale.ref.value;

            // pixel_ratio, is_ortho, has_head_rotation, has_eye_camera
            data[68] = this.values.uPixelRatio.ref.value;
            data[69] = this.values.uIsOrtho.ref.value;
            data[70] = this.values.uHasHeadRotation.ref.value ? 1.0 : 0.0;
            data[71] = this.values.uHasEyeCamera.ref.value ? 1.0 : 0.0;

            // viewport (4 floats)
            const viewport = this.values.uViewport.ref.value;
            for (let i = 0; i < 4; i++) {
                data[72 + i] = viewport[i] || 0;
            }

            // tex_dim (2 floats) + padding
            const texDim = this.values.uTexDim.ref.value;
            data[76] = texDim[0];
            data[77] = texDim[1];
            data[78] = 0;
            data[79] = 0;

            this.textVertUniformBuffer.write(data);
        }

        // Upload text fragment uniforms
        if (this.textFragUniformBuffer) {
            const data = new Float32Array(64);

            // border_color (3 floats) + border_width
            const borderColor = this.values.uBorderColor.ref.value;
            data[0] = borderColor[0] || 0;
            data[1] = borderColor[1] || 0;
            data[2] = borderColor[2] || 0;
            data[3] = this.values.uBorderWidth.ref.value;

            // background_color (3 floats) + background_opacity
            const backgroundColor = this.values.uBackgroundColor.ref.value;
            data[4] = backgroundColor[0] || 1;
            data[5] = backgroundColor[1] || 1;
            data[6] = backgroundColor[2] || 1;
            data[7] = this.values.uBackgroundOpacity.ref.value;

            this.textFragUniformBuffer.write(data);
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
        // 6 vertices per glyph
        return this.values.drawCount.ref.value * 6;
    }

    protected getInstanceCount(): number {
        return this.values.instanceCount.ref.value;
    }

    dispose(): void {
        super.dispose();

        if (this.positionTexture) this.positionTexture.destroy();
        if (this.positionSampler) this.positionSampler.destroy();
        if (this.mappingTexcoordTexture) this.mappingTexcoordTexture.destroy();
        if (this.mappingTexcoordSampler) this.mappingTexcoordSampler.destroy();
        if (this.sizeGroupTexture) this.sizeGroupTexture.destroy();
        if (this.sizeGroupSampler) this.sizeGroupSampler.destroy();
        if (this.fontTexture) this.fontTexture.destroy();
        if (this.fontSampler) this.fontSampler.destroy();
        if (this.instanceStorageBuffer) this.instanceStorageBuffer.destroy();
        if (this.frameUniformBuffer) this.frameUniformBuffer.destroy();
        if (this.materialUniformBuffer) this.materialUniformBuffer.destroy();
        if (this.objectUniformBuffer) this.objectUniformBuffer.destroy();
        if (this.textVertUniformBuffer) this.textVertUniformBuffer.destroy();
        if (this.textFragUniformBuffer) this.textFragUniformBuffer.destroy();

        this.shaderModules.clear();
    }
}

/**
 * Create a WebGPU text renderable.
 */
export function createWebGPUTextRenderable(
    context: GPUContext,
    values: WebGPUTextValues,
    state?: WebGPURenderableState,
    materialId?: number,
    transparency?: WebGPUTransparency
): WebGPUTextRenderable {
    const descriptor: WebGPURenderableDescriptor<WebGPUTextValues> = {
        context,
        materialId: materialId ?? 0,
        topology: 'triangle-list',
        values,
        state: state ?? createWebGPURenderableState(),
        transparency: transparency ?? 'blended', // Text typically needs blending
        vertexShader: TextShader.vertex,
        fragmentShaders: {
            color: TextShader.fragment.color,
            pick: TextShader.fragment.pick,
            depth: TextShader.fragment.depth,
            marking: TextShader.fragment.color,
            emissive: TextShader.fragment.color,
            tracing: TextShader.fragment.color,
        },
        vertexBufferLayouts: [],
        bindGroupLayouts: [],
    };

    return new WebGPUTextRenderable(descriptor);
}
