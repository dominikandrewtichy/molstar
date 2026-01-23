/**
 * Copyright (c) 2025 mol* contributors, licensed under MIT, See LICENSE file for more info.
 *
 * @author Alexander Rose <alexander.rose@weirdbyte.de>
 */

import { GPUContext } from '../../gpu/context';
import { ShaderModule } from '../../gpu/pipeline';

/**
 * Shader variant types for rendering.
 */
export type ShaderVariant = 'color' | 'pick' | 'depth' | 'marking' | 'emissive' | 'tracing';

/**
 * Definition of a shader with multiple variants.
 */
export interface ShaderDefinition {
    /** Vertex shader source */
    vertex: string;
    /** Fragment shaders for each variant */
    fragment: Partial<Record<ShaderVariant, string>>;
}

/**
 * Compiled shader modules for a shader definition.
 */
export interface CompiledShaderModules {
    vertex: ShaderModule;
    fragment: Map<ShaderVariant, ShaderModule>;
}

/**
 * Shader module manager for handling WGSL shader compilation and caching.
 */
export class ShaderModuleManager {
    private _context: GPUContext;
    private _moduleCache = new Map<string, ShaderModule>();
    private _compiledShaders = new Map<string, CompiledShaderModules>();

    constructor(context: GPUContext) {
        this._context = context;
    }

    /**
     * Get or compile a shader module from source.
     */
    getModule(source: string, label?: string): ShaderModule {
        // Use source hash as cache key
        const key = this._hashSource(source);

        let module = this._moduleCache.get(key);
        if (!module) {
            module = this._context.createShaderModule({
                code: source,
                label,
            });
            this._moduleCache.set(key, module);
        }

        return module;
    }

    /**
     * Compile a shader definition and cache the modules.
     */
    compileShader(id: string, definition: ShaderDefinition): CompiledShaderModules {
        let compiled = this._compiledShaders.get(id);
        if (compiled) {
            return compiled;
        }

        // Compile vertex shader
        const vertexModule = this.getModule(definition.vertex, `${id}_vertex`);

        // Compile fragment shaders for each variant
        const fragmentModules = new Map<ShaderVariant, ShaderModule>();
        for (const [variant, source] of Object.entries(definition.fragment)) {
            if (source) {
                const module = this.getModule(source, `${id}_${variant}`);
                fragmentModules.set(variant as ShaderVariant, module);
            }
        }

        compiled = {
            vertex: vertexModule,
            fragment: fragmentModules,
        };
        this._compiledShaders.set(id, compiled);

        return compiled;
    }

    /**
     * Get compiled shader modules for a shader ID.
     */
    getCompiledShader(id: string): CompiledShaderModules | undefined {
        return this._compiledShaders.get(id);
    }

    /**
     * Check if a shader has been compiled.
     */
    hasCompiledShader(id: string): boolean {
        return this._compiledShaders.has(id);
    }

    /**
     * Remove a compiled shader and its modules.
     */
    removeCompiledShader(id: string): boolean {
        const compiled = this._compiledShaders.get(id);
        if (!compiled) {
            return false;
        }

        compiled.vertex.destroy();
        compiled.fragment.forEach((module) => {
            module.destroy();
        });
        this._compiledShaders.delete(id);

        return true;
    }

    /**
     * Clear all cached modules.
     */
    clear(): void {
        this._moduleCache.forEach((module) => {
            module.destroy();
        });
        this._moduleCache.clear();
        this._compiledShaders.clear();
    }

    /**
     * Get statistics about cached modules.
     */
    getStats(): { moduleCount: number; compiledShaderCount: number } {
        return {
            moduleCount: this._moduleCache.size,
            compiledShaderCount: this._compiledShaders.size,
        };
    }

    /**
     * Simple hash function for source code.
     */
    private _hashSource(source: string): string {
        let hash = 0;
        for (let i = 0; i < source.length; i++) {
            const char = source.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // Convert to 32bit integer
        }
        return hash.toString(36);
    }
}

/**
 * Preprocessor for WGSL shaders.
 * Handles defines and conditional compilation.
 */
export class WGSLPreprocessor {
    private _defines = new Map<string, string | boolean>();

    /**
     * Set a define value.
     */
    define(name: string, value: string | boolean = true): this {
        this._defines.set(name, value);
        return this;
    }

    /**
     * Unset a define.
     */
    undefine(name: string): this {
        this._defines.delete(name);
        return this;
    }

    /**
     * Clear all defines.
     */
    clearDefines(): this {
        this._defines.clear();
        return this;
    }

    /**
     * Process shader source with defines.
     * WGSL uses override declarations for compile-time constants.
     */
    process(source: string): string {
        let result = source;

        // Generate override declarations
        const overrides: string[] = [];
        this._defines.forEach((value, name) => {
            if (typeof value === 'boolean') {
                overrides.push(`override ${name}: bool = ${value};`);
            } else {
                overrides.push(`override ${name}: f32 = ${value};`);
            }
        });

        if (overrides.length > 0) {
            // Insert overrides after any existing overrides or at the start
            const overrideBlock = overrides.join('\n') + '\n\n';

            // Find a good insertion point (after imports/comments)
            const insertPoint = this._findInsertPoint(result);
            result = result.slice(0, insertPoint) + overrideBlock + result.slice(insertPoint);
        }

        return result;
    }

    /**
     * Find a good insertion point for overrides.
     */
    private _findInsertPoint(source: string): number {
        // Skip leading comments and whitespace
        const lines = source.split('\n');
        let insertLine = 0;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (line === '' || line.startsWith('//')) {
                insertLine = i + 1;
            } else {
                break;
            }
        }

        // Calculate character position
        let pos = 0;
        for (let i = 0; i < insertLine && i < lines.length; i++) {
            pos += lines[i].length + 1; // +1 for newline
        }

        return pos;
    }
}

/**
 * Create shader variants with defines.
 */
export function createShaderVariants(
    baseVertex: string,
    baseFragment: string,
    variants: ShaderVariant[]
): ShaderDefinition {
    const preprocessor = new WGSLPreprocessor();

    const definition: ShaderDefinition = {
        vertex: baseVertex,
        fragment: {},
    };

    for (const variant of variants) {
        preprocessor.clearDefines();

        // Set variant-specific defines
        switch (variant) {
            case 'color':
                preprocessor.define('RENDER_VARIANT_COLOR', true);
                break;
            case 'pick':
                preprocessor.define('RENDER_VARIANT_PICK', true);
                break;
            case 'depth':
                preprocessor.define('RENDER_VARIANT_DEPTH', true);
                break;
            case 'marking':
                preprocessor.define('RENDER_VARIANT_MARKING', true);
                break;
            case 'emissive':
                preprocessor.define('RENDER_VARIANT_EMISSIVE', true);
                break;
            case 'tracing':
                preprocessor.define('RENDER_VARIANT_TRACING', true);
                break;
        }

        definition.fragment[variant] = preprocessor.process(baseFragment);
    }

    return definition;
}
