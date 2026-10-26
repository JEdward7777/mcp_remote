import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { generateVapidKeys } from "./scripts/vapid.mjs";

// A throwaway VAPID pair per test run (no private key is ever committed, not even a test one).
const vapid = await generateVapidKeys();

export default defineConfig({
  // test-node/ holds node-side tests (vitest.node.config.ts), never run inside workerd.
  test: { include: ["test/**/*.test.ts"] },
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
          // The derived global pairing-start cap (~52/h for everyone) is tested on its own in limits.test.ts;
          // the rest of the suite starts many pairings from many fake IPs.
          LIMIT_PAIR_START_GLOBAL: "10000,10000/h",
          // Phase 4: Web Push is configured; pushes go to an injected fetch (see push-helpers.ts).
          VAPID_PUBLIC_KEY: vapid.publicKey,
          VAPID_PRIVATE_KEY: vapid.privateKey,
          VAPID_SUBJECT: "mailto:test@example.com",
        },
      },
    }),
  ],
});
