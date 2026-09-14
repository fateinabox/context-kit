# context-kit

Thin context-injection plugin for the [pi](https://github.com/earendil-works/pi) coding agent.
Reduces system-prompt bloat by replacing verbose tool schemas and skill files with compact
indices, and adds llama.cpp context monitoring with KV cache management.

## Extensions

| Extension | Purpose | Default |
|-----------|---------|---------|
| `skill-manifest` | Injects a one-line-per-skill index into the system prompt | **on** |
| `tool-thin-schema` | Replaces verbose tool descriptions with short one-liners | **off** |
| `context-steering` | Monitors llama.cpp context; warns at ≥70%, auto-flushes KV cache on handoff | **on** |
| `commands` | Exposes `/ctx-*` commands for runtime control | **on** |

## Commands

| Command | Action |
|---------|--------|
| `/ctx-status` | Show current llama.cpp context usage with a progress bar |
| `/ctx-flush` | Erase the KV cache slot (resets context memory) |
| `/ctx-save [name]` | Save KV cache to a snapshot file (defaults to timestamp) |
| `/ctx-swap [name]` | Save KV cache to a snapshot, then flush (save + flush in one shot) |
| `/ctx-restore [name]` | Restore KV cache from a snapshot (defaults to most recent) |
| `/ctx-snapshots` | List available snapshots with size and age |
| `/ctx-threshold [on\|off\|pct]` | Set the context warning threshold (default 70%) |
| `/ctx-session-end [N\|off]` | Keep N most recent snapshots on session end (default: 1) |
| `/ctx-tools [on\|off]` | Toggle thin tool schemas |
| `/ctx-skills [on\|off]` | Toggle skill manifest injection |

Toggles persist in `state.json` (local, gitignored) and take effect on the next session.

## Install

```bash
pi install git:github.com/<you>/context-kit
```

Or from a local path:

```bash
pi install ./context-kit
```

## Uninstall

```bash
pi uninstall context-kit
```

## Configuration

All configuration is via environment variables and the `/ctx-*` commands. No config file required.

| Variable | Default | Purpose |
|----------|---------|---------|
| `PI_AGENT_DIR` | `~/.pi/agent` | Base directory for skills and manifest |
| `LLAMA_HOST` | `http://localhost:8080` | llama.cpp router address |
| `PI_MODEL` | `Qwen3.8-27B-Coder` | Fallback model name (auto-detects loaded model) |

## How It Works

### skill-manifest

- Scans `~/.pi/agent/skills/*/SKILL.md` at session start.
- Reads YAML `description:` / `trigger:` fields (not body-scrape).
- Stamps `disable-model-invocation: true` into any SKILL.md missing it.
- Writes `~/.pi/agent/skills_manifest.md`.
- Injects the manifest into the system prompt via `before_agent_start`.
- Full skill content is **not** in the prompt — the agent `read()`s it on demand.

### tool-thin-schema

- Shadows the built-in `read`, `bash`, `edit`, `write` tools with the same `execute`
  and `parameters` but a shorter `description`.
- Execution is unchanged; only the model-facing description is shorter.
- **Risk:** shorter descriptions may cause the model to forget edge-case params.
  If tool-calling degrades, run `/ctx-tools off` and restart.

### context-steering

- On each turn, queries the llama.cpp router for the loaded model's `n_tokens_max`.
- If usage ≥ 70%, injects a high-water-mark warning into the system prompt instructing
  the agent to complete its current acorn or invoke the `handoff` skill.
- On `turn_end`, if the last assistant message contains `[READY_FOR_KV_FLUSH]`,
  flushes the KV cache slot and notifies the user.

## Bundled Skills

| Skill | Purpose |
|-------|---------|
| `handoff` | Generate a session summary document for handoff to the next agent |
| `pass-the-ball` | Load a handoff file, flush KV cache, and hydrate the new session |

These skills are installed alongside the plugin and referenced by `context-steering`'s
high-water-mark warning. They work with the `/ctx-*` commands:

- **handoff** writes a Markdown summary (no code, pure prompt skill).
- **pass-the-ball** reads the handoff file, runs `/ctx-flush`, and hydrates context.
  Optionally runs `/ctx-save` before flushing for rollback via `/ctx-restore`.

## Files

```
context-kit/
  package.json              # pi manifest (pi.extensions)
  .gitignore
  extensions/
    skill-manifest.ts       # skill-stubs manifest injection
    tool-thin-schema.ts     # thin tool-schema override
    context-steering.ts     # llama.cpp context monitoring + KV flush
    commands.ts             # /ctx-* commands
  skills/
    handoff/SKILL.md        # session handoff document generator
    pass-the-ball/SKILL.md  # handoff ingestion + KV flush + hydration
  state.json                # runtime toggles (gitignored)
```

## Peer Dependencies

- `@earendil-works/pi-coding-agent` (provided by the Pi harness as a virtual module)

## License

MIT
