/**
 * recoveryDiff — modal-style React view for sync-conflict resolution.
 *
 * Triggered when the self-write detector spots a foreign write while a
 * save is in flight (see KanbanView.makeSelfWriteDetector). The user
 * picks one of three options:
 *   - Apply local: write our in-memory snapshot to disk, overwriting
 *     the foreign edit.
 *   - Apply remote: drop our in-memory changes, accept the disk state.
 *   - Open as text: side-by-side plain-Markdown view so the user can
 *     hand-merge.
 *
 * The view is intentionally a *thin wrapper* over Frontend's
 * RecoveryDiffView. Until that component ships in src/ui/banners/
 * RecoveryDiffView.tsx, we render a minimal inline implementation so the
 * end-to-end flow is testable.
 */
import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RecoveryDiffView } from '@/ui/banners/RecoveryDiffView';

export interface RecoveryDiffProps {
  /** In-memory board text (what we tried to save). */
  local: string;
  /** Current on-disk board text (the foreign write). */
  remote: string;
  onApplyLocal: () => void;
  onApplyRemote: () => void;
  onOpenAsText: () => void;
  onCancel: () => void;
}

/**
 * Thin re-export — Frontend owns the actual diff renderer. Keeping a Tech
 * Lead-side alias means callers in src/view/ don't have to know about
 * Frontend's import path, and we get a single seam to swap in a custom
 * mount strategy (modal vs. inline panel) without churning callers.
 */
export const RecoveryDiff: React.FC<RecoveryDiffProps> = (props) => {
  return <RecoveryDiffView {...props} />;
};

/**
 * Imperative mount helper used by KanbanView. Renders into a detached host
 * div appended to the leaf container; returns a `dispose()` that unmounts
 * the React root and removes the host. Buttons dispose automatically before
 * invoking their callbacks so the host never lingers past a user action.
 */
export interface MountedRecoveryDiff {
  dispose(): void;
}

export function mountRecoveryDiff(
  container: HTMLElement,
  props: RecoveryDiffProps,
): MountedRecoveryDiff {
  const host = document.createElement('div');
  host.className = 'kanban-pro-recovery-diff-host';
  container.appendChild(host);

  const root: Root = createRoot(host);
  let disposed = false;

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    try {
      root.unmount();
    } catch {
      // unmount during a render commit will throw — best-effort.
    }
    host.remove();
  };

  const wrap = (cb: () => void) => () => {
    dispose();
    cb();
  };

  root.render(
    <RecoveryDiff
      local={props.local}
      remote={props.remote}
      onApplyLocal={wrap(props.onApplyLocal)}
      onApplyRemote={wrap(props.onApplyRemote)}
      onOpenAsText={wrap(props.onOpenAsText)}
      onCancel={wrap(props.onCancel)}
    />,
  );

  return { dispose };
}
