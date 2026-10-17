import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { SavedSearchList } from '../SavedSearchList';
import { toView } from '../../../logic/savedSearches';
import { SortKey, SortOrder as ProtoSortOrder } from '../../../api/octodeck/v1/query_pb';

describe('SavedSearchList component (edit mode)', () => {
  const sampleSearches = [
    toView({
      id: 's1',
      name: 'Alpha',
      query: 'repo:kubernetes/kubernetes',
    }),
    toView({
      id: 's2',
      name: 'Beta',
      query: 'repo:kubernetes/website',
      sort: { key: SortKey.CREATED, order: ProtoSortOrder.DESC },
    }),
    toView({
      id: 's3',
      name: 'Gamma',
      query: 'triage:acked label:bug',
    }),
  ];

  it('renders section header Pinned and handles empty state', () => {
    render(
      <SavedSearchList
        searches={[]}
        onSelectSearch={vi.fn()}
      />
    );

    const section = screen.getByTestId('saved-searches-section');
    expect(section.textContent).toContain('Pinned');
    const headerTitle = section.querySelector('div.text-xs.font-bold');
    expect(headerTitle?.querySelector('svg')).toBeNull();
    expect(
      screen.getByText('Pin a search with the pin button in the search box')
    ).toBeDefined();
  });

  it('toggles edit mode when clicking pencil / Done button and shows pencil only on header hover', () => {
    render(
      <SavedSearchList
        searches={sampleSearches}
        onSelectSearch={vi.fn()}
      />
    );

    // Initial normal list
    expect(screen.getByTestId('saved-searches-list')).toBeDefined();
    expect(screen.queryByTestId('saved-searches-edit-list')).toBeNull();

    const editBtn = screen.getByTestId('edit-saved-searches-button');
    expect(editBtn.getAttribute('aria-label')).toBe('Edit pinned searches');
    // Pencil button is hidden until header hover or focus
    expect(editBtn.className).toContain('opacity-0');
    expect(editBtn.className).toContain('group-hover/pinned-header:opacity-100');
    expect(editBtn.className).toContain('focus-visible:opacity-100');
    expect(editBtn.closest('.group\\/pinned-header')).not.toBeNull();

    // Toggle edit mode
    fireEvent.click(editBtn);

    expect(screen.queryByTestId('saved-searches-list')).toBeNull();
    expect(screen.getByTestId('saved-searches-edit-list')).toBeDefined();
    expect(editBtn.textContent).toBe('Done');
    // Done button is always visible during editing
    expect(editBtn.className).not.toContain('opacity-0');
    expect(editBtn.className).not.toContain('group-hover/pinned-header:opacity-100');

    // Toggle Done
    fireEvent.click(editBtn);
    expect(screen.getByTestId('saved-searches-list')).toBeDefined();
    expect(screen.queryByTestId('saved-searches-edit-list')).toBeNull();
    expect(editBtn.getAttribute('aria-label')).toBe('Edit pinned searches');
    expect(editBtn.className).toContain('opacity-0');
    expect(editBtn.className).toContain('group-hover/pinned-header:opacity-100');
  });

  it('invokes onSelectSearch when clicking a search in the normal list', () => {
    const onSelectSearch = vi.fn();
    render(
      <SavedSearchList
        searches={sampleSearches}
        onSelectSearch={onSelectSearch}
      />
    );

    fireEvent.click(screen.getByTestId('saved-search-row-Alpha'));
    expect(onSelectSearch).toHaveBeenCalledWith(sampleSearches[0]);
  });

  it('previews non-default stored sort and hides preview for default sort', () => {
    render(
      <SavedSearchList
        searches={sampleSearches}
        onSelectSearch={vi.fn()}
      />
    );
    fireEvent.click(screen.getByTestId('edit-saved-searches-button'));

    // Alpha has default sort -> no preview
    expect(screen.queryByTestId('saved-search-sort-preview-Alpha')).toBeNull();

    // Beta has CREATED DESC -> preview visible
    const betaSort = screen.getByTestId('saved-search-sort-preview-Beta');
    expect(betaSort.textContent).toBe('Creation date, newest first');
  });

  it('calls onEditSearch when clicking the row pencil edit button', () => {
    const onEditSearch = vi.fn();
    render(
      <SavedSearchList
        searches={sampleSearches}
        onSelectSearch={vi.fn()}
        onEditSearch={onEditSearch}
      />
    );
    fireEvent.click(screen.getByTestId('edit-saved-searches-button'));

    const pencilBtn = screen.getByTestId('edit-saved-search-Alpha');
    expect(pencilBtn.getAttribute('aria-label')).toBe('Edit Alpha');

    fireEvent.click(pencilBtn);
    expect(onEditSearch).toHaveBeenCalledWith(sampleSearches[0]);
  });

  it('requires confirmation before deleting and invokes onDelete', () => {
    const onDelete = vi.fn().mockResolvedValue(undefined);
    render(
      <SavedSearchList
        searches={sampleSearches}
        onSelectSearch={vi.fn()}
        onDelete={onDelete}
      />
    );
    fireEvent.click(screen.getByTestId('edit-saved-searches-button'));

    // Click trash button on Alpha
    fireEvent.click(screen.getByTestId('delete-saved-search-Alpha'));

    // Confirmation bar appears
    expect(screen.getByText('Delete “Alpha”?')).toBeDefined();

    // Cancel dismisses confirmation
    fireEvent.click(screen.getByTestId('cancel-delete-saved-search-Alpha'));
    expect(screen.queryByText('Delete “Alpha”?')).toBeNull();
    expect(onDelete).not.toHaveBeenCalled();

    // Click delete again and confirm
    fireEvent.click(screen.getByTestId('delete-saved-search-Alpha'));
    fireEvent.click(screen.getByTestId('confirm-delete-saved-search-Alpha'));
    expect(onDelete).toHaveBeenCalledWith('s1');
  });

  it('reorders searches by keyboard ArrowUp and ArrowDown and updates polite live region', () => {
    const onReorder = vi.fn();
    render(
      <SavedSearchList
        searches={sampleSearches}
        onSelectSearch={vi.fn()}
        onReorder={onReorder}
      />
    );
    fireEvent.click(screen.getByTestId('edit-saved-searches-button'));

    const handleBeta = screen.getByLabelText('Reorder Beta');

    // Move Beta (index 1) down to index 2
    fireEvent.keyDown(handleBeta, { key: 'ArrowDown' });
    expect(onReorder).toHaveBeenCalledWith(['s1', 's3', 's2']);
    expect(document.activeElement).toBe(handleBeta);
    expect(screen.getByTestId('saved-searches-live-region').textContent).toBe(
      'Moved Beta to position 3 of 3'
    );

    onReorder.mockClear();

    // Move Beta (index 1) up to index 0
    fireEvent.keyDown(handleBeta, { key: 'ArrowUp' });
    expect(onReorder).toHaveBeenCalledWith(['s2', 's1', 's3']);
    expect(document.activeElement).toBe(handleBeta);
    expect(screen.getByTestId('saved-searches-live-region').textContent).toBe(
      'Moved Beta to position 1 of 3'
    );
  });

  it('reorders searches with drag and drop events', () => {
    const onReorder = vi.fn();
    render(
      <SavedSearchList
        searches={sampleSearches}
        onSelectSearch={vi.fn()}
        onReorder={onReorder}
      />
    );
    fireEvent.click(screen.getByTestId('edit-saved-searches-button'));

    const rowAlpha = screen.getByTestId('saved-search-edit-row-Alpha');
    const rowGamma = screen.getByTestId('saved-search-edit-row-Gamma');

    // Simulate drag start on Alpha
    fireEvent.dragStart(rowAlpha, {
      dataTransfer: { effectAllowed: 'move', setData: vi.fn() },
    });

    // Simulate drag over Gamma (index 2)
    fireEvent.dragOver(rowGamma, {
      currentTarget: {
        getBoundingClientRect: () => ({ top: 100, height: 40 }),
      },
      clientY: 130, // after midpoint
      dataTransfer: {},
    });

    // Drop on Gamma
    fireEvent.drop(rowGamma, {
      currentTarget: {
        getBoundingClientRect: () => ({ top: 100, height: 40 }),
      },
      clientY: 130,
      dataTransfer: {},
    });

    expect(onReorder).toHaveBeenCalledWith(['s2', 's3', 's1']);
  });
});
