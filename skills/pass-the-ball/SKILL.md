---
name: pass-the-ball
description: Takes a Markdown handoff document file, flushes the llama.cpp KV cache, and hydrates the active session context with the file content.
disable-model-invocation: true
hint: Provide the path to the Markdown handoff file (e.g. HANDOFF.md or docs/handoff/2025-09-14-feature-x.md).
---

# Pass-The-Ball Skill

Use this skill when receiving a Markdown handoff file from a previous session, resuming work after a high-water mark context trigger, or transitioning between agent roles.

## Behavior

1. **Resolve the handoff file**: If a path is provided, use it. If not, search for candidate files (`HANDOFF.md`, `handoff.md`, `docs/handoff/*.md`) and ask the user which to use.
2. **Save a snapshot** (optional): If the user wants to preserve current context before loading the handoff, run `/ctx-save pre-handoff` first.
3. **Flush the KV cache**: Run `/ctx-flush` to clear the current session's context memory.
4. **Hydrate**: Read the handoff file content into context.
5. **Continue**: Review the target, summary, and suggested skills from the document. Begin work on the specified target immediately.

## Usage

1. Ask the user for the handoff file path (or auto-discover).
2. Run `/ctx-flush` to clear the KV cache.
3. `read()` the handoff file.
4. Summarize the target and begin work.

## Fallback: Snapshot Restore

If the flush was premature or the handoff is wrong, restore the previous context:

1. Run `/ctx-snapshots` to list available snapshots.
2. Run `/ctx-restore pre-handoff` (or the appropriate snapshot name).
