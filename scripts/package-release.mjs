#!/usr/bin/env node
/**
 * Builds a clean unpacked Chrome extension release directory for v1.0.0-rc.1
 * excluding development, test, git, Python venv, and documentation files.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
const versionLabel = manifest.version_name || manifest.version || "1.0.0-rc.1";
const outDir = path.join(ROOT, "dist", `digital-minds-rank-tracker-v${versionLabel}`);

const INCLUDE_DIRS = [
  "background",
  "content",
  "dashboard",
  "icons",
  "modules",
  "popup",
  "utils",
];
const INCLUDE_FILES = ["manifest.json"];

function copyRecursive(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      if (entry === ".gitkeep") continue;
      copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

for (const file of INCLUDE_FILES) {
  copyRecursive(path.join(ROOT, file), path.join(outDir, file));
}
for (const dir of INCLUDE_DIRS) {
  copyRecursive(path.join(ROOT, dir), path.join(outDir, dir));
}

console.log(`Release package created at: ${outDir}`);

