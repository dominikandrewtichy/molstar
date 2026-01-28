/**
 * Copyright (c) 2025 mol* contributors, licensed under MIT, See LICENSE file for more info.
 *
 * @author Alexander Rose <alexander.rose@weirdbyte.de>
 */

import { Viewport } from '../../mol-canvas3d/camera/util';
import { ICamera } from '../../mol-canvas3d/camera';
import { GPUContext } from '../gpu/context';
import { Mat4, Vec3, Vec4, Vec2 } from '../../mol-math/linear-algebra';
import { Color } from '../../mol-util/color';
import { degToRad } from '../../mol-math/misc';
import { isTimingMode } from '../../mol-util/debug';
import { RenderPassEncoder, RenderTarget, BindGroupLayout, BindGroup, Buffer } from '../gpu';
import { PipelineCache } from './pipeline-cache';
import { WebGPURenderable, WebGPURenderVariant } from './renderable';
import { WebGPUScene } from './scene';

export interface WebGPURendererStats {
    pipelineCount: number;
    shaderModuleCount: number;
    drawCount: number;
    instanceCount: number;
}

export enum PickType {
    None = 0,
    Object = 1,
    Instance = 2,
    Group = 3,
}

export enum MarkingType {
    None = 0,
    Depth = 1,
    Mask = 2,
}

export interface Light {
    count: number;
    direction: number[];
    color: number[];
}

export interface WebGPURendererProps {
    backgroundColor: Color;
    pickingAlphaThreshold: number;
    colorMarker: boolean;
    highlightColor: Color;
    selectColor: Color;
    dimColor: Color;
    highlightStrength: number;
    selectStrength: number;
    dimStrength: number;
    markerPriority: number;
    xrayEdgeFalloff: number;
    celSteps: number;
    exposure: number;
    light: Array<{
        inclination: number;
        azimuth: number;
        color: Color;
        intensity: number;
    }>;
    ambientColor: Color;
    ambientIntensity: number;
}

const defaultProps: WebGPURendererProps = {
    backgroundColor: Color(0x000000),
    pickingAlphaThreshold: 0.5,
    colorMarker: true,
    highlightColor: Color.fromNormalizedRgb(1.0, 0.4, 0.6),
    selectColor: Color.fromNormalizedRgb(0.2, 1.0, 0.1),
    dimColor: Color.fromNormalizedRgb(1.0, 1.0, 1.0),
    highlightStrength: 0.3,
    selectStrength: 0.3,
    dimStrength: 0.0,
    markerPriority: 1,
    xrayEdgeFalloff: 1,
    celSteps: 5,
    exposure: 1,
    light: [{
        inclination: 150,
        azimuth: 320,
        color: Color.fromNormalizedRgb(1.0, 1.0, 1.0),
        intensity: 0.6
    }],
    ambientColor: Color.fromNormalizedRgb(1.0, 1.0, 1.0),
    ambientIntensity: 0.4,
};

interface FrameUniforms {
    view: Mat4;
    projection: Mat4;
    viewProjection: Mat4;
    invView: Mat4;
    invProjection: Mat4;
    cameraPosition: Vec3;
    cameraDir: Vec3;
    near: number;
    far: number;
    pixelRatio: number;
    viewport: Vec4;
    drawingBufferSize: Vec2;
    time: number;
}

interface LightUniforms {
    direction: Float32Array;
    color: Float32Array;
    ambientColor: Float32Array;
    count: number;
}

/**
 * WebGPU renderer implementation.
 */
export class WebGPURenderer {
    readonly context: GPUContext;
    readonly pipelineCache: PipelineCache;
    readonly props: WebGPURendererProps;

    private viewport = Viewport();
    private drawingBufferSize = Vec2.create(1, 1);
    private bgColor = Vec3.create(0, 0, 0);

    private frameUniforms: FrameUniforms;
    private lightUniforms: LightUniforms;

    // Uniform buffers
    private frameUniformBuffer: Buffer | null = null;
    private lightUniformBuffer: Buffer | null = null;

    // Bind groups
    private frameBindGroupLayout: BindGroupLayout | null = null;
    private frameBindGroup: BindGroup | null = null;

    // Render targets
    private colorTarget: RenderTarget | null = null;
    private depthTarget: RenderTarget | null = null;

    // Stats
    private stats: WebGPURendererStats = {
        pipelineCount: 0,
        shaderModuleCount: 0,
        drawCount: 0,
        instanceCount: 0,
    };

    private transparentBackground = false;

    constructor(context: GPUContext, props: Partial<WebGPURendererProps> = {}) {
        this.context = context;
        this.pipelineCache = new PipelineCache(context);
        this.props = { ...defaultProps, ...props };

        // Initialize frame uniforms
        this.frameUniforms = {
            view: Mat4.identity(),
            projection: Mat4.identity(),
            viewProjection: Mat4.identity(),
            invView: Mat4.identity(),
            invProjection: Mat4.identity(),
            cameraPosition: Vec3.create(0, 0, 0),
            cameraDir: Vec3.create(0, 0, -1),
            near: 1,
            far: 10000,
            pixelRatio: context.pixelRatio,
            viewport: Vec4.create(0, 0, 1, 1),
            drawingBufferSize: Vec2.create(1, 1),
            time: 0,
        };

        // Initialize light uniforms
        const lightCount = this.props.light.length;
        this.lightUniforms = {
            direction: new Float32Array(lightCount * 3),
            color: new Float32Array(lightCount * 3),
            ambientColor: new Float32Array(3),
            count: lightCount,
        };
        this.updateLightUniforms();

        this.updateBgColor();
        this.createUniformBuffers();
        this.createBindGroups();
    }

    private updateBgColor() {
        Color.toVec3Normalized(this.bgColor, this.props.backgroundColor);
    }

    private updateLightUniforms() {
        const tmpDir = Vec3();
        const tmpColor = Vec3();

        for (let i = 0; i < this.lightUniforms.count; i++) {
            const light = this.props.light[i];
            Vec3.directionFromSpherical(tmpDir, degToRad(light.inclination), degToRad(light.azimuth), 1);
            Vec3.toArray(tmpDir, this.lightUniforms.direction, i * 3);

            Vec3.scale(tmpColor, Color.toVec3Normalized(tmpColor, light.color), light.intensity);
            Vec3.toArray(tmpColor, this.lightUniforms.color, i * 3);
        }

        Vec3.scale(tmpColor, Color.toVec3Normalized(tmpColor, this.props.ambientColor), this.props.ambientIntensity);
        Vec3.toArray(tmpColor, this.lightUniforms.ambientColor, 0);
    }

    private createUniformBuffers() {
        // Create frame uniform buffer (aligned to 16 bytes)
        const frameUniformSize = 16 * 4 * 4 + // 4 matrices (16 floats each)
                                 3 * 4 + 4 +   // cameraPosition (vec3 + padding)
                                 3 * 4 + 4 +   // cameraDir (vec3 + padding)
                                 4 * 4;        // near, far, pixelRatio, time

        this.frameUniformBuffer = this.context.createBuffer({
            size: frameUniformSize,
            usage: ['uniform'],
        });

        // Create light uniform buffer
        const lightUniformSize = this.lightUniforms.direction.byteLength +
                                 this.lightUniforms.color.byteLength +
                                 this.lightUniforms.ambientColor.byteLength +
                                 4; // count
        this.lightUniformBuffer = this.context.createBuffer({
            size: lightUniformSize,
            usage: ['uniform'],
        });
    }

    private createBindGroups() {
        // Create bind group layout for frame uniforms
        this.frameBindGroupLayout = this.context.createBindGroupLayout({
            entries: [
                {
                    binding: 0,
                    visibility: ['vertex', 'fragment'],
                    buffer: { type: 'uniform' },
                },
                {
                    binding: 1,
                    visibility: ['vertex', 'fragment'],
                    buffer: { type: 'uniform' },
                },
            ],
        });

        // Create frame bind group
        if (this.frameUniformBuffer && this.lightUniformBuffer) {
            this.frameBindGroup = this.context.createBindGroup({
                layout: this.frameBindGroupLayout,
                entries: [
                    { binding: 0, resource: { buffer: this.frameUniformBuffer } },
                    { binding: 1, resource: { buffer: this.lightUniformBuffer } },
                ],
            });
        }
    }

    private updateFrameUniforms(camera: ICamera) {
        // Update matrices
        Mat4.copy(this.frameUniforms.view, camera.view);
        Mat4.copy(this.frameUniforms.projection, camera.projection);
        Mat4.mul(this.frameUniforms.viewProjection, camera.projection, camera.view);
        Mat4.invert(this.frameUniforms.invView, camera.view);
        Mat4.invert(this.frameUniforms.invProjection, camera.projection);

        // Update camera properties
        Mat4.getTranslation(this.frameUniforms.cameraPosition, this.frameUniforms.invView);
        Vec3.sub(this.frameUniforms.cameraDir, camera.state.target, this.frameUniforms.cameraPosition);
        Vec3.normalize(this.frameUniforms.cameraDir, this.frameUniforms.cameraDir);

        // Update clipping planes
        this.frameUniforms.near = camera.near;
        this.frameUniforms.far = camera.far;

        // Update viewport info
        this.frameUniforms.pixelRatio = this.context.pixelRatio;
        Vec4.set(this.frameUniforms.viewport, this.viewport.x, this.viewport.y, this.viewport.width, this.viewport.height);

        // Upload to GPU
        if (this.frameUniformBuffer) {
            const data = new Float32Array([
                ...this.frameUniforms.view,
                ...this.frameUniforms.projection,
                ...this.frameUniforms.viewProjection,
                ...this.frameUniforms.invView,
                ...this.frameUniforms.invProjection,
                ...this.frameUniforms.cameraPosition, 0,
                ...this.frameUniforms.cameraDir, 0,
                this.frameUniforms.near, this.frameUniforms.far, this.frameUniforms.pixelRatio, this.frameUniforms.time,
            ]);
            this.frameUniformBuffer.write(data);
        }
    }

    private updateLightUniformsGPU() {
        if (this.lightUniformBuffer) {
            const data = new Float32Array([
                ...this.lightUniforms.direction,
                ...this.lightUniforms.color,
                ...this.lightUniforms.ambientColor,
                this.lightUniforms.count,
            ]);
            this.lightUniformBuffer.write(data);
        }
    }

    /**
     * Update renderer for a new frame.
     */
    update(camera: ICamera, scene: WebGPUScene): void {
        if (isTimingMode) this.context.stats.drawCount = 0;

        this.updateFrameUniforms(camera);
        this.updateLightUniformsGPU();

        // Update scene
        scene.update();
    }

    /**
     * Render opaque objects.
     */
    renderOpaque(scene: WebGPUScene, camera: ICamera, passEncoder: RenderPassEncoder): void {
        if (isTimingMode) console.time('WebGPURenderer.renderOpaque');

        const renderables = scene.getOpaqueRenderables();

        // Set render state
        this.context.state.disableBlend();
        this.context.state.enableDepthTest();
        this.context.state.depthMask(true);

        for (const renderable of renderables) {
            this.renderRenderable(renderable, 'color', passEncoder);
        }

        if (isTimingMode) console.timeEnd('WebGPURenderer.renderOpaque');
    }

    /**
     * Render transparent objects.
     */
    renderTransparent(scene: WebGPUScene, camera: ICamera, passEncoder: RenderPassEncoder): void {
        if (isTimingMode) console.time('WebGPURenderer.renderTransparent');

        const renderables = scene.getTransparentRenderables();

        // Set render state for alpha blending
        this.context.state.enableBlend();
        if (this.transparentBackground) {
            this.context.state.blendFunc('one', 'one-minus-src-alpha');
        } else {
            this.context.state.blendFuncSeparate('src-alpha', 'one-minus-src-alpha', 'one', 'one-minus-src-alpha');
        }
        this.context.state.enableDepthTest();
        this.context.state.depthMask(false);

        for (const renderable of renderables) {
            this.renderRenderable(renderable, 'color', passEncoder);
        }

        if (isTimingMode) console.timeEnd('WebGPURenderer.renderTransparent');
    }

    /**
     * Render for picking.
     */
    renderPick(scene: WebGPUScene, camera: ICamera, passEncoder: RenderPassEncoder, pickType: PickType): void {
        if (isTimingMode) console.time('WebGPURenderer.renderPick');

        this.context.state.disableBlend();
        this.context.state.enableDepthTest();
        this.context.state.depthMask(true);

        const renderables = scene.getPickableRenderables();
        for (const renderable of renderables) {
            this.renderRenderable(renderable, 'pick', passEncoder);
        }

        if (isTimingMode) console.timeEnd('WebGPURenderer.renderPick');
    }

    /**
     * Render depth pass.
     */
    renderDepth(scene: WebGPUScene, camera: ICamera, passEncoder: RenderPassEncoder): void {
        if (isTimingMode) console.time('WebGPURenderer.renderDepth');

        this.context.state.disableBlend();
        this.context.state.enableDepthTest();
        this.context.state.depthMask(true);

        for (const renderable of scene.getAllRenderables()) {
            this.renderRenderable(renderable, 'depth', passEncoder);
        }

        if (isTimingMode) console.timeEnd('WebGPURenderer.renderDepth');
    }

    /**
     * Render a single renderable.
     */
    private renderRenderable(
        renderable: WebGPURenderable,
        variant: WebGPURenderVariant,
        passEncoder: RenderPassEncoder
    ): void {
        if (renderable.state.disposed || !renderable.state.visible) return;
        if (renderable.state.alphaFactor === 0) return;

        // Update the renderable
        renderable.update();

        // Record draw commands
        renderable.render(passEncoder, variant, this.frameBindGroup || undefined);

        // Update stats
        this.stats.drawCount++;
        this.stats.instanceCount += renderable.values.instanceCount?.ref.value || 1;
    }

    /**
     * Clear the render target.
     */
    clear(passEncoder: RenderPassEncoder, toBackgroundColor: boolean = true): void {
        // Clearing is handled by the render pass loadOp
    }

    /**
     * Set viewport.
     */
    setViewport(x: number, y: number, width: number, height: number): void {
        Viewport.set(this.viewport, x, y, width, height);
        Vec4.set(this.frameUniforms.viewport, x, y, width, height);
        this.context.state.viewport(x, y, width, height);
        this.context.state.scissor(x, y, width, height);
    }

    /**
     * Set drawing buffer size.
     */
    setDrawingBufferSize(width: number, height: number): void {
        Vec2.set(this.drawingBufferSize, width, height);
        this.frameUniforms.drawingBufferSize[0] = width;
        this.frameUniforms.drawingBufferSize[1] = height;
    }

    /**
     * Set pixel ratio.
     */
    setPixelRatio(value: number): void {
        this.frameUniforms.pixelRatio = value;
    }

    /**
     * Set transparent background.
     */
    setTransparentBackground(value: boolean): void {
        this.transparentBackground = value;
    }

    /**
     * Update renderer props.
     */
    setProps(props: Partial<WebGPURendererProps>): void {
        Object.assign(this.props, props);
        this.updateBgColor();
        this.updateLightUniforms();
    }

    /**
     * Get stats.
     */
    getStats(): WebGPURendererStats {
        return { ...this.stats };
    }

    /**
     * Dispose resources.
     */
    dispose(): void {
        this.frameUniformBuffer?.destroy();
        this.lightUniformBuffer?.destroy();
        this.colorTarget?.destroy();
        this.depthTarget?.destroy();
    }
}

/**
 * Create a WebGPU renderer.
 */
export function createWebGPURenderer(context: GPUContext, props?: Partial<WebGPURendererProps>): WebGPURenderer {
    return new WebGPURenderer(context, props);
}
