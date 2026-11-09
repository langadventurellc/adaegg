import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./hatchling/src/test-setup.ts"],
  },
});
