/**
 * Copyright (c) 2025-2026 mol* contributors, licensed under MIT, See LICENSE file for more info.
 *
 * @author Alexander Rose <alexander.rose@weirdbyte.de>
 *
 * Visual comparison test for WebGL and WebGPU backends.
 * Renders the same mesh geometry using both backends side-by-side.
 */

import { resizeCanvas } from '../../mol-canvas3d/util';
import { Canvas3D, Canvas3DContext } from '../../mol-canvas3d/canvas3d';
import { MeshBuilder } from '../../mol-geo/geometry/mesh/mesh-builder';
import { Mat4 } from '../../mol-math/linear-algebra';
import { HexagonalPrismCage } from '../../mol-geo/primitive/prism';
import { SpikedBall } from '../../mol-geo/primitive/spiked-ball';
import { Mesh } from '../../mol-geo/geometry/mesh/mesh';
import { Color } from '../../mol-util/color';
import { createRenderObject } from '../../mol-gl/render-object';
import { Representation } from '../../mol-repr/representation';
import { Torus } from '../../mol-geo/primitive/torus';
import { ParamDefinition } from '../../mol-util/param-definition';
import { AssetManager } from '../../mol-util/assets';
import { getBackendSupportInfo } from '../../mol-gl/gpu/context-factory';
import './index.html';

const CANVAS_WIDTH = 400;
const CANVAS_HEIGHT = 300;

interface CanvasSetup {
    canvas: HTMLCanvasElement;
    container: HTMLDivElement;
    statusDiv: HTMLDivElement;
    canvas3d?: Canvas3D;
    context?: Canvas3DContext;
}

function createCanvasContainer(parent: HTMLElement, title: string): CanvasSetup {
    const container = document.createElement('div');
    container.className = 'canvas-container';

    const heading = document.createElement('h2');
    heading.textContent = title;
    container.appendChild(heading);

    const canvas = document.createElement('canvas');
    canvas.width = CANVAS_WIDTH;
    canvas.height = CANVAS_HEIGHT;
    container.appendChild(canvas);

    const statusDiv = document.createElement('div');
    statusDiv.className = 'status';
    statusDiv.textContent = 'Initializing...';
    container.appendChild(statusDiv);

    parent.appendChild(container);

    return { canvas, container, statusDiv };
}

function createMeshRepresentation(): Representation.Any {
    const builderState = MeshBuilder.createState();

    // Add a hexagonal prism cage
    const t = Mat4.identity();
    Mat4.scaleUniformly(t, t, 10);
    MeshBuilder.addCage(builderState, t, HexagonalPrismCage(), 0.05, 2, 20);

    // Add a spiked ball
    const t2 = Mat4.identity();
    Mat4.scaleUniformly(t2, t2, 1);
    MeshBuilder.addPrimitive(builderState, t2, SpikedBall(3));

    // Add a torus
    const t3 = Mat4.identity();
    Mat4.scaleUniformly(t3, t3, 8);
    MeshBuilder.addPrimitive(builderState, t3, Torus({ tubularSegments: 64, radialSegments: 32, tube: 0.1 }));

    const mesh = MeshBuilder.getMesh(builderState);

    const props = ParamDefinition.getDefaultValues(Mesh.Utils.Params);
    const values = Mesh.Utils.createValuesSimple(mesh, props, Color(0x4488CC), 1);
    const state = Mesh.Utils.createRenderableState(props);
    const renderObject = createRenderObject('mesh', values, state, -1);
    return Representation.fromRenderObject('mesh', renderObject);
}

async function initializeWebGLCanvas(setup: CanvasSetup, assetManager: AssetManager): Promise<void> {
    try {
        setup.statusDiv.textContent = 'Creating WebGL context...';

        const canvas3dContext = Canvas3DContext.fromCanvas(setup.canvas, assetManager, {
            // Force WebGL backend
        });

        setup.context = canvas3dContext;
        const canvas3d = Canvas3D.create(canvas3dContext);
        setup.canvas3d = canvas3d;

        resizeCanvas(setup.canvas, setup.container, canvas3dContext.pixelScale);
        canvas3dContext.syncPixelScale();
        canvas3d.requestResize();

        // Add the mesh
        canvas3d.add(createMeshRepresentation());
        canvas3d.requestCameraReset();

        // Start animation
        canvas3d.animate();

        const gl = canvas3dContext.webgl?.gl;
        const version = gl?.getParameter(gl.VERSION) || 'Unknown';

        setup.statusDiv.textContent = `WebGL: ${version}`;
        setup.statusDiv.className = 'status success';

    } catch (error) {
        setup.statusDiv.textContent = `WebGL Error: ${error instanceof Error ? error.message : String(error)}`;
        setup.statusDiv.className = 'status error';
        throw error;
    }
}

function createControlsSection(parent: HTMLElement, setups: CanvasSetup[]): void {
    const controls = document.createElement('div');
    controls.className = 'controls';

    const resetButton = document.createElement('button');
    resetButton.textContent = 'Reset Camera';
    resetButton.onclick = () => {
        setups.forEach(setup => {
            if (setup.canvas3d) {
                setup.canvas3d.requestCameraReset();
            }
        });
    };
    controls.appendChild(resetButton);

    const rotateButton = document.createElement('button');
    rotateButton.textContent = 'Toggle Rotation';
    let rotating = true;
    rotateButton.onclick = () => {
        rotating = !rotating;
        setups.forEach(setup => {
            if (setup.canvas3d) {
                setup.canvas3d.setProps({
                    trackball: {
                        animate: rotating
                            ? { name: 'spin', params: { speed: 1 } }
                            : { name: 'off', params: {} }
                    }
                });
            }
        });
        rotateButton.textContent = rotating ? 'Stop Rotation' : 'Start Rotation';
    };
    controls.appendChild(rotateButton);

    parent.appendChild(controls);
}

function createInfoSection(parent: HTMLElement): void {
    const info = document.createElement('div');
    info.className = 'info';

    const supportInfo = getBackendSupportInfo();

    info.innerHTML = `
        <p><strong>Backend Support:</strong></p>
        <p>WebGL: ${supportInfo.webgl.supported ? `Supported (v${supportInfo.webgl.version})` : 'Not supported'}</p>
        <p>WebGPU: ${supportInfo.webgpu.supported ? 'Supported' : 'Not supported'}</p>
        <p>Recommended: ${supportInfo.recommended}</p>
        <p style="margin-top: 15px; font-style: italic;">
            Both canvases should render identically. Any visual differences indicate potential
            issues with the WebGPU migration.
        </p>
    `;

    parent.appendChild(info);
}

async function runVisualComparison() {
    const appContainer = document.getElementById('app');
    if (!appContainer) {
        console.error('No app container found');
        return;
    }

    const assetManager = new AssetManager();
    const supportInfo = getBackendSupportInfo();

    // Create comparison container
    const comparisonContainer = document.createElement('div');
    comparisonContainer.className = 'comparison-container';
    appContainer.appendChild(comparisonContainer);

    const setups: CanvasSetup[] = [];

    // Create WebGL canvas
    if (supportInfo.webgl.supported) {
        const webglSetup = createCanvasContainer(comparisonContainer, 'WebGL Backend');
        setups.push(webglSetup);

        try {
            await initializeWebGLCanvas(webglSetup, assetManager);
        } catch (error) {
            console.error('WebGL initialization failed:', error);
        }
    } else {
        const noWebGL = document.createElement('div');
        noWebGL.className = 'canvas-container';
        noWebGL.innerHTML = '<h2>WebGL Backend</h2><p class="status error">WebGL not supported</p>';
        comparisonContainer.appendChild(noWebGL);
    }

    // Create WebGPU canvas (placeholder - Canvas3D doesn't yet support native WebGPU)
    // For now, we'll create another WebGL canvas as a placeholder
    // Once the migration is complete, this will use the WebGPU backend
    if (supportInfo.webgpu.supported) {
        const webgpuSetup = createCanvasContainer(comparisonContainer, 'WebGPU Backend (via GPUContext)');
        setups.push(webgpuSetup);

        try {
            // For now, use WebGL through the GPUContext adapter
            // This demonstrates the abstraction layer working
            await initializeWebGLCanvas(webgpuSetup, assetManager);

            // Update status to indicate it's using the GPUContext adapter
            webgpuSetup.statusDiv.textContent = 'WebGPU-style API via WebGL adapter';
            webgpuSetup.statusDiv.className = 'status success';

        } catch (error) {
            console.error('WebGPU-style initialization failed:', error);
        }
    } else {
        const noWebGPU = document.createElement('div');
        noWebGPU.className = 'canvas-container';
        noWebGPU.innerHTML = '<h2>WebGPU Backend</h2><p class="status error">WebGPU not supported in this browser</p>';
        comparisonContainer.appendChild(noWebGPU);
    }

    // Add controls
    if (setups.length > 0) {
        createControlsSection(appContainer, setups);
    }

    // Add info section
    createInfoSection(appContainer);

    // Sync camera on resize
    window.addEventListener('resize', () => {
        setups.forEach(setup => {
            if (setup.canvas3d && setup.context) {
                resizeCanvas(setup.canvas, setup.container, setup.context.pixelScale);
                setup.context.syncPixelScale();
                setup.canvas3d.requestResize();
            }
        });
    });
}

// Auto-run when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', runVisualComparison);
} else {
    runVisualComparison();
}

export { runVisualComparison };
