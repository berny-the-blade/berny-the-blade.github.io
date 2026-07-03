// Build script: produces a minified/mangled dist/index.html from the
// readable source index.html.
//
// - Extracts the inline <script type="text/babel">...</script> block.
// - Transpiles JSX -> React.createElement(...) via @babel/preset-react
//   (classic runtime — app relies on global React/ReactDOM from CDN UMD).
// - Minifies + mangles the transpiled output with Terser.
// - Also minifies the three trailing plain <script> blocks (service worker
//   registration, wake lock, EN/PT translator) with Terser directly.
// - Removes the @babel/standalone CDN <script> tag (no longer needed since
//   JSX is now pre-compiled).
// - Writes the result to dist/index.html. Does NOT touch the source file.
//
// Usage: node build.js   (or: npm run build)

const fs = require('fs');
const path = require('path');
const babel = require('@babel/core');
const { minify } = require('terser');

const SRC_DIR = __dirname;
const SRC_HTML = path.join(SRC_DIR, 'index.html');
const DIST_DIR = path.join(SRC_DIR, 'dist');
const DIST_HTML = path.join(DIST_DIR, 'index.html');

const BABEL_OPEN_TAG = '<script type="text/babel">';
const BABEL_STANDALONE_SRC_RE =
  /\s*<script src="https:\/\/unpkg\.com\/@babel\/standalone[^"]*"><\/script>\n?/;

async function main() {
  const html = fs.readFileSync(SRC_HTML, 'utf8');

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

  const jsxSource = html.slice(babelContentStart, babelContentEnd);

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

  const srcKb = (Buffer.byteLength(html, 'utf8') / 1024).toFixed(1);
  const distKb = (Buffer.byteLength(output, 'utf8') / 1024).toFixed(1);
  console.log(`Wrote ${DIST_HTML}`);
  console.log(`Source index.html: ${srcKb} KB`);
  console.log(`Dist   index.html: ${distKb} KB`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
