/**
 * commands.ts — /ctx-* commands for the context-kit plugin.
 *
 * Commands:
 *   /ctx-status       Show current llama.cpp context usage.
 *   /ctx-flush        Flush the llama.cpp KV cache slot.
 *   /ctx-save [name]  Save KV cache to a snapshot file (default: timestamp).
 *   /ctx-restore [name] Restore KV cache from a snapshot (default: most recent).
 *   /ctx-snapshots    List available snapshots.
 *   /ctx-tools        Toggle thin tool schemas on/off.
 *   /ctx-skills       Toggle skill manifest injection on/off.
 */

import { promises as fs } from "fs";
import path from "path";

const LLAMA_HOST = process.env.LLAMA_HOST || "http://localhost:8080";
const DEFAULT_MODEL = process.env.PI_MODEL || "Qwen3.8-27B-Coder";
const STATE_PATH = path.join(__dirname, "..", "state.json");

interface KitState {
  thinTools: boolean;
  thinSkills: boolean;
  threshold: number;
  sessionEndKeep: number; // 0 = off, N = keep N most recent snapshots
}

function loadState(): KitState {
  try {
    const raw = fs.readFileSync(STATE_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    return {
      thinTools: parsed.thinTools ?? false,
      thinSkills: parsed.thinSkills ?? true,
      threshold: parsed.threshold ?? 70,
      sessionEndKeep: parsed.sessionEndKeep ?? 1,
    };
  } catch {
    return { thinTools: false, thinSkills: true, threshold: 70, sessionEndKeep: 1 };
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

const SNAPSHOT_DIR = process.env.LLAMA_SLOT_SAVE_PATH || "/opt/models/kvcache";

interface Snapshot {
  filename: string;
  size: number;
  mtime: number;
}

async function listSnapshots(): Promise<Snapshot[]> {
  try {
    const files = await fs.readdir(SNAPSHOT_DIR);
    const snaps: Snapshot[] = [];
    for (const f of files) {
      if (!f.endsWith(".bin")) continue;
      const stat = await fs.stat(path.join(SNAPSHOT_DIR, f));
      snaps.push({ filename: f, size: stat.size, mtime: stat.mtimeMs });
    }
    snaps.sort((a, b) => b.mtime - a.mtime);
    return snaps;
  } catch {
    return [];
  }
}

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
        // Find the loaded model (not necessarily PI_MODEL).
        const modelsRes = await fetch(`${LLAMA_HOST}/v1/models`);
        const modelsData = await modelsRes.json();
        const loaded = modelsData?.data?.find((m: any) => m.status?.value === "loaded");
        const model = loaded?.id || DEFAULT_MODEL;

        const res = await fetch(`${LLAMA_HOST}/slots/0?action=erase`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model }),
        });
        const data = await res.json();
        if (!res.ok) {
          ctx.ui?.notify(`Failed to flush KV cache: ${data?.error?.message || res.statusText}`, "error");
          return;
        }
        ctx.ui?.notify(`KV cache flushed. ${data.n_erased} tokens erased from slot ${data.id_slot}.`, "info");
      } catch (err) {
        ctx.ui?.notify("Failed to flush KV cache: " + String(err), "error");
      }
    },
  });

  // ─── /ctx-swap ────────────────────────────────────────────────────────────
  pi.registerCommand("ctx-swap", {
    description: "Save KV cache to a snapshot, then flush. Usage: /ctx-swap [name]",
    handler: async (args: string, ctx: any) => {
      try {
        const modelsRes = await fetch(`${LLAMA_HOST}/v1/models`);
        const modelsData = await modelsRes.json();
        const loaded = modelsData?.data?.find((m: any) => m.status?.value === "loaded");
        const model = loaded?.id || DEFAULT_MODEL;

        const name = args.trim() || new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        const filename = name.endsWith(".bin") ? name : `${name}.bin`;

        // Save
        const saveRes = await fetch(`${LLAMA_HOST}/slots/0?action=save`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model, filename }),
        });
        const saveData = await saveRes.json();
        if (!saveRes.ok) {
          ctx.ui?.notify(`Failed to save snapshot: ${saveData?.error?.message || saveRes.statusText}`, "error");
          return;
        }

        // Flush
        const flushRes = await fetch(`${LLAMA_HOST}/slots/0?action=erase`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model }),
        });
        const flushData = await flushRes.json();
        if (!flushRes.ok) {
          ctx.ui?.notify(`Saved but failed to flush: ${flushData?.error?.message || flushRes.statusText}`, "error");
          return;
        }

        ctx.ui?.notify(
          `Swapped: saved ${saveData.n_saved} tokens to ${saveData.filename}, then flushed ${flushData.n_erased} tokens.\nRollback: /ctx-restore ${name}`,
          "info"
        );
      } catch (err) {
        ctx.ui?.notify("Failed to swap: " + String(err), "error");
      }
    },
  });

  // ─── /ctx-save ────────────────────────────────────────────────────────────
  pi.registerCommand("ctx-save", {
    description: "Save the llama.cpp KV cache to a snapshot. Usage: /ctx-save [name]",
    handler: async (args: string, ctx: any) => {
      try {
        const modelsRes = await fetch(`${LLAMA_HOST}/v1/models`);
        const modelsData = await modelsRes.json();
        const loaded = modelsData?.data?.find((m: any) => m.status?.value === "loaded");
        const model = loaded?.id || DEFAULT_MODEL;

        const name = args.trim() || new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        const filename = name.endsWith(".bin") ? name : `${name}.bin`;

        const res = await fetch(`${LLAMA_HOST}/slots/0?action=save`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model, filename }),
        });
        const data = await res.json();
        if (!res.ok) {
          ctx.ui?.notify(`Failed to save snapshot: ${data?.error?.message || res.statusText}`, "error");
          return;
        }
        ctx.ui?.notify(`Snapshot saved: ${data.filename} (${data.n_saved} tokens, ${(data.n_written / 1024 / 1024).toFixed(1)} MB)`, "info");
      } catch (err) {
        ctx.ui?.notify("Failed to save snapshot: " + String(err), "error");
      }
    },
  });

  // ─── /ctx-restore ─────────────────────────────────────────────────────────
  pi.registerCommand("ctx-restore", {
    description: "Restore the llama.cpp KV cache from a snapshot. Usage: /ctx-restore [name]",
    handler: async (args: string, ctx: any) => {
      try {
        const modelsRes = await fetch(`${LLAMA_HOST}/v1/models`);
        const modelsData = await modelsRes.json();
        const loaded = modelsData?.data?.find((m: any) => m.status?.value === "loaded");
        const model = loaded?.id || DEFAULT_MODEL;

        // If no name given, find the most recent snapshot.
        let filename: string;
        if (args.trim()) {
          filename = args.trim().endsWith(".bin") ? args.trim() : `${args.trim()}.bin`;
        } else {
          // List snapshots and pick the most recent.
          const snaps = await listSnapshots();
          if (snaps.length === 0) {
            ctx.ui?.notify("No snapshots available.", "error");
            return;
          }
          filename = snaps[0].filename; // most recent
        }

        const res = await fetch(`${LLAMA_HOST}/slots/0?action=restore`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model, filename }),
        });
        const data = await res.json();
        if (!res.ok) {
          ctx.ui?.notify(`Failed to restore snapshot: ${data?.error?.message || res.statusText}`, "error");
          return;
        }
        ctx.ui?.notify(`Snapshot restored: ${data.filename} (${data.n_restored} tokens)`, "info");
      } catch (err) {
        ctx.ui?.notify("Failed to restore snapshot: " + String(err), "error");
      }
    },
  });

  // ─── /ctx-snapshots ───────────────────────────────────────────────────────
  pi.registerCommand("ctx-snapshots", {
    description: "List available KV cache snapshots.",
    handler: async (_args: string, ctx: any) => {
      try {
        const snaps = await listSnapshots();
        if (snaps.length === 0) {
          ctx.ui?.notify("No snapshots available.", "info");
          return;
        }
        const lines = snaps.map((s, i) => {
          const size = (s.size / 1024 / 1024).toFixed(1);
          const age = Date.now() - s.mtime;
          const ageStr = age < 60000 ? "just now" : age < 3600000 ? `${Math.round(age / 60000)}m ago` : `${Math.round(age / 3600000)}h ago`;
          return `${i === 0 ? "▶" : "·"} ${s.filename}  ${size} MB  ${ageStr}`;
        });
        ctx.ui?.notify(`Snapshots (most recent first):\n${lines.join("\n")}`, "info");
      } catch (err) {
        ctx.ui?.notify("Failed to list snapshots: " + String(err), "error");
      }
    },
  });

  // ─── /ctx-threshold ───────────────────────────────────────────────────────
  pi.registerCommand("ctx-threshold", {
    description: "Set the context-steering warning threshold. Usage: /ctx-threshold [on|off|pct]",
    handler: async (args: string, ctx: any) => {
      const state = loadState();
      const arg = args.trim().toLowerCase();

      if (arg === "on") {
        state.threshold = 70; // default
      } else if (arg === "off") {
        state.threshold = 0; // disabled
      } else if (arg === "") {
        // Show current value
        ctx.ui?.notify(
          `Context threshold: ${state.threshold === 0 ? "DISABLED" : state.threshold + "%"} (takes effect next session)\nUsage: /ctx-threshold <pct> to set, /ctx-threshold off to disable, /ctx-threshold on for default (70%)`,
          "info"
        );
        return;
      } else {
        const pct = parseInt(arg, 10);
        if (isNaN(pct) || pct < 0 || pct > 100) {
          ctx.ui?.notify(`Invalid threshold: ${arg}. Use a number 0-100, "on", or "off".`, "error");
          return;
        }
        state.threshold = pct;
      }

      await saveState(state);
      const label = state.threshold === 0 ? "DISABLED" : state.threshold + "%";
      ctx.ui?.notify(`Context threshold: ${label} (takes effect next session)`, "info");
    },
  });

  // ─── /ctx-session-end ─────────────────────────────────────────────────────
  pi.registerCommand("ctx-session-end", {
    description: "Set how many snapshots to keep on session end. Usage: /ctx-session-end [N|off]",
    handler: async (args: string, ctx: any) => {
      const state = loadState();
      const arg = args.trim().toLowerCase();

      if (arg === "disable") {
        state.sessionEndKeep = -1; // disabled
      } else if (arg === "") {
        // Show current value
        const label = state.sessionEndKeep === -1 ? "DISABLED" : `keep ${state.sessionEndKeep}`;
        ctx.ui?.notify(`Session-end cleanup: ${label} (takes effect next session)\nUsage: /ctx-session-end <N> to keep N snapshots, /ctx-session-end disable to turn off`, "info");
        return;
      } else {
        const n = parseInt(arg, 10);
        if (isNaN(n) || n < 0) {
          ctx.ui?.notify(`Invalid: ${arg}. Use a non-negative number or "disable".`, "error");
          return;
        }
        state.sessionEndKeep = n;
      }

      await saveState(state);
      const label = state.sessionEndKeep === -1 ? "DISABLED" : `keep ${state.sessionEndKeep}`;
      ctx.ui?.notify(`Session-end cleanup: ${label} (takes effect next session)`, "info");
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

  // ─── Session-end snapshot cleanup ─────────────────────────────────────────
  pi.on("session_end", async (_event: any, ctx: any) => {
    try {
      const state = loadState();
      if (state.sessionEndKeep === -1) return; // disabled

      const snaps = await listSnapshots();
      if (snaps.length === 0) return; // no snapshots, nothing to do
      if (snaps.length <= state.sessionEndKeep) return; // nothing to prune

      const toDelete = snaps.slice(state.sessionEndKeep);
      let deleted = 0;
      for (const snap of toDelete) {
        try {
          await fs.unlink(path.join(SNAPSHOT_DIR, snap.filename));
          deleted++;
        } catch {
          // File already gone or permission issue — skip
        }
      }

      if (deleted > 0) {
        ctx.ui?.notify(
          `Session cleanup: deleted ${deleted} old snapshot(s), kept ${state.sessionEndKeep}.`,
          "info"
        );
      }
    } catch (err) {
      // Snapshot dir may not exist locally (remote llama server).
      // Fail gracefully — cleanup is best-effort.
      if (ctx.ui) {
        ctx.ui.notify(
          `Session cleanup skipped: could not access snapshot directory (${SNAPSHOT_DIR}). ` +
          `The llama server may be remote.`,
          "warning"
        );
      }
    }
  });
}
