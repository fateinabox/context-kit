/**
 * tool-thin-schema.ts
 *
 * Optional override of the built-in tool SCHEMA descriptions (the `tools[]` the
 * API validates against) with short "facilitator" descriptions, for testing.
 *
 * HOW IT WORKS
 *   The harness sends two things to the model:
 *     1. The systemprompt "Available tools" section — already thin (one
 *        `promptSnippet` per tool). Not the problem.
 *     2. The tool JSON schema (`tools[]`) — the verbose `description` field
 *        (e.g. "Read the contents of a file..."). THIS is what we override.
 *
 *   registerTool() with the same name SHADOWS the builtin in the registry.
 *   To avoid breaking execution, we rebuild the real tool via the harness's
 *   exported factories (createReadTool/createBashTool/createEditTool) and reuse
 *   their `execute`, overriding only the `description`.
 *
 * TOGGLE
 *   Enable by setting the env var PI_THIN_TOOL_SCHEMA=1 (or "true").
 *   Without it, this extension does nothing — safe to always load.
 *
 * RISK
 *   Shorter schema descriptions may cause the model to build less-valid calls
 *   (e.g. forgetting offset/limit on read). Test it; if tool-calling degrades,
 *   unset PI_THIN_TOOL_SCHEMA and restart.
 */

import { promises as fs } from "fs";
import path from "path";

const STATE_PATH = path.join(__dirname, "..", "state.json");

// Read the toggle from the shared state file (set by /ctx-tools).
async function isEnabled(): Promise<boolean> {
  try {
    const raw = await fs.readFile(STATE_PATH, "utf-8");
    const state = JSON.parse(raw);
    return state.thinTools === true;
  } catch {
    return false; // default off
  }
}

// Short facilitator descriptions. Keep them functional: name the tool and the
// key params so the model still builds valid calls.
const THIN_DESCRIPTIONS: Record<string, string> = {
  read: "Read a file's text or image. path (required); optional offset (start line) and limit (max lines) for large files.",
  bash: "Run a shell command in the cwd. command (required); optional timeout (seconds). Output is truncated to the last 2000 lines / 50KB.",
  edit: "Edit a file with exact text replacement. path (required) + edits[] of {oldText, newText} pairs; each oldText must be unique.",
  write: "Write content to a file, creating it or overwriting. path (required) + content (required). Creates parent dirs.",
};

// Top-level import — the harness exposes this as a virtual module to extensions
// (see loader.js VIRTUAL_MODULES). Matches how all other extensions import.
import {
  createReadTool,
  createBashTool,
  createEditTool,
  createWriteTool,
} from "@earendil-works/pi-coding-agent";

const factories: Record<string, (cwd: string, opts?: any) => any> = {
  read: createReadTool,
  bash: createBashTool,
  edit: createEditTool,
  write: createWriteTool,
};

export default function(pi: any) {
  pi.on("session_start", async (_event: any, ctx: any) => {
    const enabled = await isEnabled();
    if (!enabled) return; // toggle off — do nothing

    const cwd: string = ctx?.cwd ?? process.cwd();
    try {
      for (const [name, description] of Object.entries(THIN_DESCRIPTIONS)) {
        const factory = factories[name];
        if (typeof factory !== "function") continue; // not exported — skip
        const real = factory(cwd);
        if (!real || typeof real.execute !== "function") continue;

        // Reuse the real execute + parameters; override only the description.
        pi.registerTool({
          name,
          label: name,
          description,
          promptSnippet: `${name} — ${description}`,
          parameters: real.parameters,
          execute: real.execute,
        });
      }
    } catch (err) {
      console.error("[tool-thin-schema] failed to override tool schemas:", err);
    }
  });
}
