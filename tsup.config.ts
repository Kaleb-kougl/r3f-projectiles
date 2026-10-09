import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    patterns: "src/patterns.ts",
    // React-free headless simulation. Must never import react, react-dom or
    // @react-three/fiber — pinned by src/__tests__/core.entry.test.ts.
    core: "src/core/index.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  splitting: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  external: ["react", "react-dom", "@react-three/fiber", "three"],
});
