/**
 * InlineEditor.test.tsx — covers the discard / cancel paths (empty
 * placeholder cards should disappear when the user clicks away without
 * typing) and the existing Escape semantics.
 */
import * as React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, act, cleanup } from '@testing-library/react';
import { InlineEditor } from '@/ui/InlineEditor';

describe('InlineEditor', () => {
  afterEach(() => {
    cleanup();
  });

  it('blur on an initially-empty editor dispatches discard event and calls onCancel', async () => {
    const onCommit = vi.fn();
    const onCancel = vi.fn();
    const discardSpy = vi.fn();
    const committedSpy = vi.fn();
    window.addEventListener('kanban-pro:discard-empty-card', discardSpy);
    window.addEventListener('kanban-pro:card-committed', committedSpy);

    const { container } = render(
      <InlineEditor
        cardId="c-new"
        initialValue=""
        onCommit={onCommit}
        onCancel={onCancel}
      />,
    );
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    expect(textarea).toBeTruthy();
    // Simulate blur without any input.
    await act(async () => {
      textarea.dispatchEvent(new Event('blur', { bubbles: true }));
    });

    expect(discardSpy).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCommit).not.toHaveBeenCalled();
    expect(committedSpy).not.toHaveBeenCalled();

    window.removeEventListener('kanban-pro:discard-empty-card', discardSpy);
    window.removeEventListener('kanban-pro:card-committed', committedSpy);
  });

  it('blur on an editor with content dispatches card-committed and runs onCommit', async () => {
    const onCommit = vi.fn();
    const onCancel = vi.fn();
    const discardSpy = vi.fn();
    const committedSpy = vi.fn();
    window.addEventListener('kanban-pro:discard-empty-card', discardSpy);
    window.addEventListener('kanban-pro:card-committed', committedSpy);

    const { container } = render(
      <InlineEditor
        cardId="c-new"
        initialValue=""
        onCommit={onCommit}
        onCancel={onCancel}
      />,
    );
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    await act(async () => {
      textarea.value = 'Real content';
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      textarea.dispatchEvent(new Event('blur', { bubbles: true }));
    });

    expect(onCommit).toHaveBeenCalledWith('Real content');
    expect(onCancel).not.toHaveBeenCalled();
    expect(discardSpy).not.toHaveBeenCalled();
    expect(committedSpy).toHaveBeenCalledTimes(1);

    window.removeEventListener('kanban-pro:discard-empty-card', discardSpy);
    window.removeEventListener('kanban-pro:card-committed', committedSpy);
  });

  it('clearing an existing card to empty still commits (does NOT discard)', async () => {
    // Distinguishes "user blanked an existing card" (commit empty) from
    // "user clicked + Add card and walked away" (discard placeholder).
    const onCommit = vi.fn();
    const onCancel = vi.fn();
    const discardSpy = vi.fn();
    window.addEventListener('kanban-pro:discard-empty-card', discardSpy);

    const { container } = render(
      <InlineEditor
        cardId="c-existing"
        initialValue="Some old text"
        onCommit={onCommit}
        onCancel={onCancel}
      />,
    );
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    await act(async () => {
      textarea.value = '';
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      textarea.dispatchEvent(new Event('blur', { bubbles: true }));
    });

    expect(onCommit).toHaveBeenCalledWith('');
    expect(onCancel).not.toHaveBeenCalled();
    expect(discardSpy).not.toHaveBeenCalled();

    window.removeEventListener('kanban-pro:discard-empty-card', discardSpy);
  });

  it('Escape on an empty editor dispatches discard and runs onCancel', () => {
    const onCommit = vi.fn();
    const onCancel = vi.fn();
    const discardSpy = vi.fn();
    window.addEventListener('kanban-pro:discard-empty-card', discardSpy);

    const { container } = render(
      <InlineEditor
        cardId="c-new"
        initialValue=""
        onCommit={onCommit}
        onCancel={onCancel}
      />,
    );
    const wrapper = container.querySelector('.inline-editor') as HTMLElement;
    fireEvent.keyDown(wrapper, { key: 'Escape' });

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(discardSpy).toHaveBeenCalledTimes(1);
    expect(onCommit).not.toHaveBeenCalled();

    window.removeEventListener('kanban-pro:discard-empty-card', discardSpy);
  });

  it('Escape on an editor with existing content runs onCancel and does NOT commit', () => {
    const onCommit = vi.fn();
    const onCancel = vi.fn();
    const discardSpy = vi.fn();
    window.addEventListener('kanban-pro:discard-empty-card', discardSpy);

    const { container } = render(
      <InlineEditor
        cardId="c-existing"
        initialValue="Has text"
        onCommit={onCommit}
        onCancel={onCancel}
      />,
    );
    const wrapper = container.querySelector('.inline-editor') as HTMLElement;
    fireEvent.keyDown(wrapper, { key: 'Escape' });

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCommit).not.toHaveBeenCalled();
    // Existing content should never trigger the discard path.
    expect(discardSpy).not.toHaveBeenCalled();

    window.removeEventListener('kanban-pro:discard-empty-card', discardSpy);
  });
});
