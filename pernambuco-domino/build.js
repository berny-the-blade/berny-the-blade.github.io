// Build script: produces a minified/mangled dist/index.html from the
// readable source index.html.
//
// - Extracts the inline <script type="text/babel">...</script> block.
// - Patches the loadNeuralModel fetch to XOR-decode the model bytes (see
//   MODEL_XOR_KEY below) — paired with the encode step that writes
//   dist/domino_model.bin further down. Source index.html + the plain
//   domino_model.bin next to it are untouched, so local dev (opening the
//   source directly) keeps working against the plain file.
// - Transpiles JSX -> React.createElement(...) via @babel/preset-react
//   (classic runtime — app relies on global React/ReactDOM from CDN UMD).
// - Minifies + mangles the transpiled output with Terser.
// - Also minifies the three trailing plain <script> blocks (service worker
//   registration, wake lock, EN/PT translator) with Terser directly.
// - Minifies the inline <style> block with clean-css.
// - Removes the @babel/standalone CDN <script> tag (no longer needed since
//   JSX is now pre-compiled).
// - Copies sibling static assets (domino_model.bin obfuscated, everything
//   else verbatim) into dist/.
// - Writes the result to dist/index.html. Does NOT touch the source file.
//
// Usage: node build.js   (or: npm run build)

const fs = require('fs');
const path = require('path');
const babel = require('@babel/core');
const { minify } = require('terser');
const CleanCSS = require('clean-css');

const SRC_DIR = __dirname;
const SRC_HTML = path.join(SRC_DIR, 'index.html');
const DIST_DIR = path.join(SRC_DIR, 'dist');
const DIST_HTML = path.join(DIST_DIR, 'index.html');
const MODEL_BIN = 'domino_model.bin';

const BABEL_OPEN_TAG = '<script type="text/babel">';
const BABEL_STANDALONE_SRC_RE =
  /\s*<script src="https:\/\/unpkg\.com\/@babel\/standalone[^"]*"><\/script>\n?/;

// Byte-obfuscation for domino_model.bin in the dist build only. This is
// NOT encryption — it's a cheap deterrent against "right click, save file"
// casual copying (matches the JS minification's threat model). Anyone
// willing to read the (also-minified) decode step below can reverse it.
const MODEL_XOR_KEY = [
  0x4b, 0x9e, 0x2f, 0x71, 0xc8, 0x05, 0x3a, 0xd6,
  0x88, 0x1e, 0xf4, 0x62, 0x97, 0x3c, 0xb1, 0x0a,
  0x5d, 0xe3, 0x29, 0x7f, 0xa4, 0x16, 0xcd, 0x80,
];

function xorBytes(buf, key) {
  const out = Buffer.from(buf);
  for (let i = 0; i < out.length; i++) out[i] ^= key[i % key.length];
  return out;
}

// Injected into the app script (before Babel) — decodes the obfuscated
// model bytes right after fetch, before the existing DataView parsing.
function buildDecodeSnippet(key) {
  return (
    `const __mk=[${key.join(',')}];` +
    `const __mdec=function(ab){var u=new Uint8Array(ab);` +
    `for(var i=0;i<u.length;i++)u[i]^=__mk[i%__mk.length];return ab;};`
  );
}

async function main() {
  let html = fs.readFileSync(SRC_HTML, 'utf8');
  const srcKb = (Buffer.byteLength(html, 'utf8') / 1024).toFixed(1);

  // --- Minify the inline <style> block ---
  const styleStart = html.indexOf('<style>');
  const styleEnd = html.indexOf('</style>');
  if (styleStart === -1 || styleEnd === -1) {
    throw new Error('Could not find <style>...</style> block in source HTML.');
  }
  const styleContentStart = styleStart + '<style>'.length;
  const cssSource = html.slice(styleContentStart, styleEnd);
  console.log('Minifying <style> block with clean-css...');
  const minifiedCss = new CleanCSS({}).minify(cssSource);
  if (minifiedCss.errors.length) throw new Error(minifiedCss.errors.join('\n'));
  html = html.slice(0, styleContentStart) + minifiedCss.styles + html.slice(styleEnd);

  // --- Locate the inline JSX <script type="text/babel"> block ---
  const babelTagStart = html.indexOf(BABEL_OPEN_TAG);
  if (babelTagStart === -1) {
    throw new Error('Could not find <script type="text/babel"> tag in source HTML.');
  }
  const babelContentStart = babelTagStart + BABEL_OPEN_TAG.length;
  const babelContentEnd = html.indexOf('</script>', babelContentStart);
  if (babelContentEnd === -1) {
    throw new Error('Could not find closing </script> for the babel block.');
  }
  const babelCloseTagEnd = babelContentEnd + '</script>'.length;

  let jsxSource = html.slice(babelContentStart, babelContentEnd);

  // --- Patch loadNeuralModel to XOR-decode the (dist-only obfuscated)
  //     model bytes right after fetch, before the existing DataView parsing ---
  const FETCH_LINE = 'const buf = await resp.arrayBuffer();';
  if (!jsxSource.includes(FETCH_LINE)) {
    throw new Error(
      'Could not find the model fetch line in loadNeuralModel — index.html structure may have changed, update build.js.'
    );
  }
  jsxSource = jsxSource.replace(
    FETCH_LINE,
    `const __rawBuf = await resp.arrayBuffer();\n      ${buildDecodeSnippet(MODEL_XOR_KEY)}\n      const buf = __mdec(__rawBuf);`
  );

  // --- Transpile JSX -> React.createElement calls ---
  console.log('Transpiling JSX with @babel/core...');
  const transpiled = babel.transform(jsxSource, {
    presets: [['@babel/preset-react', { runtime: 'classic' }]],
    sourceType: 'script',
    babelrc: false,
    configFile: false,
  }).code;

  // --- Minify + mangle the transpiled app code ---
  console.log('Minifying app script with Terser...');
  const minifiedApp = await minify(transpiled, {
    compress: true,
    mangle: true,
    format: { comments: false },
  });
  if (minifiedApp.error) throw minifiedApp.error;

  // --- Locate + minify the three trailing plain <script> blocks ---
  const afterBabel = html.slice(babelCloseTagEnd);
  const scriptTagRe = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
  const trailingScripts = [];
  let m;
  while ((m = scriptTagRe.exec(afterBabel)) !== null) {
    trailingScripts.push({ full: m[0], body: m[1], index: m.index });
  }
  if (trailingScripts.length !== 3) {
    throw new Error(
      `Expected exactly 3 trailing inline <script> blocks after the babel block, found ${trailingScripts.length}. ` +
        'index.html structure may have changed — update build.js.'
    );
  }

  console.log('Minifying trailing plain scripts with Terser...');
  let afterBabelRewritten = afterBabel;
  // Replace from the end so earlier indices stay valid.
  for (let i = trailingScripts.length - 1; i >= 0; i--) {
    const s = trailingScripts[i];
    const minifiedTrailing = await minify(s.body, {
      compress: true,
      mangle: true,
      format: { comments: false },
    });
    if (minifiedTrailing.error) throw minifiedTrailing.error;
    const replacement = `<script>${minifiedTrailing.code}</script>`;
    afterBabelRewritten =
      afterBabelRewritten.slice(0, s.index) +
      replacement +
      afterBabelRewritten.slice(s.index + s.full.length);
  }

  // --- Assemble the output HTML ---
  let head = html.slice(0, babelTagStart);
  head = head.replace(BABEL_STANDALONE_SRC_RE, '\n');

  const newBabelBlock = `<script>${minifiedApp.code}</script>`;

  const output = head + newBabelBlock + afterBabelRewritten;

  fs.mkdirSync(DIST_DIR, { recursive: true });
  fs.writeFileSync(DIST_HTML, output, 'utf8');

  const distKb = (Buffer.byteLength(output, 'utf8') / 1024).toFixed(1);
  console.log(`Wrote ${DIST_HTML}`);
  console.log(`Source index.html: ${srcKb} KB`);
  console.log(`Dist   index.html: ${distKb} KB`);

  // --- Copy sibling static assets into dist/ ---
  // domino_model.bin gets XOR-obfuscated (paired with the decode snippet
  // injected above); everything else is copied verbatim.
  const modelBytes = fs.readFileSync(path.join(SRC_DIR, MODEL_BIN));
  const obfuscated = xorBytes(modelBytes, MODEL_XOR_KEY);
  fs.writeFileSync(path.join(DIST_DIR, MODEL_BIN), obfuscated);
  console.log(`Obfuscated ${MODEL_BIN} -> dist/ (${(obfuscated.length / 1024 / 1024).toFixed(1)} MB)`);

  const VERBATIM_FILES = ['.nojekyll', 'icon-192.png', 'icon-512.png', 'manifest.json', 'sw.js', 'symbolic-belief.js'];
  for (const f of VERBATIM_FILES) {
    fs.copyFileSync(path.join(SRC_DIR, f), path.join(DIST_DIR, f));
  }
  fs.cpSync(path.join(SRC_DIR, 'avatars'), path.join(DIST_DIR, 'avatars'), { recursive: true });
  console.log(`Copied ${VERBATIM_FILES.length} files + avatars/ verbatim to dist/`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
