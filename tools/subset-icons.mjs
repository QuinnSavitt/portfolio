/**
 * Subsets the Themefisher icon font down to the glyphs the site actually uses.
 *
 * The stock font ships 194KB of TTF/WOFF (plus a 479KB SVG font and a 46KB
 * stylesheet) to deliver ~1500 icons. We use about 30. This script scans the
 * source for `tf-*` class names, resolves each to its codepoint via the
 * original stylesheet, and emits a subset woff2 plus a stylesheet containing
 * only the rules for those icons.
 *
 * Run with `npm run icons`. The output is committed, so the deploy build has
 * no Python dependency.
 */
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from "fs";
import { execFileSync } from "child_process";
import { join, extname } from "path";

const SRC_FONT = "source/plugins/themefisher-fonts/fonts/themefisher-font.ttf";
const SRC_CSS = "source/plugins/themefisher-fonts/css/themefisher-fonts.min.css";
const OUT_DIR = "source/plugins/icons";
const SCAN_ROOT = "source";
const SCAN_EXT = new Set([".html", ".htm", ".js", ".scss", ".css"]);
// Directories whose contents are self-contained and never use the icon font.
const SKIP = new Set(["plugins", "node_modules", "games", "proofs", "images", "fonts"]);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (!SKIP.has(entry)) walk(full, out);
    } else if (SCAN_EXT.has(extname(entry))) {
      out.push(full);
    }
  }
  return out;
}

// 1. Which icon classes does the site reference?
const used = new Set();
for (const file of walk(SCAN_ROOT)) {
  for (const m of readFileSync(file, "utf8").matchAll(/tf-[a-z0-9-]+/g)) used.add(m[0]);
}

// 2. Map each class to its codepoint using the original stylesheet.
const css = readFileSync(SRC_CSS, "utf8");
const codepoints = new Map();
const RULE = /\.(tf-[a-z0-9-]+):before\s*\{\s*content:\s*"\\([0-9a-fA-F]+)"/g;
for (const m of css.matchAll(RULE)) codepoints.set(m[1], m[2].toLowerCase());

const resolved = [];
const missing = [];
for (const cls of [...used].sort()) {
  if (codepoints.has(cls)) resolved.push([cls, codepoints.get(cls)]);
  else missing.push(cls);
}

if (!resolved.length) throw new Error("no icon classes resolved - did the stylesheet format change?");
if (missing.length) {
  // `tf-8` and friends are prefix fragments picked up by the scan, not real
  // icons. Report them so a genuine typo in a class name is still visible.
  console.log(`  note: ${missing.length} scanned name(s) have no glyph: ${missing.join(", ")}`);
}

mkdirSync(OUT_DIR, { recursive: true });

// 3. Subset the TTF to just those codepoints, as woff2.
const unicodes = resolved.map(([, cp]) => "U+" + cp).join(",");
execFileSync("python", [
  "-m", "fontTools.subset", SRC_FONT,
  `--unicodes=${unicodes}`,
  "--flavor=woff2",
  "--layout-features=",
  "--no-hinting",
  "--desubroutinize",
  `--output-file=${join(OUT_DIR, "icons.woff2")}`,
], { stdio: "inherit" });

// 4. Emit a stylesheet with only the rules we need. font-display:swap so a
//    slow font never holds up text rendering.
// The site-root path here is load-bearing. The build fingerprints this woff2
// and rewrites references by literal string match against manifest keys, which
// look like `plugins/icons/icons.woff2`. A same-directory `icons.woff2` never
// matches that key, so it would survive unrewritten and 404 every icon on the
// site. Spelling the full path keeps the reference in sync with the hash.
const face = [
  "@font-face{font-family:themefisher-font;src:url(/plugins/icons/icons.woff2) format(\"woff2\");",
  "font-weight:normal;font-style:normal;font-display:swap}",
].join("");
const base = [
  "[class^=\"tf-\"],[class*=\" tf-\"]{font-family:themefisher-font!important;speak:never;",
  "font-style:normal;font-weight:normal;font-variant:normal;text-transform:none;line-height:1;",
  "-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}",
].join("");
const rules = resolved.map(([cls, cp]) => `.${cls}::before{content:"\\${cp}"}`).join("\n");

writeFileSync(join(OUT_DIR, "icons.css"), `${face}\n${base}\n${rules}\n`);

const size = statSync(join(OUT_DIR, "icons.woff2")).size;
console.log(`  icons: ${resolved.length} glyphs -> ${(size / 1024).toFixed(1)}KB woff2 (was 194KB woff + 46KB css)`);
