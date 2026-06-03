/**
 * Stable, fast, non-cryptographic content hash used for byte-identity
 * detection on cards and self-write loop detection on the view layer.
 * FNV-1a 32-bit, encoded as base36 for compactness.
 */
export function hashString(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(36);
}
