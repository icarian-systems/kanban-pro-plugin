/**
 * FilterChip — accent-tinted control in the subnav that reads the active
 * filter and opens a small popover on click. The popover body is supplied
 * by the parent (BoardRoot) via `renderBody` — that's where the actual
 * filter UI (FilterPopover) lives. This component owns only the chip
 * styling, the open/close toggle, and the legacy `kanban-pro:open-filter`
 * event for any external listener.
 *
 * Filter is a Free feature (the filter engine is needed for Table/List
 * anyway). Saved Views (named filters) are Pro; that gating lives on the
 * Views control and the right rail.
 */
import * as React from 'react';
import { SubnavPopover } from '@/ui/SubnavPopover';

export interface FilterChipProps {
  /**
   * Short human description of the current filter — e.g. "all",
   * "due ≤ 7d · me", "tag:bug". When `undefined`, displays "all".
   */
  description?: string;
  /**
   * Called when the chip is activated. If omitted, the chip toggles a
   * built-in inline popover and dispatches `kanban-pro:open-filter` on
   * the window so external hosts can react if they want to.
   */
  onOpen?: () => void;
  /** When true, render with the active accent fill; otherwise neutral. */
  active?: boolean;
  /**
   * Render-prop for the popover body. Receives a `close` callback the body
   * can wire to its Apply/Cancel buttons. When omitted, the popover shows
   * a stub message — keeps the chip usable even before BoardRoot wires
   * the full filter builder.
   */
  renderBody?: (ctx: { close: () => void }) => React.ReactNode;
}

export const FILTER_OPEN_EVENT = 'kanban-pro:open-filter';

export const FilterChip: React.FC<FilterChipProps> = ({
  description,
  onOpen,
  active = false,
  renderBody,
}) => {
  const label = `Filter · ${description?.trim() || 'all'}`;
  const [open, setOpen] = React.useState(false);

  const handle = React.useCallback(() => {
    // Always dispatch the event so external listeners can observe it
    // (parity with previous behavior; lets a future filter modal hook
    // in without code changes here).
    window.dispatchEvent(new CustomEvent(FILTER_OPEN_EVENT));
    if (onOpen) {
      onOpen();
      return;
    }
    setOpen((v) => !v);
  }, [onOpen]);

  const close = React.useCallback(() => setOpen(false), []);

  return (
    <div className="kp-popover-anchor">
      <button
        type="button"
        className={`kp-control is-filter${active ? ' is-active' : ''}${open ? ' is-open' : ''}`}
        onClick={handle}
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="dialog"
        title="Open filter"
      >
        {label}
      </button>
      <SubnavPopover
        open={open}
        onClose={close}
        title="Filter cards"
        labelId="kp-filter-popover-title"
      >
        {renderBody ? renderBody({ close }) : (
          <>
            <p className="kp-popover-msg">
              A full filter builder (tags, assignees, due-by) ships soon.
            </p>
            <div className="kp-popover-actions">
              <button type="button" className="kp-control is-ghost" onClick={close}>
                Got it
              </button>
            </div>
          </>
        )}
      </SubnavPopover>
    </div>
  );
};
