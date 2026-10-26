import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        // Explicit test bindings; DEV_AUTH is deliberately unset here so tests prove the
        // dev sign-in route is absent by default even if a local .dev.vars enables it.
        bindings: {
          SESSION_SECRET: "test-secret-0123456789-0123456789-abcdef",
          DEV_AUTH: "",
          GOOGLE_CLIENT_ID: "test-client.apps.googleusercontent.com",
          GOOGLE_CLIENT_SECRET: "test-google-secret",
          ALLOWED_EMAILS: "allowed@example.com",
          // Phase 3: the "boss" dev tenant runs on the owner plan (limits.test.ts).
          OWNER_EMAILS: "someone@example.com, Boss@dev.local",
        },
      },
    }),
  ],
});
