import { promises as fs } from "fs";
import path from "path";

const AGENT_DIR = process.env.PI_AGENT_DIR || path.join(process.env.HOME || "/home/richard", ".pi", "agent");
const SKILLS_DIR = path.join(AGENT_DIR, "skills");
const MANIFEST_PATH = path.join(AGENT_DIR, "skills_manifest.md");
const STATE_PATH = path.join(__dirname, "..", "state.json");

interface Skill {
  name: string;
  usage: string;
  path: string;
}

// Split a SKILL.md into { frontmatter, body } using a bounded frontmatter block
// (leading --- ... first closing ---) instead of a global split that breaks on
// "---" appearing in the body (horizontal rules, prose dashes, etc.).
function splitFrontmatter(content: string): { frontmatter: string; body: string } {
  if (!content.startsWith("---")) return { frontmatter: "", body: content };
  const closeIdx = content.indexOf("\n---", 3);
  if (closeIdx === -1) return { frontmatter: "", body: content };
  const frontmatter = content.slice(3, closeIdx).trim();
  const body = content.slice(closeIdx + 4);
  return { frontmatter, body };
}

// Read a scalar value from a YAML frontmatter block. Handles single-quoted,
// double-quoted, and plain values; skips nested/indented keys.
function readFrontmatterField(fm: string, key: string): string {
  const re = new RegExp(`^${key}:\\s*(.+)$`, "m");
  const m = fm.match(re);
  if (!m) return "";
  let v = m[1].trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  return v;
}

// Collect a YAML list that is either inline ([a, b]) or block-dash indented
// under `key:`. Returns trimmed, non-empty items.
function readFrontmatterList(fm: string, key: string): string[] {
  const lines = fm.split("\n");
  const out: string[] = [];
  let inBlock = false;
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!inBlock) {
      const m = line.match(new RegExp(`^${key}:\\s*(.*)$`));
      if (!m) continue;
      const rest = m[1].trim();
      if (rest.startsWith("[")) {
        // inline list: [a, b, c]
        out.push(...rest.replace(/^\[/, "").replace(/\]$/, "").split(",").map((s) => s.trim()).filter(Boolean));
        inBlock = false;
        continue;
      }
      if (rest === "") {
        inBlock = true; // block list starts on following indented lines
        continue;
      }
      // scalar value on the same line
      out.push(rest);
      inBlock = false;
    } else {
      if (/^\s+-\s+/.test(line)) {
        out.push(line.replace(/^\s+-\s+/, "").trim());
      } else if (/^\s+/.test(line)) {
        // continuation of the last item (indented, not a new dash) — append
        if (out.length > 0) out[out.length - 1] += " " + line.trim();
      } else {
        break; // dedent ends the block list
      }
    }
  }
  return out;
}

async function generateManifest(): Promise<Skill[]> {
  const entries = await fs.readdir(SKILLS_DIR, { withFileTypes: true });
  const skills: Skill[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillMdPath = path.join(SKILLS_DIR, entry.name, "SKILL.md");
    let content: string;
    try {
      content = await fs.readFile(skillMdPath, "utf-8");
    } catch {
      continue; // no SKILL.md — skip
    }

    // 1. Ensure `disable-model-invocation: true` is present in the frontmatter.
    const { frontmatter, body } = splitFrontmatter(content);
    if (frontmatter && !frontmatter.includes("disable-model-invocation")) {
      const patchedFm = frontmatter.trimEnd() + "\ndisable-model-invocation: true\n";
      const patched = `---\n${patchedFm}---\n${body}`;
      await fs.writeFile(skillMdPath, patched, "utf-8");
    }

    // 2. Triggers + description from the REAL frontmatter (not body-scrape).
    const triggers = readFrontmatterList(frontmatter, "trigger");
    const description = readFrontmatterField(frontmatter, "description");

    const usage =
      triggers.length > 0
        ? `Triggers: ${triggers.slice(0, 5).join(", ")}${triggers.length > 5 ? "..." : ""}`
        : description || "No description provided.";

    skills.push({ name: entry.name, usage, path: skillMdPath });
  }

  skills.sort((a, b) => a.name.localeCompare(b.name));
  return skills;
}

// Read the toggle from the shared state file.
async function skillsEnabled(): Promise<boolean> {
  try {
    const raw = await fs.readFile(STATE_PATH, "utf-8");
    const state = JSON.parse(raw);
    return state.thinSkills !== false; // default on
  } catch {
    return true; // default on
  }
}

export default function(pi: any) {
  // Generate + write the manifest file at session start.
  pi.on("session_start", async (_event: any, _ctx: any) => {
    try {
      const skills = await generateManifest();
      let manifestContent = "# Skill Stubs Manifest\n\n";
      for (const skill of skills) {
        manifestContent += `- **${skill.name}**: <usage>${skill.usage}</usage> -> \`read(${skill.path})\`\n`;
      }
      await fs.writeFile(MANIFEST_PATH, manifestContent, "utf-8");
    } catch (error) {
      console.error("Failed to generate skill stubs manifest:", error);
    }
  });

  // Inject the manifest into the system prompt each turn (respects /ctx-skills toggle).
  pi.on("before_agent_start", async (event: any, _ctx: any) => {
    try {
      if (!(await skillsEnabled())) return undefined;
      const content = await fs.readFile(MANIFEST_PATH, "utf-8");
      return { systemPrompt: `${event.systemPrompt}\n\n${content}` };
    } catch {
      return undefined;
    }
  });
}
