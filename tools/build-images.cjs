/**
 * Image pipeline.
 *
 * The source tree keeps full-resolution originals (the hero wordmark is a
 * 3991x796 PNG); this emits only what the pages actually request, resized to
 * the largest size they can display at 2x and re-encoded to WebP with an
 * original-format fallback.
 */
const sharp = require("sharp");
const fs = require("fs");
const path = require("path");

const SRC = "source/images";

// Referenced nowhere in any page, partial, script or stylesheet. Left in the
// source tree (they are the theme's stock assets) but not deployed. Delete an
// entry here if you start using one of them again.
const UNUSED = new Set([
  "author.png", "author.jpg", "phantom.png", "tm.jpg", "tm-2.jpg", "hexa-02.svg",
  "works/1.jpg", "works/2.jpg", "works/3.jpg", "works/4.jpg", "works/5.jpg",
]);

// Images needing more than a straight re-encode. `widths` emits one WebP per
// entry; the first (largest) doubles as the fallback's dimensions.
const RESPONSIVE = {
  // Hero wordmark, displayed at 600px CSS width -> 1200px covers 2x screens.
  "QuinnSavitt.png": { widths: [1200, 600], quality: 86, fallback: "png" },
  // Full-bleed CSS background behind the homepage.
  "banner.jpg": { widths: [1600], quality: 74, fallback: "jpeg" },
};

function walk(dir, base = "") {
  const out = [];
  for (const entry of fs.readdirSync(path.join(dir, base))) {
    const rel = base ? `${base}/${entry}` : entry;
    if (fs.statSync(path.join(dir, rel)).isDirectory()) out.push(...walk(dir, rel));
    else out.push(rel);
  }
  return out;
}

async function buildImages(destRoot) {
  const dest = path.join(destRoot, "images");
  let shipped = 0;
  let bytesIn = 0;
  let bytesOut = 0;

  for (const rel of walk(SRC)) {
    if (UNUSED.has(rel)) continue;

    const from = path.join(SRC, rel);
    const to = path.join(dest, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    bytesIn += fs.statSync(from).size;

    // SVGs are already small and lossless; copy untouched.
    if (rel.endsWith(".svg")) {
      fs.copyFileSync(from, to);
      bytesOut += fs.statSync(to).size;
      shipped++;
      continue;
    }

    const spec = RESPONSIVE[rel];
    const stem = rel.replace(/\.[^.]+$/, "");

    if (spec) {
      for (const width of spec.widths) {
        // The largest width keeps the bare name so markup reads cleanly;
        // narrower ones get a -<width> suffix for srcset.
        const suffix = width === spec.widths[0] ? "" : `-${width}`;
        const out = path.join(dest, `${stem}${suffix}.webp`);
        await sharp(from)
          .resize({ width, withoutEnlargement: true })
          .webp({ quality: spec.quality, effort: 6 })
          .toFile(out);
        bytesOut += fs.statSync(out).size;
        shipped++;
      }

      // Fallback in the original format at the largest width, for the few
      // browsers without WebP support.
      const fbExt = spec.fallback === "jpeg" ? "jpg" : spec.fallback;
      const fbOut = path.join(dest, `${stem}.${fbExt}`);
      const pipe = sharp(from).resize({ width: spec.widths[0], withoutEnlargement: true });
      await (spec.fallback === "png"
        ? pipe.png({ compressionLevel: 9, palette: true, quality: 90 })
        : pipe.jpeg({ quality: 80, mozjpeg: true })
      ).toFile(fbOut);
      bytesOut += fs.statSync(fbOut).size;
      shipped++;
      continue;
    }

    // Everything else: re-encode in place at its native size. These are the
    // small project thumbnails; at this size WebP routinely loses to a
    // palette-optimised PNG, so they stay single-format and the markup stays
    // a plain <img>.
    if (rel === "favicon.png") {
      await sharp(from).png({ compressionLevel: 9 }).toFile(to);
    } else if (/\.png$/.test(rel)) {
      await sharp(from).png({ compressionLevel: 9, palette: true, quality: 90 }).toFile(to);
    } else if (/\.(jpg|jpeg)$/.test(rel)) {
      await sharp(from).jpeg({ quality: 80, mozjpeg: true }).toFile(to);
    } else {
      fs.copyFileSync(from, to);
    }
    bytesOut += fs.statSync(to).size;
    shipped++;
  }

  const kb = (n) => (n / 1024).toFixed(0) + "KB";
  console.log(`  images: ${shipped} files, ${kb(bytesIn)} source -> ${kb(bytesOut)} shipped`);
}

module.exports = { buildImages };
