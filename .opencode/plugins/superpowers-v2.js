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
  // 1. Register the superpowers skills directory as a skill source.
  //    NOTE: In this beta build, plugin-registered sources did NOT surface
  //    skills to the model in testing; the reliable discovery mechanism is the
  //    `.opencode/skills` symlink shipped in this package (OpenCode 2 auto-scans
  //    `.opencode/skills`). This call is kept as a forward-compatible bonus in
  //    case the beta starts honoring plugin sources. See docs/README.opencode-v2.md.
  try {
    if (ctx && ctx.skill && typeof ctx.skill.transform === 'function') {
      await ctx.skill.transform((draft) => {
        if (draft && typeof draft.source === 'function') {
          draft.source({ type: 'directory', path: superpowersSkillsDir });
        }
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
