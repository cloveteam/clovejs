import { defineConfig } from "tsup"

export default defineConfig([
  {
    entry: { index: "src/index.ts" },
    format: ["esm", "cjs"],
    dts: true,
    clean: true,
    sourcemap: true,
    target: "node20",
  },
  {
    entry: { cli: "src/cli/index.ts" },
    format: ["esm"],
    dts: false,
    sourcemap: true,
    target: "node20",
    banner: { js: "#!/usr/bin/env node" },
  },
])
