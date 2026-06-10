import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    patterns: "src/patterns.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  splitting: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  external: ["react", "react-dom", "@react-three/fiber", "three"],
});
