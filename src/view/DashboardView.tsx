/**
 * DashboardView — Pro multi-board roll-up.
 *
 * Wires together the vault index, the Pro gate, and the <Dashboard>
 * component. We own:
 *   - the leaf lifecycle (onOpen / onClose, React root mount/unmount),
 *   - the paywall when `gate.tier !== 'pro'`,
 *   - the not-yet-initialised guard when the vault index is unavailable.
 *
 * The full vault-wide dashboard (KPI overview + per-board cards + filters)
 * lives at @/ui/dashboard/Dashboard and consumes the canonical
 * VaultIndexEntry shape directly. (An earlier build mounted an inline
 * placeholder while a contracts shape was reconciled; that reconciliation is
 * done — the component and its sub-views all read the canonical fields.)
 */
import { ItemView, WorkspaceLeaf, type App } from 'obsidian';
import { createRoot, type Root } from 'react-dom/client';
import * as React from 'react';

import { useProGate } from '@/pro/license/state';
import { PaywallCard } from '@/ui/PaywallCard';
import { Dashboard } from '@/ui/dashboard/Dashboard';
import type { VaultIndex } from '@/core/vaultIndex';
import { log } from '@/shared/log';

export const DASHBOARD_VIEW_TYPE = 'kanban-pro-dashboard';

/**
 * The plugin instance carries the singleton VaultIndex. We accept the
 * accessor as a property bag so we don't introduce a circular import on
 * the concrete KanbanProPlugin class.
 */
export interface DashboardViewDeps {
  vaultIndex: VaultIndex;
}

let SHARED_DEPS: DashboardViewDeps | null = null;

/**
 * Called from main.ts before the view is constructed (via registerView's
 * factory closure). This is the only way to get the index into the
 * view without a constructor signature change — Obsidian's registerView
 * factory is `(leaf) => view`.
 */
export function setDashboardViewDeps(deps: DashboardViewDeps): void {
  SHARED_DEPS = deps;
}

export class DashboardView extends ItemView {
  private reactRoot: Root | null = null;
  private unsubscribeIndex: (() => void) | null = null;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  getViewType(): string {
    return DASHBOARD_VIEW_TYPE;
  }

  getDisplayText(): string {
    return 'Kanban Dashboard';
  }

  getIcon(): string {
    return 'layout-dashboard';
  }

  async onOpen(): Promise<void> {
    this.contentEl.empty?.();
    while (this.contentEl.firstChild) {
      this.contentEl.removeChild(this.contentEl.firstChild);
    }
    const mount = document.createElement('div');
    mount.className = 'kanban-pro-dashboard-mount';
    this.contentEl.appendChild(mount);

    this.reactRoot = createRoot(mount);

    // Subscribe to vault index changes so the dashboard re-renders.
    if (SHARED_DEPS?.vaultIndex) {
      this.unsubscribeIndex = SHARED_DEPS.vaultIndex.onChange(() => {
        this.renderTree();
      });
    } else {
      log.warn('DashboardView opened without vaultIndex deps wired');
    }

    this.renderTree();
  }

  async onClose(): Promise<void> {
    this.unsubscribeIndex?.();
    this.unsubscribeIndex = null;
    this.reactRoot?.unmount();
    this.reactRoot = null;
    this.contentEl.empty?.();
  }

  private renderTree(): void {
    if (!this.reactRoot) return;
    this.reactRoot.render(
      <DashboardShell
        app={this.app}
        vaultIndex={SHARED_DEPS?.vaultIndex ?? null}
      />,
    );
  }
}

// ────────────────────────────────────────────────────────────────────────
// Shell: paywall gate → not-initialised guard → full Dashboard
// ────────────────────────────────────────────────────────────────────────

interface DashboardShellProps {
  app: App;
  vaultIndex: VaultIndex | null;
}

const DashboardShell: React.FC<DashboardShellProps> = ({ app, vaultIndex }) => {
  const gate = useProGate();

  if (gate.tier !== 'pro') {
    return (
      <div className="kanban-pro-dashboard-paywall">
        <PaywallCard
          feature="Kanban Dashboard"
          description="See every board's overdue, upcoming, and tag counts at a glance. Activate Pro to unlock."
        />
      </div>
    );
  }

  if (!vaultIndex) {
    return (
      <div className="kanban-pro-dashboard-empty">
        Vault index not initialised. Run “Kanban Pro: Rebuild vault index”.
      </div>
    );
  }

  // The full vault-wide dashboard: KPI overview across every board, a filter
  // bar, and per-board cards. It subscribes to the index and opens boards via
  // `app.workspace.openLinkText`, so the view doesn't need to thread an
  // open-board callback through.
  return <Dashboard app={app} vaultIndex={vaultIndex} />;
};
