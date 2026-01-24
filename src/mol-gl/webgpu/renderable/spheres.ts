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
import { SpheresShader } from '../../shader/wgsl/spheres.wgsl';

/**
 * Values for WebGPU spheres renderable.
 * Spheres are rendered as screen-aligned quads with ray-sphere intersection
 * computed in the fragment shader.
 */
export interface WebGPUSpheresValues extends WebGPURenderableValues {
    // Sphere data texture (position.xyz, group)
    tPositionGroup: ValueCell<Float32Array>;
    uTexDim: ValueCell<Float32Array>; // [width, height]

    // Instance data
    aTransform: ValueCell<Float32Array>;
    aInstance: ValueCell<Float32Array>;

    // Counts
    drawCount: ValueCell<number>; // Number of spheres
    instanceCount: ValueCell<number>;

    // Spheres-specific uniforms
    uModelView: ValueCell<Float32Array>; // mat4
    uInvProjection: ValueCell<Float32Array>; // mat4
    uInvView: ValueCell<Float32Array>; // mat4
    uIsOrtho: ValueCell<number>;
    uModelScale: ValueCell<number>;

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
    uAlphaThickness: ValueCell<number>;
    uDoubleSided: ValueCell<boolean>;

    // Object properties
    uObjectId: ValueCell<number>;
}

/**
 * Create initial spheres values.
 */
export function createWebGPUSpheresValues(): WebGPUSpheresValues {
    return {
        tPositionGroup: ValueCell.create(new Float32Array(0)),
        uTexDim: ValueCell.create(new Float32Array([1, 1])),

        aTransform: ValueCell.create(new Float32Array(16)),
        aInstance: ValueCell.create(new Float32Array(0)),

        drawCount: ValueCell.create(0),
        instanceCount: ValueCell.create(1),

        uModelView: ValueCell.create(new Float32Array(16)),
        uInvProjection: ValueCell.create(new Float32Array(16)),
        uInvView: ValueCell.create(new Float32Array(16)),
        uIsOrtho: ValueCell.create(0),
        uModelScale: ValueCell.create(1),

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
        uAlphaThickness: ValueCell.create(0.5),
        uDoubleSided: ValueCell.create(true),

        uObjectId: ValueCell.create(0),
    };
}

/**
 * WebGPU spheres renderable implementation.
 * Uses ray-casting on screen-aligned quads for per-pixel sphere rendering.
 */
export class WebGPUSpheresRenderable extends WebGPURenderableBase<WebGPUSpheresValues> {
    // GPU resources
    private positionGroupTexture: Texture | null = null;
    private positionGroupSampler: Sampler | null = null;
    private instanceStorageBuffer: Buffer | null = null;
    private frameUniformBuffer: Buffer | null = null;
    private materialUniformBuffer: Buffer | null = null;
    private objectUniformBuffer: Buffer | null = null;
    private spheresVertUniformBuffer: Buffer | null = null;
    private spheresFragUniformBuffer: Buffer | null = null;

    // Bind group layouts
    private frameBindGroupLayout: BindGroupLayout | null = null;
    private materialBindGroupLayout: BindGroupLayout | null = null;
    private objectBindGroupLayout: BindGroupLayout | null = null;

    // Shader modules
    private shaderModules: Map<WebGPURenderVariant, ShaderModule> = new Map();

    protected createPipelines(descriptor: WebGPURenderableDescriptor<WebGPUSpheresValues>): void {
        // Create shader modules
        const vertexModule = this.context.createShaderModule({
            code: SpheresShader.vertex,
            label: 'spheres-vertex',
        });

        // Create shader modules for each variant
        const colorModule = this.context.createShaderModule({
            code: SpheresShader.fragment.color,
            label: 'spheres-fragment-color',
        });
        const pickModule = this.context.createShaderModule({
            code: SpheresShader.fragment.pick,
            label: 'spheres-fragment-pick',
        });
        const depthModule = this.context.createShaderModule({
            code: SpheresShader.fragment.depth,
            label: 'spheres-fragment-depth',
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
            label: 'spheres-pipeline-layout',
        });

        // Create pipelines for each variant
        this.createPipelineForVariant('color', vertexModule, colorModule, pipelineLayout);
        this.createPipelineForVariant('pick', vertexModule, pickModule, pipelineLayout);
        this.createPipelineForVariant('depth', vertexModule, depthModule, pipelineLayout);
    }

    private createBindGroupLayouts(): void {
        // Frame bind group layout (group 0)
        // Contains: FrameUniforms, LightUniforms
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
            label: 'spheres-frame-bind-group-layout',
        });

        // Material bind group layout (group 1)
        // Contains: MaterialUniforms
        this.materialBindGroupLayout = this.context.createBindGroupLayout({
            entries: [
                {
                    binding: 0,
                    visibility: ['fragment'] as ShaderStage[],
                    buffer: { type: 'uniform' }, // MaterialUniforms
                },
            ],
            label: 'spheres-material-bind-group-layout',
        });

        // Object bind group layout (group 2)
        // Contains: ObjectUniforms, SpheresUniforms, position/group texture, sampler, instances storage
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
                    buffer: { type: 'uniform' }, // SpheresUniforms (vertex)
                },
                {
                    binding: 2,
                    visibility: ['vertex'] as ShaderStage[],
                    texture: { sampleType: 'unfilterable-float', viewDimension: '2d' }, // tPositionGroup
                },
                {
                    binding: 3,
                    visibility: ['vertex'] as ShaderStage[],
                    sampler: { type: 'non-filtering' }, // sPositionGroup
                },
                {
                    binding: 4,
                    visibility: ['vertex'] as ShaderStage[],
                    buffer: { type: 'read-only-storage' }, // instances
                },
            ],
            label: 'spheres-object-bind-group-layout',
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

        // Spheres use 6 vertices per sphere (2 triangles for quad)
        // No vertex buffers needed - everything comes from textures/storage buffers
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
                cullMode: 'none', // Spheres need both faces for ray-casting
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
        // Frame uniform buffer (camera matrices, time, etc.)
        if (!this.frameUniformBuffer) {
            // FrameUniforms: projection (64) + view (64) + camera_position (16) + viewport (16) + time (4) + near (4) + far (4) + padding (4) = 176 bytes
            // Round to 256 for alignment
            this.frameUniformBuffer = this.context.createBuffer({
                size: 256,
                usage: ['uniform', 'copy-dst'],
                label: 'spheres-frame-uniforms',
            });
        }

        // Material uniform buffer
        if (!this.materialUniformBuffer) {
            // MaterialUniforms: color (16) + interior_color (16) + alpha (4) + metalness (4) + roughness (4) + emissive (4) + flags (16) = 64 bytes
            // Round to 256 for alignment
            this.materialUniformBuffer = this.context.createBuffer({
                size: 256,
                usage: ['uniform', 'copy-dst'],
                label: 'spheres-material-uniforms',
            });
        }

        // Object uniform buffer
        if (!this.objectUniformBuffer) {
            // ObjectUniforms: model (64) + normal_matrix (48) + object_id (4) + instance_count (4) = 120 bytes
            // Round to 128 for alignment
            this.objectUniformBuffer = this.context.createBuffer({
                size: 256,
                usage: ['uniform', 'copy-dst'],
                label: 'spheres-object-uniforms',
            });
        }

        // Spheres vertex uniform buffer
        if (!this.spheresVertUniformBuffer) {
            // SpheresUniforms for vertex: model_view (64) + inv_projection (64) + is_ortho (4) + is_asymmetric (4) + model_scale (4) + padding (4) +
            // tex_dim (8) + padding (8) + lod (16) + camera_plane (16) = 192 bytes
            this.spheresVertUniformBuffer = this.context.createBuffer({
                size: 256,
                usage: ['uniform', 'copy-dst'],
                label: 'spheres-vert-uniforms',
            });
        }

        // Spheres fragment uniform buffer
        if (!this.spheresFragUniformBuffer) {
            // SpheresFragUniforms: inv_view (64) + is_ortho (4) + alpha_thickness (4) + model_scale (4) + double_sided (4) = 80 bytes
            this.spheresFragUniformBuffer = this.context.createBuffer({
                size: 256,
                usage: ['uniform', 'copy-dst'],
                label: 'spheres-frag-uniforms',
            });
        }

        // Create position/group texture
        this.createPositionGroupTexture();

        // Create instance storage buffer
        this.createInstanceStorageBuffer();

        // Create bind groups (to be implemented with actual data)
    }

    private createPositionGroupTexture(): void {
        const positionGroupData = this.values.tPositionGroup.ref.value;
        const texDim = this.values.uTexDim.ref.value;
        const width = Math.max(1, Math.floor(texDim[0]));
        const height = Math.max(1, Math.floor(texDim[1]));

        if (!this.positionGroupTexture ||
            this.positionGroupTexture.width !== width ||
            this.positionGroupTexture.height !== height) {

            if (this.positionGroupTexture) {
                this.positionGroupTexture.destroy();
            }

            this.positionGroupTexture = this.context.createTexture({
                size: [width, height],
                format: 'rgba32float',
                usage: ['texture-binding', 'copy-dst'],
                label: 'spheres-position-group-texture',
            });

            if (!this.positionGroupSampler) {
                this.positionGroupSampler = this.context.createSampler({
                    magFilter: 'nearest',
                    minFilter: 'nearest',
                    addressModeU: 'clamp-to-edge',
                    addressModeV: 'clamp-to-edge',
                    label: 'spheres-position-group-sampler',
                });
            }
        }

        // Write texture data
        if (positionGroupData.length > 0) {
            this.positionGroupTexture.write(positionGroupData, {
                size: [width, height, 1],
            });
        }
    }

    private createInstanceStorageBuffer(): void {
        const transforms = this.values.aTransform.ref.value;
        const instances = this.values.aInstance.ref.value;
        const instanceCount = this.values.instanceCount.ref.value;

        // Instance data: transform (64 bytes = mat4) + instance_id (4 bytes) + padding (12 bytes) = 80 bytes per instance
        const instanceSize = 80;
        const bufferSize = Math.max(instanceSize, instanceCount * instanceSize);

        if (!this.instanceStorageBuffer || this.instanceStorageBuffer.size < bufferSize) {
            if (this.instanceStorageBuffer) {
                this.instanceStorageBuffer.destroy();
            }

            this.instanceStorageBuffer = this.context.createBuffer({
                size: bufferSize,
                usage: ['storage', 'copy-dst'],
                label: 'spheres-instance-storage',
            });
        }

        // Pack instance data
        const instanceData = new Float32Array(instanceCount * 20); // 20 floats per instance
        for (let i = 0; i < instanceCount; i++) {
            // Copy transform (16 floats)
            for (let j = 0; j < 16; j++) {
                const srcIdx = i * 16 + j;
                instanceData[i * 20 + j] = transforms.length > srcIdx ? transforms[srcIdx] : (j % 5 === 0 ? 1 : 0);
            }
            // Instance ID
            instanceData[i * 20 + 16] = instances.length > i ? instances[i] : i;
            // Padding
            instanceData[i * 20 + 17] = 0;
            instanceData[i * 20 + 18] = 0;
            instanceData[i * 20 + 19] = 0;
        }

        this.instanceStorageBuffer.write(instanceData);
    }

    protected uploadValues(): void {
        // Upload position/group texture
        this.createPositionGroupTexture();

        // Upload instance data
        this.createInstanceStorageBuffer();

        // Upload uniform buffer data
        this.uploadUniformBuffers();
    }

    private uploadUniformBuffers(): void {
        // Upload spheres vertex uniforms
        if (this.spheresVertUniformBuffer) {
            const data = new Float32Array(64); // 256 bytes / 4

            // model_view (16 floats)
            const modelView = this.values.uModelView.ref.value;
            for (let i = 0; i < 16; i++) {
                data[i] = modelView[i] || 0;
            }

            // inv_projection (16 floats)
            const invProjection = this.values.uInvProjection.ref.value;
            for (let i = 0; i < 16; i++) {
                data[16 + i] = invProjection[i] || 0;
            }

            // is_ortho, is_asymmetric_projection, model_scale, padding
            data[32] = this.values.uIsOrtho.ref.value;
            data[33] = 0; // is_asymmetric_projection (will be computed)
            data[34] = this.values.uModelScale.ref.value;
            data[35] = 0; // padding

            // tex_dim (2 floats) + padding (2 floats)
            const texDim = this.values.uTexDim.ref.value;
            data[36] = texDim[0];
            data[37] = texDim[1];
            data[38] = 0;
            data[39] = 0;

            // LOD parameters
            data[40] = this.values.uLodNear.ref.value;
            data[41] = this.values.uLodFar.ref.value;
            data[42] = this.values.uLodFade.ref.value;
            data[43] = this.values.uLodFactor.ref.value;

            // camera_plane (4 floats)
            const cameraPlane = this.values.uCameraPlane.ref.value;
            for (let i = 0; i < 4; i++) {
                data[44 + i] = cameraPlane[i] || 0;
            }

            this.spheresVertUniformBuffer.write(data);
        }

        // Upload spheres fragment uniforms
        if (this.spheresFragUniformBuffer) {
            const data = new Float32Array(64); // 256 bytes / 4

            // inv_view (16 floats)
            const invView = this.values.uInvView.ref.value;
            for (let i = 0; i < 16; i++) {
                data[i] = invView[i] || 0;
            }

            // is_ortho, alpha_thickness, model_scale, double_sided
            data[16] = this.values.uIsOrtho.ref.value;
            data[17] = this.values.uAlphaThickness.ref.value;
            data[18] = this.values.uModelScale.ref.value;
            data[19] = this.values.uDoubleSided.ref.value ? 1.0 : 0.0;

            this.spheresFragUniformBuffer.write(data);
        }

        // Upload material uniforms
        if (this.materialUniformBuffer) {
            const data = new Float32Array(64);

            // color (4 floats)
            const color = this.values.uColor.ref.value;
            for (let i = 0; i < 4; i++) {
                data[i] = color[i] || 0;
            }

            // interior_color (4 floats)
            const interiorColor = this.values.uInteriorColor.ref.value;
            for (let i = 0; i < 4; i++) {
                data[4 + i] = interiorColor[i] || 0;
            }

            // alpha, metalness, roughness, emissive
            data[8] = this.values.uAlpha.ref.value;
            data[9] = this.values.uMetalness.ref.value;
            data[10] = this.values.uRoughness.ref.value;
            data[11] = this.values.uEmissive.ref.value;

            this.materialUniformBuffer.write(data);
        }
    }

    protected getDrawCount(): number {
        // 6 vertices per sphere (2 triangles for quad)
        return this.values.drawCount.ref.value * 6;
    }

    protected getInstanceCount(): number {
        return this.values.instanceCount.ref.value;
    }

    dispose(): void {
        super.dispose();

        // Clean up specific resources
        if (this.positionGroupTexture) this.positionGroupTexture.destroy();
        if (this.positionGroupSampler) this.positionGroupSampler.destroy();
        if (this.instanceStorageBuffer) this.instanceStorageBuffer.destroy();
        if (this.frameUniformBuffer) this.frameUniformBuffer.destroy();
        if (this.materialUniformBuffer) this.materialUniformBuffer.destroy();
        if (this.objectUniformBuffer) this.objectUniformBuffer.destroy();
        if (this.spheresVertUniformBuffer) this.spheresVertUniformBuffer.destroy();
        if (this.spheresFragUniformBuffer) this.spheresFragUniformBuffer.destroy();

        this.shaderModules.clear();
    }
}

/**
 * Create a WebGPU spheres renderable.
 */
export function createWebGPUSpheresRenderable(
    context: GPUContext,
    values: WebGPUSpheresValues,
    state?: WebGPURenderableState,
    materialId?: number,
    transparency?: WebGPUTransparency
): WebGPUSpheresRenderable {
    const descriptor: WebGPURenderableDescriptor<WebGPUSpheresValues> = {
        context,
        materialId: materialId ?? 0,
        topology: 'triangle-list',
        values,
        state: state ?? createWebGPURenderableState(),
        transparency: transparency ?? 'opaque',
        vertexShader: SpheresShader.vertex,
        fragmentShaders: {
            color: SpheresShader.fragment.color,
            pick: SpheresShader.fragment.pick,
            depth: SpheresShader.fragment.depth,
            marking: SpheresShader.fragment.color, // Use color for now
            emissive: SpheresShader.fragment.color,
            tracing: SpheresShader.fragment.color,
        },
        vertexBufferLayouts: [],
        bindGroupLayouts: [],
    };

    return new WebGPUSpheresRenderable(descriptor);
}
