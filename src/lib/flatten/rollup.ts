import commonjs from '@rollup/plugin-commonjs';
import rollupJson from '@rollup/plugin-json';
import nodeResolve from '@rollup/plugin-node-resolve';
import MagicString from 'magic-string';
import * as path from 'path';
import type { OutputAsset, OutputChunk, RollupCache } from 'rollup';
import sourcemaps from 'rollup-plugin-sourcemaps';
import { OutputFileCache } from '../ng-package/nodes';
import { readCacheEntry, saveCacheEntry } from '../utils/cache';
import * as log from '../utils/log';
import { ensureUnixPath } from '../utils/path';

/**
 * Options used in `ng-packagr` for writing flat bundle files.
 *
 * These options are passed through to rollup.
 */
export interface RollupOptions {
  moduleName: string;
  entry: string;
  entryName: string;
  dir: string;
  sourceRoot: string;
  cache?: RollupCache;
  cacheDirectory?: string | false;
  fileCache: OutputFileCache;
  cacheKey: string;
}

let rollup: typeof import('rollup') | undefined;

/** Runs rollup over the given entry file, writes a bundle file. */
export async function rollupBundleFile(
  opts: RollupOptions,
): Promise<{ cache: RollupCache; files: (OutputChunk | OutputAsset)[] }> {
  await ensureRollup();

  log.debug(`rollup (v${rollup.VERSION}) ${opts.entry} to ${opts.dir}`);

  const cacheDirectory = opts.cacheDirectory;

  function customReplace() {
    return {
      name: 'custom-replace',
      transform(code, _id) {
        const magicCode = new MagicString(code);
        // Define the patterns to search for
        const patterns = [
          /ɵɵngDeclareComponent\(\{ minVersion: "14\.0\.0",/g,
          /ɵɵngDeclareNgModule\(\{ minVersion: "14\.0\.0",/g
        ];

        patterns.forEach(pattern => {
          let match;
          // Loop over all matches for the pattern
          while ((match = pattern.exec(code)) !== null) {
            // Replace the matched text with the desired version
            magicCode.overwrite(match.index, match.index + match[0].length, match[0].replace('14.0.0', '12.0.0'));
          }
        });

        return {
          code: magicCode.toString(),
          map: magicCode.generateMap({ hires: true }) // Generates a proper sourcemap
        };
      }
    };
  }

  // Create the bundle
  const bundle = await rollup.rollup({
    context: 'this',
    external: moduleId => isExternalDependency(moduleId),
    cache: opts.cache ?? (cacheDirectory ? await readCacheEntry(cacheDirectory, opts.cacheKey) : undefined),
    input: opts.entry,
    plugins: [
      nodeResolve(),
      commonjs(),
      rollupJson(),
      customReplace(),
      sourcemaps({
        readFile: (path: string, callback: (error: Error | null, data: Buffer | string) => void) => {
          const fileData = opts.fileCache.get(ensureUnixPath(path));
          callback(fileData ? null : new Error(`Could not load '${path}' from memory.`), fileData?.content);
        },
      }),
    ],
    onwarn: warning => {
      switch (warning.code) {
        case 'CIRCULAR_DEPENDENCY':
        case 'UNUSED_EXTERNAL_IMPORT':
        case 'THIS_IS_UNDEFINED':
          break;

        default:
          log.warn(warning.message);
          break;
      }
    },
    preserveSymlinks: true,
    // Disable treeshaking when generating bundles
    // see: https://github.com/angular/angular/pull/32069
    treeshake: false,
  });

  // Output the bundle to disk
  const output = await bundle.write({
    name: opts.moduleName,
    format: 'es',
    dir: opts.dir,
    inlineDynamicImports: false,
    chunkFileNames: opts.entryName + '-[name]-[hash].mjs',
    entryFileNames: opts.entryName + '.mjs',
    banner: '',
    sourcemap: true,
  });

  if (cacheDirectory) {
    await saveCacheEntry(cacheDirectory, opts.cacheKey, JSON.stringify(bundle.cache));
  }

  // Close the bundle to let plugins clean up their external processes or services
  await bundle.close();

  return {
    files: output.output,
    cache: bundle.cache,
  };
}

async function ensureRollup(): Promise<void> {
  if (rollup) {
    return;
  }

  try {
    rollup = await import('rollup');
    log.debug(`rollup using native version.`);
  } catch {
    rollup = await import('@rollup/wasm-node');
    log.debug(`rollup using wasm version.`);
  }
}

function isExternalDependency(moduleId: string): boolean {
  // more information about why we don't check for 'node_modules' path
  // https://github.com/rollup/rollup-plugin-node-resolve/issues/110#issuecomment-350353632
  if (
    moduleId.startsWith('.') ||
    moduleId.startsWith('/') ||
    path.isAbsolute(moduleId) ||
    moduleId.includes('@getnuvo') ||
    moduleId.includes('vanilla-adapter')
  ) {
    // if it's either 'absolute', marked to embed, starts with a '.' or '/' or is the umd bundle and is tslib
    return false;
  }

  return true;
}
