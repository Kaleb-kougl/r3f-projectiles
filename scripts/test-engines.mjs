#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:engines — the det-math goldens in Chromium, Firefox and WebKit
// ---------------------------------------------------------------------------
//
// 0.8.0's claim is that the built-in patterns produce the same bits on every
// JS engine. This script checks it against the *built* package (run
// `npm run build` first): it serves `dist/` plus a blank page over node:http,
// opens the page in each Playwright engine, and recomputes there
//
//   1. the 1,000,000-input detSinCos FNV hash (dist/detmath.js),
//   2. the detSinCos hash over inputs beyond DETMATH_RANGE (the `%` 2π
//      reduction path, 2^20 up to ±MAX_VALUE), and
//   3. the PATTERN_CASES golden spawn hash (dist/patterns.js),
//
// with the same helper code the vitest suite pins them with
// (src/__tests__/helpers/{detmathGolden,patternGolden}.ts, transpiled here with
// the TypeScript compiler: they hold type-only imports, so each one becomes a
// self-contained ES module). Each engine's numbers must equal the committed
// constants AND the ones this Node process computes from the same dist files.
//
// An engine whose browser is not installed is SKIPPED, unless CI=true, where
// all three are required (`npx playwright install --with-deps chromium firefox
// webkit` in the CI job). Exit code 0 only if nothing failed.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { chromium, firefox, webkit } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const THREE_BUILD = path.join(ROOT, 'node_modules', 'three', 'build');
const HELPERS = path.join(ROOT, 'src', '__tests__', 'helpers');
const REQUIRE_ALL = process.env.CI === 'true';
const PAGE_TIMEOUT_MS = 120_000;

for (const f of ['detmath.js', 'patterns.js']) {
  if (!fs.existsSync(path.join(DIST, f))) {
    console.error(`test:engines: dist/${f} is missing — run \`npm run build\` first.`);
    process.exit(1);
  }
}

// ---- The helpers as plain ES modules ----------------------------------------

/** Transpile one helper; refuse it if anything but a type import survived. */
function transpileHelper(name) {
  const source = fs.readFileSync(path.join(HELPERS, `${name}.ts`), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
    fileName: `${name}.ts`,
  });
  if (/^\s*import\b/m.test(outputText)) {
    throw new Error(`helpers/${name}.ts has a value import; it must stay self-contained.`);
  }
  return outputText;
}

const HELPER_JS = {
  'detmathGolden.js': transpileHelper('detmathGolden'),
  'patternGolden.js': transpileHelper('patternGolden'),
};

// ---- The page ----------------------------------------------------------------

const PAGE = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>r3f-projectiles det-math engines</title>
<script type="importmap">{ "imports": { "three": "/three/three.module.js" } }</script>
</head>
<body>
<script type="module">
  try {
    const det = await import('/dist/detmath.js');
    const pat = await import('/dist/patterns.js');
    const { Vector3 } = await import('three');
    const dg = await import('/helpers/detmathGolden.js');
    const pg = await import('/helpers/patternGolden.js');
    const api = {
      gen: pat.gen, mod: pat.mod, compose: pat.compose,
      createSeededRandom: pat.createSeededRandom,
      vec3: (x, y, z) => new Vector3(x, y, z),
    };
    const t0 = performance.now();
    const detSinCos = dg.detSinCosGoldenHash({ detSinCos: det.detSinCos, createSeededRandom: pat.createSeededRandom });
    const t1 = performance.now();
    window.__engineResult = {
      detSinCos,
      beyond: dg.detSinCosBeyondGoldenHash({ detSinCos: det.detSinCos, createSeededRandom: pat.createSeededRandom }),
      pattern: pg.patternGoldenHash(api),
      cases: pg.patternCaseHashes(api),
      detSinCosMs: t1 - t0,
      userAgent: navigator.userAgent,
    };
  } catch (e) {
    window.__engineResult = { error: String(e && e.stack || e) };
  }
</script>
</body>
</html>
`;

// ---- Static server (dist/, three's build, the helpers, the page) ------------

const TYPES = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.map': 'application/json' };

/** `file` inside `dir`, or null if the request tries to leave it. */
function inside(dir, rel) {
  const file = path.resolve(dir, '.' + path.posix.normalize('/' + rel));
  return file.startsWith(dir + path.sep) ? file : null;
}

function serve(req, res) {
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const send = (status, type, body) => {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(body);
  };
  if (pathname === '/' || pathname === '/index.html') return send(200, TYPES['.html'], PAGE);
  if (pathname.startsWith('/helpers/')) {
    const js = HELPER_JS[pathname.slice('/helpers/'.length)];
    return js ? send(200, TYPES['.js'], js) : send(404, 'text/plain', 'not found');
  }
  let file = null;
  if (pathname.startsWith('/dist/')) file = inside(DIST, pathname.slice('/dist/'.length));
  else if (pathname.startsWith('/three/')) file = inside(THREE_BUILD, pathname.slice('/three/'.length));
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(404, 'text/plain', 'not found');
  send(200, TYPES[path.extname(file)] ?? 'application/octet-stream', fs.readFileSync(file));
}

// ---- Node's own numbers, from the same dist files ---------------------------

async function importHelper(name) {
  return import(`data:text/javascript;base64,${Buffer.from(HELPER_JS[name]).toString('base64')}`);
}

/** Run `fn` with console.warn muted (the beyond-range inputs trigger detmath's dev warning). */
function quietly(fn) {
  const warn = console.warn;
  console.warn = () => {};
  try {
    return fn();
  } finally {
    console.warn = warn;
  }
}

async function nodeResult() {
  const det = await import(pathToFileURL(path.join(DIST, 'detmath.js')).href);
  const pat = await import(pathToFileURL(path.join(DIST, 'patterns.js')).href);
  const { Vector3 } = await import('three');
  const dg = await importHelper('detmathGolden.js');
  const pg = await importHelper('patternGolden.js');
  const api = {
    gen: pat.gen, mod: pat.mod, compose: pat.compose,
    createSeededRandom: pat.createSeededRandom,
    vec3: (x, y, z) => new Vector3(x, y, z),
  };
  return {
    detSinCos: dg.detSinCosGoldenHash({ detSinCos: det.detSinCos, createSeededRandom: pat.createSeededRandom }),
    beyond: quietly(() =>
      dg.detSinCosBeyondGoldenHash({ detSinCos: det.detSinCos, createSeededRandom: pat.createSeededRandom }),
    ),
    pattern: pg.patternGoldenHash(api),
    cases: pg.patternCaseHashes(api),
    expected: { detSinCos: dg.DETSINCOS_GOLDEN, beyond: dg.DETSINCOS_BEYOND_GOLDEN, pattern: pg.PATTERN_GOLDEN },
  };
}

// ---- Run ----------------------------------------------------------------------

const hex = (n) => '0x' + (n >>> 0).toString(16).padStart(8, '0');

async function runEngine(type, origin, node) {
  const exe = type.executablePath();
  if (!exe || !fs.existsSync(exe)) return { status: 'SKIPPED', reason: `not installed (${exe})` };
  let browser;
  try {
    browser = await type.launch();
  } catch (e) {
    const msg = String(e?.message ?? e);
    if (/Executable doesn't exist|playwright install/i.test(msg)) {
      return { status: 'SKIPPED', reason: msg.split('\n')[0] };
    }
    return { status: 'FAILED', reason: `launch failed: ${msg.split('\n')[0]}` };
  }
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(origin + '/');
    await page.waitForFunction(() => window.__engineResult, null, { timeout: PAGE_TIMEOUT_MS });
    const r = await page.evaluate(() => window.__engineResult);
    if (r.error) return { status: 'FAILED', reason: r.error, version: browser.version() };
    const problems = [];
    for (const key of ['detSinCos', 'beyond', 'pattern']) {
      if (r[key] !== node.expected[key]) problems.push(`${key} ${hex(r[key])} != committed ${hex(node.expected[key])}`);
      if (r[key] !== node[key]) problems.push(`${key} ${hex(r[key])} != Node ${hex(node[key])}`);
    }
    node.cases.forEach((c, i) => {
      if (r.cases[i]?.hash !== c.hash) problems.push(`case "${c.name}": ${hex(r.cases[i]?.hash)} != Node ${hex(c.hash)}`);
    });
    if (errors.length) problems.push(...errors.map((e) => `page error: ${e}`));
    return {
      status: problems.length ? 'FAILED' : 'PASSED',
      reason: problems.join('\n      '),
      version: browser.version(),
      result: r,
    };
  } finally {
    await browser.close();
  }
}

const node = await nodeResult();
console.log(`Node ${process.version} (V8 ${process.versions.v8})`);
console.log(`  detSinCos ${hex(node.detSinCos)}  beyond ${hex(node.beyond)}  pattern ${hex(node.pattern)}`);
console.log(
  `  committed ${hex(node.expected.detSinCos)}         ${hex(node.expected.beyond)}          ${hex(node.expected.pattern)}`,
);
let failed = 0;
if (['detSinCos', 'beyond', 'pattern'].some((k) => node[k] !== node.expected[k])) {
  console.log('  FAILED: Node does not reproduce the committed goldens from dist/ (stale build?)');
  failed++;
}

const server = http.createServer(serve);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

try {
  for (const type of [chromium, firefox, webkit]) {
    const out = await runEngine(type, origin, node);
    if (out.status === 'SKIPPED' && REQUIRE_ALL) {
      out.status = 'FAILED';
      out.reason = `CI=true requires every engine: ${out.reason}`;
    }
    const name = type.name().padEnd(8);
    const ver = out.version ? ` ${out.version}` : '';
    if (out.result) {
      const r = out.result;
      console.log(
        `${out.status.padEnd(7)} ${name}${ver}: detSinCos ${hex(r.detSinCos)}  beyond ${hex(r.beyond)}  pattern ${hex(r.pattern)}` +
          `  (1e6 detSinCos in ${r.detSinCosMs.toFixed(0)} ms)`,
      );
    } else {
      console.log(`${out.status.padEnd(7)} ${name}${ver}`);
    }
    if (out.reason) console.log(`      ${out.reason}`);
    if (out.status === 'FAILED') failed++;
  }
} finally {
  server.close();
}

if (failed) {
  console.error(`test:engines: ${failed} failure(s).`);
  process.exit(1);
}
console.log('test:engines: OK');
