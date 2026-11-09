import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./src/test-setup.ts"],
    // Tests run real git and node subprocesses on the owner's machine; a busy disk (e.g. the first index of a fresh node_modules) can slow a correct test far past 5 s.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
