#!/usr/bin/env node
/**
 * install-skills.js — copies bundled skills into ~/.pi/agent/skills/
 * Runs as postinstall so /skill:handoff and /skill:pass-the-ball work immediately.
 */

const fs = require("fs");
const path = require("path");

const AGENT_DIR = process.env.PI_AGENT_DIR || path.join(process.env.HOME || ".", ".pi", "agent");
const SKILLS_DIR = path.join(AGENT_DIR, "skills");
const BUNDLED_DIR = path.join(__dirname, "..", "skills");

async function main() {
  // Ensure the skills directory exists.
  fs.mkdirSync(SKILLS_DIR, { recursive: true });

  const entries = fs.readdirSync(BUNDLED_DIR, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const srcDir = path.join(BUNDLED_DIR, entry.name);
    const destDir = path.join(SKILLS_DIR, entry.name);

    // Skip if already installed and identical (avoid unnecessary writes).
    const srcSkill = path.join(srcDir, "SKILL.md");
    const destSkill = path.join(destDir, "SKILL.md");

    if (fs.existsSync(destSkill)) {
      const srcContent = fs.readFileSync(srcSkill, "utf-8");
      const destContent = fs.readFileSync(destSkill, "utf-8");
      if (srcContent === destContent) continue;
    }

    // Copy the skill directory.
    fs.mkdirSync(destDir, { recursive: true });
    for (const file of fs.readdirSync(srcDir)) {
      const srcFile = path.join(srcDir, file);
      const destFile = path.join(destDir, file);
      fs.copyFileSync(srcFile, destFile);
    }

    console.log(`[context-kit] installed skill: ${entry.name}`);
  }
}

main().catch((err) => {
  console.error("[context-kit] failed to install skills:", err);
  process.exit(1);
});
