/**
 * FilterPopover — body content for the FilterChip's popover. Renders the
 * three filter criteria: tags (multi-select), assignees (multi-select),
 * and `dueBefore` date. The popover chrome
 * itself (header, close button, outside-click handling) lives in
 * SubnavPopover; this component renders inside `SubnavPopover`'s body.
 *
 * State model: this is a pure controlled component. The parent owns the
 * `ViewFilter` object and the available tag/assignee lists, and reacts
 * to `onChange` by re-running the filter against the board.
 */
import * as React from 'react';
import type { ViewFilter } from '@/core/model';

export interface FilterPopoverProps {
  value: ViewFilter;
  onChange: (next: ViewFilter) => void;
  availableTags: readonly string[];
  availableAssignees: readonly string[];
  onClear: () => void;
  onApply: () => void;
}

export const FilterPopover: React.FC<FilterPopoverProps> = ({
  value,
  onChange,
  availableTags,
  availableAssignees,
  onClear,
  onApply,
}) => {
  const selectedTags = value.tags ?? [];
  const selectedAssignees = value.assignees ?? [];

  const toggleTag = React.useCallback(
    (tag: string) => {
      const has = selectedTags.includes(tag);
      const nextTags = has
        ? selectedTags.filter((t) => t !== tag)
        : [...selectedTags, tag];
      onChange({ ...value, tags: nextTags.length ? nextTags : undefined });
    },
    [onChange, selectedTags, value],
  );

  const toggleAssignee = React.useCallback(
    (a: string) => {
      const has = selectedAssignees.includes(a);
      const nextAssignees = has
        ? selectedAssignees.filter((x) => x !== a)
        : [...selectedAssignees, a];
      onChange({
        ...value,
        assignees: nextAssignees.length ? nextAssignees : undefined,
      });
    },
    [onChange, selectedAssignees, value],
  );

  const onDateChange = React.useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const raw = e.currentTarget.value;
      onChange({ ...value, dueBefore: raw || undefined });
    },
    [onChange, value],
  );

  return (
    <>
      <label className="kp-popover-field">
        <span className="kp-popover-field-label">Tags</span>
        {availableTags.length === 0 ? (
          <p className="kp-popover-msg">No tags on this board yet.</p>
        ) : (
          <div className="kp-chiplist" role="group" aria-label="Tags">
            {availableTags.map((tag) => {
              const active = selectedTags.includes(tag);
              return (
                <button
                  key={tag}
                  type="button"
                  className={`kp-chiplist-item${active ? ' is-on' : ''}`}
                  onClick={() => toggleTag(tag)}
                  aria-pressed={active}
                >
                  #{tag}
                </button>
              );
            })}
          </div>
        )}
      </label>

      <label className="kp-popover-field">
        <span className="kp-popover-field-label">Assignees</span>
        {availableAssignees.length === 0 ? (
          <p className="kp-popover-msg">No assignees on this board yet.</p>
        ) : (
          <div className="kp-chiplist" role="group" aria-label="Assignees">
            {availableAssignees.map((a) => {
              const active = selectedAssignees.includes(a);
              return (
                <button
                  key={a}
                  type="button"
                  className={`kp-chiplist-item${active ? ' is-on' : ''}`}
                  onClick={() => toggleAssignee(a)}
                  aria-pressed={active}
                >
                  {a}
                </button>
              );
            })}
          </div>
        )}
      </label>

      <label className="kp-popover-field">
        <span className="kp-popover-field-label">Due before</span>
        <input
          type="date"
          className="kp-popover-input"
          value={value.dueBefore ?? ''}
          onChange={onDateChange}
          aria-label="Filter by due date — show cards due before this date"
        />
      </label>

      <div className="kp-popover-actions">
        <button type="button" className="kp-control is-ghost" onClick={onClear}>
          Clear
        </button>
        <button type="button" className="kp-control is-primary" onClick={onApply}>
          Apply
        </button>
      </div>
    </>
  );
};
