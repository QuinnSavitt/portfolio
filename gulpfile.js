"use strict";

const sass = require("gulp-sass")(require("sass"));
const gulp = require("gulp");
const sourcemaps = require("gulp-sourcemaps");
const fileinclude = require("gulp-file-include");
const autoprefixer = require("gulp-autoprefixer");
const cleanCSS = require("gulp-clean-css");
const terser = require("gulp-terser");
const bs = require("browser-sync").create();
const rimraf = require("rimraf");
const jshint = require("gulp-jshint");
const plumber = require("gulp-plumber");
const notify = require("gulp-notify");
const fs = require("fs");
const path = require("path");

const { buildImages } = require("./tools/build-images.cjs");

/**
 * `gulp` runs the dev server: readable output, sourcemaps, stable filenames.
 * `gulp build` runs the deploy build: minified, content-hashed, no sourcemaps.
 * Tasks read this at execution time, so the flag set by `build` applies to
 * everything in its series.
 */
let PROD = false;

const DEST = "theme/";

const path_ = {
  src: {
    html: "source/*.html",
    others: "source/*.+(php|ico|png)",
    htminc: "source/partials/**/*.htm",
    incdir: "source/partials/",
    js: "source/js/*.js",
    // style.scss is the only entry point; everything else is a partial it
    // imports. Compiling the whole tree also emitted a standalone dark.css and
    // four colour-switcher stylesheets that no page has ever linked.
    scss: "source/scss/style.scss",
    scssWatch: "source/scss/**/*.scss",
    images: "source/images/**/*.+(png|jpg|gif|svg)",
    fonts: "source/fonts/**/*.+(eot|ttf|woff|woff2|otf)",
    proofs: "source/proofs/**/*.*",
    games: "source/games/**/*.*",
  },
};

/**
 * Only the plugin files the site actually loads. The stock template also
 * shipped jQuery, Bootstrap's JS bundle, Slick, niceScroll, animate.css and
 * the full 1.1MB Themefisher icon font on every page; none of them are
 * referenced any more. The icon font is now a subset built by
 * `npm run icons` into source/plugins/icons.
 */
const PLUGIN_FILES = [
  "source/plugins/bootstrap/bootstrap.min.css",
  "source/plugins/icons/icons.css",
  "source/plugins/icons/icons.woff2",
  "source/plugins/isotope/isotope.pkgd.min.js",
];

function customPlumber(errTitle) {
  return plumber({
    errorHandler: notify.onError({
      title: errTitle || "Error running Gulp",
      message: "Error: <%= error.message %>",
      sound: "Glass",
    }),
  });
}

gulp.task("set-prod", function (cb) {
  PROD = true;
  cb();
});

// HTML
gulp.task("html:build", function () {
  return gulp
    .src(path_.src.html)
    .pipe(customPlumber("Error Running html-include"))
    .pipe(fileinclude({ basepath: path_.src.incdir }))
    .pipe(gulp.dest(DEST))
    .pipe(bs.reload({ stream: true }));
});

// SCSS
gulp.task("scss:build", function () {
  let stream = gulp.src(path_.src.scss).pipe(customPlumber("Error Running SCSS"));

  // Sourcemaps are a development aid. The old build wrote a 123KB style.css.map
  // into the deployed site, where it was pure dead weight.
  if (!PROD) stream = stream.pipe(sourcemaps.init());

  stream = stream
    .pipe(sass({ outputStyle: "expanded" }).on("error", sass.logError))
    .pipe(autoprefixer());

  if (PROD) stream = stream.pipe(cleanCSS({ level: 2 }));
  else stream = stream.pipe(sourcemaps.write("/"));

  return stream.pipe(gulp.dest(DEST + "css/")).pipe(bs.reload({ stream: true }));
});

// Javascript
gulp.task("js:build", function () {
  let stream = gulp
    .src(path_.src.js)
    .pipe(customPlumber("Error Running JS"))
    .pipe(jshint("./.jshintrc"))
    .pipe(jshint.reporter("jshint-stylish"));

  if (PROD) stream = stream.pipe(terser());

  return stream.pipe(gulp.dest(DEST + "js/")).pipe(bs.reload({ stream: true }));
});

// Images - resized and re-encoded by sharp, see tools/build-images.cjs
gulp.task("images:build", function () {
  return buildImages(DEST).then(function () {
    bs.reload();
  });
});

// fonts
gulp.task("fonts:build", function () {
  if (!fs.existsSync("source/fonts")) return Promise.resolve();
  return gulp.src(path_.src.fonts).pipe(gulp.dest(DEST + "fonts/"));
});

// Proofs
gulp.task("proofs:build", function () {
  return gulp.src(path_.src.proofs).pipe(gulp.dest(DEST + "proofs/")).pipe(bs.reload({ stream: true }));
});

/**
 * Bootstrap declares a Glyphicons @font-face pointing at font files this
 * project has never contained. Nothing uses a .glyphicon class, so browsers
 * never request them and the site works - but they are dangling references
 * that trip the build checker and would confuse anyone reading the output.
 * Dropping the declaration leaves the icon rules inert, which they already are.
 */
function stripGlyphiconFont() {
  const GLYPHICON_FACE = /@font-face\{font-family:'Glyphicons Halflings';[^}]*\}/g;
  const { Transform } = require("stream");
  return new Transform({
    objectMode: true,
    transform(file, _, cb) {
      if (file.isBuffer() && file.path.endsWith("bootstrap.min.css")) {
        file.contents = Buffer.from(file.contents.toString().replace(GLYPHICON_FACE, ""));
      }
      cb(null, file);
    },
  });
}

// Plugins
gulp.task("plugins:build", function () {
  return gulp
    .src(PLUGIN_FILES, { base: "source/plugins" })
    .pipe(stripGlyphiconFont())
    .pipe(gulp.dest(DEST + "plugins/"))
    .pipe(bs.reload({ stream: true }));
});

// Other files like favicon, php on root directory
gulp.task("others:build", function () {
  return gulp.src(path_.src.others).pipe(gulp.dest(DEST));
});

// Games (standalone apps, not run through file-include and not fingerprinted -
// each manages its own assets)
gulp.task("games:build", function () {
  return gulp.src(path_.src.games).pipe(gulp.dest(DEST + "games/")).pipe(bs.reload({ stream: true }));
});

// Clean Build Folder
gulp.task("clean", function (cb) {
  rimraf("./theme", cb);
});

/* =====================================================================
   Fingerprinting

   Filenames carry a hash of their contents, so a deployed asset can be
   cached forever and a changed one is simply a different URL. This replaces
   the hand-maintained `?v=4` query strings, which had to be bumped in two
   places at once and silently served stale JS against fresh HTML whenever
   somebody forgot.

   Three passes, in dependency order: leaf assets first, then the code that
   references them, then the HTML that references everything.
   ===================================================================== */

// gulp-rev and gulp-rev-rewrite are ESM-only and this gulpfile is CommonJS,
// so they load on demand rather than at the top.
let revModules = null;
async function loadRev() {
  if (!revModules) {
    const [rev, revRewrite] = await Promise.all([
      import("gulp-rev"),
      import("gulp-rev-rewrite"),
    ]);
    revModules = { rev: rev.default, revRewrite: revRewrite.default };
  }
  return revModules;
}

// Gulp needs a stream or promise it can await; an async task that builds a
// stream has to bridge the two explicitly.
function runStream(build) {
  return new Promise(function (resolve, reject) {
    build().on("end", resolve).on("finish", resolve).on("error", reject);
  });
}

// Each pass writes its own manifest and they are combined here. gulp-rev's
// own `merge` option silently dropped the earlier pass's entries, which left
// the images hashed on disk but still referenced by their original names.
const ASSET_MANIFEST = "theme/rev-assets.json";
const CODE_MANIFEST = "theme/rev-code.json";

function readManifest(file) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
}

function mergedManifest() {
  return Buffer.from(
    JSON.stringify(Object.assign({}, readManifest(ASSET_MANIFEST), readManifest(CODE_MANIFEST)))
  );
}

// Deletes the pre-hash copies gulp-rev leaves behind, so the deploy carries
// one of each file rather than two.
function dropOriginals(manifestPath) {
  const manifest = readManifest(manifestPath);
  for (const [original, revved] of Object.entries(manifest)) {
    if (original === revved) continue;
    const stale = path.join(DEST, original);
    if (fs.existsSync(stale)) fs.unlinkSync(stale);
  }
}

// Pass 1: images and the icon font. Nothing's name depends on these.
gulp.task("rev:assets", async function () {
  if (!PROD) return;
  const { rev } = await loadRev();
  await runStream(function () {
    return gulp
      .src(["theme/images/**/*", "theme/plugins/icons/*.woff2"], { base: DEST, encoding: false })
      .pipe(rev())
      .pipe(gulp.dest(DEST))
      .pipe(rev.manifest(path.basename(ASSET_MANIFEST)))
      .pipe(gulp.dest(DEST));
  });
});

// Pass 2: stylesheets and scripts. Their contents point at pass-1 assets, so
// rewrite those references before hashing the files themselves.
gulp.task("rev:code", async function () {
  if (!PROD) return;
  const { rev, revRewrite } = await loadRev();
  dropOriginals(ASSET_MANIFEST);
  const manifest = fs.readFileSync(ASSET_MANIFEST);
  await runStream(function () {
    return gulp
      .src(["theme/css/**/*.css", "theme/js/**/*.js", "theme/plugins/**/*.css", "theme/plugins/**/*.js"], {
        base: DEST,
      })
      .pipe(revRewrite({ manifest }))
      .pipe(rev())
      .pipe(gulp.dest(DEST))
      .pipe(rev.manifest(path.basename(CODE_MANIFEST)))
      .pipe(gulp.dest(DEST));
  });
});

// Pass 3: the pages, which reference both of the above.
gulp.task("rev:html", async function () {
  if (!PROD) return;
  const { revRewrite } = await loadRev();
  dropOriginals(CODE_MANIFEST);
  const manifest = mergedManifest();
  await runStream(function () {
    return gulp.src("theme/*.html").pipe(revRewrite({ manifest })).pipe(gulp.dest(DEST));
  });
});

// The manifests are build artifacts; they should not be published.
gulp.task("rev:cleanup", function (cb) {
  if (!PROD) return cb();
  if (process.env.KEEP_MANIFEST) return cb();
  for (const file of [ASSET_MANIFEST, CODE_MANIFEST]) {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
  cb();
});

gulp.task("rev", gulp.series("rev:assets", "rev:code", "rev:html", "rev:cleanup"));

// Watch Task
gulp.task("watch:build", function () {
  gulp.watch(path_.src.html, gulp.series("html:build"));
  gulp.watch(path_.src.htminc, gulp.series("html:build"));
  gulp.watch(path_.src.scssWatch, gulp.series("scss:build"));
  gulp.watch(path_.src.js, gulp.series("js:build"));
  gulp.watch(path_.src.images, gulp.series("images:build"));
  gulp.watch(path_.src.fonts, gulp.series("fonts:build"));
  gulp.watch("source/plugins/**/*.*", gulp.series("plugins:build"));
  gulp.watch(path_.src.proofs, gulp.series("proofs:build"));
  gulp.watch(path_.src.games, gulp.series("games:build"));
});

const assetTasks = [
  "html:build",
  "js:build",
  "scss:build",
  "images:build",
  "fonts:build",
  "plugins:build",
  "others:build",
  "proofs:build",
  "games:build",
];

// Dev Task
gulp.task(
  "default",
  gulp.series(
    "clean",
    ...assetTasks,
    gulp.parallel("watch:build", function () {
      bs.init({ server: { baseDir: DEST } });
    })
  )
);

// Build Task
gulp.task("build", gulp.series("set-prod", "clean", ...assetTasks, "rev"));
