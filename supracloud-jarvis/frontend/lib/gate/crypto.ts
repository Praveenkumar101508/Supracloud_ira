/**
 * WebCrypto primitives for the Awakening Gate.
 *
 * - PIN is never stored: only a salted PBKDF2-SHA256 hash.
 * - The backend session token can be kept across browser restarts only as
 *   AES-GCM ciphertext under a key derived from the PIN, so a PIN unlock
 *   genuinely decrypts the session rather than flipping a boolean.
 */

const PBKDF2_ITERATIONS = 310_000;

export interface PinRecord {
  saltB64: string;
  iterations: number;
  hashB64: string;
}

export interface WrappedSecret {
  saltB64: string;
  ivB64: string;
  ctB64: string;
  iterations: number;
}

export function toB64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  bytes.forEach((b) => (s += String.fromCharCode(b)));
  return btoa(s);
}

export function fromB64(b64: string): Uint8Array {
  const s = atob(b64);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes;
}

export function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

async function pbkdf2Bits(secret: string, salt: Uint8Array, iterations: number): Promise<ArrayBuffer> {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  return crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations },
    material,
    256
  );
}

export async function hashSecret(secret: string): Promise<PinRecord> {
  const salt = randomBytes(16);
  const bits = await pbkdf2Bits(secret, salt, PBKDF2_ITERATIONS);
  return { saltB64: toB64(salt), iterations: PBKDF2_ITERATIONS, hashB64: toB64(bits) };
}

export async function verifySecret(secret: string, rec: PinRecord): Promise<boolean> {
  const bits = await pbkdf2Bits(secret, fromB64(rec.saltB64), rec.iterations);
  const a = new Uint8Array(bits);
  const b = fromB64(rec.hashB64);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function deriveAesKey(secret: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function wrapSecret(pin: string, plaintext: string): Promise<WrappedSecret> {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await deriveAesKey(pin, salt, PBKDF2_ITERATIONS);
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    new TextEncoder().encode(plaintext)
  );
  return { saltB64: toB64(salt), ivB64: toB64(iv), ctB64: toB64(ct), iterations: PBKDF2_ITERATIONS };
}

export async function unwrapSecret(pin: string, wrapped: WrappedSecret): Promise<string | null> {
  try {
    const key = await deriveAesKey(pin, fromB64(wrapped.saltB64), wrapped.iterations);
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromB64(wrapped.ivB64) as BufferSource },
      key,
      fromB64(wrapped.ctB64) as BufferSource
    );
    return new TextDecoder().decode(pt);
  } catch {
    return null; // wrong PIN or tampered ciphertext
  }
}
