/**
 * Breadcrumb — derives a `Projects / Mercury / Q2 Sprint` path from the
 * source file's vault-relative path. The terminal segment is the board
 * basename (without `.md`); intermediate segments are the parent folders.
 *
 * When the board lives at the vault root we render just the basename — no
 * leading `/` (which would read as "vault root" and add noise).
 *
 * A Pro tag pill is appended when the licence FSM reports the user is on
 * the Pro tier. The mockup positions it inline with the breadcrumb, which
 * gives Pro users a constant ambient cue that they're on the paid surface
 * without yelling.
 */
import * as React from 'react';
import { useProGate } from '@/pro/license/state';

export interface BreadcrumbProps {
  /** Vault-relative path of the board file (e.g. `Projects/Mercury/Q2 Sprint.md`). */
  sourcePath?: string;
  /** Fallback label when sourcePath is missing — usually the in-memory title. */
  fallbackLabel?: string;
}

/** Strip the `.md` (or any) extension from a basename. */
function stripExt(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return name;
  return name.slice(0, dot);
}

/**
 * Splits a vault path into UI segments. The final segment is the basename
 * sans extension; intermediates are folder names. Returns `[]` when there
 * is nothing meaningful to render.
 */
export function deriveSegments(sourcePath?: string, fallback?: string): string[] {
  const path = (sourcePath ?? '').trim();
  if (!path) {
    const f = (fallback ?? '').trim();
    return f ? [f] : [];
  }
  const cleaned = path.replace(/^\/+/, '').replace(/\/+$/, '');
  const parts = cleaned.split('/').filter(Boolean);
  if (parts.length === 0) return fallback ? [fallback] : [];
  const last = stripExt(parts[parts.length - 1]);
  if (parts.length === 1) return [last];
  return [...parts.slice(0, -1), last];
}

export const Breadcrumb: React.FC<BreadcrumbProps> = ({ sourcePath, fallbackLabel }) => {
  const gate = useProGate();
  const segments = deriveSegments(sourcePath, fallbackLabel);
  if (segments.length === 0) return null;
  return (
    <div className="kp-breadcrumb" aria-label="Breadcrumb">
      {segments.map((seg, i) => (
        <React.Fragment key={`${i}:${seg}`}>
          {i > 0 ? <span className="kp-chev" aria-hidden="true">/</span> : null}
          <span className={i === segments.length - 1 ? 'kp-breadcrumb-leaf' : 'kp-breadcrumb-seg'}>
            {seg}
          </span>
        </React.Fragment>
      ))}
      {gate.tier === 'pro' ? (
        <span className="kp-pro-tag" aria-label="Pro tier">Pro</span>
      ) : null}
    </div>
  );
};
