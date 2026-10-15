import { zipSync, strToU8 } from 'fflate';
import { mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
await mkdir('release/obsidian-harness', { recursive: true });
const hashes = [];
const files = {};
for (const f of ['main.js', 'manifest.json', 'styles.css']) {
  await copyFile(`dist/obsidian-harness/${f}`, `release/obsidian-harness/${f}`);
  const data = await readFile(`release/obsidian-harness/${f}`);
  files[`obsidian-harness/${f}`] = new Uint8Array(data);
  hashes.push(`${createHash('sha256').update(data).digest('hex')}  obsidian-harness/${f}`);
}
await writeFile('release/SHA256SUMS', hashes.join('\n') + '\n');
console.log(
  'Installable directory: release/obsidian-harness (copy to <test-vault>/.obsidian/plugins/)',
);

files['SHA256SUMS'] = strToU8(hashes.join('\n') + '\n');
await writeFile('release/obsidian-harness-0.1.0.zip', zipSync(files, { level: 9 }));
console.log('Archive: release/obsidian-harness-0.1.0.zip');
