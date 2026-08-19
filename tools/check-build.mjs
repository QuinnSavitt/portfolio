/**
 * Verifies that every asset the built site references actually exists.
 *
 * The build fingerprints filenames and rewrites references to match. When a
 * reference is written in a form the rewriter does not recognise, the file is
 * renamed but the reference is not - the page still builds, deploys and looks
 * fine in a warm browser cache, and 404s for everyone else. This catches that
 * before it ships.
 *
 * Run with `npm run check` (after a build).
 */
import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join, dirname, resolve, extname } from "path";

const ROOT = "theme";

// Standalone apps that manage their own assets and are not fingerprinted.
const SKIP_DIRS = new Set(["games", "proofs"]);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(entry)) walk(full, out);
    } else {
      out.push(full);
    }
  }
  return out;
}

function isExternal(ref) {
  return (
    !ref ||
    ref.startsWith("http:") ||
    ref.startsWith("https:") ||
    ref.startsWith("//") ||
    ref.startsWith("data:") ||
    ref.startsWith("mailto:") ||
    ref.startsWith("tel:") ||
    ref.startsWith("#") ||
    ref.startsWith("javascript:")
  );
}

/** Resolves a reference the way a browser would, relative to the file holding it. */
function resolveRef(fromFile, ref) {
  const clean = ref.split("#")[0].split("?")[0];
  if (!clean) return null;
  // Root-absolute references are relative to the published site root.
  if (clean.startsWith("/")) return resolve(ROOT, "." + clean);
  return resolve(dirname(fromFile), clean);
}

const problems = [];
let checked = 0;

for (const file of walk(ROOT)) {
  const ext = extname(file);
  if (![".html", ".css"].includes(ext)) continue;

  const text = readFileSync(file, "utf8");
  const refs = [];

  if (ext === ".html") {
    for (const m of text.matchAll(/(?:href|src)="([^"]*)"/g)) refs.push(m[1]);
    // srcset carries several "url descriptor" pairs per attribute.
    for (const m of text.matchAll(/srcset="([^"]*)"/g)) {
      for (const candidate of m[1].split(",")) {
        const url = candidate.trim().split(/\s+/)[0];
        if (url) refs.push(url);
      }
    }
  } else {
    for (const m of text.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) refs.push(m[1]);
  }

  for (const ref of refs) {
    if (isExternal(ref)) continue;
    const target = resolveRef(file, ref);
    if (!target) continue;
    checked++;
    if (!existsSync(target)) {
      problems.push(`${file}  ->  ${ref}`);
    }
  }
}

if (problems.length) {
  console.error(`\n  ${problems.length} broken reference(s) of ${checked} checked:\n`);
  for (const p of problems) console.error("    " + p);
  console.error("");
  process.exit(1);
}

console.log(`  build check: ${checked} references resolve, no broken assets`);
