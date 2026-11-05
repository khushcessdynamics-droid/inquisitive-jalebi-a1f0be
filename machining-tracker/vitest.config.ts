import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["packages/**/*.test.ts", "apps/web/src/**/*.test.{ts,tsx}", "tools/**/*.test.ts", "tests/unit/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          environment: "node",
          testTimeout: 30_000,
          hookTimeout: 120_000,
          fileParallelism: false,
        },
      },
      {
        // capacity / speed measurement for docs/COSTS.md (npm run test:capacity); not part of the normal test runs
        test: {
          name: "capacity",
          include: ["tests/capacity/**/*.test.ts"],
          environment: "node",
          testTimeout: 3_600_000,
          hookTimeout: 600_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
