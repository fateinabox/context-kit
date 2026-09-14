/**
 * commands.ts — /ctx-* commands for the context-kit plugin.
 *
 * Commands:
 *   /ctx-status   Show current llama.cpp context usage.
 *   /ctx-flush    Flush the llama.cpp KV cache slot.
 *   /ctx-tools    Toggle thin tool schemas on/off.
 *   /ctx-skills   Toggle skill manifest injection on/off.
 */

import { promises as fs } from "fs";
import path from "path";

const LLAMA_HOST = process.env.LLAMA_HOST || "http://localhost:8080";
const DEFAULT_MODEL = process.env.PI_MODEL || "Qwen3.8-27B-Coder";
const STATE_PATH = path.join(__dirname, "..", "state.json");

interface KitState {
  thinTools: boolean;
  thinSkills: boolean;
}

function loadState(): KitState {
  try {
    const raw = fs.readFileSync(STATE_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return { thinTools: false, thinSkills: true };
  }
}

async function saveState(state: KitState) {
  try {
    await fs.writeFile(STATE_PATH, JSON.stringify(state, null, 2), "utf-8");
  } catch (err) {
    console.error("[context-kit] failed to save state:", err);
  }
}

// Expose state to sibling extensions via a shared module-level cache.
// (Extensions in the same plugin share the process; this is sufficient.)
export const getState = loadState;

async function fetchLlamaMetrics(): Promise<{ n_ctx: number; n_tokens_max: number; usagePct: number; model: string } | null> {
  try {
    // Find the loaded model (not necessarily PI_MODEL).
    const modelsRes = await fetch(`${LLAMA_HOST}/v1/models`);
    const modelsData = await modelsRes.json();

    let loadedModel = DEFAULT_MODEL;
    let n_ctx = 128000;

    if (modelsData?.data) {
      const loaded = modelsData.data.find((m: any) => m.status?.value === "loaded");
      if (loaded) {
        loadedModel = loaded.id;
      }
      const target = modelsData.data.find(
        (m: any) => m.id === loadedModel || (m.id === DEFAULT_MODEL && modelsData.data.length === 1)
      );
      if (target?.meta?.n_ctx) {
        n_ctx = target.meta.n_ctx;
      }
    }

    // Query metrics for the actually-loaded model.
    const metricsRes = await fetch(`${LLAMA_HOST}/metrics?model=${encodeURIComponent(loadedModel)}&autoload=false`);
    const metricsText = await metricsRes.text();

    let n_tokens_max = 0;
    for (const line of metricsText.split("\n")) {
      if (line.startsWith("llamacpp:n_tokens_max")) {
        const parts = line.split(/\s+/);
        n_tokens_max = parseInt(parts[1], 10) || 0;
        break;
      }
    }

    return { n_ctx, n_tokens_max, usagePct: (n_tokens_max / n_ctx) * 100, model: loadedModel };
  } catch {
    return null;
  }
}

export default function commandsExtension(pi: any) {
  // ─── /ctx-status ───────────────────────────────────────────────────────────
  pi.registerCommand("ctx-status", {
    description: "Show current llama.cpp context usage (n_tokens_max / n_ctx).",
    handler: async (_args: string, ctx: any) => {
      const metrics = await fetchLlamaMetrics();
      if (!metrics) {
        ctx.ui?.notify("Could not reach llama.cpp at " + LLAMA_HOST, "error");
        return;
      }
      const { n_ctx, n_tokens_max, usagePct, model } = metrics;
      const bar = "█".repeat(Math.round(usagePct / 5)) + "░".repeat(20 - Math.round(usagePct / 5));
      ctx.ui?.notify(
        `${model}: ${n_tokens_max.toLocaleString()} / ${n_ctx.toLocaleString()} tokens (${usagePct.toFixed(1)}%)\n[${bar}]`,
        "info"
      );
    },
  });

  // ─── /ctx-flush ────────────────────────────────────────────────────────────
  pi.registerCommand("ctx-flush", {
    description: "Flush the llama.cpp KV cache slot (resets context memory).",
    handler: async (_args: string, ctx: any) => {
      try {
        await fetch(`${LLAMA_HOST}/slots/0?model=${DEFAULT_MODEL}&action=erase`, { method: "POST" });
        ctx.ui?.notify("KV cache flushed. Slot 0 memory reset.", "info");
      } catch (err) {
        ctx.ui?.notify("Failed to flush KV cache: " + String(err), "error");
      }
    },
  });

  // ─── /ctx-tools ────────────────────────────────────────────────────────────
  pi.registerCommand("ctx-tools", {
    description: "Toggle thin tool schemas on/off.",
    handler: async (args: string, ctx: any) => {
      const state = loadState();
      const arg = args.trim().toLowerCase();

      if (arg === "on") state.thinTools = true;
      else if (arg === "off") state.thinTools = false;
      else state.thinTools = !state.thinTools; // toggle

      await saveState(state);
      ctx.ui?.notify(
        `Thin tool schemas: ${state.thinTools ? "ON" : "OFF"} (takes effect next session)`,
        "info"
      );
    },
  });

  // ─── /ctx-skills ───────────────────────────────────────────────────────────
  pi.registerCommand("ctx-skills", {
    description: "Toggle skill manifest injection on/off.",
    handler: async (args: string, ctx: any) => {
      const state = loadState();
      const arg = args.trim().toLowerCase();

      if (arg === "on") state.thinSkills = true;
      else if (arg === "off") state.thinSkills = false;
      else state.thinSkills = !state.thinSkills; // toggle

      await saveState(state);
      ctx.ui?.notify(
        `Skill manifest injection: ${state.thinSkills ? "ON" : "OFF"} (takes effect next session)`,
        "info"
      );
    },
  });
}
