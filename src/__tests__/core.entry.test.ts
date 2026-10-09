// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { build, type Options } from 'tsup';

/**
 * The `/core` entry is React-free **as built**, not just as written.
 *
 * Source-level discipline is not enough: a bundler's code splitting can hoist
 * a module into a shared chunk that the core entry then imports, and a type
 * bundler can do the same to declarations. So this file runs the package's own
 * tsup config — every entry, ESM + CJS + declarations, the same splitting —
 * into a scratch directory, and inspects what `core.js`, `core.cjs` and
 * `core.d.ts` actually load, transitively. Then it imports the built `core.js`
 * and runs a simulation with it.
 *
 * Building into a scratch directory rather than reading `dist/` keeps the test
 * independent of whether (and from what) `npm run build` last ran.
 */

// ---- Node built-ins, loaded at run time --------------------------------------
// This package deliberately carries no Node typings (see `src/dev.ts`), so the
// `node:` modules are imported dynamically — untyped — rather than statically.
// The same goes for the two files outside `src/` (the tsup config and
// package.json), which the test tsconfig's `rootDir` does not admit.
/* eslint-disable @typescript-eslint/no-explicit-any */
const load = (specifier: string): Promise<any> => import(/* @vite-ignore */ specifier);
let fs: any;
let path: any;
let url: any;
/* eslint-enable @typescript-eslint/no-explicit-any */
let ROOT = '';
let OUT = '';

beforeAll(async () => {
  [fs, path, url] = await Promise.all([load('node:fs'), load('node:path'), load('node:url')]);
  ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../..');
  // Inside the repo so the built files resolve `three` from node_modules.
  const cache = path.join(ROOT, 'node_modules', '.cache');
  fs.mkdirSync(cache, { recursive: true });
  OUT = fs.mkdtempSync(path.join(cache, 'core-entry-'));
  const config = (await load(path.join(ROOT, 'tsup.config.ts'))).default as Options;
  await build({
    ...config,
    config: false,
    outDir: OUT,
    sourcemap: false,
    silent: true,
    clean: false,
  });
}, 120_000);

afterAll(() => {
  if (OUT) fs.rmSync(OUT, { recursive: true, force: true });
});

/** Strip comments, so a JSDoc example mentioning React is not an import. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** Every module specifier a built JS or .d.ts file loads. */
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

/**
 * Follow relative imports from `entry`; return every file reached and every
 * bare (package) specifier seen along the way.
 */
function closure(entry: string): { files: string[]; bare: Set<string> } {
  const files: string[] = [];
  const bare = new Set<string>();
  const queue: string[] = [path.join(OUT, entry)];
  while (queue.length) {
    const file = queue.pop()!;
    if (files.includes(file)) continue;
    files.push(file);
    for (const s of specifiers(fs.readFileSync(file, 'utf8'))) {
      if (!s.startsWith('.')) {
        bare.add(s);
        continue;
      }
      let target: string = path.resolve(path.dirname(file), s);
      // Declaration chunks are referenced as `./chunk.js` but live in `.d.ts`.
      if (file.endsWith('.d.ts')) target = target.replace(/\.js$/, '.d.ts');
      if (file.endsWith('.d.cts')) target = target.replace(/\.cjs$|\.js$/, '.d.cts');
      queue.push(target);
    }
  }
  return { files, bare };
}

describe('@k9kbdev/r3f-projectiles/core — React-free as built', () => {
  for (const entry of ['core.js', 'core.cjs', 'core.d.ts', 'core.d.cts']) {
    it(`${entry} loads nothing but three, transitively`, () => {
      const { files, bare } = closure(entry);
      expect(files.length).toBeGreaterThan(1); // it does reach its chunks
      expect([...bare]).toEqual(['three']);
      for (const f of files) {
        const src = code(fs.readFileSync(f, 'utf8'));
        expect(src).not.toMatch(/\bReact\b|react-dom|@react-three|\bdocument\.|\bwindow\./);
      }
    });
  }

  it('the root entry still loads React — the check can tell the difference', () => {
    expect([...closure('index.js').bare].sort()).toEqual(['@react-three/fiber', 'react', 'react/jsx-runtime', 'three']);
  });

  it('package.json maps ./core to the built files, with types', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const map: Record<string, Record<string, string>> = pkg.exports['./core'];
    expect(map).toEqual({
      import: { types: './dist/core.d.ts', default: './dist/core.js' },
      require: { types: './dist/core.d.cts', default: './dist/core.cjs' },
    });
    for (const cond of Object.values(map)) {
      for (const p of Object.values(cond)) {
        expect(fs.existsSync(path.join(OUT, p.replace('./dist/', '')))).toBe(true);
      }
    }
  });

  it('the built core.js runs a simulation', async () => {
    const core = await load(url.pathToFileURL(path.join(OUT, 'core.js')).href);
    expect(Object.keys(core).sort()).toEqual(['createBulletSimulation', 'createSeededRandom']);
    const sim = core.createBulletSimulation({ maxBullets: 100 });
    expect(sim.fireAt({ x: 0, y: 0, z: 0 }, 'ring')).toBe(100);
    sim.step(1 / 60);
    expect(sim.activeCount).toBe(100);
    expect(typeof sim.hashState()).toBe('number');
  });
});
