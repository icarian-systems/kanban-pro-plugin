/**
 * Bundled Ed25519 public keys used to verify license tokens offline.
 *
 * Three keys ship at any time so keys can be rotated without invalidating
 * already-issued tokens:
 *
 *   prev — the previous cycle's key, honored until tokens signed under it
 *          would have expired.
 *   curr — the key license tokens are currently signed with.
 *   next — pre-published so clients recognize it before the next rotation.
 *
 * Each key has a stable `kid` (key id) that is embedded in every token so
 * verification can select the matching public key directly. An unknown
 * `kid` is rejected outright — verification never falls back to trying
 * every key.
 *
 * The signing (private) halves are held only by the license service and are
 * never part of this repository; this file ships the public halves alone.
 *
 * Encoding: lowercase hex, 32 bytes / 64 hex chars (Ed25519 public key).
 */

export interface PublicKeyEntry {
  /** Stable key id. Embedded in every token payload. */
  kid: string;
  /** Ed25519 public key, 32 raw bytes, hex-encoded (lowercase, 64 chars). */
  publicKeyHex: string;
  /**
   * Soft expiry — clients refuse to verify tokens whose `iat` is after
   * this date even if the signature checks out. Lets us retire `prev`
   * cleanly. ISO date.
   */
  retireAfter?: string;
}

// These are production public keys. The CI guard at
// scripts/checkProductionKeys.mjs fails a release build if any slot still
// holds a placeholder (all-zero) or known non-production development key.
export const PUBLIC_KEYS: ReadonlyArray<PublicKeyEntry> = [
  {
    kid: 'prev-2025',
    publicKeyHex: 'a398feddcd19ef6e2e78509b73ec1d338967ffe51e3b1bfdae6412840f88ffa4',
    retireAfter: '2026-12-31',
  },
  {
    kid: 'curr-2026',
    publicKeyHex: '235d6a1e00922c2e0722d951c551f92bb9d50e8e1c40444eea67bc0ec3ed7186',
  },
  {
    kid: 'next-2027',
    publicKeyHex: '3c9947d77fba3c3e43713be47d94e3b285363813d5bdfc561be1d84d027e49cb',
  },
];

export function getPublicKey(kid: string): PublicKeyEntry | null {
  return PUBLIC_KEYS.find((k) => k.kid === kid) ?? null;
}
