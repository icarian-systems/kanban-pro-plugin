/**
 * SubnavPopover — a tiny, anchor-positioned floating panel used by the
 * Filter / Views / Search controls in the board subnav.
 *
 * Scope:
 *   A small reusable popover shell. It hosts the shipped Saved Views picker
 *   (`SavedViewsPicker`) and card Search (`SearchOverlay`) in the board
 *   subnav. Originally introduced to fix *silent* toolbar
 *   buttons; the real picker/search UIs now live inside it.
 *
 * Behavior:
 *   - Renders as a child of the trigger's containing element (no portal —
 *     `position: absolute` against the nearest positioned ancestor, which
 *     is the .kp-subnav row).
 *   - Closes on outside click (capture-phase document listener) and Escape.
 *   - Listener is registered and torn down in a single `useEffect`; no
 *     leaks.
 *
 * Selector discipline: this component reads no store state. Parents
 * subscribe to whatever primitives they need and pass them in.
 */
import * as React from 'react';

export interface SubnavPopoverProps {
  /** Whether the popover is currently open. Controlled by parent. */
  open: boolean;
  /** Called when the user wants to close (Esc, outside click, close btn). */
  onClose: () => void;
  /** Title shown in the popover header. */
  title: string;
  /** Element id used for aria-labelledby on the panel. */
  labelId?: string;
  /** Popover body content. */
  children: React.ReactNode;
  /** Optional className appended to the panel root. */
  className?: string;
  /**
   * Horizontal anchoring: `left` aligns the panel's left edge to its
   * trigger; `right` aligns the panel's right edge. Defaults to `left`.
   */
  anchor?: 'left' | 'right';
}

export const SubnavPopover: React.FC<SubnavPopoverProps> = ({
  open,
  onClose,
  title,
  labelId,
  children,
  className,
  anchor = 'left',
}) => {
  const panelRef = React.useRef<HTMLDivElement>(null);

  // Outside-click + Escape close. Registered only while `open`.
  React.useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      const panel = panelRef.current;
      if (!panel) return;
      const target = e.target as Node | null;
      if (target && panel.contains(target)) return;
      // Allow the trigger button to handle its own click (toggle-off).
      // We just close — the trigger's click handler will then re-open
      // if appropriate. Using `mousedown` (capture) gets us in before
      // the click event fires, but we don't preventDefault so trigger
      // clicks still register.
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('mousedown', onPointerDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointerDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      ref={panelRef}
      className={`kp-popover${anchor === 'right' ? ' is-anchor-right' : ''}${className ? ' ' + className : ''}`}
      role="dialog"
      aria-modal="false"
      aria-labelledby={labelId}
    >
      <div className="kp-popover-head">
        <span className="kp-popover-title" id={labelId}>{title}</span>
        <button
          type="button"
          className="kp-popover-close"
          aria-label="Close"
          onClick={onClose}
        >
          {/* small × glyph */}
          <svg viewBox="0 0 14 14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={1.4}>
            <path d="M3 3l8 8M11 3l-8 8" />
          </svg>
        </button>
      </div>
      <div className="kp-popover-body">{children}</div>
    </div>
  );
};
