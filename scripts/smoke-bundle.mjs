import { readFile } from 'node:fs/promises';
import { createRequire, builtinModules } from 'node:module';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const nativeRequire = createRequire(import.meta.url),
  imports = new Set();
class HostClass {}
const host = {
  Plugin: HostClass,
  ItemView: HostClass,
  Modal: HostClass,
  PluginSettingTab: HostClass,
  Setting: HostClass,
  SecretComponent: HostClass,
  Notice: HostClass,
  TFile: HostClass,
  FileSystemAdapter: HostClass,
};
const module = { exports: {} };
const source = await readFile('dist/obsidian-harness/main.js', 'utf8');
const sandbox = {
  module,
  exports: module.exports,
  require(name) {
    imports.add(name);
    if (name === 'obsidian') return host;
    if (builtinModules.includes(name) || name.startsWith('node:')) return nativeRequire(name);
    throw new Error(`Unexpected runtime dependency: ${name}`);
  },
  console,
  structuredClone,
  Buffer,
  TextEncoder,
  TextDecoder,
  URL,
  AbortController,
  AbortSignal,
  setTimeout,
  clearTimeout,
  process,
  crypto: globalThis.crypto,
};
vm.runInNewContext(source, sandbox, { timeout: 5000, filename: 'main.js' });
assert.equal(typeof module.exports.default, 'function');
assert.equal(typeof module.exports.default.prototype.onload, 'function');
const manifest = JSON.parse(await readFile('dist/obsidian-harness/manifest.json', 'utf8'));
assert.equal(manifest.id, 'obsidian-harness');
assert.equal(manifest.isDesktopOnly, true);
assert((await readFile('dist/obsidian-harness/styles.css', 'utf8')).includes('.harness-view'));
console.log(
  `Bundle smoke passed: CommonJS plugin + manifest + styles; ${imports.size} allowed imports. This does not simulate Obsidian UI.`,
);
