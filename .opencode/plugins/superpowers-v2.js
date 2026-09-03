/**
 * Superpowers plugin for OpenCode 2 (the `opencode2` beta / `@opencode-ai/cli@beta`).
 *
 * OpenCode 2's plugin API differs from OpenCode 1's, so the v1 plugin
 * (`superpowers.js`) does not load here. This module targets the real
 * `@opencode-ai/plugin@1.x` Promise API, verified against the installed
 * package's type definitions:
 *
 *   - The plugin factory is `define({ id, setup })` exported from
 *     `@opencode-ai/plugin/v2/promise` (uses `id`, not `name`), and must be the
 *     module's DEFAULT export.
 *   - Skills are registered via `ctx.skill.transform(draft => draft.source({
 *     type: "directory", path }))` — a structured source object, not a string.
 *   - The Promise `PluginContext` has NO `session`/`request` hook. Bootstrap is
 *     delivered by prepending to each agent's `system` prompt through
 *     `ctx.agent.transform(draft => draft.update(id, a => { a.system = ... }))`.
 *
 * Docs: https://opencode.ai/v2/docs/plugins and https://opencode.ai/v2/docs/skills
 * API surface confirmed from: @opencode-ai/plugin/dist/v2/promise/*.d.ts
 *
 * NOTE: The v2 plugin API is beta. Every context call below is guarded so an
 * API drift degrades gracefully (logged, not thrown) rather than crashing the
 * host. See docs/README.opencode-v2.md.
 */

import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const superpowersSkillsDir = path.resolve(__dirname, '../../skills');

// --- Bootstrap assembly (cached; SKILL.md does not change during a session) ---

const extractAndStripFrontmatter = (content) => {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return content;
  return match[2];
};

const TOOL_MAPPING = `**Tool Mapping for OpenCode:**
When skills request actions, substitute OpenCode equivalents:
- Create or update todos → \`todowrite\`
- \`Subagent (general-purpose):\` → \`task\` with \`subagent_type: "general"\`
- Invoke a skill → OpenCode's native \`skill\` tool
- Read files → \`read\`
- Create, edit, or delete files → \`apply_patch\`
- Run shell commands → \`bash\`
- Search files → \`grep\`, \`glob\`
- Fetch a URL → \`webfetch\`

Use OpenCode's native \`skill\` tool to list and load skills.`;

const BOOTSTRAP_MARKER = 'EXTREMELY_IMPORTANT';

let _bootstrapCache; // undefined = not loaded, null = file missing

const getBootstrapContent = () => {
  if (_bootstrapCache !== undefined) return _bootstrapCache;

  const skillPath = path.join(superpowersSkillsDir, 'using-superpowers', 'SKILL.md');
  if (!fs.existsSync(skillPath)) {
    _bootstrapCache = null;
    return null;
  }

  const content = extractAndStripFrontmatter(fs.readFileSync(skillPath, 'utf8'));

  _bootstrapCache = `<${BOOTSTRAP_MARKER}>
You have superpowers.

**IMPORTANT: The using-superpowers skill content is included below. It is ALREADY LOADED - you are currently following it. Do NOT use the skill tool to load "using-superpowers" again - that would be redundant.**

${content}

${TOOL_MAPPING}
</${BOOTSTRAP_MARKER}>`;

  return _bootstrapCache;
};

// --- Embedded skill discovery ---
//
// In the beta, a `{ type: "directory" }` skill source did not surface skills to
// the model, and the `.opencode/skills` symlink does not survive git-package
// install (npm pack drops symlinks). Registering each skill as an embedded
// source ({ type: "embedded", skill: {...} }) carries the skill content in the
// plugin registration itself, independent of directory scanning or symlinks.

const parseFrontmatter = (raw) => {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n/);
  const fm = {};
  if (match) {
    for (const line of match[1].split('\n')) {
      const idx = line.indexOf(':');
      if (idx > 0) {
        const key = line.slice(0, idx).trim();
        const val = line.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
        fm[key] = val;
      }
    }
  }
  return fm;
};

let _embeddedSkillsCache; // cached list of SkillV2Info

const discoverEmbeddedSkills = () => {
  if (_embeddedSkillsCache !== undefined) return _embeddedSkillsCache;

  const skills = [];
  let entries;
  try {
    entries = fs.readdirSync(superpowersSkillsDir, { withFileTypes: true });
  } catch {
    _embeddedSkillsCache = skills;
    return skills;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillFile = path.join(superpowersSkillsDir, entry.name, 'SKILL.md');
    if (!fs.existsSync(skillFile)) continue;
    let raw;
    try {
      raw = fs.readFileSync(skillFile, 'utf8');
    } catch {
      continue;
    }
    const fm = parseFrontmatter(raw);
    const name = fm.name || entry.name;
    if (!fm.description) continue; // skills without a description aren't advertised
    skills.push({
      name,
      description: fm.description,
      location: path.dirname(skillFile),
      content: raw,
    });
  }

  _embeddedSkillsCache = skills;
  return skills;
};

// --- Skill installation into an OpenCode-watched directory ---
//
// Verified from the server log: after loading this plugin, OpenCode 2 only
// watches these skill sources — `~/.claude/skills`, `~/.agents/skills`,
// `~/.config/opencode/skill(s)`. Skill sources registered from a plugin
// (`draft.source(...)`, directory or embedded) are NOT picked up in this beta.
// The reliable mechanism is to place skills in one of the watched directories.
//
// So on setup we symlink each superpowers skill into
// `<configDir>/skills/<name>` -> `<package>/skills/<name>`. Symlinks (not
// copies) keep skills in sync with the installed package and survive updates.
// Existing non-superpowers skills of the same name are left untouched.

const linkSkillsIntoConfigDir = () => {
  const configDir = process.env.OPENCODE_CONFIG_DIR
    ? path.resolve(process.env.OPENCODE_CONFIG_DIR)
    : path.join(os.homedir(), '.config', 'opencode');
  const targetSkillsDir = path.join(configDir, 'skills');

  let created = 0;
  try {
    fs.mkdirSync(targetSkillsDir, { recursive: true });
  } catch (err) {
    console.error('[superpowers] cannot create skills dir:', err && err.message);
    return created;
  }

  let entries;
  try {
    entries = fs.readdirSync(superpowersSkillsDir, { withFileTypes: true });
  } catch {
    return created;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const src = path.join(superpowersSkillsDir, entry.name);
    if (!fs.existsSync(path.join(src, 'SKILL.md'))) continue;
    const dest = path.join(targetSkillsDir, entry.name);

    try {
      const existing = fs.lstatSync(dest, { throwIfNoEntry: false });
      if (existing) {
        // Refresh only symlinks we own; never clobber a real dir or foreign skill.
        if (existing.isSymbolicLink() && fs.readlinkSync(dest) === src) continue;
        if (existing.isSymbolicLink()) {
          fs.unlinkSync(dest);
        } else {
          continue; // a real directory / foreign skill with this name — leave it
        }
      }
      fs.symlinkSync(src, dest, 'dir');
      created += 1;
    } catch (err) {
      console.error(`[superpowers] failed to link skill "${entry.name}":`, err && err.message);
    }
  }
  return created;
};

// --- Plugin definition ---

// `define` lives at @opencode-ai/plugin/v2/promise. Import it lazily so this
// module also loads under a host/test that provides the factory differently,
// falling back to a plain { id, setup } object (which OpenCode also accepts).
let define;
try {
  ({ define } = await import('@opencode-ai/plugin/v2/promise'));
} catch {
  define = undefined;
}

const setup = async (ctx) => {
  // 1. Make skills discoverable. In this beta, plugin-registered skill sources
  //    are ignored (OpenCode 2 only watches fixed skill directories), so the
  //    reliable path is to symlink each skill into `<configDir>/skills/`.
  try {
    linkSkillsIntoConfigDir();
  } catch (err) {
    console.error('[superpowers] linking skills failed:', err && err.message);
  }

  //    Also register the skills as plugin sources (embedded + directory) as a
  //    forward-compatible bonus, in case a later beta honors plugin sources.
  try {
    if (ctx && ctx.skill && typeof ctx.skill.transform === 'function') {
      const embedded = discoverEmbeddedSkills();
      await ctx.skill.transform((draft) => {
        if (!draft || typeof draft.source !== 'function') return;
        for (const skill of embedded) {
          draft.source({ type: 'embedded', skill });
        }
        draft.source({ type: 'directory', path: superpowersSkillsDir });
      });
    }
  } catch (err) {
    console.error('[superpowers] skill source registration failed:', err && err.message);
  }

  // 2. Inject the bootstrap into every agent's system prompt. The Promise
  //    PluginContext exposes no per-request/session hook, so the agent's
  //    `system` field is the delivery surface that reaches the model each turn.
  try {
    const bootstrap = getBootstrapContent();
    if (bootstrap && ctx && ctx.agent && typeof ctx.agent.transform === 'function') {
      await ctx.agent.transform((draft) => {
        if (!draft || typeof draft.list !== 'function' || typeof draft.update !== 'function') return;
        for (const agent of draft.list()) {
          if (!agent || !agent.id) continue;
          draft.update(agent.id, (a) => {
            const current = typeof a.system === 'string' ? a.system : '';
            if (current.includes(BOOTSTRAP_MARKER)) return; // dedup
            a.system = current ? `${bootstrap}\n\n${current}` : bootstrap;
          });
        }
      });
    }
  } catch (err) {
    console.error('[superpowers] agent system injection failed:', err && err.message);
  }
};

const definition = { id: 'superpowers', setup };

export default define && typeof define === 'function' ? define(definition) : definition;
