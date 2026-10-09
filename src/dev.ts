// ---------------------------------------------------------------------------
// Development-build detection
// ---------------------------------------------------------------------------

/**
 * Declared locally rather than pulled from `@types/node`: this package does not
 * depend on Node typings, and the only thing ever read is `NODE_ENV`. Module
 * scoped, so it neither leaks into the emitted declarations nor collides with a
 * consumer's own `process` global.
 */
declare const process: { env: { NODE_ENV?: string } };

/**
 * `true` in development and test builds, `false` in production.
 *
 * Written as the literal `process.env.NODE_ENV` expression on purpose: that is
 * the exact text every mainstream bundler (Vite, webpack, esbuild, Rollup's
 * replace plugin) substitutes at build time, so a production bundle sees
 * `"production" !== "production"` and every dev-only check below it folds to
 * nothing.
 *
 * The `try` covers the one environment that substitutes nothing: unbundled ESM
 * in a browser, where `process` does not exist at all. That is treated as
 * production — silent — rather than as a crash at import time.
 *
 * Internal. Not barrelled.
 */
export const DEV: boolean = (() => {
  try {
    return process.env.NODE_ENV !== 'production';
  } catch {
    return false;
  }
})();
