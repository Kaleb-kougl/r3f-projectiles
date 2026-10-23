// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { build, type Options } from 'tsup';

/**
 * Det-math guard rail, as built (0.8.0, docs/detmath-plan.md "Guard rails").
 *
 * The ESLint rules keep engine trig out of the source; this keeps it out of
 * what ships. A bundler can pull a module into a shared chunk that an entry
 * then loads, so a `Math.sin` reached through an import would pass a
 * source-level check. This file runs the package's own tsup config (every
 * entry, ESM + CJS, the same splitting; declarations off, they hold no code)
 * into a scratch directory, follows each det entry's relative imports
 * transitively, and scans every file it reaches.
 *
 * Comments are stripped before scanning: the shipped JSDoc mentions
 * `Math.atan2` (how to recover a heading), which is documentation, not a call.
 *
 * It also checks the fdlibm notice ships: src/detmath.ts keeps it as a legal
 * comment (`/*!`), which esbuild moves to the end of the output file (here,
 * the shared chunk) holding detSin, where an ordinary comment is stripped.
 *
 * Like `core.entry.test.ts`, building into a scratch directory rather than
 * reading `dist/` keeps the test independent of whether (and from what)
 * `npm run build` last ran.
 */

// ---- Node built-ins, loaded at run time (no Node typings; see core.entry) ----
/* eslint-disable @typescript-eslint/no-explicit-any */
const load = (specifier: string): Promise<any> => import(/* @vite-ignore */ specifier);
let fs: any;
let path: any;
let url: any;
/* eslint-enable @typescript-eslint/no-explicit-any */
let OUT = '';

beforeAll(async () => {
  [fs, path, url] = await Promise.all([load('node:fs'), load('node:path'), load('node:url')]);
  const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../..');
  const cache = path.join(root, 'node_modules', '.cache');
  fs.mkdirSync(cache, { recursive: true });
  OUT = fs.mkdtempSync(path.join(cache, 'bundle-detmath-'));
  const config = (await load(path.join(root, 'tsup.config.ts'))).default as Options;
  await build({
    ...config,
    config: false,
    outDir: OUT,
    dts: false,
    sourcemap: false,
    silent: true,
    clean: false,
  });
}, 120_000);

afterAll(() => {
  if (OUT) fs.rmSync(OUT, { recursive: true, force: true });
});

/** Strip comments, so documentation that names a function is not a call. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** Every module specifier a built JS file loads. */
function specifiers(text: string): string[] {
  const src = code(text);
  const out: string[] = [];
  for (const re of [
    /\b(?:import|export)\b[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]) {
    for (const m of src.matchAll(re)) out.push(m[1]);
  }
  return out;
}

/** Follow relative imports from `entry`: every file reached, every bare specifier seen. */
function closure(entry: string): { files: string[]; bare: Set<string> } {
  const files: string[] = [];
  const bare = new Set<string>();
  const queue: string[] = [path.join(OUT, entry)];
  while (queue.length) {
    const file = queue.pop()!;
    if (files.includes(file)) continue;
    files.push(file);
    for (const s of specifiers(fs.readFileSync(file, 'utf8'))) {
      if (s.startsWith('.')) queue.push(path.resolve(path.dirname(file), s));
      else bare.add(s);
    }
  }
  return { files, bare };
}

/**
 * Banned in the det entries' code. The plan's list first (engine trig / pow /
 * exp / log / hypot, three's trig-backed rotations), then the rest of what the
 * lint restricts. `Math.random` is not here: `gen.galaxy` / `gen.rose3D`
 * default to it by design (documented as non-deterministic; pass an rng).
 */
const BANNED: readonly string[] = [
  'Math.sin(',
  'Math.cos(',
  'Math.tan(',
  'Math.atan2(',
  'Math.pow(',
  'Math.exp(',
  'Math.log(',
  'Math.hypot(',
  'setFromAxisAngle',
  'applyQuaternion',
  // Beyond the plan's list — the lint's other restrictions.
  'Math.asin(',
  'Math.acos(',
  'Math.atan(',
  'Math.sinh(',
  'Math.cosh(',
  'Math.tanh(',
  'Math.asinh(',
  'Math.acosh(',
  'Math.atanh(',
  'Math.expm1(',
  'Math.log1p(',
  'Math.log2(',
  'Math.log10(',
  'Math.cbrt(',
  'applyAxisAngle',
  'setFromEuler',
  'applyEuler',
  // three's other trig-backed methods the lint restricts (the distinctive
  // names; `angle(` alone would match too much).
  'angleTo(',
  'rotateAround(',
  'makeRotationX(',
  'makeRotationY(',
  'makeRotationZ(',
  'makeRotationAxis(',
  'makeRotationFromEuler(',
  'setFromSphericalCoords(',
  'setFromCylindricalCoords(',
  'setFromSpherical(',
  'setFromCylindrical(',
  'setFromCartesianCoords(',
  'slerp(',
  'slerpQuaternions(',
  'rotateTowards(',
  'new Spherical(',
  'new Cylindrical(',
  'globalThis.Math',
];

/** Banned names found in `files` (comment-stripped), as `file: name`. */
function hits(files: string[]): string[] {
  const out: string[] = [];
  for (const f of files) {
    const src = code(fs.readFileSync(f, 'utf8'));
    for (const name of BANNED) if (src.includes(name)) out.push(`${path.basename(f)}: ${name}`);
  }
  return out;
}

describe('det-math as built — no engine trig in the det entries', () => {
  for (const entry of ['patterns.js', 'patterns.cjs', 'core.js', 'core.cjs', 'detmath.js', 'detmath.cjs']) {
    it(`${entry} and every chunk it loads contain no engine trig / pow / three rotations`, () => {
      const { files } = closure(entry);
      // Every det entry pulls its code from a shared chunk (detmath.ts at least).
      expect(files.length).toBeGreaterThan(1);
      expect(hits(files)).toEqual([]);
    });
  }

  for (const entry of ['detmath.js', 'detmath.cjs']) {
    it(`${entry} loads no package at all, transitively (relative chunks only)`, () => {
      const { files, bare } = closure(entry);
      expect([...bare]).toEqual([]);
      for (const f of files.slice(1)) expect(path.dirname(f)).toBe(OUT);
    });
  }

  for (const entry of ['detmath.js', 'detmath.cjs', 'patterns.js', 'core.js', 'index.js', 'index.cjs']) {
    it(`${entry}: the built file holding detSin carries the fdlibm notice`, () => {
      const { files } = closure(entry);
      const holders = files.filter((f) => /\bfunction detSin\s*\(/.test(code(fs.readFileSync(f, 'utf8'))));
      expect(holders.length).toBe(1);
      const text = fs.readFileSync(holders[0], 'utf8');
      expect(text).toContain('Copyright (C) 1993 by Sun Microsystems, Inc. All rights reserved.');
      expect(text).toContain('Permission to use, copy, modify, and distribute this');
    });
  }

  it('the root entry still has them (render code) — the scan can tell the difference', () => {
    const found = hits(closure('index.js').files);
    expect(found.some((h) => h.endsWith('setFromAxisAngle'))).toBe(true);
    expect(found.some((h) => h.endsWith('Math.hypot('))).toBe(true);
  });

  it('comment stripping does not hide code: a call after a comment is still seen', () => {
    expect(code('/** Math.atan2(y, x) */ const a = 1;')).not.toContain('Math.atan2(');
    expect(code('/* x */ const h = Math.hypot(1, 2);')).toContain('Math.hypot(');
  });
});
