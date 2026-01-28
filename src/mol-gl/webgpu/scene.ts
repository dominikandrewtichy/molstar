/**
 * Copyright (c) 2025 mol* contributors, licensed under MIT, See LICENSE file for more info.
 *
 * @author Alexander Rose <alexander.rose@weirdbyte.de>
 */

import { GPUContext } from '../gpu/context';
import { Sphere3D } from '../../mol-math/geometry/primitives/sphere3d';
import { WebGPURenderable, WebGPURenderableState, WebGPURenderableValues } from './renderable';
import { Object3D } from '../object3d';
import { CommitQueue } from '../commit-queue';
import { now } from '../../mol-util/now';
import { arraySetRemove } from '../../mol-util/array';
import { BoundaryHelper } from '../../mol-math/geometry/boundary-helper';
import { hash1 } from '../../mol-data/util';
import { clamp } from '../../mol-math/interpolate';

const boundaryHelper = new BoundaryHelper('98');

/**
 * WebGPU render object.
 */
export interface WebGPURenderObject<T extends string = string, V extends WebGPURenderableValues = WebGPURenderableValues> {
    readonly id: number;
    readonly type: T;
    readonly values: V;
    readonly state: WebGPURenderableState;
    readonly materialId: number;
}

/**
 * WebGPU scene implementation.
 */
export class WebGPUScene {
    readonly context: GPUContext;
    readonly object3d: Object3D;

    private renderables: WebGPURenderable[] = [];
    private primitives: WebGPURenderable[] = [];
    private volumes: WebGPURenderable[] = [];

    private renderableMap = new Map<WebGPURenderObject, WebGPURenderable>();
    private commitQueue = new CommitQueue();

    private boundingSphere = Sphere3D();
    private boundingSphereVisible = Sphere3D();
    private boundingSphereDirty = true;
    private boundingSphereVisibleDirty = true;

    private markerAverageDirty = true;
    private emissiveAverageDirty = true;
    private opacityAverageDirty = true;
    private transparencyMinDirty = true;
    private hasOpaqueDirty = true;

    private markerAverage = 0;
    private emissiveAverage = 0;
    private opacityAverage = 0;
    private transparencyMin = 0;
    private hasOpaque = false;

    private visibleHash = -1;

    constructor(context: GPUContext) {
        this.context = context;
        this.object3d = Object3D.create();
    }

    get view() { return this.object3d.view; }
    get position() { return this.object3d.position; }
    get direction() { return this.object3d.direction; }
    get up() { return this.object3d.up; }

    /**
     * Get all renderables.
     */
    getAllRenderables(): ReadonlyArray<WebGPURenderable> {
        return this.renderables;
    }

    /**
     * Get primitive renderables (non-volume).
     */
    getPrimitives(): ReadonlyArray<WebGPURenderable> {
        return this.primitives;
    }

    /**
     * Get volume renderables.
     */
    getVolumes(): ReadonlyArray<WebGPURenderable> {
        return this.volumes;
    }

    /**
     * Get opaque renderables.
     */
    getOpaqueRenderables(): WebGPURenderable[] {
        return this.primitives.filter(r => {
            const alpha = clamp(r.values.alpha?.ref.value * r.state.alphaFactor || 1, 0, 1);
            return alpha === 1 && r.state.opaque;
        });
    }

    /**
     * Get transparent renderables.
     */
    getTransparentRenderables(): WebGPURenderable[] {
        return this.primitives.filter(r => {
            const alpha = clamp(r.values.alpha?.ref.value * r.state.alphaFactor || 1, 0, 1);
            return alpha < 1 || !r.state.opaque;
        });
    }

    /**
     * Get pickable renderables.
     */
    getPickableRenderables(): WebGPURenderable[] {
        return this.renderables.filter(r => r.state.pickable);
    }

    /**
     * Add a render object.
     */
    add(renderObject: WebGPURenderObject, renderable: WebGPURenderable): void {
        if (this.renderableMap.has(renderObject)) {
            console.warn(`RenderObject with id '${renderObject.id}' already present`);
            return;
        }

        this.renderables.push(renderable);
        if (renderObject.type === 'direct-volume') {
            this.volumes.push(renderable);
        } else {
            this.primitives.push(renderable);
        }
        this.renderableMap.set(renderObject, renderable);

        this.markDirty();
    }

    /**
     * Remove a render object.
     */
    remove(renderObject: WebGPURenderObject): void {
        const renderable = this.renderableMap.get(renderObject);
        if (renderable) {
            renderable.dispose();
            arraySetRemove(this.renderables, renderable);
            arraySetRemove(this.primitives, renderable);
            arraySetRemove(this.volumes, renderable);
            this.renderableMap.delete(renderObject);
            this.markDirty();
        }
    }

    /**
     * Check if scene has a render object.
     */
    has(renderObject: WebGPURenderObject): boolean {
        return this.renderableMap.has(renderObject);
    }

    /**
     * Commit pending add/remove operations.
     */
    commit(maxTimeMs: number = Number.MAX_VALUE): boolean {
        const start = now();
        const commitBulkSize = 100;
        let i = 0;

        // Process removals
        while (true) {
            const obj = this.commitQueue.tryGetRemove();
            if (!obj) break;
            this.remove(obj as WebGPURenderObject);
            if (++i % commitBulkSize === 0 && now() - start > maxTimeMs) return false;
        }

        // Process additions
        while (true) {
            const obj = this.commitQueue.tryGetAdd();
            if (!obj) break;
            // Note: additions need the renderable to be created first
            // This is handled by the consumer
            if (++i % commitBulkSize === 0 && now() - start > maxTimeMs) return false;
        }

        // Sort renderables for optimal batching
        this.sortRenderables();
        this.markPropertiesDirty();

        return true;
    }

    /**
     * Get if commit is needed.
     */
    get needsCommit(): boolean {
        return !this.commitQueue.isEmpty;
    }

    /**
     * Get commit queue size.
     */
    get commitQueueSize(): number {
        return this.commitQueue.size;
    }

    /**
     * Update all renderables.
     */
    update(): void {
        for (const renderable of this.renderables) {
            renderable.update();
        }
    }

    /**
     * Sync visibility state.
     */
    syncVisibility(): boolean {
        const newHash = this.computeVisibleHash();
        if (newHash !== this.visibleHash) {
            this.boundingSphereVisibleDirty = true;
            this.markPropertiesDirty();
            this.visibleHash = newHash;
            return true;
        }
        return false;
    }

    private computeVisibleHash(): number {
        let hash = 23;
        for (const renderable of this.renderables) {
            if (!renderable.state.visible) continue;
            hash = (31 * hash + renderable.id) | 0;
        }
        hash = hash1(hash);
        return hash === -1 ? 0 : hash;
    }

    private sortRenderables(): void {
        this.renderables.sort((a, b) => {
            // Sort by material ID for batching
            if (a.materialId !== b.materialId) {
                return a.materialId - b.materialId;
            }
            // Then by ID for consistency
            return a.id - b.id;
        });
    }

    private markDirty(): void {
        this.boundingSphereDirty = true;
        this.boundingSphereVisibleDirty = true;
        this.markPropertiesDirty();
    }

    private markPropertiesDirty(): void {
        this.markerAverageDirty = true;
        this.emissiveAverageDirty = true;
        this.opacityAverageDirty = true;
        this.transparencyMinDirty = true;
        this.hasOpaqueDirty = true;
    }

    /**
     * Get bounding sphere of all renderables.
     */
    getBoundingSphere(): Sphere3D {
        if (this.boundingSphereDirty) {
            this.calculateBoundingSphere(this.boundingSphere, false);
            this.boundingSphereDirty = false;
        }
        return this.boundingSphere;
    }

    /**
     * Get bounding sphere of visible renderables.
     */
    getBoundingSphereVisible(): Sphere3D {
        if (this.boundingSphereVisibleDirty) {
            this.calculateBoundingSphere(this.boundingSphereVisible, true);
            this.boundingSphereVisibleDirty = false;
        }
        return this.boundingSphereVisible;
    }

    private calculateBoundingSphere(result: Sphere3D, onlyVisible: boolean): void {
        boundaryHelper.reset();

        for (const renderable of this.renderables) {
            if (onlyVisible && !renderable.state.visible) continue;

            const boundingSphere = renderable.values.boundingSphere?.ref.value;
            if (!boundingSphere || boundingSphere.radius === 0) continue;

            boundaryHelper.includeSphere(boundingSphere);
        }

        boundaryHelper.finishedIncludeStep();

        for (const renderable of this.renderables) {
            if (onlyVisible && !renderable.state.visible) continue;

            const boundingSphere = renderable.values.boundingSphere?.ref.value;
            if (!boundingSphere || boundingSphere.radius === 0) continue;

            boundaryHelper.radiusSphere(boundingSphere);
        }

        boundaryHelper.getSphere(result);
    }

    /**
     * Get marker average.
     */
    getMarkerAverage(): number {
        if (this.markerAverageDirty) {
            this.calculateMarkerAverage();
        }
        return this.markerAverage;
    }

    private calculateMarkerAverage(): void {
        if (this.primitives.length === 0) {
            this.markerAverage = 0;
        } else {
            let count = 0;
            let sum = 0;
            for (const r of this.primitives) {
                if (!r.state.visible) continue;
                sum += r.values.markerAverage?.ref.value || 0;
                count++;
            }
            this.markerAverage = count > 0 ? sum / count : 0;
        }
        this.markerAverageDirty = false;
    }

    /**
     * Get emissive average.
     */
    getEmissiveAverage(): number {
        if (this.emissiveAverageDirty) {
            this.calculateEmissiveAverage();
        }
        return this.emissiveAverage;
    }

    private calculateEmissiveAverage(): void {
        if (this.primitives.length === 0) {
            this.emissiveAverage = 0;
        } else {
            let count = 0;
            let sum = 0;
            for (const r of this.primitives) {
                if (!r.state.visible) continue;
                sum += (r.values.emissiveAverage?.ref.value || 0) + (r.values.uEmissive?.ref.value || 0);
                count++;
            }
            this.emissiveAverage = count > 0 ? sum / count : 0;
        }
        this.emissiveAverageDirty = false;
    }

    /**
     * Get opacity average.
     */
    getOpacityAverage(): number {
        if (this.opacityAverageDirty) {
            this.calculateOpacityAverage();
        }
        return this.opacityAverage;
    }

    private calculateOpacityAverage(): void {
        if (this.primitives.length === 0) {
            this.opacityAverage = 0;
        } else {
            let count = 0;
            let sum = 0;
            for (const r of this.primitives) {
                if (!r.state.visible) continue;
                const alpha = clamp(r.values.alpha?.ref.value * r.state.alphaFactor || 1, 0, 1);
                sum += alpha;
                count++;
            }
            this.opacityAverage = count > 0 ? sum / count : 0;
        }
        this.opacityAverageDirty = false;
    }

    /**
     * Get transparency minimum.
     */
    getTransparencyMin(): number {
        if (this.transparencyMinDirty) {
            this.calculateTransparencyMin();
        }
        return this.transparencyMin;
    }

    private calculateTransparencyMin(): void {
        if (this.primitives.length === 0) {
            this.transparencyMin = 1;
        } else {
            let min = 1;
            for (const r of this.primitives) {
                if (!r.state.visible) continue;
                const alpha = clamp(r.values.alpha?.ref.value * r.state.alphaFactor || 1, 0, 1);
                if (alpha < 1) min = Math.min(min, alpha);
            }
            this.transparencyMin = min;
        }
        this.transparencyMinDirty = false;
    }

    /**
     * Check if scene has opaque objects.
     */
    getHasOpaque(): boolean {
        if (this.hasOpaqueDirty) {
            this.calculateHasOpaque();
        }
        return this.hasOpaque;
    }

    private calculateHasOpaque(): void {
        this.hasOpaque = false;
        for (const r of this.primitives) {
            if (!r.state.visible) continue;
            if (r.state.opaque) {
                this.hasOpaque = true;
                break;
            }
        }
        this.hasOpaqueDirty = false;
    }

    /**
     * Get renderable count.
     */
    get count(): number {
        return this.renderables.length;
    }

    /**
     * Clear all renderables.
     */
    clear(): void {
        for (const renderable of this.renderables) {
            renderable.dispose();
        }
        this.renderables.length = 0;
        this.primitives.length = 0;
        this.volumes.length = 0;
        this.renderableMap.clear();
        this.markDirty();
    }

    /**
     * Iterate over renderables.
     */
    forEach(callback: (renderable: WebGPURenderable, object: WebGPURenderObject) => void): void {
        this.renderableMap.forEach(callback);
    }

    /**
     * Dispose the scene.
     */
    dispose(): void {
        this.clear();
    }
}

/**
 * Create a WebGPU scene.
 */
export function createWebGPUScene(context: GPUContext): WebGPUScene {
    return new WebGPUScene(context);
}
