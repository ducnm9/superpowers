/**
 * Superpowers plugin for OpenCode 2 (the `opencode2` beta / `@opencode-ai/cli@beta`).
 *
 * OpenCode 2 ships a different plugin API than OpenCode 1, so the v1 plugin
 * (`superpowers.js`) does not work here. The differences that matter:
 *
 *   - The module must have a DEFAULT export built with `Plugin.define(...)`
 *     that carries a unique plugin id and a `setup(ctx)` function. v1 used a
 *     named export returning a hook-map object.
 *   - Skills are registered through the `ctx.skill.transform` hook (a `source`
 *     draft operation), not by mutating `config.skills.paths`.
 *   - The bootstrap is injected through `ctx.session.hook("request", ...)`,
 *     which can mutate `system` / `messages` right before the model is called.
 *     v1 used the `experimental.chat.messages.transform` hook.
 *
 * Docs: https://opencode.ai/v2/docs/plugins and https://opencode.ai/v2/docs/skills
 *
 * NOTE: The v2 plugin API is beta and its exact draft/hook object shapes may
 * change before the stable release. Every v2 primitive below is called through
 * a defensive helper so that an API drift degrades gracefully (skills still
 * discovered via the co-located `.opencode/skills` convention, bootstrap simply
 * not injected) rather than crashing the host. See README.opencode-v2.md.
 */

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const superpowersSkillsDir = path.resolve(__dirname, '../../skills');

// --- Bootstrap assembly (cached; SKILL.md does not change during a session) ---

const extractAndStripFrontmatter = (content) => {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { frontmatter: {}, content };
  return { frontmatter: {}, content: match[2] };
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

  const { content } = extractAndStripFrontmatter(fs.readFileSync(skillPath, 'utf8'));

  _bootstrapCache = `<${BOOTSTRAP_MARKER}>
You have superpowers.

**IMPORTANT: The using-superpowers skill content is included below. It is ALREADY LOADED - you are currently following it. Do NOT use the skill tool to load "using-superpowers" again - that would be redundant.**

${content}

${TOOL_MAPPING}
</${BOOTSTRAP_MARKER}>`;

  return _bootstrapCache;
};

// --- v2 message helpers ---

// The `request` hook exposes `messages` and `system`. The exact element shape
// is not fully pinned down in the beta docs, so we detect an already-injected
// bootstrap across the shapes v2 is known to use (plain-string parts, or
// `{ type, text }` content parts) and inject in a matching shape.
const messageAlreadyHasBootstrap = (messages, system) => {
  if (Array.isArray(system) && system.some((s) => typeof s === 'string' && s.includes(BOOTSTRAP_MARKER))) {
    return true;
  }
  if (typeof system === 'string' && system.includes(BOOTSTRAP_MARKER)) return true;

  for (const msg of messages || []) {
    const content = msg && msg.content;
    if (typeof content === 'string' && content.includes(BOOTSTRAP_MARKER)) return true;
    if (Array.isArray(content)) {
      for (const part of content) {
        if (part && typeof part.text === 'string' && part.text.includes(BOOTSTRAP_MARKER)) return true;
      }
    }
  }
  return false;
};

const injectBootstrapIntoMessages = (messages, bootstrap) => {
  const firstUser = (messages || []).find((m) => m && m.role === 'user');
  if (!firstUser) return false;

  if (typeof firstUser.content === 'string') {
    firstUser.content = `${bootstrap}\n\n${firstUser.content}`;
    return true;
  }
  if (Array.isArray(firstUser.content)) {
    firstUser.content.unshift({ type: 'text', text: bootstrap });
    return true;
  }
  return false;
};

// --- Plugin definition ---

// `Plugin.define` is provided by the `@opencode-ai/plugin` package the host
// injects at load time. We import it lazily so this module also loads under
// hosts/tests that pass it differently, without a hard top-level dependency.
let Plugin;
try {
  ({ Plugin } = await import('@opencode-ai/plugin'));
} catch {
  Plugin = undefined;
}

const setup = async (ctx) => {
  // 1. Register the superpowers skills directory as a skill source, so OpenCode
  //    discovers all skills without symlinks or manual `skills` config edits.
  try {
    if (ctx && ctx.skill && typeof ctx.skill.transform === 'function') {
      ctx.skill.transform((draft) => {
        if (draft && typeof draft.source === 'function') {
          draft.source(superpowersSkillsDir);
        }
      });
    }
  } catch (err) {
    // Non-fatal: fall back to OpenCode's co-located `.opencode/skills`
    // discovery convention. Surface the reason in logs.
    console.error('[superpowers] skill source registration failed:', err && err.message);
  }

  // 2. Inject the bootstrap into the first user message on every model request.
  //    The request hook fires per model step, so we guard against re-injection.
  try {
    if (ctx && ctx.session && typeof ctx.session.hook === 'function') {
      ctx.session.hook('request', async (event) => {
        const bootstrap = getBootstrapContent();
        if (!bootstrap || !event || !Array.isArray(event.messages)) return;
        if (messageAlreadyHasBootstrap(event.messages, event.system)) return;
        injectBootstrapIntoMessages(event.messages, bootstrap);
      });
    }
  } catch (err) {
    console.error('[superpowers] request hook registration failed:', err && err.message);
  }
};

const definition = { name: 'superpowers', setup };

export default Plugin && typeof Plugin.define === 'function'
  ? Plugin.define(definition)
  : definition;
