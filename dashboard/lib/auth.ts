// Console access control (spec §6). AUTH_MODE=none (default) leaves the console
// open; AUTH_MODE=single gates it behind one email/password taken from env.
//
// Everything here runs in BOTH the edge middleware and Node server actions, so it
// uses Web Crypto (globalThis.crypto) and btoa/atob — never node:crypto.

export type AuthMode = "none" | "single";

export const AUTH_MODE: AuthMode = process.env.AUTH_MODE === "single" ? "single" : "none";
export const SESSION_COOKIE = "tb_session";
export const SESSION_MAX_AGE = 60 * 60 * 24 * 7; // 7 days, in seconds

const encoder = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}

async function sign(payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(process.env.SESSION_SECRET || ""),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return b64url(new Uint8Array(sig));
}

/** Length-independent constant-time compare. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function credentialsValid(email: string, password: string): boolean {
  const adminEmail = process.env.ADMIN_EMAIL || "";
  const adminPassword = process.env.ADMIN_PASSWORD || "";
  if (!adminEmail || !adminPassword) return false;
  // Evaluate both so timing doesn't reveal which field was wrong.
  const okEmail = safeEqual(email, adminEmail);
  const okPassword = safeEqual(password, adminPassword);
  return okEmail && okPassword;
}

export async function createToken(email: string): Promise<string> {
  const payload = b64url(encoder.encode(JSON.stringify({ sub: email, iat: Date.now() })));
  return `${payload}.${await sign(payload)}`;
}

export async function verifyToken(token: string | undefined | null): Promise<boolean> {
  if (!token || !process.env.SESSION_SECRET) return false;
  const dot = token.indexOf(".");
  if (dot < 0) return false;
  const payload = token.slice(0, dot);
  if (!safeEqual(token.slice(dot + 1), await sign(payload))) return false;
  try {
    const { iat } = JSON.parse(new TextDecoder().decode(fromB64url(payload)));
    return typeof iat === "number" && Date.now() - iat < SESSION_MAX_AGE * 1000;
  } catch {
    return false;
  }
}
