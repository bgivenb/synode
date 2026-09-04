import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    hookTimeout: 15_000,
    include: ["tests/postgres.integration.ts"],
    testTimeout: 15_000,
  },
});
