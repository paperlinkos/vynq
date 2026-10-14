import { cp, mkdir, rm } from 'node:fs/promises';
import { build } from 'esbuild';

await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
await Promise.all([
  cp('index.html', 'dist/index.html'),
  cp('styles.css', 'dist/styles.css'),
  cp('server.mjs', 'dist/server.mjs')
]);
await build({ entryPoints: ['src/main.js'], bundle: true, format: 'esm', outfile: 'dist/src/main.js', minify: true, sourcemap: true });
console.log('Built VYNQ application to dist/.');
