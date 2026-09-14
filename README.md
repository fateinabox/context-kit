# context-kit

Thin context-injection extensions for the pi coding agent. Two independent
extensions, both safe to always load:

## `skill-manifest`

Generates a one-line-per-skill manifest from `~/.pi/agent/skills/*/SKILL.md`
and injects it into the systemprompt at session start.

- Reads the real YAML `description:` / `trigger:` fields (not body-scrape).
- Stamps `disable-model-invocation: true` into any SKILL.md missing it.
- Writes `~/.pi/agent/skills_manifest.md`.
- Injects the manifest via `ctx.injectContext({ role: "system", ephemeral: true })`.

No toggle — always active. To disable, remove the file from `pi.extensions`.

## `tool-thin-schema`

**Optional.** Overrides the built-in tool *schema* descriptions (`read`,
`bash`, `edit`, `write`) with short "facilitator" one-liners, for testing.

- **Toggle:** set `PI_THIN_TOOL_SCHEMA=1` (or `true`) to enable. Off by default.
- Rebuilds each tool via the harness's exported factories
  (`createReadTool` / `createBashTool` / `createEditTool` / `createWriteTool`)
  and reuses the real `execute` + `parameters`, overriding only `description`.
  Execution is unchanged; only the model-facing description is shorter.
- **Risk:** shorter schema descriptions may cause the model to build less-valid
  calls (e.g. forgetting `offset`/`limit` on `read`). If tool-calling degrades,
  unset `PI_THIN_TOOL_SCHEMA` and restart.

## Install

The package is installed by the pi package manager. The `pi.extensions` field
in `package.json` declares the entry points; the harness loads them.

```
# from a local path
pi install <path-to-this-package>

# or, if published to a registry / git
pi install npm:<name>
pi install git:<url>
```

## Uninstall

```
pi uninstall <name>
```

## Files

```
context-kit/
  package.json              # pi manifest (pi.extensions)
  extensions/
    skill-manifest.ts       # skill-stubs manifest injection
    tool-thin-schema.ts     # optional thin tool-schema override (PI_THIN_TOOL_SCHEMA)
```
