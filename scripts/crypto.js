/*
  Web Crypto wrappers: PBKDF2 key derivation + AES-GCM encrypt/decrypt.
  All ciphertext and IVs are stored base64-encoded.
*/

const PBKDF2_ITERATIONS = 250_000;
const enc = new TextEncoder();
const dec = new TextDecoder();

export async function deriveKey(pin, saltB64) {
  const salt = b64decode(saltB64);
  const baseKey = await crypto.subtle.importKey(
    'raw', enc.encode(pin), 'PBKDF2', false, ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function encrypt(key, plaintextObj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = enc.encode(JSON.stringify(plaintextObj));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
  return { iv: b64encode(iv), blob: b64encode(new Uint8Array(ct)) };
}

export async function decrypt(key, ivB64, blobB64) {
  const iv = b64decode(ivB64);
  const ct = b64decode(blobB64);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return JSON.parse(dec.decode(pt));
}

export function newSalt() {
  return b64encode(crypto.getRandomValues(new Uint8Array(16)));
}

function b64encode(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function b64decode(s) {
  const binary = atob(s);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
