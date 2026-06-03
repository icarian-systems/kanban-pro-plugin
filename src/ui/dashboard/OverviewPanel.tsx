/**
 * OverviewPanel — three small KPI cards summarising the vault's kanban
 * state. Renders as the dashboard hero.
 *
 * Numbers are derived synchronously from the VaultIndex; the parent
 * subscribes via `vaultIndex.onChange` and re-renders.
 */
import * as React from 'react';
import type { VaultIndexEntry } from '@/ui/contracts';

export interface OverviewPanelProps {
  entries: VaultIndexEntry[];
}

function sumNumber(
  entries: VaultIndexEntry[],
  pick: (e: VaultIndexEntry) => number,
): number {
  let total = 0;
  for (const e of entries) total += pick(e);
  return total;
}

const KpiCard: React.FC<{
  label: string;
  value: string | number;
  tone?: 'normal' | 'warn' | 'alert' | 'ok';
  hint?: string;
}> = ({ label, value, tone = 'normal', hint }) => (
  <div className={`kp-kpi kp-kpi--${tone}`}>
    <div className="kp-kpi__value">{value}</div>
    <div className="kp-kpi__label">{label}</div>
    {hint ? <div className="kp-kpi__hint">{hint}</div> : null}
  </div>
);

export const OverviewPanel: React.FC<OverviewPanelProps> = ({ entries }) => {
  const boards = entries.length;
  const overdue = sumNumber(entries, (e) => e.overdue);
  const dueSoon = sumNumber(entries, (e) => e.dueWithin7d);
  const totalCards = sumNumber(entries, (e) => e.totalCards);
  const tagCount = new Set(entries.flatMap((e) => Object.keys(e.tags))).size;

  return (
    <section className="kp-dashboard__overview" aria-label="Vault overview">
      <KpiCard label="Boards" value={boards} hint={`${totalCards} cards`} />
      <KpiCard
        label="Overdue"
        value={overdue}
        tone={overdue > 0 ? 'alert' : 'normal'}
      />
      <KpiCard
        label="Due this week"
        value={dueSoon}
        tone={dueSoon > 0 ? 'warn' : 'normal'}
      />
      <KpiCard
        label="Tags"
        value={tagCount}
        tone="normal"
        hint="distinct"
      />
    </section>
  );
};
