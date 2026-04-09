import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "backend",
    environment: "node",
    globals: true,
    setupFiles: ["./test/setup.ts"],
    include: ["./test/**/*.{test,spec}.ts"],
  },
});
