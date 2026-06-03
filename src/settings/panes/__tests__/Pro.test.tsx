/**
 * Pro.test.tsx — settings-pane regression for the legacy-licenseToken scrub.
 *
 * After a successful activate, the Pro pane MUST scrub the legacy
 * `host.settings.licenseToken` raw-input field. The signed token is
 * already persisted under `persistedLicense`; leaving the stale raw
 * `email|key` on disk would (a) confuse the
 * `kanban-pro-license-activate` command's fall-back path on cold start,
 * and (b) advertise the raw key in a place users (and backup tools)
 * are likely to grep.
 *
 * The deactivate handler already scrubs the field; this test pins the
 * activate-success handler to the same contract.
 */
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
// The mock at `src/__mocks__/obsidian.ts` is aliased over the real
// `obsidian` import in `vitest.config.ts`. We import its test helpers
// directly via the mock path so TypeScript sees them — the real
// `obsidian` package types (used by tsc) don't expose them.
import { __resetSettingRegistry, __findSettingByName } from '@/__mocks__/obsidian';
import { PUBLIC_KEYS } from '@/pro/license/keys';
import { base64urlEncode, bytesToHex } from '@/pro/license/verify';

ed.etc.sha512Sync = (...m: Uint8Array[]) => sha512(ed.etc.concatBytes(...m));
ed.etc.sha512Async = async (...m: Uint8Array[]) => sha512(ed.etc.concatBytes(...m));

const TEST_KID = 'curr-2026';
let priv: Uint8Array;
let mockActivateResponse: { token: string; exp: number } = { token: '', exp: 0 };

vi.mock('@/pro/license/remote', () => ({
  activate: vi.fn(async () => mockActivateResponse),
  validate: vi.fn(async () => ({ status: 'ok' as const })),
  fetchRevocations: vi.fn(async () => ({ revoked: [], cursor: 0 })),
  setLicenseServerBaseUrl: vi.fn(),
  getLicenseServerBaseUrl: () => 'http://test',
}));

import { renderProPane } from '../Pro';
import { licenseFSM } from '@/pro/license/state';

async function signToken(payload: object): Promise<string> {
  const json = JSON.stringify(payload);
  const payloadBytes = new TextEncoder().encode(json);
  const payloadB64 = base64urlEncode(payloadBytes);
  const signed = new TextEncoder().encode(payloadB64);
  const sig = await ed.signAsync(signed, priv);
  return `${payloadB64}.${base64urlEncode(sig)}`;
}

async function primeSignedActivateResponse(sub: string): Promise<{ token: string; exp: number }> {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + 365 * 24 * 60 * 60;
  const token = await signToken({
    sub,
    tier: 'pro',
    kid: TEST_KID,
    iat: now,
    exp,
    entitlements: ['recurrence', 'savedViews'],
  });
  mockActivateResponse = { token, exp };
  return mockActivateResponse;
}

beforeAll(async () => {
  priv = ed.utils.randomPrivateKey();
  const pub = await ed.getPublicKeyAsync(priv);
  const entry = PUBLIC_KEYS.find((k) => k.kid === TEST_KID);
  if (entry) {
    (entry as { publicKeyHex: string }).publicKeyHex = bytesToHex(pub);
  }
});

beforeEach(() => {
  __resetSettingRegistry();
});

describe('Pro pane — activate-success scrubs legacy licenseToken', () => {
  it('clicking Activate on a host with a legacy licenseToken clears it after success', async () => {
    await primeSignedActivateResponse('dev@example.com');
    const root = document.createElement('div');
    const settings = {
      defaultView: 'board' as const,
      laneWidth: 272,
      archiveWithDate: true,
      compatibilityMode: false,
      licenseToken: 'dev@example.com|DEV-TEST-KEY-0001' as string | null,
      persistedLicense: null,
      revocationsCursor: 0,
      github: { accessToken: null },
      calendar: { icsExportEnabled: false },
      hasSeenOnboarding: true,
    };
    const saveSettings = vi.fn(async () => {});
    const host = {
      settings,
      saveSettings,
      // Cast through `unknown` — the test's narrow plugin shape is fine
      // for the Pro pane, which only reads `settings` / `saveSettings`.
      plugin: {} as unknown as import('obsidian').Plugin,
    };
    const disposers: Array<() => void> = [];
    renderProPane(root, host, (d) => disposers.push(d));

    // Two-field activation: the user types email and key, then clicks Activate
    // (the button lives on the License key row). The legacy `licenseToken`
    // field is migration data only — the new pane no longer prefills from it.
    const emailRow = __findSettingByName('License email');
    const keyRow = __findSettingByName('License key');
    expect(emailRow).not.toBeNull();
    expect(keyRow).not.toBeNull();
    emailRow!.text!.onChange?.('dev@example.com');
    keyRow!.text!.onChange?.('DEV-TEST-KEY-0001');

    const activateBtn = keyRow!.buttons.find((b) => b.text === 'Activate');
    expect(activateBtn).toBeTruthy();
    await activateBtn!.onClick!();

    // FSM should have moved to Pro · Licensed.
    expect(licenseFSM.getGate().tier).toBe('pro');
    expect(licenseFSM.getGate().state).toBe('licensed');

    // The contract under test: licenseToken cleared, saveSettings called.
    expect(host.settings.licenseToken).toBeNull();
    expect(saveSettings).toHaveBeenCalled();

    // Cleanup disposers so the FSM subscription doesn't leak between tests.
    for (const d of disposers) d();
  });

  it('a failed activate leaves licenseToken untouched (no scrub on failure)', async () => {
    // Prime an invalid mock response so the FSM lands in Free · Unlicensed.
    mockActivateResponse = { token: 'not-a-real-token', exp: 0 };
    const root = document.createElement('div');
    const settings = {
      defaultView: 'board' as const,
      laneWidth: 272,
      archiveWithDate: true,
      compatibilityMode: false,
      licenseToken: 'dev@example.com|BAD-KEY' as string | null,
      persistedLicense: null,
      revocationsCursor: 0,
      github: { accessToken: null },
      calendar: { icsExportEnabled: false },
      hasSeenOnboarding: true,
    };
    const saveSettings = vi.fn(async () => {});
    const host = {
      settings,
      saveSettings,
      plugin: {} as unknown as import('obsidian').Plugin,
    };
    const disposers: Array<() => void> = [];
    renderProPane(root, host, (d) => disposers.push(d));

    const emailRow = __findSettingByName('License email');
    const keyRow = __findSettingByName('License key');
    emailRow!.text!.onChange?.('dev@example.com');
    keyRow!.text!.onChange?.('BAD-KEY');
    const activateBtn = keyRow!.buttons.find((b) => b.text === 'Activate');
    await activateBtn!.onClick!();

    // Gate did NOT move to pro — scrub MUST NOT have fired.
    expect(licenseFSM.getGate().tier).toBe('free');
    expect(host.settings.licenseToken).toBe('dev@example.com|BAD-KEY');
    // saveSettings is the scrub channel; on failure it should never run.
    expect(saveSettings).not.toHaveBeenCalled();

    for (const d of disposers) d();
  });
});
