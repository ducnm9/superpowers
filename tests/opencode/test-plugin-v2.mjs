// Unit test for the OpenCode 2 plugin (.opencode/plugins/superpowers-v2.js).
//
// Exercises setup(ctx) against a mock v2 Promise-API context and verifies:
//   - the skills directory is registered as a directory skill source
//     ({ type: "directory", path }) via ctx.skill.transform
//   - the bootstrap is prepended to each agent's `system` prompt via
//     ctx.agent.transform (the Promise PluginContext has no session hook)
//   - injection is idempotent (a second transform does not double-inject)
//   - SKILL.md is read once and cached
//   - the tool mapping targets v2-correct tools, not stale v1 wording
//
// Requires no OpenCode install; runs under plain node.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

const [, , pluginPath] = process.argv;
if (!pluginPath) {
  console.error('Usage: node test-plugin-v2.mjs PLUGIN_PATH');
  process.exit(2);
}

// Isolate the config dir the plugin symlinks skills into, so the test never
// touches the real ~/.config/opencode/skills.
const tmpConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-v2-cfg-'));
process.env.OPENCODE_CONFIG_DIR = tmpConfigDir;

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
check('default export has id "superpowers"', definition && definition.id === 'superpowers');
check('default export has setup', typeof (definition && definition.setup) === 'function');

// --- Mock v2 Promise-API context ---
const skillSources = [];

// Simulated agent registry that agent.transform mutates in place.
const agents = [
  { id: 'build', system: 'You are the build agent.' },
  { id: 'plan', system: '' },
  { id: 'noSystem' }, // agent with no system field
];

const ctx = {
  skill: {
    transform: async (cb) => {
      cb({ source: (s) => skillSources.push(s), list: () => skillSources.slice() });
    },
  },
  agent: {
    transform: async (cb) => {
      cb({
        list: () => agents,
        get: (id) => agents.find((a) => a.id === id),
        update: (id, fn) => {
          const a = agents.find((x) => x.id === id);
          if (a) fn(a);
        },
        default: () => {},
        remove: () => {},
      });
    },
  },
};

await definition.setup(ctx);

// --- skill source registration ---
const embeddedSources = skillSources.filter((s) => s && s.type === 'embedded');
const directorySources = skillSources.filter((s) => s && s.type === 'directory');

check('registered at least one embedded skill source', embeddedSources.length >= 1);
check('registered the brainstorming skill as embedded',
  embeddedSources.some((s) => s.skill && s.skill.name === 'brainstorming'));
check('embedded skills carry a description',
  embeddedSources.every((s) => s.skill && typeof s.skill.description === 'string' && s.skill.description.length > 0));
check('embedded skills carry content',
  embeddedSources.every((s) => s.skill && typeof s.skill.content === 'string' && s.skill.content.includes('---')));
check('embedded skills carry a location path',
  embeddedSources.every((s) => s.skill && typeof s.skill.location === 'string'));
check('also registered one directory source (forward-compat)', directorySources.length === 1);
check('directory source points at skills dir',
  directorySources[0] && String(directorySources[0].path).endsWith('/skills'));

// --- bootstrap injected into each agent's system prompt ---
const build = agents.find((a) => a.id === 'build');
const plan = agents.find((a) => a.id === 'plan');
const noSystem = agents.find((a) => a.id === 'noSystem');

check('build agent got bootstrap', build.system.includes('EXTREMELY_IMPORTANT'));
check('build agent keeps original system text', build.system.includes('You are the build agent.'));
check('plan agent got bootstrap', plan.system.includes('EXTREMELY_IMPORTANT'));
check('agent with no system field got bootstrap', typeof noSystem.system === 'string' && noSystem.system.includes('EXTREMELY_IMPORTANT'));

// --- tool mapping correctness ---
check('maps subagent to task', build.system.includes('`task` with `subagent_type: "general"`'));
check('maps mutation to apply_patch', build.system.includes('`apply_patch`'));
check('no stale @mention mapping', !build.system.includes('@mention'));

// --- caching: using-superpowers/SKILL.md is read during the first setup
//     (once for embedded discovery, once for the bootstrap) then cached. ---
const readsAfterFirstSetup = readCount;
check('using-superpowers SKILL.md read during first setup', readsAfterFirstSetup >= 1);

// --- skill symlinks: the reliable discovery mechanism (plugin sources are
//     ignored in the beta, so skills are symlinked into <configDir>/skills). ---
const linkedSkillsDir = path.join(tmpConfigDir, 'skills');
const brainstormingLink = path.join(linkedSkillsDir, 'brainstorming');
check('created <configDir>/skills/brainstorming', fs.existsSync(brainstormingLink));
check('brainstorming is a symlink', (() => {
  try { return fs.lstatSync(brainstormingLink).isSymbolicLink(); } catch { return false; }
})());
check('brainstorming symlink points at the skill dir', (() => {
  try { return fs.readlinkSync(brainstormingLink).endsWith('/skills/brainstorming'); } catch { return false; }
})());
check('linked using-superpowers skill', fs.existsSync(path.join(linkedSkillsDir, 'using-superpowers')));

// A pre-existing real directory (foreign skill) must NOT be clobbered.
const foreignDir = path.join(linkedSkillsDir, 'foreign-skill');
fs.mkdirSync(foreignDir, { recursive: true });
fs.writeFileSync(path.join(foreignDir, 'SKILL.md'), '---\nname: foreign\n---\n');

// --- idempotency: running setup again does not double-inject or re-read ---
await definition.setup(ctx);
const markerCount = (build.system.match(/<EXTREMELY_IMPORTANT>/g) || []).length;
check('idempotent (single bootstrap block after 2nd run)', markerCount === 1);
check('caches survive 2nd run (no extra SKILL.md reads)', readCount === readsAfterFirstSetup);
check('did not clobber a foreign real skill dir', fs.lstatSync(foreignDir).isDirectory() && !fs.lstatSync(foreignDir).isSymbolicLink());

// cleanup
try { fs.rmSync(tmpConfigDir, { recursive: true, force: true }); } catch { /* noop */ }

if (failures.length > 0) {
  for (const f of failures) console.error(`FAIL: ${f}`);
  process.exit(1);
}
console.log('PASS: all v2 plugin checks passed');
