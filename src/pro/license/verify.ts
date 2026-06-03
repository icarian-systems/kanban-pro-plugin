/**
 * Offline token verifier.
 *
 * Wire format:
 *
 *   token = base64url(payload_json) + "." + base64url(signature)
 *
 * where signature = Ed25519(secretKey, utf8(base64url(payload_json))).
 *
 * Note we sign the base64url-encoded payload string, not the raw JSON
 * bytes. That keeps the verifier free of having to canonicalize JSON;
 * the bytes that go over the wire are the bytes we sign.
 *
 * @noble/ed25519 v2 is pure JS — important because Web Crypto's
 * importKey is broken in Obsidian's Electron build. We must NOT switch to
 * SubtleCrypto here even though it's tempting.
 */

import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';
import { getPublicKey } from './keys';

// @noble/ed25519 v2 doesn't ship its own hash — the caller wires SHA-512.
// We inject @noble/hashes (a transitive dep of @noble/ed25519, so it's
// already on disk). We MUST NOT use Web Crypto's importKey/subtle here:
// it's broken in Obsidian's Electron build.
//
// Both sync and async paths get hooked so verifyAsync works.
ed.etc.sha512Sync = (...m: Uint8Array[]) => sha512(ed.etc.concatBytes(...m));
ed.etc.sha512Async = async (...m: Uint8Array[]) =>
  sha512(ed.etc.concatBytes(...m));

export interface TokenPayload {
  /** Subject — typically the licensee's email. */
  sub: string;
  tier: 'pro';
  /** Key id used to sign — see keys.ts. */
  kid: string;
  /** Issued-at, unix seconds. */
  iat: number;
  /** Expiry, unix seconds. Verifier rejects after this with skew. */
  exp: number;
  /** Optional per-tier entitlement flags (e.g. ["github","calendar"]). */
  entitlements?: string[];
}

export type VerifyResult =
  | { ok: true; payload: TokenPayload }
  | { ok: false; reason: VerifyFailure };

export type VerifyFailure =
  | 'malformed'
  | 'bad-base64'
  | 'bad-json'
  | 'bad-payload-shape'
  | 'unknown-kid'
  | 'key-retired'
  | 'bad-signature'
  | 'not-yet-valid'
  | 'expired';

/** Tokens issued more than this far in the future are rejected outright. */
const MAX_FUTURE_IAT_SKEW_SEC = 5 * 60; // 5 min — generous, handles clock drift
/** Tokens are accepted for this long after exp to absorb tiny clock skew. */
const MAX_EXP_SKEW_SEC = 60; // 1 min

export async function verifyToken(
  raw: string,
  now: number = Math.floor(Date.now() / 1000),
): Promise<VerifyResult> {
  if (typeof raw !== 'string' || raw.length === 0) {
    return { ok: false, reason: 'malformed' };
  }
  const dot = raw.indexOf('.');
  if (dot <= 0 || dot === raw.length - 1 || raw.indexOf('.', dot + 1) !== -1) {
    return { ok: false, reason: 'malformed' };
  }

  const payloadB64 = raw.slice(0, dot);
  const sigB64 = raw.slice(dot + 1);

  let payloadBytes: Uint8Array;
  let sigBytes: Uint8Array;
  try {
    payloadBytes = base64urlDecode(payloadB64);
    sigBytes = base64urlDecode(sigB64);
  } catch {
    return { ok: false, reason: 'bad-base64' };
  }

  // Ed25519 signatures are exactly 64 bytes. Reject early — saves a
  // verifyAsync call and gives a clearer error.
  if (sigBytes.length !== 64) {
    return { ok: false, reason: 'malformed' };
  }

  let payload: TokenPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(payloadBytes)) as TokenPayload;
  } catch {
    return { ok: false, reason: 'bad-json' };
  }

  if (!isPayloadShape(payload)) {
    return { ok: false, reason: 'bad-payload-shape' };
  }

  const keyEntry = getPublicKey(payload.kid);
  if (!keyEntry) {
    return { ok: false, reason: 'unknown-kid' };
  }
  if (keyEntry.retireAfter) {
    const retireSec = Math.floor(new Date(keyEntry.retireAfter).getTime() / 1000);
    if (payload.iat > retireSec) {
      return { ok: false, reason: 'key-retired' };
    }
  }

  // Time checks come AFTER shape and kid checks so a malformed token
  // never masquerades as "expired".
  if (payload.iat > now + MAX_FUTURE_IAT_SKEW_SEC) {
    return { ok: false, reason: 'not-yet-valid' };
  }
  if (payload.exp + MAX_EXP_SKEW_SEC < now) {
    return { ok: false, reason: 'expired' };
  }

  const pubKey = hexToBytes(keyEntry.publicKeyHex);
  const signedMsg = new TextEncoder().encode(payloadB64);

  let okSig = false;
  try {
    okSig = await ed.verifyAsync(sigBytes, signedMsg, pubKey);
  } catch {
    okSig = false;
  }
  if (!okSig) {
    return { ok: false, reason: 'bad-signature' };
  }

  return { ok: true, payload };
}

function isPayloadShape(p: unknown): p is TokenPayload {
  if (!p || typeof p !== 'object') return false;
  const o = p as Record<string, unknown>;
  return (
    typeof o.sub === 'string' &&
    o.tier === 'pro' &&
    typeof o.kid === 'string' &&
    typeof o.iat === 'number' &&
    typeof o.exp === 'number' &&
    Number.isFinite(o.iat) &&
    Number.isFinite(o.exp) &&
    (o.entitlements === undefined ||
      (Array.isArray(o.entitlements) && o.entitlements.every((e) => typeof e === 'string')))
  );
}

// --- base64url & hex helpers ---------------------------------------------

export function base64urlEncode(bytes: Uint8Array): string {
  let b64: string;
  if (typeof btoa === 'function') {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    b64 = btoa(s);
  } else {
    // Node / Worker fallback.
    b64 = Buffer.from(bytes).toString('base64');
  }
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64urlDecode(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('not base64url');
  const pad = s.length % 4 === 2 ? '==' : s.length % 4 === 3 ? '=' : '';
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad;
  if (typeof atob === 'function') {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('odd hex length');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    s += bytes[i].toString(16).padStart(2, '0');
  }
  return s;
}
