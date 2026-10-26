// Node-side tests of browser code that can't run inside workerd (the built service worker, run in a
// node:vm sandbox with fake ServiceWorkerGlobalScope APIs). `npm test` runs both configs.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["test-node/**/*.test.ts"], environment: "node" },
});
