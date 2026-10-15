import { build, context } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
await mkdir('dist/obsidian-harness', { recursive: true });
for (const f of ['manifest.json', 'styles.css']) await copyFile(f, `dist/obsidian-harness/${f}`);
const options = {
  entryPoints: ['apps/obsidian-plugin/main.ts'],
  bundle: true,
  platform: 'node',
  target: 'es2022',
  format: 'cjs',
  outfile: 'dist/obsidian-harness/main.js',
  external: ['obsidian', 'electron'],
  sourcemap: false,
  logLevel: 'info',
};
if (process.argv.includes('--watch')) await (await context(options)).watch();
else await build(options);
