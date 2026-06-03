/**
 * SearchOverlay — body content for the Search popover. Renders a single
 * input bound to the parent-owned search query. Submitting the form (or
 * pressing Enter) is a no-op beyond what onChange already does: search
 * is applied live as the user types.
 *
 * Highlighting matches in card titles is out of scope for the alpha — we
 * just hide non-matching cards via CSS at the BoardRoot level.
 */
import * as React from 'react';

export interface SearchOverlayProps {
  value: string;
  onChange: (next: string) => void;
  matchCount: number;
  onClear: () => void;
}

export const SearchOverlay: React.FC<SearchOverlayProps> = ({
  value,
  onChange,
  matchCount,
  onClear,
}) => {
  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    // Autofocus the input when the overlay mounts so typing lands directly
    // in the search field (Cmd+F-style behaviour).
    requestAnimationFrame(() => el.focus());
  }, []);

  return (
    <>
      <label className="kp-popover-field">
        <span className="kp-popover-field-label">Search cards</span>
        <input
          ref={inputRef}
          type="search"
          className="kp-popover-input"
          placeholder="Title or body…"
          value={value}
          onChange={(e) => onChange(e.currentTarget.value)}
          aria-label="Search cards by title or body"
        />
      </label>
      {value.trim() ? (
        <p className="kp-popover-msg" aria-live="polite">
          {matchCount === 1
            ? '1 card matches'
            : `${matchCount} cards match`}
        </p>
      ) : (
        <p className="kp-popover-msg">
          Type to filter cards by title or body. Non-matching cards are
          hidden until you clear the search.
        </p>
      )}
      <div className="kp-popover-actions">
        <button type="button" className="kp-control is-ghost" onClick={onClear}>
          Clear
        </button>
      </div>
    </>
  );
};
