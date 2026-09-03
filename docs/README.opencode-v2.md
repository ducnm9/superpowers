# Superpowers for OpenCode 2 (beta)

Guide for using Superpowers with [OpenCode 2](https://opencode.ai/v2/docs), the
`opencode2` beta (`@opencode-ai/cli@beta`).

OpenCode 2 installs as a separate `opencode2` binary and does not replace
OpenCode 1's `opencode`. You can keep both installed. Superpowers ships a
dedicated plugin for each, because the plugin APIs are incompatible:

- OpenCode 1 → `.opencode/plugins/superpowers.js` (see
  [README.opencode.md](README.opencode.md))
- OpenCode 2 → `.opencode/plugins/superpowers-v2.js` (this document)

## Why a separate plugin

The OpenCode 2 plugin API differs from v1 in ways that break the v1 plugin:

| Concern | OpenCode 1 | OpenCode 2 |
| --- | --- | --- |
| Config key | `"plugin"` | `"plugins"` |
| Export shape | named export returning a hook-map object | default export from `Plugin.define({ name, setup })` |
| Skill registration | mutate `config.skills.paths` in the `config` hook | `ctx.skill.transform` with a `source` draft operation |
| Bootstrap injection | `experimental.chat.messages.transform` hook | `ctx.session.hook("request", ...)` mutating `system` / `messages` |

Loading the v1 plugin under `opencode2` results in no skills registered and no
bootstrap injected, so skills never auto-trigger.

## Installation

Add superpowers to the `plugins` array in your `opencode.json` (global or
project-level):

```json
{
  "plugins": ["superpowers@git+https://github.com/ducnm9/superpowers.git"]
}
```

Restart `opencode2`. Verify by asking: "Tell me about your superpowers"

To pin a version, append a tag or branch:

```json
{
  "plugins": ["superpowers@git+https://github.com/ducnm9/superpowers.git#v6.3.0"]
}
```

## How it works

`setup(ctx)` runs when the plugin activates and does two things:

1. **Registers the skills directory** via `ctx.skill.transform`, adding
   `skills/` as a skill source so OpenCode discovers every superpowers skill.
2. **Injects the bootstrap** via `ctx.session.hook("request", ...)`. On each
   model request it prepends the `using-superpowers` skill content (wrapped in
   `<EXTREMELY_IMPORTANT>` tags, with the tool mapping appended) to the first
   user message. A dedup guard skips injection when the bootstrap is already
   present, so the per-step request hook does not double-inject.

The bootstrap content is read from `skills/using-superpowers/SKILL.md` once and
cached at module level.

## Tool mapping

Skills speak in actions; on OpenCode 2 they resolve to the same native tools as
on OpenCode 1:

- "Create a todo" / "mark complete in todo list" → `todowrite`
- `Subagent (general-purpose):` → `task` with `subagent_type: "general"`
  (or `"explore"` for codebase exploration)
- "Invoke a skill" → OpenCode's native `skill` tool
- "Read a file" → `read`
- "Create / edit / delete a file" → `apply_patch`
- "Run a shell command" → `bash`
- "Search file contents" / "find files by name" → `grep`, `glob`
- "Fetch a URL" → `webfetch`

## Beta caveat

The OpenCode 2 plugin API is beta; its draft and hook object shapes may change
before the stable release. The plugin calls each v2 primitive defensively and
logs (rather than throws) if a call fails, so an API drift degrades to "skills
discovered by OpenCode's co-located convention, bootstrap not injected" instead
of crashing the host. If the bootstrap stops injecting after an `opencode2`
update, that is the signal the request-hook or skill-source contract changed.

## Troubleshooting

### Plugin not loading

1. Confirm you used the `plugins` key, not `plugin`.
2. Check logs: `opencode2 run --print-logs "hello" 2>&1 | grep -i superpowers`
3. List active plugins: `opencode2 plugin list`

### Skills not found

1. Use OpenCode's `skill` tool to list discovered skills.
2. Confirm the plugin loaded (above).
3. Each skill needs a `SKILL.md` with valid YAML frontmatter and a
   `description`; skills without a description are not advertised to the model.

### Bootstrap not appearing

1. Confirm the plugin loaded and no `[superpowers]` error is in the logs.
2. Ask the model to describe its superpowers; if it knows it has them, the
   bootstrap injected.

## Getting help

- Report issues: https://github.com/obra/superpowers/issues
- OpenCode 2 docs: https://opencode.ai/v2/docs
- OpenCode 1 guide: [README.opencode.md](README.opencode.md)
