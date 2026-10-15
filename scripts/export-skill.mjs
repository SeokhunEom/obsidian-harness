import { build } from 'esbuild';
import { writeFile } from 'node:fs/promises';
const result = await build({
  entryPoints: ['packages/agent/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'es2022',
  format: 'esm',
  write: false,
});
const { BUILTIN_SKILL } = await import(
  'data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64')
);
const { id, version, inputSchema, outputSchema, requiredTools, optionalTools } = BUILTIN_SKILL;
await writeFile(
  'skills/daily-work-review/manifest.json',
  JSON.stringify(
    {
      id,
      version,
      instructionsFile: 'instructions.md',
      inputSchema,
      outputSchema,
      requiredTools,
      optionalTools,
    },
    null,
    2,
  ) + '\n',
);
console.log('Updated declarative Skill manifest.');
