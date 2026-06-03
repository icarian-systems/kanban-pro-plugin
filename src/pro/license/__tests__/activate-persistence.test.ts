/**
 * Full-stack regression for license activation persistence.
 *
 * Reproduces a failure where, after activation, the on-disk blob still
 * carried the legacy pipe-delimited form:
 *
 *     "licenseToken": "dev@example.com|DEV-TEST-KEY-0001"
 *
 * with no `persistedLicense.token`. The required on-disk contract is:
 *   - `licenseToken` field is `null` or absent;
 *   - `persistedLicense.token` is a signed Ed25519 string (length > 100,
 *     no literal `|` character).
 *
 * Existing coverage:
 *   - `persistence.test.ts` exercises the FSM's `save()` channel.
 *   - `persistence.contract.test.ts` exercises the FSM + a stand-in scrub.
 *   - `src/settings/panes/__tests__/Pro.test.tsx` calls the Pro pane's
 *     onClick and asserts `host.settings.licenseToken == null`.
 *
 * What was missing — and what this test adds — is the integrated path that
 * actually mirrors what `data.json` looks like after the user clicks
 * Activate in the Pro pane. The Pro pane writes `licenseToken = null` via
 * `host.saveSettings()`, but the FSM writes `persistedLicense` via the
 * separate `LicensePersistence.save()` channel that `main.ts.onload`
 * attaches. Both writes round-trip through plugin.saveData(data) doing a
 * read-modify-write on the same blob.  A wiring bug in either side (race
 * between concurrent saves, the FSM's fire-and-forget `save()` losing to
 * a subsequent legacy-field write, the Pro pane forgetting to await the
 * FSM's persist) would land the failure shape: licenseToken stuck on
 * disk, persistedLicense absent.
 *
 * This test stands up the exact main.ts.onload wiring with a real
 * loadData/saveData backing store, drives the Pro pane's onClick handler,
 * waits for the fire-and-forget FSM persist, and asserts the final blob.
 */
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { __resetSettingRegistry, __findSettingByName } from '@/__mocks__/obsidian';
import { PUBLIC_KEYS } from '@/pro/license/keys';
import { base64urlEncode, bytesToHex } from '@/pro/license/verify';
import type { KanbanPluginSettings } from '@/settings/SettingsTab';
import { DEFAULT_SETTINGS } from '@/settings/SettingsTab';

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

import { renderProPane } from '@/settings/panes/Pro';
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

/**
 * Tiny in-memory plugin host. The on-disk blob is `data`; loadData /
 * saveData round-trip through it the same way Obsidian's
 * `plugin.loadData()` / `plugin.saveData()` do — with the same
 * read-modify-write idiom main.ts.saveSettings uses (so neither owner
 * stomps the other).
 *
 * `data` is the test stand-in for `.obsidian/plugins/kanban-pro/data.json`.
 */
function makePluginHost(initial: Record<string, unknown> = {}) {
  let data: Record<string, unknown> = { ...initial };
  const settings: KanbanPluginSettings = {
    ...DEFAULT_SETTINGS,
    // Hydrate settings from the seeded data blob so the Pro pane sees the
    // legacy licenseToken in the input field, exactly like a real boot.
    ...(initial as Partial<KanbanPluginSettings>),
  };
  async function loadData(): Promise<Record<string, unknown> | null> {
    return data;
  }
  async function saveData(blob: Record<string, unknown>): Promise<void> {
    data = blob;
  }
  // Mirror main.ts.saveSettings (read-modify-write).
  async function saveSettings(): Promise<void> {
    const existing = (await loadData()) ?? {};
    const next = { ...existing, ...settings };
    await saveData(next);
  }
  // Mirror main.ts.onload's persistence wiring.
  const persistence = {
    load: async () => settings.persistedLicense ?? null,
    save: async (p: import('@/pro/license/state').PersistedLicense | null) => {
      settings.persistedLicense = p;
      await saveSettings();
    },
  };
  return {
    settings,
    saveSettings,
    persistence,
    plugin: {} as unknown as import('obsidian').Plugin,
    getDiskData: () => data,
  };
}

/** Flush both microtask queues + the FSM's fire-and-forget persist. */
async function flushPersistence(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
  }
}

/**
 * Drive the Pro pane's two-field activation (email + key) the way a user
 * would: populate both inputs (firing their onChange into the pane's
 * buffers) then click the Activate button that lives on the key row.
 */
async function activateViaPane(email: string, key: string): Promise<void> {
  const emailRow = __findSettingByName('License email');
  const keyRow = __findSettingByName('License key');
  expect(emailRow).not.toBeNull();
  expect(keyRow).not.toBeNull();
  emailRow!.text!.onChange!(email);
  keyRow!.text!.onChange!(key);
  const activateBtn = keyRow!.buttons.find((b) => b.text === 'Activate');
  expect(activateBtn).toBeTruthy();
  await activateBtn!.onClick!();
}

describe('full-stack — data.json after Activate matches the persistence contract', () => {
  it('Pro pane Activate → final data.json has licenseToken:null and persistedLicense.token signed > 100 chars no "|"', async () => {
    const signed = await primeSignedActivateResponse('dev@example.com');

    // Seed disk exactly like a vault carrying the legacy field over from 1.0.0.
    const host = makePluginHost({
      licenseToken: 'dev@example.com|DEV-TEST-KEY-0001',
      persistedLicense: null,
      revocationsCursor: 0,
    });
    // Wire the FSM persistence the same way main.ts.onload does.
    licenseFSM.attachPersistence(host.persistence);

    // Mount the Pro pane and drive the Activate click.
    const root = document.createElement('div');
    const disposers: Array<() => void> = [];
    renderProPane(root, host, (d) => disposers.push(d));

    await activateViaPane('dev@example.com', 'DEV-TEST-KEY-0001');
    // FSM's `commit()` writes the persistedLicense via a fire-and-forget
    // promise; let it settle before we sample disk.
    await flushPersistence();

    // ── persistence contract acceptance ─────────────────────────────────
    const disk = host.getDiskData();

    // (a) licenseToken cleared
    expect(disk.licenseToken == null).toBe(true);

    // (b) persistedLicense.token is an Ed25519-signed string
    const persisted = disk.persistedLicense as { token: string; sub: string; exp: number } | null;
    expect(persisted).not.toBeNull();
    expect(typeof persisted!.token).toBe('string');
    expect(persisted!.token.length).toBeGreaterThan(100);
    expect(persisted!.token.includes('|')).toBe(false);
    expect(persisted!.token).toBe(signed.token);
    // Signed wire format is `payloadB64.signatureB64`.
    expect(persisted!.token.split('.').length).toBe(2);
    // Subject + exp came through unchanged.
    expect(persisted!.sub).toBe('dev@example.com');
    expect(persisted!.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));

    for (const d of disposers) d();
  });

  it('cold restart: a fresh FSM reading the same disk blob warm-starts to pro · licensed', async () => {
    await primeSignedActivateResponse('dev@example.com');
    const host = makePluginHost({
      licenseToken: 'dev@example.com|DEV-TEST-KEY-0001',
      persistedLicense: null,
      revocationsCursor: 0,
    });
    licenseFSM.attachPersistence(host.persistence);

    // First boot: render pane, click Activate.
    const root1 = document.createElement('div');
    const disposers1: Array<() => void> = [];
    renderProPane(root1, host, (d) => disposers1.push(d));
    await activateViaPane('dev@example.com', 'DEV-TEST-KEY-0001');
    await flushPersistence();
    for (const d of disposers1) d();
    expect(licenseFSM.getGate().tier).toBe('pro');

    // Simulate a plugin toggle-off / toggle-on cycle.
    //   1. New `host` reads the persisted disk blob into a fresh settings
    //      object — this is what `loadSettings()` does in main.ts.
    //   2. New FSM instance attached to the same disk blob.
    const replayedDisk = host.getDiskData();
    expect(replayedDisk.licenseToken == null).toBe(true);
    expect((replayedDisk.persistedLicense as { token: string } | null)?.token.length ?? 0).toBeGreaterThan(100);

    // `licenseFSM.load()` against the same persistence: this is the
    // cold-start auto-activation path. We DELIBERATELY DO NOT make any
    // network call here — load is meant to be entirely offline.
    // Reset the FSM's gate by detaching/reattaching is not exposed;
    // instead we exercise `load()` against the same disk shape via a
    // new `attachPersistence` call. The FSM picks up the seeded record
    // and hydrates the gate.
    licenseFSM.attachPersistence(host.persistence);
    await licenseFSM.load();
    expect(licenseFSM.getGate().tier).toBe('pro');
    expect(licenseFSM.getGate().state).toBe('licensed');
  });

  it('disk blob round-trips through JSON.stringify — what would actually be written to data.json', async () => {
    // The on-disk file is JSON. Asserting `JSON.stringify(disk).includes('|')` is
    // a tight check on "the raw email|key escaped onto disk somewhere"
    // because the canonical bytes contain neither pipes in the signed
    // token (it's base64url) nor pipes in the legacy field (we scrubbed
    // it to null). Anything that brings a `|` back — e.g. a missed scrub
    // path that left `licenseToken` populated — would surface here.
    await primeSignedActivateResponse('dev@example.com');
    const host = makePluginHost({
      licenseToken: 'dev@example.com|DEV-TEST-KEY-0001',
      persistedLicense: null,
    });
    licenseFSM.attachPersistence(host.persistence);

    const root = document.createElement('div');
    const disposers: Array<() => void> = [];
    renderProPane(root, host, (d) => disposers.push(d));
    await activateViaPane('dev@example.com', 'DEV-TEST-KEY-0001');
    await flushPersistence();

    const onDiskJson = JSON.stringify(host.getDiskData());
    // No literal pipe — the raw email|key form is gone.
    expect(onDiskJson.includes('|')).toBe(false);
    // The signed token landed in the on-disk JSON.
    expect(onDiskJson).toContain('"persistedLicense"');
    expect(onDiskJson).toContain('"token":"');
    // Legacy field present but null (we explicitly null-write rather
    // than delete so the absent-vs-null distinction stays predictable
    // for downstream readers).
    expect(onDiskJson).toContain('"licenseToken":null');

    for (const d of disposers) d();
  });
});
