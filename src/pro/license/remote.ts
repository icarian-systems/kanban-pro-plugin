/**
 * Thin client for the Kanban Pro license server (Cloudflare Workers).
 *
 * Everything goes through `obsidianFetch` (= requestUrl), the only
 * sanctioned HTTP path. Bypasses CORS and works on mobile — `fetch()`
 * would not.
 *
 * NONE of these calls are mandatory at runtime. The plugin works
 * offline; we only hit the server to (a) exchange a purchase-key for
 * a signed token on first activation, (b) re-validate weekly to catch
 * refunds/chargebacks, and (c) pick up new revocations.
 */

import { obsidianFetch } from '@/shared/obsidian';

/** Override only in tests or for a self-hosted deployment. */
let baseUrl = 'https://kanban-pro-license.icariansystems.workers.dev';

export function setLicenseServerBaseUrl(url: string): void {
  baseUrl = url.replace(/\/+$/, '');
}

export function getLicenseServerBaseUrl(): string {
  return baseUrl;
}

export interface ActivateResponse {
  /** Signed token (see verify.ts wire format). */
  token: string;
  /** Echo of payload.exp so the client doesn't have to decode just to schedule revalidation. */
  exp: number;
}

export interface ValidateResponse {
  /** Server's view: still good, refunded, revoked, or refreshed token. */
  status: 'ok' | 'revoked' | 'refunded' | 'rotated';
  /** Present when status === 'rotated' — a freshly-signed token to replace the old one. */
  token?: string;
}

export interface RevocationsResponse {
  /** List of subjects (typically emails) whose licenses are revoked. */
  revoked: string[];
  /** Server timestamp at response time — client persists, sends next call. */
  cursor: number;
}

export interface RemoteError {
  status: number;
  body: string;
}

/**
 * Exchange a Lemon Squeezy license key for a signed offline token.
 * Called exactly once per device on activation; requires network.
 */
export async function activate(email: string, key: string): Promise<ActivateResponse> {
  const res = await obsidianFetch({
    method: 'POST',
    url: `${baseUrl}/v1/activate`,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, key }),
  });
  if (res.status !== 200) throw remoteError(res);
  const json = parseJson(res.text);
  if (!isActivateResponse(json)) throw new Error('malformed activate response');
  return json;
}

/**
 * Background weekly check. Server may return `rotated` with a new
 * token (e.g. annual renewal) — the FSM swaps it in transparently.
 */
export async function validate(token: string): Promise<ValidateResponse> {
  const res = await obsidianFetch({
    method: 'POST',
    url: `${baseUrl}/v1/validate`,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  if (res.status !== 200) throw remoteError(res);
  const json = parseJson(res.text);
  if (!isValidateResponse(json)) throw new Error('malformed validate response');
  return json;
}

/**
 * Pull the incremental revocation list. Clients persist `cursor` and
 * pass it back to get only what's new since last poll. Keeps the
 * response bounded even if the global list grows over time.
 */
export async function fetchRevocations(since: number): Promise<RevocationsResponse> {
  const url = `${baseUrl}/v1/revocations?since=${encodeURIComponent(String(since))}`;
  const res = await obsidianFetch({ method: 'GET', url });
  if (res.status !== 200) throw remoteError(res);
  const json = parseJson(res.text);
  if (!isRevocationsResponse(json)) throw new Error('malformed revocations response');
  return json;
}

function remoteError(res: { status: number; text: string }): Error & RemoteError {
  const err = new Error(`license server ${res.status}`) as Error & RemoteError;
  err.status = res.status;
  err.body = res.text;
  return err;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('non-JSON response from license server');
  }
}

function isActivateResponse(v: unknown): v is ActivateResponse {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o.token === 'string' && typeof o.exp === 'number';
}

function isValidateResponse(v: unknown): v is ValidateResponse {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if (o.status !== 'ok' && o.status !== 'revoked' && o.status !== 'refunded' && o.status !== 'rotated') {
    return false;
  }
  if (o.token !== undefined && typeof o.token !== 'string') return false;
  return true;
}

function isRevocationsResponse(v: unknown): v is RevocationsResponse {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    Array.isArray(o.revoked) &&
    o.revoked.every((s) => typeof s === 'string') &&
    typeof o.cursor === 'number'
  );
}
