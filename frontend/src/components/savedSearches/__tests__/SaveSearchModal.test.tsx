import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { create } from '@bufbuild/protobuf';
import { Code, ConnectError } from '@connectrpc/connect';
import { SaveSearchModal } from '../SaveSearchModal';
import { toView } from '../../../logic/savedSearches';
import {
  ExprErrorSchema,
  Field,
  SortKey,
  SortOrder as ProtoSortOrder,
  type Expr,
  type Sort,
} from '../../../api/octodeck/v1/query_pb';
import type { Item } from '../../../api/octodeck/v1/resources_pb';
import {
  defaultHandlers,
  predicatesOf,
  renderWithDaemon,
  type OctoDeckHandlers,
} from '../../../test/rpcTestUtils';
import { SEARCH_DEBOUNCE_MS } from '../../../hooks/useDashboardData';

function sampleItem(id: string, number: number, title: string): Item {
  return {
    id,
    repo: 'kubernetes/kubernetes',
    number,
    title,
  } as unknown as Item;
}

function renderModal(
  props: React.ComponentProps<typeof SaveSearchModal>,
  handlers: OctoDeckHandlers = {}
) {
  return renderWithDaemon(<SaveSearchModal {...props} />, defaultHandlers(handlers));
}

describe('SaveSearchModal component', () => {
  it('suggests a name based on the query in create mode', () => {
    renderModal({
      isOpen: true,
      queryText: 'repo:kubernetes/kubernetes',
      sort: 'updated',
      order: 'desc',
      onClose: vi.fn(),
    });

    expect(screen.getByRole('heading', { name: 'Pin search' })).toBeDefined();
    const input = screen.getByLabelText(/^Name$/i) as HTMLInputElement;
    expect(input.value).toBe('kubernetes/kubernetes');
    expect(
      (screen.getByTestId('saved-search-query-input') as HTMLTextAreaElement).value
    ).toBe('repo:kubernetes/kubernetes');
    expect(screen.getByTestId('saved-search-preview-count')).toBeDefined();
    expect(
      within(screen.getByTestId('saved-search-preview')).getByRole('button', {
        name: 'Sort options',
      }).textContent
    ).toContain('Latest Activity');
  });

  it('autofocuses and selects the name input on open', () => {
    renderModal({
      isOpen: true,
      queryText: 'repo:kubernetes/kubernetes',
      sort: 'updated',
      order: 'desc',
      onClose: vi.fn(),
    });

    const input = screen.getByLabelText(/^Name$/i) as HTMLInputElement;
    expect(document.activeElement).toBe(input);
  });

  it('validates empty name, length, control characters, and duplicates', async () => {
    const onSave = vi.fn();
    const existing = [{ id: 's1', name: 'Existing Search' }];

    renderModal({
      isOpen: true,
      queryText: 'repo:kubernetes/kubernetes',
      sort: 'updated',
      order: 'desc',
      existingSearches: existing,
      onClose: vi.fn(),
      onSave,
    });

    const input = screen.getByLabelText(/^Name$/i);

    // Empty name
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    expect(await screen.findByText('Name is required.')).toBeDefined();
    expect(onSave).not.toHaveBeenCalled();

    // Control character
    fireEvent.change(input, { target: { value: 'Bad\x07Name' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    expect(await screen.findByText('Name cannot contain control characters.')).toBeDefined();

    // Name too long (> 80)
    fireEvent.change(input, { target: { value: 'x'.repeat(81) } });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    expect(await screen.findByText('Name cannot exceed 80 characters.')).toBeDefined();

    // Duplicate name
    fireEvent.change(input, { target: { value: 'existing search' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    expect(await screen.findByText('A saved search with this name already exists.')).toBeDefined();
  });

  it('validates empty query and query length limit', async () => {
    const onSave = vi.fn();

    renderModal({
      isOpen: true,
      queryText: 'repo:kubernetes/kubernetes',
      sort: 'updated',
      order: 'desc',
      onClose: vi.fn(),
      onSave,
    });

    const queryInput = screen.getByTestId('saved-search-query-input');

    // Empty query
    fireEvent.change(queryInput, { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    expect(await screen.findByText('Query is required.')).toBeDefined();
    expect(onSave).not.toHaveBeenCalled();

    // Query too long (> 1000 characters, including untrimmed trailing whitespace)
    fireEvent.change(queryInput, { target: { value: 'a'.repeat(1000) + ' ' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    expect(await screen.findByText('Query cannot exceed 1000 characters.')).toBeDefined();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('renders live preview count, top 3 items summary, and remaining count when > 3 items match', async () => {
    const items = [
      sampleItem('1', 101, 'First PR'),
      sampleItem('2', 102, 'Second PR'),
      sampleItem('3', 103, 'Third PR'),
      sampleItem('4', 104, 'Fourth PR (not shown in top 3)'),
      sampleItem('5', 105, 'Fifth PR (not shown in top 3)'),
    ];

    renderModal(
      {
        isOpen: true,
        queryText: 'repo:kubernetes/kubernetes is:open',
        sort: 'updated',
        order: 'desc',
        onClose: vi.fn(),
      },
      {
        getItems: () => ({ items }),
      }
    );

    expect(await screen.findByText('First PR')).toBeDefined();
    expect(screen.getByTestId('saved-search-preview-count').textContent).toContain('5 items');
    const renderedItems = screen.getAllByTestId('saved-search-preview-item');
    expect(renderedItems).toHaveLength(3);
    expect(renderedItems[0].textContent).toContain('kubernetes/kubernetes#101');
    expect(renderedItems[0].textContent).toContain('First PR');
    expect(renderedItems[1].textContent).toContain('kubernetes/kubernetes#102');
    expect(renderedItems[2].textContent).toContain('kubernetes/kubernetes#103');
    expect(screen.queryByText('Fourth PR (not shown in top 3)')).toBeNull();
    expect(screen.getByTestId('saved-search-preview-more').textContent).toBe('... and 2 more');
  });

  it('renders preview items without more-indicator when 3 or fewer items match', async () => {
    const items = [
      sampleItem('1', 101, 'First PR'),
      sampleItem('2', 102, 'Second PR'),
      sampleItem('3', 103, 'Third PR'),
    ];

    renderModal(
      {
        isOpen: true,
        queryText: 'repo:kubernetes/kubernetes is:open',
        sort: 'updated',
        order: 'desc',
        onClose: vi.fn(),
      },
      {
        getItems: () => ({ items }),
      }
    );

    expect(await screen.findByText('First PR')).toBeDefined();
    expect(screen.getByTestId('saved-search-preview-count').textContent).toContain('3 items');
    expect(screen.getAllByTestId('saved-search-preview-item')).toHaveLength(3);
    expect(screen.queryByTestId('saved-search-preview-more')).toBeNull();
  });

  it('renders empty state when there are no matching preview items', async () => {
    renderModal(
      {
        isOpen: true,
        queryText: 'repo:kubernetes/kubernetes is:open',
        sort: 'updated',
        order: 'desc',
        onClose: vi.fn(),
      },
      {
        getItems: () => ({ items: [] }),
      }
    );

    expect(await screen.findByTestId('saved-search-preview-empty')).toBeDefined();
    expect(screen.getByTestId('saved-search-preview-count').textContent).toContain('0 items');
    expect(screen.getByTestId('saved-search-preview-empty').textContent).toBe('No matching items');
  });

  it('allows changing sort and order via modal SortMenu', () => {
    const onSave = vi.fn();

    renderModal({
      isOpen: true,
      queryText: 'repo:kubernetes/kubernetes',
      sort: 'updated',
      order: 'desc',
      onClose: vi.fn(),
      onSave,
    });

    const sortBtn = within(screen.getByTestId('saved-search-preview')).getByRole('button', {
      name: 'Sort options',
    });
    fireEvent.click(sortBtn);
    fireEvent.click(screen.getByRole('button', { name: /^Creation Date$/i }));

    fireEvent.click(sortBtn);
    fireEvent.click(screen.getByRole('button', { name: /^Ascending$/i }));

    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    expect(onSave).toHaveBeenCalledWith({
      name: 'kubernetes/kubernetes',
      text: 'repo:kubernetes/kubernetes',
      sort: 'created',
      order: 'asc',
    });
  });

  it('submits on Enter and closes on Escape', () => {
    const onSave = vi.fn();
    const onClose = vi.fn();

    renderModal({
      isOpen: true,
      queryText: 'repo:kubernetes/kubernetes',
      sort: 'updated',
      order: 'desc',
      onClose,
      onSave,
    });

    const input = screen.getByLabelText(/^Name$/i);
    fireEvent.change(input, { target: { value: 'Valid Name' } });
    fireEvent.submit(input.closest('form')!);
    expect(onSave).toHaveBeenCalledWith({
      name: 'Valid Name',
      text: 'repo:kubernetes/kubernetes',
      sort: 'updated',
      order: 'desc',
    });

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('closes open SortMenu on Escape without closing the modal', () => {
    const onClose = vi.fn();

    renderModal({
      isOpen: true,
      queryText: 'repo:kubernetes/kubernetes',
      sort: 'updated',
      order: 'desc',
      onClose,
    });

    const sortBtn = within(screen.getByTestId('saved-search-preview')).getByRole('button', {
      name: 'Sort options',
    });
    fireEvent.click(sortBtn);
    expect(screen.getByRole('dialog', { name: 'Sort options' })).toBeDefined();

    // Escape closes SortMenu dialog, does NOT close modal
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Sort options' })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();

    // Second Escape closes the modal
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes open SuggestionList in QueryInput on Escape without closing the modal', () => {
    const onClose = vi.fn();

    renderModal({
      isOpen: true,
      queryText: '',
      sort: 'updated',
      order: 'desc',
      onClose,
      facets: {
        labels: ['bug', 'feature'],
      },
    });

    const queryInput = screen.getByTestId('saved-search-query-input') as HTMLTextAreaElement;
    fireEvent.focus(queryInput);
    fireEvent.change(queryInput, { target: { value: 'is:' } });
    queryInput.setSelectionRange(3, 3);
    fireEvent.select(queryInput);

    // SuggestionList is open
    expect(screen.getByRole('listbox', { name: 'Query suggestions' })).toBeDefined();

    // First Escape closes suggestions, does NOT close modal
    fireEvent.keyDown(queryInput, { key: 'Escape' });
    expect(screen.queryByRole('listbox', { name: 'Query suggestions' })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Pin search' })).toBeDefined();

    // Second Escape closes the modal
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('sends expected Expr and Sort in preview GetItems request, debounces typing, and does not fire while draft has parse issues', async () => {
    const { daemon } = renderModal({
      isOpen: true,
      queryText: 'repo:kubernetes/kubernetes',
      sort: 'updated',
      order: 'desc',
      onClose: vi.fn(),
    });

    // Initial request: should contain repo predicate and updated/desc sort
    await waitFor(() => {
      expect(daemon.requestsFor('GetItems').length).toBeGreaterThanOrEqual(1);
    });
    const initialReq = daemon.lastRequest<{ query?: Expr; sort?: Sort }>('GetItems');
    expect(initialReq?.sort?.key).toBe(SortKey.UPDATED);
    expect(initialReq?.sort?.order).toBe(ProtoSortOrder.DESC);
    const initialPreds = predicatesOf(initialReq?.query);
    expect(initialPreds).toEqual([
      { field: Field.REPO, values: ['kubernetes/kubernetes'], negated: false },
    ]);

    const countBefore = daemon.requestsFor('GetItems').length;
    const queryInput = screen.getByTestId('saved-search-query-input');

    // 1. Typing an invalid query with syntax issues (e.g. unclosed quote or dangling key)
    fireEvent.change(queryInput, { target: { value: 'label:' } });

    // Wait past debounce duration to verify no request is fired with parse issues
    await new Promise((resolve) => setTimeout(resolve, SEARCH_DEBOUNCE_MS + 50));
    expect(daemon.requestsFor('GetItems').length).toBe(countBefore);
    expect(screen.getByTestId('saved-search-preview-count').textContent).toContain('0 items');

    // 2. Typing a valid query: fires debounced request
    fireEvent.change(queryInput, { target: { value: 'repo:octo/deck is:open' } });
    // Before debounce: no immediate new request
    expect(daemon.requestsFor('GetItems').length).toBe(countBefore);

    // After debounce: request fires with expected predicates
    await waitFor(() => {
      expect(daemon.requestsFor('GetItems').length).toBeGreaterThan(countBefore);
    });
    const updatedReq = daemon.lastRequest<{ query?: Expr; sort?: Sort }>('GetItems');
    const updatedPreds = predicatesOf(updatedReq?.query);
    expect(updatedPreds).toEqual([
      { field: Field.REPO, values: ['octo/deck'], negated: false },
      { field: Field.STATE, values: ['open'], negated: false },
    ]);

    // 3. Changing SortMenu updates Sort on next request
    const sortBtn = within(screen.getByTestId('saved-search-preview')).getByRole('button', {
      name: 'Sort options',
    });
    fireEvent.click(sortBtn);
    fireEvent.click(screen.getByRole('button', { name: /^Creation Date$/i }));

    await waitFor(() => {
      const sortedReq = daemon.lastRequest<{ query?: Expr; sort?: Sort }>('GetItems');
      expect(sortedReq?.sort?.key).toBe(SortKey.CREATED);
    });
  });

  it('displays server InvalidArgument errors on modal QueryInput', async () => {
    renderModal(
      {
        isOpen: true,
        queryText: 'is:open state:merged',
        sort: 'updated',
        order: 'desc',
        onClose: vi.fn(),
      },
      {
        getItems: () => {
          throw new ConnectError('invalid query', Code.InvalidArgument, undefined, [
            {
              desc: ExprErrorSchema,
              value: create(ExprErrorSchema, {
                path: 'and.exprs[1]',
                message: 'state "merged" is not supported here',
              }),
            },
          ]);
        },
      }
    );

    const alert = await screen.findByTestId('invalid-query');
    expect(alert.textContent).toContain('state "merged" is not supported here');

    const pills = screen.getAllByTestId('query-pill');
    expect(pills[1].dataset.status).toBe('error');
    expect(pills[1].dataset.tone).toBe('error');
    expect(pills[0].dataset.status).toBe('ok');

    const input = screen.getByTestId('saved-search-query-input');
    expect(input.getAttribute('aria-invalid')).toBe('true');
  });

  it('renders saved-search-query-error when attempting to submit with parse issues', async () => {
    renderModal({
      isOpen: true,
      queryText: 'repo:k8s/k8s',
      sort: 'updated',
      order: 'desc',
      onClose: vi.fn(),
      onSave: vi.fn(),
    });

    const queryInput = screen.getByTestId('saved-search-query-input');
    fireEvent.change(queryInput, { target: { value: 'label:' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));

    const queryErr = await screen.findByTestId('saved-search-query-error');
    expect(queryErr.textContent).toBe('Fix the highlighted parts of the query first');
  });

  it('traps Tab focus within the modal dialog', () => {
    renderModal({
      isOpen: true,
      queryText: 'repo:kubernetes/kubernetes',
      sort: 'updated',
      order: 'desc',
      onClose: vi.fn(),
    });

    const dialog = screen.getByRole('dialog', { name: 'Pin search' });
    const closeBtn = screen.getByRole('button', { name: /Close dialog/i });
    const saveBtn = screen.getByRole('button', { name: /^Save$/i });

    // Focus last element (Save button) and press Tab -> should wrap to first element (Close button)
    saveBtn.focus();
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: false });
    expect(document.activeElement).toBe(closeBtn);

    // Focus first element (Close button) and press Shift+Tab -> should wrap to last element (Save button)
    closeBtn.focus();
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(saveBtn);
  });

  it('previews stored sort in edit mode even when dashboard sort differs', () => {
    const stored = toView({
      id: 's1',
      name: 'Old PRs',
      query: 'type:pr is:open',
      sort: { key: SortKey.CREATED, order: ProtoSortOrder.ASC },
    });

    renderModal({
      isOpen: true,
      mode: 'edit',
      savedSearch: stored,
      queryText: 'type:pr is:open',
      sort: 'updated', // dashboard sort differs!
      order: 'desc',
      onClose: vi.fn(),
    });

    expect(screen.getByRole('heading', { name: 'Edit pinned search' })).toBeDefined();
    expect((screen.getByLabelText(/^Name$/i) as HTMLInputElement).value).toBe('Old PRs');
    expect(
      within(screen.getByTestId('saved-search-preview')).getByRole('button', {
        name: 'Sort options',
      }).textContent
    ).toContain('Creation Date');
  });

  it('supports delete confirmation flow in edit mode', async () => {
    const stored = toView({
      id: 's1',
      name: 'Delete Me',
      query: 'type:pr is:open',
    });
    const onDelete = vi.fn();
    const onClose = vi.fn();

    renderModal({
      isOpen: true,
      mode: 'edit',
      savedSearch: stored,
      queryText: 'type:pr is:open',
      sort: 'updated',
      order: 'desc',
      onClose,
      onDelete,
    });

    // Click Delete button
    fireEvent.click(screen.getByRole('button', { name: /^Delete$/i }));

    // Confirmation prompt appears
    expect(screen.getByTestId('delete-confirm-prompt')).toBeDefined();
    expect(screen.getByText('Delete “Delete Me”?')).toBeDefined();

    // Cancel returns to normal
    fireEvent.click(screen.getByRole('button', { name: /^Cancel$/i }));
    expect(screen.queryByTestId('delete-confirm-prompt')).toBeNull();

    // Re-click Delete and Confirm
    fireEvent.click(screen.getByRole('button', { name: /^Delete$/i }));
    fireEvent.click(screen.getByTestId('confirm-delete-saved-search'));

    await waitFor(() => {
      expect(onDelete).toHaveBeenCalledWith('s1');
      expect(onClose).toHaveBeenCalled();
    });
  });

  it('preserves its snapshot mode and user-typed name across parent rerenders', () => {
    const { rerender } = renderModal({
      isOpen: true,
      mode: 'create',
      queryText: 'repo:k8s/k8s',
      sort: 'updated',
      order: 'desc',
      onClose: vi.fn(),
    });

    const input = screen.getByLabelText(/^Name$/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'My Custom Title' } });
    expect(input.value).toBe('My Custom Title');
    expect(screen.getByRole('heading', { name: 'Pin search' })).toBeDefined();

    // Rerender with mode="edit" and savedSearch as if a create response made the search active
    rerender(
      <SaveSearchModal
        isOpen={true}
        mode="edit"
        savedSearch={toView({ id: 's1', name: 'My Custom Title', query: 'repo:k8s/k8s' })}
        queryText="repo:k8s/k8s"
        sort="updated"
        order="desc"
        onClose={vi.fn()}
      />
    );

    // Stays in create mode ("Pin search" heading) and keeps user-typed name
    expect(screen.getByRole('heading', { name: 'Pin search' })).toBeDefined();
    expect(input.value).toBe('My Custom Title');
    expect(screen.queryByRole('button', { name: /^Delete$/i })).toBeNull();
  });

  it('supports [Save as new] and [Update] footer buttons in edit and modified mode', async () => {
    const stored = toView({
      id: 's1',
      name: 'K8s Bugs',
      query: 'repo:kubernetes/kubernetes label:kind/bug',
      sort: { key: SortKey.UPDATED, order: ProtoSortOrder.DESC },
    });
    const onUpdate = vi.fn();
    const onSave = vi.fn();
    const onClose = vi.fn();

    renderModal({
      isOpen: true,
      mode: 'modified',
      savedSearch: stored,
      queryText: 'repo:kubernetes/kubernetes label:kind/bug is:issue',
      sort: 'updated',
      order: 'desc',
      onClose,
      onUpdate,
      onSave,
    });

    expect(screen.getByRole('heading', { name: 'Edit pinned search' })).toBeDefined();
    const saveAsNewBtn = screen.getByTestId('save-as-new-button');
    const updateBtn = screen.getByTestId('update-saved-search-button');
    expect(saveAsNewBtn).toBeDefined();
    expect(updateBtn).toBeDefined();

    const nameInput = screen.getByLabelText(/^Name$/i) as HTMLInputElement;
    expect(nameInput.value).toBe('K8s Bugs');

    // 1. Click Save as new without renaming -> inline error, focus/select input, no save
    fireEvent.click(saveAsNewBtn);
    expect(await screen.findByText('Give the new pinned search a different name')).toBeDefined();
    expect(document.activeElement).toBe(nameInput);
    expect(onSave).not.toHaveBeenCalled();

    // 2. Change name and click Save as new -> invokes onSave with new name
    fireEvent.change(nameInput, { target: { value: 'New K8s Bugs' } });
    fireEvent.click(saveAsNewBtn);
    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith({
        name: 'New K8s Bugs',
        text: 'repo:kubernetes/kubernetes label:kind/bug is:issue',
        sort: 'updated',
        order: 'desc',
      });
      expect(onClose).toHaveBeenCalled();
    });
  });

  it('updates query and sort fields when Update button is clicked in edit mode', async () => {
    const stored = toView({
      id: 's1',
      name: 'Alpha',
      query: 'repo:k8s/k8s',
      sort: { key: SortKey.UPDATED, order: ProtoSortOrder.DESC },
    });
    const onUpdate = vi.fn();
    const onClose = vi.fn();

    renderModal({
      isOpen: true,
      mode: 'edit',
      savedSearch: stored,
      queryText: 'repo:k8s/k8s',
      sort: 'updated',
      order: 'desc',
      onClose,
      onUpdate,
    });

    const queryInput = screen.getByTestId('saved-search-query-input');
    fireEvent.change(queryInput, { target: { value: 'repo:k8s/k8s is:pr' } });

    const sortBtn = within(screen.getByTestId('saved-search-preview')).getByRole('button', {
      name: 'Sort options',
    });
    fireEvent.click(sortBtn);
    fireEvent.click(screen.getByRole('button', { name: /^Creation Date$/i }));

    fireEvent.click(sortBtn);
    fireEvent.click(screen.getByRole('button', { name: /^Ascending$/i }));

    fireEvent.click(screen.getByTestId('update-saved-search-button'));

    await waitFor(() => {
      expect(onUpdate).toHaveBeenCalledWith('s1', {
        name: 'Alpha',
        text: 'repo:k8s/k8s is:pr',
        sort: 'created',
        order: 'asc',
      });
      expect(onClose).toHaveBeenCalled();
    });
  });

  it('strips tab clauses in modified mode when updating an unscoped origin search on Acked tab', () => {
    const stored = toView({
      id: 's1',
      name: 'K8s Bugs',
      query: 'repo:kubernetes/kubernetes label:kind/bug',
      sort: { key: SortKey.UPDATED, order: ProtoSortOrder.DESC },
    });

    renderModal({
      isOpen: true,
      mode: 'modified',
      savedSearch: stored,
      queryText: 'triage:acked repo:kubernetes/kubernetes label:kind/bug is:issue',
      sort: 'updated',
      order: 'desc',
      onClose: vi.fn(),
    });

    // Initial state: tab clause triage:acked is stripped so search stays unscoped when updated
    const queryInput = screen.getByTestId('saved-search-query-input') as HTMLTextAreaElement;
    expect(queryInput.value).toBe('repo:kubernetes/kubernetes label:kind/bug is:issue');
  });
});
