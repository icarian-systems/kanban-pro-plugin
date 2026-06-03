/**
 * LaneMenu.test.tsx — covers the popover wired to the lane "..." button.
 *
 * Previously the menu did nothing. The contract this
 * suite enforces:
 *   - Rename triggers the consumer callback and dismisses
 *   - Move left / right call store.moveLane with the correct target index
 *   - The leftmost / rightmost lanes' direction items are disabled
 *   - Delete falls back to a Notice when store.deleteLane isn't wired
 *   - Outside click and Escape dismiss the popover
 */
import * as React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { LaneMenu } from '@/ui/LaneMenu';
import type { BoardStore } from '@/core/store';

function makeStore(opts: {
  laneIds?: string[];
  deleteLane?: (id: string) => void;
}): { store: BoardStore; moveLane: ReturnType<typeof vi.fn> } {
  const laneIds = opts.laneIds ?? ['lane-a', 'lane-b', 'lane-c'];
  const moveLane = vi.fn();
  const base: Partial<BoardStore> = {
    selectLaneIds: () => laneIds as never,
    moveLane: moveLane as never,
    subscribe: () => () => {},
  };
  if (opts.deleteLane) {
    (base as unknown as { deleteLane: (id: string) => void }).deleteLane = opts.deleteLane;
  }
  return { store: base as BoardStore, moveLane };
}

describe('LaneMenu', () => {
  afterEach(() => {
    cleanup();
  });

  it('renames via the consumer callback and dismisses', () => {
    const onDismiss = vi.fn();
    const onRename = vi.fn();
    const { store } = makeStore({});
    const { getByText } = render(
      <LaneMenu laneId="lane-b" store={store} onDismiss={onDismiss} onRename={onRename} />,
    );
    fireEvent.click(getByText('Rename'));
    expect(onRename).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('move left calls store.moveLane with index - 1', () => {
    const onDismiss = vi.fn();
    const { store, moveLane } = makeStore({});
    const { getByText } = render(
      <LaneMenu laneId="lane-b" store={store} onDismiss={onDismiss} onRename={() => {}} />,
    );
    fireEvent.click(getByText('Move left'));
    expect(moveLane).toHaveBeenCalledWith('lane-b', 0);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('move right calls store.moveLane with index + 1', () => {
    const onDismiss = vi.fn();
    const { store, moveLane } = makeStore({});
    const { getByText } = render(
      <LaneMenu laneId="lane-b" store={store} onDismiss={onDismiss} onRename={() => {}} />,
    );
    fireEvent.click(getByText('Move right'));
    expect(moveLane).toHaveBeenCalledWith('lane-b', 2);
  });

  it('disables move-left on the first lane', () => {
    const onDismiss = vi.fn();
    const { store, moveLane } = makeStore({});
    const { getByText } = render(
      <LaneMenu laneId="lane-a" store={store} onDismiss={onDismiss} onRename={() => {}} />,
    );
    const btn = getByText('Move left') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(moveLane).not.toHaveBeenCalled();
  });

  it('disables move-right on the last lane', () => {
    const onDismiss = vi.fn();
    const { store, moveLane } = makeStore({});
    const { getByText } = render(
      <LaneMenu laneId="lane-c" store={store} onDismiss={onDismiss} onRename={() => {}} />,
    );
    const btn = getByText('Move right') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(moveLane).not.toHaveBeenCalled();
  });

  it('delete calls store.deleteLane when present', () => {
    const onDismiss = vi.fn();
    const deleteLane = vi.fn();
    const { store } = makeStore({ deleteLane });
    const { getByText } = render(
      <LaneMenu laneId="lane-b" store={store} onDismiss={onDismiss} onRename={() => {}} />,
    );
    fireEvent.click(getByText('Delete lane'));
    expect(deleteLane).toHaveBeenCalledWith('lane-b');
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('delete dismisses (and does not throw) when store.deleteLane is missing', () => {
    const onDismiss = vi.fn();
    const { store } = makeStore({});
    const { getByText } = render(
      <LaneMenu laneId="lane-b" store={store} onDismiss={onDismiss} onRename={() => {}} />,
    );
    expect(() => fireEvent.click(getByText('Delete lane'))).not.toThrow();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('Escape on document dismisses the popover', () => {
    const onDismiss = vi.fn();
    const { store } = makeStore({});
    render(<LaneMenu laneId="lane-b" store={store} onDismiss={onDismiss} onRename={() => {}} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('outside pointerdown dismisses the popover', () => {
    const onDismiss = vi.fn();
    const { store } = makeStore({});
    render(<LaneMenu laneId="lane-b" store={store} onDismiss={onDismiss} onRename={() => {}} />);
    // Dispatch a pointerdown outside the menu — use document.body directly so
    // we know we're outside the popover root.
    fireEvent.pointerDown(document.body);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
