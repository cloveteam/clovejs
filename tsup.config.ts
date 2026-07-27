import { defineConfig } from "tsup"

export default defineConfig([
  {
    entry: {
      index: "src/index.ts",
      mcp: "src/mcp/index.ts",
      bus: "src/bus/index.ts",
      "bus-redis": "src/bus/redis/index.ts",
      testing: "src/testing/index.ts",
    },
    format: ["esm", "cjs"],
    dts: true,
    clean: true,
    sourcemap: true,
    target: "node20",
    // Optional peer dependencies: a project without an mcp/ directory, or with
    // no Redis bus, never loads them, so they must not be bundled in.
    external: ["@modelcontextprotocol/sdk", "zod", "redis", "ioredis"],
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
