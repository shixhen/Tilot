import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@tilot/agent-core": fileURLToPath(new URL("./packages/agent-core/src/index.ts", import.meta.url)) } },
  test: { environment: "node", include: ["tests/**/*.test.ts"] },
});
