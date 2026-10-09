import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "packages/*",
      "apps/*",
      {
        test: {
          name: "e2e",
          include: ["tests/e2e/*.test.ts"],
        },
      },
    ],
  },
});
