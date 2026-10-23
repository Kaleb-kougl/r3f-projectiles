import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    patterns: "src/patterns.ts",
    // React-free headless simulation. Must never import react, react-dom or
    // @react-three/fiber — pinned by src/__tests__/core.entry.test.ts.
    core: "src/core/index.ts",
    // Deterministic sin / cos (0.8.0). Imports nothing at all.
    detmath: "src/detmath.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  splitting: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  external: ["react", "react-dom", "@react-three/fiber", "three"],
  esbuildOptions(options) {
    // Keep `/*! ... */` legal comments — src/detmath.ts' fdlibm notice — at
    // the end of each output file (esbuild's default for bundles, pinned
    // here). Pinned by src/__tests__/bundle.detmath.test.ts.
    options.legalComments = "eof";
  },
});
