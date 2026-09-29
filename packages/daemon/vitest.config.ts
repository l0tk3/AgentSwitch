import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Any real Codex a test reaches writes to a throwaway home, never the user's ~/.codex (its config holds hook trust).
    setupFiles: ["tests/setup.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/cli.ts"],
      thresholds: { lines: 80, functions: 80, branches: 75, statements: 80 },
    },
  },
});
