#!/usr/bin/env node
// Generate a VAPID key pair for Web Push (RFC 8292) with WebCrypto. Nothing is written to disk and
// nothing goes over the network: it prints the two values and the commands that store them as Worker
// secrets. Usage: npm run vapid   (or: node worker/scripts/vapid.mjs [--json])
const { subtle } = globalThis.crypto;

const b64u = (buf) => Buffer.from(buf).toString("base64url");

export async function generateVapidKeys() {
  const kp = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const publicKey = b64u(await subtle.exportKey("raw", kp.publicKey)); // 65-byte uncompressed point
  const privateKey = (await subtle.exportKey("jwk", kp.privateKey)).d; // 32-byte scalar, base64url
  return { publicKey, privateKey };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const k = await generateVapidKeys();
  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(k)}\n`);
  } else {
    process.stdout.write(
      [
        "New VAPID key pair for Web Push (keep the private key secret; never commit it).",
        "",
        `VAPID_PUBLIC_KEY=${k.publicKey}`,
        `VAPID_PRIVATE_KEY=${k.privateKey}`,
        "",
        "Store both as Worker secrets (from the worker/ folder), plus a contact for push services:",
        "",
        `  echo '${k.publicKey}' | npx wrangler secret put VAPID_PUBLIC_KEY`,
        "  npx wrangler secret put VAPID_PRIVATE_KEY      # paste the private key above when asked",
        "  npx wrangler secret put VAPID_SUBJECT          # e.g. mailto:you@example.com (optional)",
        "",
        "For local `wrangler dev`, put the same three lines in worker/.dev.vars instead.",
        "Changing the keys later makes every phone re-subscribe (the app does it when it next opens).",
        "",
      ].join("\n"),
    );
  }
}
