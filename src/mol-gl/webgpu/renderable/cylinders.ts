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
import { CylindersShader } from '../../shader/wgsl/cylinders.wgsl';

/**
 * Values for WebGPU cylinders renderable.
 * Cylinders are rendered as bounding boxes with ray-cylinder intersection
 * computed in the fragment shader.
 *
 * Cap modes (encoded in cap value):
 *   0.0 = no caps
 *   1.0 = top cap only
 *   2.0 = bottom cap only
 *   3.0 = both caps
 */
export interface WebGPUCylindersValues extends WebGPURenderableValues {
    // Cylinder data textures
    tStartEnd: ValueCell<Float32Array>; // Start position (xyz) + end.x
    tScaleCapGroup: ValueCell<Float32Array>; // end.yz + scale + cap
    uTexDim: ValueCell<Float32Array>; // [width, height]

    // Instance data
    aTransform: ValueCell<Float32Array>;
    aInstance: ValueCell<Float32Array>;

    // Counts
    drawCount: ValueCell<number>; // Number of cylinders
    instanceCount: ValueCell<number>;

    // Cylinders-specific uniforms
    uModelView: ValueCell<Float32Array>; // mat4
    uInvView: ValueCell<Float32Array>; // mat4
    uIsOrtho: ValueCell<number>;
    uModelScale: ValueCell<number>;
    uCameraDir: ValueCell<Float32Array>; // vec3
    uNear: ValueCell<number>;

    // LOD parameters
    uLodNear: ValueCell<number>;
    uLodFar: ValueCell<number>;
    uLodFade: ValueCell<number>;
    uLodFactor: ValueCell<number>;
    uCameraPlane: ValueCell<Float32Array>; // vec4

    // Material properties
    uColor: ValueCell<Float32Array>; // vec4
    uInteriorColor: ValueCell<Float32Array>; // vec4
    uAlpha: ValueCell<number>;
    uMetalness: ValueCell<number>;
    uRoughness: ValueCell<number>;
    uEmissive: ValueCell<number>;
    uDoubleSided: ValueCell<boolean>;
    uSolidInterior: ValueCell<boolean>;

    // Object properties
    uObjectId: ValueCell<number>;
}

/**
 * Create initial cylinders values.
 */
export function createWebGPUCylindersValues(): WebGPUCylindersValues {
    return {
        tStartEnd: ValueCell.create(new Float32Array(0)),
        tScaleCapGroup: ValueCell.create(new Float32Array(0)),
        uTexDim: ValueCell.create(new Float32Array([1, 1])),

        aTransform: ValueCell.create(new Float32Array(16)),
        aInstance: ValueCell.create(new Float32Array(0)),

        drawCount: ValueCell.create(0),
        instanceCount: ValueCell.create(1),

        uModelView: ValueCell.create(new Float32Array(16)),
        uInvView: ValueCell.create(new Float32Array(16)),
        uIsOrtho: ValueCell.create(0),
        uModelScale: ValueCell.create(1),
        uCameraDir: ValueCell.create(new Float32Array([0, 0, -1])),
        uNear: ValueCell.create(0.1),

        uLodNear: ValueCell.create(0),
        uLodFar: ValueCell.create(0),
        uLodFade: ValueCell.create(0),
        uLodFactor: ValueCell.create(0),
        uCameraPlane: ValueCell.create(new Float32Array(4)),

        uColor: ValueCell.create(new Float32Array([1, 1, 1, 1])),
        uInteriorColor: ValueCell.create(new Float32Array([0.5, 0.5, 0.5, 1])),
        uAlpha: ValueCell.create(1),
        uMetalness: ValueCell.create(0),
        uRoughness: ValueCell.create(0.5),
        uEmissive: ValueCell.create(0),
        uDoubleSided: ValueCell.create(true),
        uSolidInterior: ValueCell.create(false),

        uObjectId: ValueCell.create(0),
    };
}

/**
 * WebGPU cylinders renderable implementation.
 * Uses ray-casting on bounding boxes for per-pixel cylinder rendering.
 */
export class WebGPUCylindersRenderable extends WebGPURenderableBase<WebGPUCylindersValues> {
    // GPU resources - textures
    private startEndTexture: Texture | null = null;
    private startEndSampler: Sampler | null = null;
    private scaleCapGroupTexture: Texture | null = null;
    private scaleCapGroupSampler: Sampler | null = null;

    // GPU resources - buffers
    private instanceStorageBuffer: Buffer | null = null;
    private frameUniformBuffer: Buffer | null = null;
    private materialUniformBuffer: Buffer | null = null;
    private objectUniformBuffer: Buffer | null = null;
    private cylindersVertUniformBuffer: Buffer | null = null;
    private cylindersFragUniformBuffer: Buffer | null = null;

    // Bind group layouts
    private frameBindGroupLayout: BindGroupLayout | null = null;
    private materialBindGroupLayout: BindGroupLayout | null = null;
    private objectBindGroupLayout: BindGroupLayout | null = null;

    // Shader modules
    private shaderModules: Map<WebGPURenderVariant, ShaderModule> = new Map();

    protected createPipelines(descriptor: WebGPURenderableDescriptor<WebGPUCylindersValues>): void {
        // Create shader modules
        const vertexModule = this.context.createShaderModule({
            code: CylindersShader.vertex,
            label: 'cylinders-vertex',
        });

        // Create shader modules for each variant
        const colorModule = this.context.createShaderModule({
            code: CylindersShader.fragment.color,
            label: 'cylinders-fragment-color',
        });
        const pickModule = this.context.createShaderModule({
            code: CylindersShader.fragment.pick,
            label: 'cylinders-fragment-pick',
        });
        const depthModule = this.context.createShaderModule({
            code: CylindersShader.fragment.depth,
            label: 'cylinders-fragment-depth',
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
            label: 'cylinders-pipeline-layout',
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
                    buffer: { type: 'uniform' }, // FrameUniforms
                },
                {
                    binding: 1,
                    visibility: ['fragment'] as ShaderStage[],
                    buffer: { type: 'uniform' }, // LightUniforms
                },
            ],
            label: 'cylinders-frame-bind-group-layout',
        });

        // Material bind group layout (group 1)
        this.materialBindGroupLayout = this.context.createBindGroupLayout({
            entries: [
                {
                    binding: 0,
                    visibility: ['fragment'] as ShaderStage[],
                    buffer: { type: 'uniform' }, // MaterialUniforms
                },
            ],
            label: 'cylinders-material-bind-group-layout',
        });

        // Object bind group layout (group 2)
        // Contains: ObjectUniforms, CylindersUniforms, textures, samplers, instances
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
                    buffer: { type: 'uniform' }, // CylindersUniforms (vertex)
                },
                {
                    binding: 2,
                    visibility: ['vertex'] as ShaderStage[],
                    texture: { sampleType: 'unfilterable-float', viewDimension: '2d' }, // tStartEnd
                },
                {
                    binding: 3,
                    visibility: ['vertex'] as ShaderStage[],
                    sampler: { type: 'non-filtering' }, // sStartEnd
                },
                {
                    binding: 4,
                    visibility: ['vertex'] as ShaderStage[],
                    texture: { sampleType: 'unfilterable-float', viewDimension: '2d' }, // tScaleCapGroup
                },
                {
                    binding: 5,
                    visibility: ['vertex'] as ShaderStage[],
                    sampler: { type: 'non-filtering' }, // sScaleCapGroup
                },
                {
                    binding: 6,
                    visibility: ['vertex'] as ShaderStage[],
                    buffer: { type: 'read-only-storage' }, // instances
                },
            ],
            label: 'cylinders-object-bind-group-layout',
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

        // Cylinders use 36 vertices per cylinder (bounding box with 12 triangles)
        const pipeline = this.context.createRenderPipeline({
            layout,
            vertex: {
                module: vertexModule,
                entryPoint: 'main',
                buffers: [], // No vertex attributes - all from textures/storage
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
                cullMode: 'none', // Need both faces for ray-casting
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
                    { format: 'rgba8unorm' as TextureFormat }, // Object ID
                    { format: 'rgba8unorm' as TextureFormat }, // Instance ID
                    { format: 'rgba8unorm' as TextureFormat }, // Group ID
                    { format: 'rgba8unorm' as TextureFormat }, // Depth
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
        // Frame uniform buffer
        if (!this.frameUniformBuffer) {
            this.frameUniformBuffer = this.context.createBuffer({
                size: 256,
                usage: ['uniform', 'copy-dst'],
                label: 'cylinders-frame-uniforms',
            });
        }

        // Material uniform buffer
        if (!this.materialUniformBuffer) {
            this.materialUniformBuffer = this.context.createBuffer({
                size: 256,
                usage: ['uniform', 'copy-dst'],
                label: 'cylinders-material-uniforms',
            });
        }

        // Object uniform buffer
        if (!this.objectUniformBuffer) {
            this.objectUniformBuffer = this.context.createBuffer({
                size: 256,
                usage: ['uniform', 'copy-dst'],
                label: 'cylinders-object-uniforms',
            });
        }

        // Cylinders vertex uniform buffer
        if (!this.cylindersVertUniformBuffer) {
            this.cylindersVertUniformBuffer = this.context.createBuffer({
                size: 256,
                usage: ['uniform', 'copy-dst'],
                label: 'cylinders-vert-uniforms',
            });
        }

        // Cylinders fragment uniform buffer
        if (!this.cylindersFragUniformBuffer) {
            this.cylindersFragUniformBuffer = this.context.createBuffer({
                size: 256,
                usage: ['uniform', 'copy-dst'],
                label: 'cylinders-frag-uniforms',
            });
        }

        // Create textures
        this.createCylinderTextures();

        // Create instance storage buffer
        this.createInstanceStorageBuffer();
    }

    private createCylinderTextures(): void {
        const texDim = this.values.uTexDim.ref.value;
        const width = Math.max(1, Math.floor(texDim[0]));
        const height = Math.max(1, Math.floor(texDim[1]));

        // Start/End texture
        const startEndData = this.values.tStartEnd.ref.value;
        if (!this.startEndTexture ||
            this.startEndTexture.width !== width ||
            this.startEndTexture.height !== height) {

            if (this.startEndTexture) this.startEndTexture.destroy();

            this.startEndTexture = this.context.createTexture({
                size: [width, height],
                format: 'rgba32float',
                usage: ['texture-binding', 'copy-dst'],
                label: 'cylinders-start-end-texture',
            });

            if (!this.startEndSampler) {
                this.startEndSampler = this.context.createSampler({
                    magFilter: 'nearest',
                    minFilter: 'nearest',
                    addressModeU: 'clamp-to-edge',
                    addressModeV: 'clamp-to-edge',
                    label: 'cylinders-start-end-sampler',
                });
            }
        }

        if (startEndData.length > 0) {
            this.startEndTexture.write(startEndData, {
                size: [width, height, 1],
            });
        }

        // Scale/Cap/Group texture
        const scaleCapGroupData = this.values.tScaleCapGroup.ref.value;
        if (!this.scaleCapGroupTexture ||
            this.scaleCapGroupTexture.width !== width ||
            this.scaleCapGroupTexture.height !== height) {

            if (this.scaleCapGroupTexture) this.scaleCapGroupTexture.destroy();

            this.scaleCapGroupTexture = this.context.createTexture({
                size: [width, height],
                format: 'rgba32float',
                usage: ['texture-binding', 'copy-dst'],
                label: 'cylinders-scale-cap-group-texture',
            });

            if (!this.scaleCapGroupSampler) {
                this.scaleCapGroupSampler = this.context.createSampler({
                    magFilter: 'nearest',
                    minFilter: 'nearest',
                    addressModeU: 'clamp-to-edge',
                    addressModeV: 'clamp-to-edge',
                    label: 'cylinders-scale-cap-group-sampler',
                });
            }
        }

        if (scaleCapGroupData.length > 0) {
            this.scaleCapGroupTexture.write(scaleCapGroupData, {
                size: [width, height, 1],
            });
        }
    }

    private createInstanceStorageBuffer(): void {
        const transforms = this.values.aTransform.ref.value;
        const instances = this.values.aInstance.ref.value;
        const instanceCount = this.values.instanceCount.ref.value;

        const instanceSize = 80; // 20 floats per instance
        const bufferSize = Math.max(instanceSize, instanceCount * instanceSize);

        if (!this.instanceStorageBuffer || this.instanceStorageBuffer.size < bufferSize) {
            if (this.instanceStorageBuffer) this.instanceStorageBuffer.destroy();

            this.instanceStorageBuffer = this.context.createBuffer({
                size: bufferSize,
                usage: ['storage', 'copy-dst'],
                label: 'cylinders-instance-storage',
            });
        }

        // Pack instance data
        const instanceData = new Float32Array(instanceCount * 20);
        for (let i = 0; i < instanceCount; i++) {
            // Copy transform
            for (let j = 0; j < 16; j++) {
                const srcIdx = i * 16 + j;
                instanceData[i * 20 + j] = transforms.length > srcIdx ? transforms[srcIdx] : (j % 5 === 0 ? 1 : 0);
            }
            // Instance ID + padding
            instanceData[i * 20 + 16] = instances.length > i ? instances[i] : i;
            instanceData[i * 20 + 17] = 0;
            instanceData[i * 20 + 18] = 0;
            instanceData[i * 20 + 19] = 0;
        }

        this.instanceStorageBuffer.write(instanceData);
    }

    protected uploadValues(): void {
        this.createCylinderTextures();
        this.createInstanceStorageBuffer();
        this.uploadUniformBuffers();
    }

    private uploadUniformBuffers(): void {
        // Upload cylinders vertex uniforms
        if (this.cylindersVertUniformBuffer) {
            const data = new Float32Array(64);

            // model_view (16 floats)
            const modelView = this.values.uModelView.ref.value;
            for (let i = 0; i < 16; i++) {
                data[i] = modelView[i] || 0;
            }

            // is_ortho, model_scale, padding
            data[16] = this.values.uIsOrtho.ref.value;
            data[17] = this.values.uModelScale.ref.value;
            data[18] = 0;
            data[19] = 0;

            // camera_dir (3 floats) + padding
            const cameraDir = this.values.uCameraDir.ref.value;
            data[20] = cameraDir[0] || 0;
            data[21] = cameraDir[1] || 0;
            data[22] = cameraDir[2] || -1;
            data[23] = 0;

            // tex_dim (2 floats) + padding
            const texDim = this.values.uTexDim.ref.value;
            data[24] = texDim[0];
            data[25] = texDim[1];
            data[26] = 0;
            data[27] = 0;

            // LOD parameters
            data[28] = this.values.uLodNear.ref.value;
            data[29] = this.values.uLodFar.ref.value;
            data[30] = this.values.uLodFade.ref.value;
            data[31] = this.values.uLodFactor.ref.value;

            // camera_plane
            const cameraPlane = this.values.uCameraPlane.ref.value;
            for (let i = 0; i < 4; i++) {
                data[32 + i] = cameraPlane[i] || 0;
            }

            this.cylindersVertUniformBuffer.write(data);
        }

        // Upload cylinders fragment uniforms
        if (this.cylindersFragUniformBuffer) {
            const data = new Float32Array(64);

            // inv_view (16 floats)
            const invView = this.values.uInvView.ref.value;
            for (let i = 0; i < 16; i++) {
                data[i] = invView[i] || 0;
            }

            // is_ortho, double_sided, solid_interior, near
            data[16] = this.values.uIsOrtho.ref.value;
            data[17] = this.values.uDoubleSided.ref.value ? 1.0 : 0.0;
            data[18] = this.values.uSolidInterior.ref.value ? 1.0 : 0.0;
            data[19] = this.values.uNear.ref.value;

            // camera_dir (3 floats) + padding
            const cameraDir = this.values.uCameraDir.ref.value;
            data[20] = cameraDir[0] || 0;
            data[21] = cameraDir[1] || 0;
            data[22] = cameraDir[2] || -1;
            data[23] = 0;

            this.cylindersFragUniformBuffer.write(data);
        }

        // Upload material uniforms
        if (this.materialUniformBuffer) {
            const data = new Float32Array(64);

            const color = this.values.uColor.ref.value;
            for (let i = 0; i < 4; i++) {
                data[i] = color[i] || 0;
            }

            const interiorColor = this.values.uInteriorColor.ref.value;
            for (let i = 0; i < 4; i++) {
                data[4 + i] = interiorColor[i] || 0;
            }

            data[8] = this.values.uAlpha.ref.value;
            data[9] = this.values.uMetalness.ref.value;
            data[10] = this.values.uRoughness.ref.value;
            data[11] = this.values.uEmissive.ref.value;

            this.materialUniformBuffer.write(data);
        }
    }

    protected getDrawCount(): number {
        // 36 vertices per cylinder (12 triangles for bounding box)
        return this.values.drawCount.ref.value * 36;
    }

    protected getInstanceCount(): number {
        return this.values.instanceCount.ref.value;
    }

    dispose(): void {
        super.dispose();

        if (this.startEndTexture) this.startEndTexture.destroy();
        if (this.startEndSampler) this.startEndSampler.destroy();
        if (this.scaleCapGroupTexture) this.scaleCapGroupTexture.destroy();
        if (this.scaleCapGroupSampler) this.scaleCapGroupSampler.destroy();
        if (this.instanceStorageBuffer) this.instanceStorageBuffer.destroy();
        if (this.frameUniformBuffer) this.frameUniformBuffer.destroy();
        if (this.materialUniformBuffer) this.materialUniformBuffer.destroy();
        if (this.objectUniformBuffer) this.objectUniformBuffer.destroy();
        if (this.cylindersVertUniformBuffer) this.cylindersVertUniformBuffer.destroy();
        if (this.cylindersFragUniformBuffer) this.cylindersFragUniformBuffer.destroy();

        this.shaderModules.clear();
    }
}

/**
 * Create a WebGPU cylinders renderable.
 */
export function createWebGPUCylindersRenderable(
    context: GPUContext,
    values: WebGPUCylindersValues,
    state?: WebGPURenderableState,
    materialId?: number,
    transparency?: WebGPUTransparency
): WebGPUCylindersRenderable {
    const descriptor: WebGPURenderableDescriptor<WebGPUCylindersValues> = {
        context,
        materialId: materialId ?? 0,
        topology: 'triangle-list',
        values,
        state: state ?? createWebGPURenderableState(),
        transparency: transparency ?? 'opaque',
        vertexShader: CylindersShader.vertex,
        fragmentShaders: {
            color: CylindersShader.fragment.color,
            pick: CylindersShader.fragment.pick,
            depth: CylindersShader.fragment.depth,
            marking: CylindersShader.fragment.color,
            emissive: CylindersShader.fragment.color,
            tracing: CylindersShader.fragment.color,
        },
        vertexBufferLayouts: [],
        bindGroupLayouts: [],
    };

    return new WebGPUCylindersRenderable(descriptor);
}
