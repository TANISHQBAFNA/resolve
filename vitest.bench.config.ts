import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

/** Bench only. Default `vitest run` stays on tests/** so this file is not in CI. */
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["bench/**/*.bench.ts"],
  },
});
