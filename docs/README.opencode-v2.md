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

The plugin is a default export from `define({ id, setup })`
(`@opencode-ai/plugin/v2/promise`). `setup(ctx)` runs when the plugin activates
and does two things:

1. **Makes skills discoverable** by symlinking each superpowers skill into
   `<configDir>/skills/<name>` (default `~/.config/opencode/skills/`). This is
   the reliable mechanism: OpenCode 2 only watches a fixed set of skill
   directories, and skill sources registered from a plugin (`ctx.skill.transform`
   with `directory`/`embedded` sources) are not picked up in the current beta.
   Existing real directories or non-superpowers skills of the same name are left
   untouched; symlinks the plugin owns are refreshed to track package updates.
   The plugin still registers `ctx.skill.transform` sources as a
   forward-compatible bonus in case a later beta honors them.
2. **Injects the bootstrap** via `ctx.agent.transform`. The Promise
   `PluginContext` has no per-request/session hook, so the plugin prepends the
   `using-superpowers` content (wrapped in `<EXTREMELY_IMPORTANT>` tags, with the
   tool mapping appended) to every agent's `system` prompt. A dedup guard skips
   agents whose system prompt already contains the bootstrap.

The bootstrap content is read from `skills/using-superpowers/SKILL.md` once and
cached at module level.

> Why symlinks and not `.opencode/skills`: a bundled `.opencode/skills` symlink
> does not survive git-package install (npm pack strips symlinks), and OpenCode
> 2 does not auto-scan a plugin package's own `skills/`. Symlinking into the
> watched config dir at runtime works for both git-install and local checkouts.

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
logs (rather than throws) if a call fails, so an API drift degrades gracefully
instead of crashing the host. Notable behaviors observed against
`@opencode-ai/plugin@1.18.x` (subject to change):

- Skill sources registered from a plugin (`ctx.skill.transform`) are not
  advertised to the model — hence the symlink approach above.
- The Promise `PluginContext` exposes no session/request hook, so the bootstrap
  rides the agent `system` prompt via `ctx.agent.transform`.
- OpenCode 2 runs through a background service that can hold an older plugin
  generation. After changing the plugin or clearing the package cache, use
  `opencode2 run --standalone ...` or restart the service to pick up the change.

## Troubleshooting

### Plugin not loading

1. Confirm you used the `plugins` key, not `plugin`.
2. List active plugins: `opencode2 plugin list` — the `superpowers` row should
   show a version/commit, not an empty id.
3. If it shows empty after an update, clear the cache and reload with
   `opencode2 run --standalone ...` (the background service can hold an older
   plugin generation).

### Skills not found

1. Check that skills were symlinked: `ls -l ~/.config/opencode/skills` should
   list `brainstorming`, `test-driven-development`, etc. pointing at the
   installed package.
2. Look for `[superpowers] failed to link skill ...` in the logs.
3. Use OpenCode's `skill` tool to list discovered skills.
4. Each skill needs a `SKILL.md` with valid YAML frontmatter and a
   `description`; skills without a description are not advertised to the model.

### Bootstrap not appearing

1. Confirm the plugin loaded and no `[superpowers]` error is in the logs.
2. Ask the model to describe its superpowers; if it knows it has them, the
   bootstrap injected.

## Getting help

- Report issues: https://github.com/obra/superpowers/issues
- OpenCode 2 docs: https://opencode.ai/v2/docs
- OpenCode 1 guide: [README.opencode.md](README.opencode.md)
