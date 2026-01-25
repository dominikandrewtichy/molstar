/**
 * Copyright (c) 2021-2026 mol* contributors, licensed under MIT, See LICENSE file for more info.
 *
 * @author David Sehnal <david.sehnal@gmail.com>
 * @author Alexander Rose <alexander.rose@weirdbyte.de>
 */

import { is_iOS } from '../mol-util/browser';
import { isWebGPUSupported, GPUBackend } from '../mol-gl/gpu/context';

export const PluginFeatureDetection = {
    get defaultTransparency(): 'blended' | 'wboit' | 'dpoit' {
        return is_iOS() ? 'blended' : 'wboit';
    },
    get preferWebGl1() {
        if (typeof navigator === 'undefined' || typeof window === 'undefined') return false;

        // WebGL2 isn't working in MacOS 12.0.1 Safari 15.1, 15.2. It is working in Safari 15.4 tech preview, so disabling all versions before that.
        // prefer webgl 1 based on the userAgent substring
        const unpportedSafariVersions = [
            'Version/15.1 Safari',
            'Version/15.2 Safari',
            'Version/15.3 Safari',
        ];
        if (unpportedSafariVersions.some(v => navigator.userAgent.indexOf(v) > 0)) {
            return true;
        }

        return is_iOS();
    },
    /**
     * Get the default GPU backend preference.
     * Returns 'auto' which will use WebGPU if available, falling back to WebGL.
     * On iOS and older Safari versions, WebGL is preferred for stability.
     */
    get defaultGPUBackend(): GPUBackend | 'auto' {
        // For now, default to 'auto' which prefers WebGPU when available
        // On iOS, WebGPU support is limited, so we stick with 'auto' which will fallback appropriately
        return 'auto';
    },
    /**
     * Check if WebGPU is supported in the current environment.
     */
    get isWebGPUAvailable(): boolean {
        return isWebGPUSupported();
    },
};