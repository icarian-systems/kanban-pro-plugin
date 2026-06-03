/**
 * FilterPopover.test.tsx — verifies the popover surfaces every filter
 * criterion (tags, assignees, dueBefore) and that clicking a chip emits
 * a properly-shaped `ViewFilter` patch.
 */
import * as React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { FilterPopover } from '@/ui/FilterPopover';
import { SearchOverlay } from '@/ui/SearchOverlay';
import type { ViewFilter } from '@/core/model';

afterEach(() => {
  cleanup();
});

describe('FilterPopover', () => {
  it('renders all three criteria (tags, assignees, dueBefore)', () => {
    const onChange = vi.fn();
    const { getByText, container } = render(
      <FilterPopover
        value={{}}
        onChange={onChange}
        availableTags={['urgent', 'marketing']}
        availableAssignees={['alex', 'pat']}
        onClear={() => {}}
        onApply={() => {}}
      />,
    );
    expect(getByText('Tags')).toBeTruthy();
    expect(getByText('Assignees')).toBeTruthy();
    expect(getByText('Due before')).toBeTruthy();
    expect(getByText('#urgent')).toBeTruthy();
    expect(getByText('#marketing')).toBeTruthy();
    expect(getByText('alex')).toBeTruthy();
    expect(container.querySelector('input[type="date"]')).toBeTruthy();
  });

  it('toggling a tag emits a filter with that tag in the array', () => {
    const onChange = vi.fn();
    const { getByText } = render(
      <FilterPopover
        value={{}}
        onChange={onChange}
        availableTags={['urgent', 'marketing']}
        availableAssignees={[]}
        onClear={() => {}}
        onApply={() => {}}
      />,
    );
    fireEvent.click(getByText('#urgent'));
    expect(onChange).toHaveBeenCalledTimes(1);
    const patch = onChange.mock.calls[0][0] as ViewFilter;
    expect(patch.tags).toEqual(['urgent']);
  });

  it('toggling an already-selected tag removes it', () => {
    const onChange = vi.fn();
    const { getByText } = render(
      <FilterPopover
        value={{ tags: ['urgent'] }}
        onChange={onChange}
        availableTags={['urgent']}
        availableAssignees={[]}
        onClear={() => {}}
        onApply={() => {}}
      />,
    );
    fireEvent.click(getByText('#urgent'));
    const patch = onChange.mock.calls[0][0] as ViewFilter;
    expect(patch.tags).toBeUndefined();
  });

  it('emits dueBefore when the user picks a date', () => {
    const onChange = vi.fn();
    const { container } = render(
      <FilterPopover
        value={{}}
        onChange={onChange}
        availableTags={[]}
        availableAssignees={[]}
        onClear={() => {}}
        onApply={() => {}}
      />,
    );
    const date = container.querySelector('input[type="date"]') as HTMLInputElement;
    fireEvent.change(date, { target: { value: '2026-05-21' } });
    expect(onChange).toHaveBeenCalled();
    const patch = onChange.mock.calls[0][0] as ViewFilter;
    expect(patch.dueBefore).toBe('2026-05-21');
  });

  it('Clear button calls onClear', () => {
    const onClear = vi.fn();
    const { getByText } = render(
      <FilterPopover
        value={{}}
        onChange={() => {}}
        availableTags={[]}
        availableAssignees={[]}
        onClear={onClear}
        onApply={() => {}}
      />,
    );
    fireEvent.click(getByText('Clear'));
    expect(onClear).toHaveBeenCalledTimes(1);
  });
});

describe('SearchOverlay', () => {
  it('renders an input and propagates changes', () => {
    const onChange = vi.fn();
    const { container } = render(
      <SearchOverlay
        value=""
        onChange={onChange}
        matchCount={0}
        onClear={() => {}}
      />,
    );
    const input = container.querySelector('input[type="search"]') as HTMLInputElement;
    expect(input).toBeTruthy();
    fireEvent.change(input, { target: { value: 'bug' } });
    expect(onChange).toHaveBeenCalledWith('bug');
  });

  it('shows match count when a query is present', () => {
    const { getByText } = render(
      <SearchOverlay
        value="bug"
        onChange={() => {}}
        matchCount={3}
        onClear={() => {}}
      />,
    );
    expect(getByText('3 cards match')).toBeTruthy();
  });

  it('Clear button calls onClear', () => {
    const onClear = vi.fn();
    const { getByText } = render(
      <SearchOverlay
        value="bug"
        onChange={() => {}}
        matchCount={1}
        onClear={onClear}
      />,
    );
    fireEvent.click(getByText('Clear'));
    expect(onClear).toHaveBeenCalledTimes(1);
  });
});
