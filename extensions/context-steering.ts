/**
 * context-steering: monitors llama.cpp context utilization and injects
 * a high-water-mark warning into the system prompt when usage ≥ 70%.
 * Detects [READY_FOR_KV_FLUSH] in the last assistant message and flushes
 * the KV cache slot.
 */

const LLAMA_HOST = process.env.LLAMA_HOST || "http://localhost:8080";
const DEFAULT_MODEL = process.env.PI_MODEL || "Qwen3.8-27B-Coder";

interface LlamaMetrics {
  n_ctx: number;
  n_tokens_max: number;
  usagePct: number;
}

async function fetchLlamaMetrics(host: string): Promise<LlamaMetrics | null> {
  try {
    // Find the loaded model and its n_ctx.
    const modelsRes = await fetch(`${host}/v1/models`);
    const modelsData = await modelsRes.json();
    let n_ctx = 128000;
    let loadedModel = DEFAULT_MODEL;

    if (modelsData?.data) {
      const loaded = modelsData.data.find((m: any) => m.status?.value === "loaded");
      if (loaded) {
        loadedModel = loaded.id;
      }
      const target = modelsData.data.find((m: any) => m.id === loadedModel);
      if (target?.meta?.n_ctx) {
        n_ctx = target.meta.n_ctx;
      }
    }

    // Query metrics for the actually-loaded model.
    const metricsRes = await fetch(`${host}/metrics?model=${encodeURIComponent(loadedModel)}&autoload=false`);
    const metricsText = await metricsRes.text();

    let n_tokens_max = 0;
    for (const line of metricsText.split("\n")) {
      if (line.startsWith("llamacpp:n_tokens_max")) {
        const parts = line.split(/\s+/);
        n_tokens_max = parseInt(parts[1], 10) || 0;
        break;
      }
    }

    const usagePct = (n_tokens_max / n_ctx) * 100;
    return { n_ctx, n_tokens_max, usagePct };
  } catch {
    return null;
  }
}

export default function contextSteeringExtension(pi: any) {
  // Inject high-water-mark warning into the system prompt when context ≥ 70%.
  pi.on("before_agent_start", async (event: any, ctx: any) => {
    try {
      const metrics = await fetchLlamaMetrics(LLAMA_HOST);
      if (!metrics) return undefined;

      const { n_ctx, n_tokens_max, usagePct } = metrics;
      if (usagePct < 70) return undefined;

      const warning = `⚠️ [CONTEXT HIGH-WATER MARK: ${usagePct.toFixed(1)}% (${n_tokens_max.toLocaleString()}/${n_ctx.toLocaleString()} tokens)]
CRITICAL INSTRUCTION: High context utilization detected.
1. CHIPMUNK FLOW CHECK: If you are currently working in a burrow on an acorn that is CLOSE TO FINALIZATION, complete that acorn first before generating the handoff.
2. Otherwise (if not in a burrow, or if the active acorn is NOT near finalization), invoke your \`handoff\` skill immediately.
3. Upon completion of the handoff document, conclude your turn with the exact flag \`[READY_FOR_KV_FLUSH]\` so the engine can safely reset the KV slot cache.`;

      return { systemPrompt: `${event.systemPrompt}\n\n${warning}` };
    } catch {
      return undefined;
    }
  });

  // Detect [READY_FOR_KV_FLUSH] in the last assistant message and flush KV cache.
  pi.on("turn_end", async (event: any, ctx: any) => {
    try {
      const msg = event.message;
      if (!msg || msg.role !== "assistant") return;

      const content =
        typeof msg.content === "string"
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content.map((c: any) => c.text || "").join("")
            : "";

      if (!content.includes("[READY_FOR_KV_FLUSH]")) return;

      await fetch(`${LLAMA_HOST}/slots/0?model=${DEFAULT_MODEL}&action=erase`, {
        method: "POST",
      });

      ctx.ui?.notify(
        "Context limit reached: Completed handoff and flushed llama.cpp KV cache.",
        "warning"
      );
    } catch (err) {
      console.error("Failed to flush KV cache:", err);
    }
  });
}
