import { defineConfig } from "tsup"

export default defineConfig([
  {
    entry: {
      index: "src/index.ts",
      mcp: "src/mcp/index.ts",
      testing: "src/testing/index.ts",
    },
    format: ["esm", "cjs"],
    dts: true,
    clean: true,
    sourcemap: true,
    target: "node20",
    // Optional peer dependencies: a project without an mcp/ directory never
    // loads them, so they must not be bundled in.
    external: ["@modelcontextprotocol/sdk", "zod"],
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
