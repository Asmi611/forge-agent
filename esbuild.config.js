/** Forge Agent — esbuild bundling config (S-01).
 *
 * Bundles src/extension.ts into out/extension.js for the VS Code
 * extension host (main: "./out/extension.js" in package.json).
 *
 * Extension-host requirements:
 *  - CJS format (extension host loads the entry via require()).
 *  - `vscode` left external (the extension host injects it as a global
 *    namespace; it is not an npm package).
 *  - No node built-ins bundled (vscode.workspace, fs, etc. are VS Code
 *    API surface; node:fs is unused in the extension).
 *  - Sourcemap disabled for the shipped artifact.
 *
 * Watch mode uses esbuild.context() (an ESBuildContext) whose .watch()
 * method keeps the process alive and rebuilds on source changes.
 * Normal build mode uses esbuild.build() with shared options.
 * Note: `type: module` is intentionally NOT set in package.json: the
 * installed esbuild ^0.25.0 fails its peer dependency range under the
 * ESM package type, so this file still runs on the installed version.
 */

import * as esbuild from 'esbuild';

const outdir = 'out';

// Base build options shared by build() and context().
function baseOptions() {
  return {
    entryPoints: ['src/extension.ts'],
    bundle: true,
    outdir,
    format: 'cjs',
    target: 'node18',
    platform: 'node',
    external: ['vscode'],
    sourcemap: false,
    minify: false,
    metafile: true,
  };
}

async function main() {
  const isWatch = process.argv.includes('--watch');

  if (isWatch) {
    const ctx = await esbuild.context(baseOptions());
    console.log('esbuild watching: src/extension.ts -> out/extension.js');
    await ctx.watch();
    // ctx.watch() resolves after the first build + the watcher is armed.
    // The process stays alive for the file system watcher.
  } else {
    const ctx = await esbuild.build({ ...baseOptions() });
    if (ctx.metafile) {
      console.log('\n--- esbuild metafile ---');
      console.log(JSON.stringify(ctx.metafile, null, 2));
      console.log('--- end metafile ---\n');
    }
    console.log('esbuild built: out/extension.js');
  }
}

main().then(() => {}).catch(() => process.exit(1));
