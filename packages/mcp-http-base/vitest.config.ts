import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    globals: false,
    /**
     * Defense-in-depth: fail the suite if any test file uses `it.only` /
     * `describe.only` / `test.only`. This prevents accidental narrowing
     * of the test surface from passing CI silently.
     */
    forbidOnly: true,
  },
});
