import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Each test boots its own app and closes it in afterEach; forks keep the
    // suites isolated from one another.
    pool: "forks",
  },
})
