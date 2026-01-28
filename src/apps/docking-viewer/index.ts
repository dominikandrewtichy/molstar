/**
 * Copyright (c) 2018-2026 mol* contributors, licensed under MIT, See LICENSE file for more info.
 *
 * @author David Sehnal <david.sehnal@gmail.com>
 * @author Alexander Rose <alexander.rose@weirdbyte.de>
 */

import { Structure } from '../../mol-model/structure';
import { BuiltInTrajectoryFormat } from '../../mol-plugin-state/formats/trajectory';
import { PluginStateObject as PSO, PluginStateTransform } from '../../mol-plugin-state/objects';
import { PluginUIContext } from '../../mol-plugin-ui/context';
import { DefaultPluginUISpec, PluginUISpec } from '../../mol-plugin-ui/spec';
import { PluginBehaviors } from '../../mol-plugin/behavior';
import { PluginCommands } from '../../mol-plugin/commands';
import { PluginConfig } from '../../mol-plugin/config';
import { PluginSpec } from '../../mol-plugin/spec';
import { StateObject } from '../../mol-state';
import { Task } from '../../mol-task';
import { Color } from '../../mol-util/color';
import { ColorNames } from '../../mol-util/color/names';
import { ParamDefinition as PD } from '../../mol-util/param-definition';
import '../../mol-util/polyfill';
import { ObjectKeys } from '../../mol-util/type-helpers';
import './index.html';
import { ShowButtons, StructurePreset, ViewportComponent } from './viewport';

import { createElement } from 'react';
import { renderReact18 } from '../../mol-plugin-ui/react18';
import { Plugin } from '../../mol-plugin-ui/plugin';
import { Canvas3DContext } from '../../mol-canvas3d/canvas3d';
import { AssetManager } from '../../mol-util/assets';

import '../../mol-plugin-ui/skin/light.scss';

export { PLUGIN_VERSION as version } from '../../mol-plugin/version';
export { setDebugMode, setProductionMode } from '../../mol-util/debug';
export { Viewer as DockingViewer };

/** GPU Backend preference for the docking viewer
 * - 'webgl': Use WebGL (default, most compatible)
 * - 'webgpu': Use WebGPU (requires Chrome 113+, Edge 113+, or Firefox with WebGPU enabled)
 * - 'auto': Automatically select the best available backend
 */
export type GPUBackendPreference = 'webgl' | 'webgpu' | 'auto';

const DefaultViewerOptions = {
    extensions: ObjectKeys({}),
    layoutIsExpanded: true,
    layoutShowControls: true,
    layoutShowRemoteState: true,
    layoutControlsDisplay: 'reactive' as const,
    layoutShowSequence: true,
    layoutShowLog: true,
    layoutShowLeftPanel: true,

    viewportShowExpand: PluginConfig.Viewport.ShowExpand.defaultValue,
    viewportShowControls: PluginConfig.Viewport.ShowControls.defaultValue,
    viewportShowSettings: PluginConfig.Viewport.ShowSettings.defaultValue,
    viewportShowSelectionMode: PluginConfig.Viewport.ShowSelectionMode.defaultValue,
    viewportShowAnimation: PluginConfig.Viewport.ShowAnimation.defaultValue,
    pluginStateServer: PluginConfig.State.DefaultServer.defaultValue,
    volumeStreamingServer: PluginConfig.VolumeStreaming.DefaultServer.defaultValue,
    pdbProvider: PluginConfig.Download.DefaultPdbProvider.defaultValue,
    emdbProvider: PluginConfig.Download.DefaultEmdbProvider.defaultValue,
    /** Preferred GPU backend - 'webgl' for compatibility, 'webgpu' for modern browsers, 'auto' for automatic selection */
    preferredBackend: 'webgl' as GPUBackendPreference,
};

class Viewer {
    constructor(public plugin: PluginUIContext) {
    }

    static async create(
        elementOrId: string | HTMLElement,
        colors = [Color(0x992211), Color(0xDDDDDD)],
        showButtons = true,
        preferredBackend: GPUBackendPreference = 'webgl'
    ) {
        const o = {
            ...DefaultViewerOptions, ...{
                layoutIsExpanded: false,
                layoutShowControls: false,
                layoutShowRemoteState: false,
                layoutShowSequence: true,
                layoutShowLog: false,
                layoutShowLeftPanel: true,

                viewportShowExpand: true,
                viewportShowControls: false,
                viewportShowSettings: false,
                viewportShowSelectionMode: false,
                viewportShowAnimation: false,
                preferredBackend,
            }
        };
        const defaultSpec = DefaultPluginUISpec();

        const spec: PluginUISpec = {
            actions: defaultSpec.actions,
            behaviors: [
                PluginSpec.Behavior(PluginBehaviors.Representation.HighlightLoci, { mark: false }),
                PluginSpec.Behavior(PluginBehaviors.Representation.DefaultLociLabelProvider),
                PluginSpec.Behavior(PluginBehaviors.Camera.FocusLoci),

                PluginSpec.Behavior(PluginBehaviors.CustomProps.StructureInfo),
                PluginSpec.Behavior(PluginBehaviors.CustomProps.Interactions),
                PluginSpec.Behavior(PluginBehaviors.CustomProps.SecondaryStructure),
            ],
            animations: defaultSpec.animations,
            customParamEditors: defaultSpec.customParamEditors,
            layout: {
                initial: {
                    isExpanded: o.layoutIsExpanded,
                    showControls: o.layoutShowControls,
                    controlsDisplay: o.layoutControlsDisplay,
                },
            },
            components: {
                ...defaultSpec.components,
                controls: {
                    ...defaultSpec.components?.controls,
                    top: o.layoutShowSequence ? undefined : 'none',
                    bottom: o.layoutShowLog ? undefined : 'none',
                    left: o.layoutShowLeftPanel ? undefined : 'none',
                },
                remoteState: o.layoutShowRemoteState ? 'default' : 'none',
                viewport: {
                    view: ViewportComponent
                }
            },
            config: [
                [PluginConfig.Viewport.ShowExpand, o.viewportShowExpand],
                [PluginConfig.Viewport.ShowControls, o.viewportShowControls],
                [PluginConfig.Viewport.ShowSettings, o.viewportShowSettings],
                [PluginConfig.Viewport.ShowSelectionMode, o.viewportShowSelectionMode],
                [PluginConfig.Viewport.ShowAnimation, o.viewportShowAnimation],
                [PluginConfig.State.DefaultServer, o.pluginStateServer],
                [PluginConfig.State.CurrentServer, o.pluginStateServer],
                [PluginConfig.VolumeStreaming.DefaultServer, o.volumeStreamingServer],
                [PluginConfig.Download.DefaultPdbProvider, o.pdbProvider],
                [PluginConfig.Download.DefaultEmdbProvider, o.emdbProvider],
                [ShowButtons, showButtons]
            ]
        };

        const element = typeof elementOrId === 'string'
            ? document.getElementById(elementOrId)
            : elementOrId;
        if (!element) throw new Error(`Could not get element with id '${elementOrId}'`);

        // Create the plugin context
        const plugin = new PluginUIContext(spec);
        await plugin.init();

        // Create a canvas element for WebGPU/WebGL context
        const canvas = document.createElement('canvas');
        canvas.style.width = '100%';
        canvas.style.height = '100%';

        // Create asset manager
        const assetManager = new AssetManager();

        // Create Canvas3DContext with the preferred backend
        let canvas3dContext: Canvas3DContext;
        if (preferredBackend === 'webgl') {
            // Use synchronous path for WebGL
            canvas3dContext = Canvas3DContext.fromCanvas(canvas, assetManager, {
                antialias: true,
                preserveDrawingBuffer: true,
                powerPreference: 'high-performance',
                handleResize: () => plugin.handleResize(),
            });
        } else {
            // Use async path for WebGPU or auto selection
            canvas3dContext = await Canvas3DContext.fromCanvasAsync(canvas, assetManager, {
                preferredBackend: preferredBackend,
                antialias: true,
                preserveDrawingBuffer: true,
                powerPreference: 'high-performance',
                handleResize: () => plugin.handleResize(),
            });
        }

        // Mount the plugin with the canvas context
        const success = await plugin.mountAsync(element, {
            canvas3dContext,
            checkeredCanvasBackground: true,
        });

        if (!success) {
            throw new Error('Failed to mount plugin');
        }

        // Wait for canvas3d to be initialized
        try {
            await plugin.canvas3dInitialized;
        } catch {
            // Error reported elsewhere
        }

        // Render the UI
        renderReact18(createElement(Plugin, { plugin }), element);

        (plugin.customState as any) = {
            colorPalette: {
                name: 'colors',
                params: { list: { colors } }
            }
        };

        PluginCommands.Canvas3D.SetSettings(plugin, {
            settings: {
                renderer: {
                    ...plugin.canvas3d!.props.renderer,
                    backgroundColor: ColorNames.white,
                },
                camera: {
                    ...plugin.canvas3d!.props.camera,
                    helper: { axes: { name: 'off', params: {} } }
                }
            }
        });

        return new Viewer(plugin);
    }

    async loadStructuresFromUrlsAndMerge(sources: { url: string, format: BuiltInTrajectoryFormat, isBinary?: boolean }[]) {
        const structures: { ref: string }[] = [];
        for (const { url, format, isBinary } of sources) {
            const data = await this.plugin.builders.data.download({ url, isBinary });
            const trajectory = await this.plugin.builders.structure.parseTrajectory(data, format);
            const model = await this.plugin.builders.structure.createModel(trajectory);
            const modelProperties = await this.plugin.builders.structure.insertModelProperties(model);
            const structure = await this.plugin.builders.structure.createStructure(modelProperties || model);
            const structureProperties = await this.plugin.builders.structure.insertStructureProperties(structure);

            structures.push({ ref: structureProperties?.ref || structure.ref });
        }

        // remove current structures from hierarchy as they will be merged
        // TODO only works with using loadStructuresFromUrlsAndMerge once
        //      need some more API metho to work with the hierarchy
        this.plugin.managers.structure.hierarchy.updateCurrent(this.plugin.managers.structure.hierarchy.current.structures, 'remove');

        const dependsOn = structures.map(({ ref }) => ref);
        const data = this.plugin.state.data.build().toRoot().apply(MergeStructures, { structures }, { dependsOn });
        const structure = await data.commit();
        const structureProperties = await this.plugin.builders.structure.insertStructureProperties(structure);
        this.plugin.behaviors.canvas3d.initialized.subscribe(async v => {
            await this.plugin.builders.structure.representation.applyPreset(structureProperties || structure, StructurePreset);
        });
    }
}

type MergeStructures = typeof MergeStructures
const MergeStructures = PluginStateTransform.BuiltIn({
    name: 'merge-structures',
    display: { name: 'Merge Structures', description: 'Merge Structure' },
    from: PSO.Root,
    to: PSO.Molecule.Structure,
    params: {
        structures: PD.ObjectList({
            ref: PD.Text('')
        }, ({ ref }) => ref, { isHidden: true })
    }
})({
    apply({ params, dependencies }) {
        return Task.create('Merge Structures', async ctx => {
            if (params.structures.length === 0) return StateObject.Null;

            const first = dependencies![params.structures[0].ref].data as Structure;
            const builder = Structure.Builder({ masterModel: first.models[0] });
            for (const { ref } of params.structures) {
                const s = dependencies![ref].data as Structure;
                for (const unit of s.units) {
                    // TODO invariantId
                    builder.addUnit(unit.kind, unit.model, unit.conformation.operator, unit.elements, unit.traits);
                }
            }

            const structure = builder.getStructure();
            return new PSO.Molecule.Structure(structure, { label: 'Merged Structure' });
        });
    }
});

(window as any).DockingViewer = Viewer;
