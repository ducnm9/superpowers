// Unit test for the OpenCode 2 plugin (.opencode/plugins/superpowers-v2.js).
//
// Exercises setup(ctx) against a mock v2 context and verifies:
//   - the skills directory is registered as a skill source
//   - the request hook injects the bootstrap into the first user message
//     (for both string-content and array-content message shapes)
//   - injection is idempotent (the per-step request hook does not double-inject)
//   - SKILL.md is read once and cached (no re-read on the second request)
//   - the tool mapping targets v2-correct tools, not stale v1 wording
//
// Requires no OpenCode install; runs under plain node.

import fs from 'fs';
import { pathToFileURL } from 'url';

const [, , pluginPath] = process.argv;
if (!pluginPath) {
  console.error('Usage: node test-plugin-v2.mjs PLUGIN_PATH');
  process.exit(2);
}

const failures = [];
const check = (name, cond) => {
  if (!cond) failures.push(name);
};

// Count reads of the bootstrap SKILL.md so we can assert caching.
let readCount = 0;
const originalReadFileSync = fs.readFileSync;
fs.readFileSync = function (...args) {
  if (String(args[0]).replaceAll('\\', '/').includes('using-superpowers/SKILL.md')) {
    readCount += 1;
  }
  return originalReadFileSync.apply(this, args);
};

const mod = await import(pathToFileURL(pluginPath).href);
const definition = mod.default;
check('default export exists', !!definition);
check('default export has setup', typeof (definition && definition.setup) === 'function');

// Mock v2 context.
const skillSources = [];
let requestHook;
const ctx = {
  skill: { transform: (cb) => cb({ source: (p) => skillSources.push(p) }) },
  session: { hook: (name, cb) => { if (name === 'request') requestHook = cb; } },
};

await definition.setup(ctx);

check('registered exactly one skill source', skillSources.length === 1);
check('skill source points at skills dir', skillSources[0] && skillSources[0].endsWith('/skills'));
check('registered a request hook', typeof requestHook === 'function');

// --- string-content message shape ---
const ev1 = { messages: [{ role: 'user', content: "Let's make a react todo list" }], system: '' };
await requestHook(ev1);
const c1 = ev1.messages[0].content;
check('string-shape: bootstrap injected', c1.includes('EXTREMELY_IMPORTANT'));
check('string-shape: original text preserved', c1.includes("Let's make a react todo list"));
check('string-shape: maps subagent to task', c1.includes('`task` with `subagent_type: "general"`'));
check('string-shape: maps mutation to apply_patch', c1.includes('`apply_patch`'));
check('string-shape: no stale @mention mapping', !c1.includes('@mention'));

const readAfterFirst = readCount;
await requestHook(ev1); // second step
const markerCount1 = (ev1.messages[0].content.match(/<EXTREMELY_IMPORTANT>/g) || []).length;
check('string-shape: idempotent (single bootstrap)', markerCount1 === 1);
check('bootstrap read once and cached', readCount === readAfterFirst);

// --- array-content part shape ---
const ev2 = { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], system: [] };
await requestHook(ev2);
const parts = ev2.messages[0].content;
const bootstrapParts = parts.filter((p) => p.text && p.text.includes('EXTREMELY_IMPORTANT'));
check('array-shape: one bootstrap part injected', bootstrapParts.length === 1);
await requestHook(ev2);
const bootstrapPartsAfter = parts.filter((p) => p.text && p.text.includes('EXTREMELY_IMPORTANT'));
check('array-shape: idempotent (single bootstrap part)', bootstrapPartsAfter.length === 1);

// --- system-string dedup guard ---
const ev3 = { messages: [{ role: 'user', content: 'hello' }], system: 'prelude <EXTREMELY_IMPORTANT> already here' };
await requestHook(ev3);
check('system-marker: skips injection when system already has bootstrap', !ev3.messages[0].content.includes('EXTREMELY_IMPORTANT'));

if (failures.length > 0) {
  for (const f of failures) console.error(`FAIL: ${f}`);
  process.exit(1);
}
console.log(`PASS: all ${13} v2 plugin checks passed`);
