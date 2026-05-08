import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const fromHere = (rel: string) =>
  fileURLToPath(new URL(rel, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@lordcode/shared": fromHere("../shared/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    globals: false,
  },
});
