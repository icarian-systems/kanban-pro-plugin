/**
 * FilterBar — local-state form that emits a DashboardQuery on each change.
 *
 * Layout: free-text input, due-window selector, status selector, sort
 * selector. Tag chips are derived from the supplied `availableTags` (the
 * union of tags across the indexed boards) and toggleable in the chip
 * row below.
 *
 * The component is uncontrolled-on-purpose: parent owns the canonical
 * DashboardQuery and re-emits when it changes. The component only mirrors
 * the parent's query into local state so typing doesn't lag.
 */
import * as React from 'react';
import type { DashboardQuery } from '@/ui/contracts';

export interface FilterBarProps {
  value: DashboardQuery;
  onChange: (next: DashboardQuery) => void;
  availableTags: string[];
}

export const FilterBar: React.FC<FilterBarProps> = ({
  value,
  onChange,
  availableTags,
}) => {
  const emit = (patch: Partial<DashboardQuery>) => {
    onChange({ ...value, ...patch });
  };

  const toggleTag = (tag: string) => {
    const cur = new Set(value.tags ?? []);
    if (cur.has(tag)) cur.delete(tag);
    else cur.add(tag);
    emit({ tags: Array.from(cur) });
  };

  return (
    <section className="kp-dashboard__filters" aria-label="Filter boards">
      <div className="kp-dashboard__filters-row">
        <label className="kp-dashboard__filter">
          <span className="kp-dashboard__filter-label">Search</span>
          <input
            type="search"
            className="kp-dashboard__filter-input"
            placeholder="Board title…"
            value={value.text ?? ''}
            onChange={(e) => emit({ text: e.target.value })}
          />
        </label>

        <label className="kp-dashboard__filter">
          <span className="kp-dashboard__filter-label">Due</span>
          <select
            className="kp-dashboard__filter-select"
            value={value.due ?? 'all'}
            onChange={(e) =>
              emit({ due: e.target.value as DashboardQuery['due'] })
            }
          >
            <option value="all">Any</option>
            <option value="overdue">Has overdue</option>
            <option value="soon">Due this week</option>
            <option value="none">No due dates</option>
          </select>
        </label>

        <label className="kp-dashboard__filter">
          <span className="kp-dashboard__filter-label">Status</span>
          <select
            className="kp-dashboard__filter-select"
            value={value.status ?? 'all'}
            onChange={(e) =>
              emit({ status: e.target.value as DashboardQuery['status'] })
            }
          >
            <option value="all">All</option>
            <option value="active">Active</option>
            <option value="shipped">Shipped</option>
          </select>
        </label>

        <label className="kp-dashboard__filter">
          <span className="kp-dashboard__filter-label">Sort</span>
          <select
            className="kp-dashboard__filter-select"
            value={value.sort ?? 'recent'}
            onChange={(e) =>
              emit({ sort: e.target.value as DashboardQuery['sort'] })
            }
          >
            <option value="recent">Recently edited</option>
            <option value="title">Title</option>
            <option value="overdue">Most overdue</option>
          </select>
        </label>
      </div>

      {availableTags.length > 0 ? (
        <div className="kp-dashboard__tags" role="group" aria-label="Filter by tag">
          {availableTags.map((tag) => {
            const isActive = (value.tags ?? []).includes(tag);
            return (
              <button
                key={tag}
                type="button"
                className={`kp-dashboard__tag${isActive ? ' is-active' : ''}`}
                onClick={() => toggleTag(tag)}
                aria-pressed={isActive}
              >
                {tag.startsWith('#') ? tag : `#${tag}`}
              </button>
            );
          })}
        </div>
      ) : null}
    </section>
  );
};
