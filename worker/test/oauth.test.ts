import { describe, expect, it } from "vitest";
import { b64urlEncode } from "../src/crypto";
import { IdTokenError, buildAuthUrl, isAllowed, newPending, pkceChallenge, verifyIdToken } from "../src/oauth";

const CLIENT = "client-123.apps.googleusercontent.com";

async function makeKey() {
  const kp = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", kp.publicKey)) as JsonWebKey;
  return { kp, jwk: { kid: "k1", kty: "RSA", n: jwk.n!, e: jwk.e!, alg: "RS256" } };
}

async function sign(kp: CryptoKeyPair, claims: Record<string, unknown>, header: Record<string, unknown> = { alg: "RS256", kid: "k1" }) {
  const h = b64urlEncode(JSON.stringify(header));
  const p = b64urlEncode(JSON.stringify(claims));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", kp.privateKey, new TextEncoder().encode(`${h}.${p}`));
  return `${h}.${p}.${b64urlEncode(sig)}`;
}

describe("verifyIdToken", async () => {
  const { kp, jwk } = await makeKey();
  const jwks = async () => ({ keys: [jwk] });
  const now = Date.now();
  const good = {
    iss: "https://accounts.google.com",
    aud: CLIENT,
    sub: "1234567890",
    exp: Math.floor(now / 1000) + 3600,
    nonce: "n1",
    email: "a@example.com",
    email_verified: true,
  };

  it("accepts a valid token", async () => {
    const c = await verifyIdToken(await sign(kp, good), { clientId: CLIENT, nonce: "n1", jwks, now });
    expect(c.sub).toBe("1234567890");
  });

  it.each([
    ["bad aud", { aud: "someone-else" }],
    ["bad iss", { iss: "https://evil.example" }],
    ["expired", { exp: Math.floor(now / 1000) - 3600 }],
    ["bad nonce", { nonce: "other" }],
  ])("rejects %s", async (_name, patch) => {
    const t = await sign(kp, { ...good, ...patch });
    await expect(verifyIdToken(t, { clientId: CLIENT, nonce: "n1", jwks, now })).rejects.toBeInstanceOf(IdTokenError);
  });

  it("rejects a bad signature and an unknown key / alg", async () => {
    const t = await sign(kp, good);
    const [h, , s] = t.split(".");
    const tampered = `${h}.${b64urlEncode(JSON.stringify({ ...good, sub: "999" }))}.${s}`;
    await expect(verifyIdToken(tampered, { clientId: CLIENT, nonce: "n1", jwks, now })).rejects.toThrow(/signature/);
    const other = await makeKey();
    const t2 = await sign(other.kp, good);
    await expect(verifyIdToken(t2, { clientId: CLIENT, nonce: "n1", jwks, now })).rejects.toThrow(/signature/);
    const t3 = await sign(kp, good, { alg: "none", kid: "k1" });
    await expect(verifyIdToken(t3, { clientId: CLIENT, nonce: "n1", jwks, now })).rejects.toThrow(/alg/);
    const t4 = await sign(kp, good, { alg: "RS256", kid: "nope" });
    await expect(verifyIdToken(t4, { clientId: CLIENT, nonce: "n1", jwks, now })).rejects.toThrow(/key/);
  });
});

describe("auth url + gating", () => {
  it("builds a PKCE S256 authorization URL with state and nonce", async () => {
    const p = newPending();
    const u = new URL(await buildAuthUrl(CLIENT, "https://x.workers.dev/auth/callback", p));
    expect(u.origin).toBe("https://accounts.google.com");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("code_challenge")).toBe(await pkceChallenge(p.verifier));
    expect(u.searchParams.get("state")).toBe(p.state);
    expect(u.searchParams.get("nonce")).toBe(p.nonce);
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(p.verifier.length).toBeGreaterThanOrEqual(43);
  });

  it("gates sign-up on ALLOWED_EMAILS / OPEN_SIGNUP and verified email", () => {
    const c = { email: "Me@Example.com", email_verified: true };
    expect(isAllowed(c, "other@x.com, me@example.com", "false")).toBe(true);
    expect(isAllowed(c, "other@x.com", "false")).toBe(false);
    expect(isAllowed(c, "", "true")).toBe(true);
    expect(isAllowed({ email: "me@example.com", email_verified: false }, "me@example.com", "true")).toBe(false);
    expect(isAllowed({ email_verified: true }, "", "true")).toBe(false);
  });
});
