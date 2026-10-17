// Dashboard tests with the daemon mocked at the RPC level: requests go through the real
// connect-query hooks and a router transport. Each test asserts the request the dashboard sends
// (the structured query, sort and facet fields) and renders exactly what the daemon returns —
// the client does no filtering, option extraction or counting of its own.
import { act, fireEvent, renderHook, screen, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { create, type MessageInitShape } from '@bufbuild/protobuf';
import { Code, ConnectError } from '@connectrpc/connect';
import { TransportProvider } from '@connectrpc/connect-query';
import { QueryClientProvider } from '@tanstack/react-query';
import { Dashboard } from '../Dashboard';
import {
  createMockDaemon,
  createTestQueryClient,
  defaultHandlers,
  facetResponse,
  predicatesOf,
  renderWithDaemon,
  type FacetSpec,
  type OctoDeckHandlers,
} from '../../test/rpcTestUtils';
import { useSavedSearches } from '../../hooks/useSavedSearches';
import { queryPillTexts, removeQueryClause, stubQueryPillLayout } from '../../test/queryInput';
import { ItemState, ItemStatus, ItemType, SubscriptionState, type Item, type ItemSchema } from '../../api/octodeck/v1/resources_pb';
import { ExprErrorSchema, Field, SortKey, SortOrder, type Expr } from '../../api/octodeck/v1/query_pb';
import {
  CreateSavedSearchResponseSchema,
  DeleteSavedSearchResponseSchema,
  ReorderSavedSearchesResponseSchema,
  UpdateSavedSearchResponseSchema,
  type CreateSavedSearchRequest,
  type DeleteSavedSearchRequest,
  type GetFacetsRequest,
  type GetItemRequest,
  type GetItemsRequest,
  type ReorderSavedSearchesRequest,
  type ReorderSavedSearchesResponse,
  type UpdateSavedSearchRequest,
} from '../../api/octodeck/v1/service_pb';

vi.mock('../../api/client', async () => {
  const actual = await vi.importActual<typeof import('../../api/client')>('../../api/client');
  return { ...actual, checkStatus: vi.fn().mockResolvedValue({ gh_authenticated: true, version: 'v0.0.1-test' }) };
});

// Plain init objects (not Item messages), so tests can spread overrides into them.
type ItemInit = Exclude<MessageInitShape<typeof ItemSchema>, Item>;
type FacetMap = Partial<Record<Field, FacetSpec[]>>;

const DAY_MS = 86400 * 1000;
const ts = (ms: number) => ({ seconds: BigInt(Math.floor(ms / 1000)), nanos: 0 });

let nextNumber = 100;
function item(id: string, title: string, overrides: Partial<ItemInit> = {}): ItemInit {
  const number = nextNumber++;
  return {
    id,
    repo: 'kubernetes/kubernetes',
    number,
    type: ItemType.PR,
    state: ItemState.OPEN,
    title,
    url: `https://github.com/kubernetes/kubernetes/pull/${number}`,
    author: { login: 'octo' },
    createdAt: ts(Date.now()),
    updatedAt: ts(Date.now()),
    local: { computedStatus: ItemStatus.NEW },
    ...overrides,
  };
}

/** Compact, test-side rendering of a request query: "triage:acked -label:bug label:a,b". */
function describeQuery(expr: Expr | undefined): string {
  return predicatesOf(expr)
    .map((p) => `${p.negated ? '-' : ''}${Field[p.field].toLowerCase()}:${p.values.join(',')}`)
    .join(' ');
}

/**
 * GetItems handler answering from a table keyed by the exact query. An unexpected query fails
 * loudly, so the table doubles as an assertion on every request the dashboard sends.
 */
function itemsByQuery(table: Record<string, ItemInit[]>): NonNullable<OctoDeckHandlers['getItems']> {
  return (req) => {
    const key = describeQuery(req.query);
    if (!(key in table)) throw new ConnectError(`unexpected query "${key}"`, Code.Internal);
    return { items: table[key] };
  };
}

/**
 * GetFacets handler: the dashboard makes one call per distinct query — the selector fields for
 * the current query, and the sidebar fields for the unfiltered inbox and for new:any.
 */
function facets(spec: { selector?: FacetMap | ((query: string) => FacetMap); sidebar?: FacetMap; unread?: FacetMap }) {
  return (req: GetFacetsRequest) => {
    const query = describeQuery(req.query);
    let values: FacetMap | undefined;
    if (req.fields.includes(Field.AUTHOR)) {
      values = typeof spec.selector === 'function' ? spec.selector(query) : spec.selector;
    } else if (query === 'new:any') {
      values = spec.unread;
    } else if (query === '') {
      values = spec.sidebar;
    }
    return facetResponse(req.fields, values ?? {});
  };
}

const lastItemsQuery = (daemon: { lastRequest<T>(n: string): T | undefined }) =>
  describeQuery(daemon.lastRequest<GetItemsRequest>('GetItems')?.query);

const ALLOWED_URL_KEYS = new Set(['q', 'sort', 'order', 'item']);

function assertNoLegacyUrlKeys(search = window.location.search): void {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  for (const key of params.keys()) {
    expect(ALLOWED_URL_KEYS.has(key)).toBe(true);
  }
}

function render(handlers: OctoDeckHandlers) {
  return renderWithDaemon(<Dashboard />, defaultHandlers(handlers));
}

describe('Dashboard (RPC-level)', () => {
  let restoreQueryLayout: () => void;
  beforeEach(() => {
    window.history.pushState(null, '', '/');
    restoreQueryLayout = stubQueryPillLayout();
  });

  afterEach(() => {
    vi.useRealTimers();
    window.history.pushState(null, '', '/');
    restoreQueryLayout();
  });

  describe('items come from GetItems', () => {
    it('renders the daemon result as returned and sends the implicit-inbox query with an explicit sort', async () => {
      // An acked item would have been hidden by the old client-side Inbox filter.
      const { daemon } = render({
        getItems: itemsByQuery({
          '': [item('PR_1', 'Server says inbox'), item('PR_2', 'Server says acked too', { local: { computedStatus: ItemStatus.ACKED } })],
        }),
      });

      expect(await screen.findByText('Server says inbox')).toBeDefined();
      expect(screen.getByText('Server says acked too')).toBeDefined();
      expect(screen.getByText('2 items')).toBeDefined();
      const req = daemon.lastRequest<GetItemsRequest>('GetItems')!;
      expect(predicatesOf(req.query)).toEqual([]);
      expect(req.sort).toMatchObject({ key: SortKey.UPDATED, order: SortOrder.DESC });
    });

    it('sends the legacy example URL as the equivalent structured query, in URL order, and rewrites to ?q=', async () => {
      window.history.pushState(null, '', '/?repo=a/b&author=x&triage=acked&state=closed&label=bug');
      const { daemon } = render({
        getItems: itemsByQuery({ 'repo:a/b author:x triage:acked state:closed label:bug': [item('PR_1', 'Matching PR')] }),
      });

      expect(await screen.findByText('Matching PR')).toBeDefined();
      expect(predicatesOf(daemon.requestsFor<GetItemsRequest>('GetItems')[0].query)).toEqual([
        { field: Field.REPO, values: ['a/b'], negated: false },
        { field: Field.AUTHOR, values: ['x'], negated: false },
        { field: Field.TRIAGE, values: ['acked'], negated: false },
        { field: Field.STATE, values: ['closed'], negated: false },
        { field: Field.LABEL, values: ['bug'], negated: false },
      ]);
      expect(window.location.search).toBe('?q=repo:a/b+author:x+triage:acked+state:closed+label:bug');
      assertNoLegacyUrlKeys();
    });

    it('sends the sort as a separate field and keeps the daemon order', async () => {
      window.history.pushState(null, '', '/?sort=created&order=asc');
      const { daemon } = render({
        getItems: itemsByQuery({ '': [item('PR_B', 'Second by title'), item('PR_A', 'First by title')] }),
      });

      expect(await screen.findByText('Second by title')).toBeDefined();
      expect(daemon.lastRequest<GetItemsRequest>('GetItems')!.sort).toMatchObject({ key: SortKey.CREATED, order: SortOrder.ASC });
      const ids = [...document.querySelectorAll('[data-item-id]')].map((el) => el.getAttribute('data-item-id'));
      expect(ids).toEqual(['PR_B', 'PR_A']);

      fireEvent.click(screen.getByRole('button', { name: /Sort options/i }));
      fireEvent.click(screen.getByRole('button', { name: /^Last Acked$/i }));
      await waitFor(() =>
        expect(daemon.lastRequest<GetItemsRequest>('GetItems')!.sort).toMatchObject({ key: SortKey.ACKED, order: SortOrder.ASC })
      );
      expect(window.location.search).toBe('?sort=acked&order=asc');
    });

    it('keeps the previous result on screen while a changed query is in flight', async () => {
      let release: () => void = () => {};
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      render({
        getItems: async (req) => {
          if (describeQuery(req.query) === 'state:open') {
            await pending;
            return { items: [item('PR_2', 'Only Open')] };
          }
          return { items: [item('PR_1', 'Everything')] };
        },
      });
      expect(await screen.findByText('Everything')).toBeDefined();

      fireEvent.click(within(screen.getByRole('group', { name: /Filter item state/i })).getByRole('button', { name: /Open/i }));
      await act(async () => {
        await new Promise((r) => setTimeout(r, 50));
      });
      expect(screen.queryByText(/Connecting to OctoDeck Daemon/i)).toBeNull();
      expect(screen.getByText('Everything')).toBeDefined();

      release();
      expect(await screen.findByText('Only Open')).toBeDefined();
      expect(screen.queryByText('Everything')).toBeNull();
    });

    it('polls GetItems and the facets every 3 s', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const { daemon } = render({ getItems: itemsByQuery({ '': [item('PR_1', 'Polled PR')] }) });
      await screen.findByText('Polled PR');
      const items = daemon.requestsFor('GetItems').length;
      const facetCalls = daemon.requestsFor('GetFacets').length;

      await act(async () => {
        await vi.advanceTimersByTimeAsync(3100);
      });

      await waitFor(() => expect(daemon.requestsFor('GetItems').length).toBeGreaterThan(items));
      expect(daemon.requestsFor('GetFacets').length).toBeGreaterThanOrEqual(facetCalls + 2);
    });

    it('refreshes the list and the facets after an ack', async () => {
      const ackItem = vi.fn(() => ({}));
      const { daemon } = render({ getItems: itemsByQuery({ '': [item('PR_1', 'Ack me')] }), ackItem });
      await screen.findByText('Ack me');
      const items = daemon.requestsFor('GetItems').length;
      const facetCalls = daemon.requestsFor('GetFacets').length;

      fireEvent.click(screen.getByRole('button', { name: 'Ack item' }));

      await waitFor(() => expect(ackItem).toHaveBeenCalled());
      await waitFor(() => expect(daemon.requestsFor('GetItems').length).toBeGreaterThan(items));
      await waitFor(() => expect(daemon.requestsFor('GetFacets').length).toBeGreaterThanOrEqual(facetCalls + 2));
    });
  });

  describe('controls send predicates', () => {
    it('filters by state with the segmented control', async () => {
      const open = item('PR_1', 'Open PR');
      const closed = item('PR_2', 'Closed PR', { state: ItemState.CLOSED });
      const { daemon } = render({ getItems: itemsByQuery({ '': [open, closed], 'state:open': [open], 'state:closed': [closed] }) });
      expect(await screen.findByText('Closed PR')).toBeDefined();
      const stateGroup = screen.getByRole('group', { name: /Filter item state/i });

      fireEvent.click(within(stateGroup).getByRole('button', { name: /^Open$/i }));
      await waitFor(() => expect(screen.queryByText('Closed PR')).toBeNull());
      expect(lastItemsQuery(daemon)).toBe('state:open');
      expect(window.location.search).toBe('?q=state:open');
      assertNoLegacyUrlKeys();

      fireEvent.click(within(stateGroup).getByRole('button', { name: /^Closed$/i }));
      await waitFor(() => expect(screen.queryByText('Open PR')).toBeNull());
      expect(lastItemsQuery(daemon)).toBe('state:closed');
      expect(window.location.search).toBe('?q=state:closed');
      assertNoLegacyUrlKeys();

      fireEvent.click(within(stateGroup).getByRole('button', { name: /^All$/i }));
      expect(await screen.findByText('Closed PR')).toBeDefined();
      expect(window.location.search).toBe('');
    });

    it('filters by type with the Type menu', async () => {
      const pr = item('PR_1', 'Fix bug PR');
      const issue = item('ISSUE_1', 'Open feature issue', { type: ItemType.ISSUE });
      const { daemon } = render({ getItems: itemsByQuery({ '': [pr, issue], 'type:pr': [pr], 'type:issue': [issue] }) });
      expect(await screen.findByText('Open feature issue')).toBeDefined();
      const typeTrigger = screen.getByRole('button', { name: /Filter by type/i });

      fireEvent.click(typeTrigger);
      fireEvent.click(screen.getByRole('button', { name: /^Pull requests$/i }));
      await waitFor(() => expect(screen.queryByText('Open feature issue')).toBeNull());
      expect(lastItemsQuery(daemon)).toBe('type:pr');
      expect(window.location.search).toBe('?q=type:pr');
      assertNoLegacyUrlKeys();

      fireEvent.click(typeTrigger);
      fireEvent.click(screen.getByRole('button', { name: /^Issues$/i }));
      await waitFor(() => expect(screen.queryByText('Fix bug PR')).toBeNull());
      expect(lastItemsQuery(daemon)).toBe('type:issue');
      expect(window.location.search).toBe('?q=type:issue');
      assertNoLegacyUrlKeys();

      fireEvent.click(typeTrigger);
      fireEvent.click(screen.getByRole('button', { name: /^Issues$/i }));
      expect(await screen.findByText('Fix bug PR')).toBeDefined();
      expect(window.location.search).toBe('');
    });

    it('switches triage tabs: New is new:any, Acked is triage:acked, Inbox is the implicit scope', async () => {
      const newItem = item('PR_1', 'New PR', { local: { computedStatus: ItemStatus.NEW_ACTIVITY } });
      const idleItem = item('PR_2', 'Idle PR', { local: { computedStatus: ItemStatus.IDLE } });
      const ackedItem = item('PR_3', 'Acked PR', { local: { computedStatus: ItemStatus.ACKED } });
      const { daemon } = render({
        getItems: itemsByQuery({ '': [newItem, idleItem], 'new:any': [newItem], 'triage:acked': [ackedItem] }),
      });
      expect(await screen.findByText('Idle PR')).toBeDefined();

      fireEvent.click(screen.getByRole('button', { name: /^New/i }));
      await waitFor(() => expect(screen.queryByText('Idle PR')).toBeNull());
      expect(lastItemsQuery(daemon)).toBe('new:any');
      expect(window.location.search).toBe('?q=new:any');
      assertNoLegacyUrlKeys();

      const titleDropdown = screen.getByLabelText(/Select triage status/i);
      fireEvent.click(titleDropdown);
      fireEvent.click(
        within(screen.getByRole('dialog', { name: 'Triage status' })).getByRole('button', {
          name: /Acked/i,
        })
      );
      expect(await screen.findByText('Acked PR')).toBeDefined();
      expect(screen.queryByText('New PR')).toBeNull();
      expect(lastItemsQuery(daemon)).toBe('triage:acked');
      expect(window.location.search).toBe('?q=triage:acked');
      assertNoLegacyUrlKeys();

      fireEvent.click(titleDropdown);
      fireEvent.click(
        within(screen.getByRole('dialog', { name: 'Triage status' })).getByRole('button', {
          name: /Inbox/i,
        })
      );
      expect(await screen.findByText('Idle PR')).toBeDefined();
      // Back to the unfiltered query: its cached result is shown (the query key includes the request).
    });

    it('filters by tracking and removes the filter with its chip', async () => {
      const tracked = item('PR_T', 'Tracked PR', { viewerSubscription: SubscriptionState.SUBSCRIBED });
      const untracked = item('PR_U', 'Untracked PR', { viewerSubscription: SubscriptionState.UNSUBSCRIBED });
      const { daemon } = render({
        getItems: itemsByQuery({ '': [tracked, untracked], 'tracking:false': [untracked], 'tracking:true': [tracked] }),
      });
      expect(await screen.findByText('Tracked PR')).toBeDefined();
      const activityTrigger = screen.getByRole('button', { name: /Filter by activity/i });

      fireEvent.click(activityTrigger);
      fireEvent.click(within(activityTrigger.parentElement!).getByRole('button', { name: /^Unsubscribed$/i }));
      await waitFor(() => expect(screen.queryByText('Tracked PR')).toBeNull());
      expect(lastItemsQuery(daemon)).toBe('tracking:false');
      expect(window.location.search).toBe('?q=tracking:false');
      assertNoLegacyUrlKeys();
      expect(queryPillTexts()).toContain('tracking:false');

      fireEvent.click(activityTrigger);
      fireEvent.click(within(activityTrigger.parentElement!).getByRole('button', { name: /^Subscribed$/i }));
      await waitFor(() => expect(screen.queryByText('Untracked PR')).toBeNull());
      expect(lastItemsQuery(daemon)).toBe('tracking:true');
      expect(window.location.search).toBe('?q=tracking:true');
      assertNoLegacyUrlKeys();

      removeQueryClause('tracking:true');
      expect(await screen.findByText('Untracked PR')).toBeDefined();
      expect(queryPillTexts().some((t) => t.startsWith('tracking:'))).toBe(false);
      // Back to the unfiltered query: its cached result is shown (the query key includes the request).
      expect(window.location.search).toBe('');
    });

    it('filters by assignee:@me with the Assigned toggle', async () => {
      const mine = item('PR_1', 'Assigned PR');
      const other = item('PR_2', 'Unassigned PR');
      const { daemon } = render({ getItems: itemsByQuery({ '': [mine, other], 'assignee:@me': [mine] }) });
      expect(await screen.findByText('Unassigned PR')).toBeDefined();
      const toggle = screen.getByRole('button', { name: /^Assigned$/i });

      fireEvent.click(toggle);
      await waitFor(() => expect(screen.queryByText('Unassigned PR')).toBeNull());
      expect(lastItemsQuery(daemon)).toBe('assignee:@me');
      expect(window.location.search).toBe('?q=assignee:@me');
      assertNoLegacyUrlKeys();

      fireEvent.click(toggle);
      expect(await screen.findByText('Unassigned PR')).toBeDefined();
      expect(window.location.search).toBe('');
    });

    it('selects multiple assignees from the overflow Assignee menu', async () => {
      const a = item('PR_1', 'Alice assigned');
      const b = item('PR_2', 'Bob assigned');
      const c = item('PR_3', 'Carol assigned');
      const { daemon } = render({
        getItems: itemsByQuery({
          '': [a, b, c],
          'assignee:alice': [a],
          'assignee:alice,bob': [a, b],
        }),
        getFacets: facets({
          selector: { [Field.ASSIGNEE]: [['alice', 1], ['bob', 1], ['carol', 1]] },
        }),
      });
      expect(await screen.findByText('Carol assigned')).toBeDefined();

      fireEvent.click(screen.getByRole('button', { name: /More filters/i }));
      fireEvent.click(screen.getByRole('button', { name: /Filter by assignee/i }));
      fireEvent.click(await screen.findByRole('option', { name: /^@alice$/i }));
      await waitFor(() => expect(lastItemsQuery(daemon)).toBe('assignee:alice'));

      // Menu remains open after first toggle
      fireEvent.click(screen.getByRole('option', { name: /^@bob$/i }));
      await waitFor(() => expect(lastItemsQuery(daemon)).toBe('assignee:alice,bob'));
      expect(window.location.search).toBe('?q=assignee:alice,bob');
      assertNoLegacyUrlKeys();
    });

    it('filters by author from the facet options (writing author:@me for the pinned you row) and clears with Clear query', async () => {
      const alice = item('PR_1', 'Alice PR', { author: { login: 'alice' } });
      const bob = item('PR_2', 'Bob PR', { author: { login: 'bob' } });
      const { daemon } = render({
        getConfig: () => ({
          config: { pollingIntervalMin: 15, pinnedRepos: [] },
          currentUserLogin: 'alice',
        }),
        getItems: itemsByQuery({ '': [alice, bob], 'author:@me': [alice], 'author:@me,bob': [alice, bob] }),
        getFacets: facets({ selector: { [Field.AUTHOR]: [['alice', 1], ['bob', 1]] } }),
      });
      expect(await screen.findByText('Bob PR')).toBeDefined();

      fireEvent.click(screen.getByRole('button', { name: /Filter by author/i }));
      fireEvent.click(await screen.findByRole('option', { name: /@alice \(you\)/i }));
      await waitFor(() => expect(screen.queryByText('Bob PR')).toBeNull());
      expect(lastItemsQuery(daemon)).toBe('author:@me');
      expect(window.location.search).toBe('?q=author:@me');
      assertNoLegacyUrlKeys();

      fireEvent.click(screen.getByRole('option', { name: /^@bob$/i }));
      await waitFor(() => expect(lastItemsQuery(daemon)).toBe('author:@me,bob'));
      expect(window.location.search).toBe('?q=author:@me,bob');

      fireEvent.click(screen.getByRole('button', { name: 'Clear query' }));
      expect(await screen.findByText('Bob PR')).toBeDefined();
      expect(window.location.search).toBe('');
    });

    it('filters by org and then repo from the combined selector, clearing org when repo is selected', async () => {
      const k8s = item('PR_1', 'K8s core');
      const minikube = item('PR_2', 'Minikube', { repo: 'kubernetes/minikube' });
      const go = item('PR_3', 'Go lang', { repo: 'golang/go' });
      const { daemon } = render({
        getItems: itemsByQuery({
          '': [k8s, minikube, go],
          'org:kubernetes': [k8s, minikube],
          'repo:kubernetes/minikube': [minikube],
        }),
        getFacets: facets({
          selector: {
            [Field.REPO]: [['kubernetes/kubernetes', 1], ['kubernetes/minikube', 1], ['golang/go', 1]],
            [Field.ORG]: [['kubernetes', 2], ['golang', 1]],
          },
        }),
      });
      expect(await screen.findByText('Go lang')).toBeDefined();

      fireEvent.click(screen.getByRole('button', { name: /More filters/i }));
      fireEvent.click(screen.getByRole('button', { name: /Filter by repository/i }));
      fireEvent.click(await screen.findByRole('option', { name: /^kubernetes$/i }));
      await waitFor(() => expect(screen.queryByText('Go lang')).toBeNull());
      expect(lastItemsQuery(daemon)).toBe('org:kubernetes');
      expect(window.location.search).toBe('?q=org:kubernetes');
      assertNoLegacyUrlKeys();

      // Menu stays open; selecting a repo clears the org selection (P3)
      fireEvent.click(screen.getByRole('option', { name: /kubernetes\/minikube/i }));
      await waitFor(() => expect(screen.queryByText('K8s core')).toBeNull());
      expect(lastItemsQuery(daemon)).toBe('repo:kubernetes/minikube');
      expect(window.location.search).toBe('?q=repo:kubernetes/minikube');
      assertNoLegacyUrlKeys();
    });

    it('renders multi-repo clause as a query chip and removes the predicate on ×', async () => {
      window.history.pushState(null, '', '/?repo=a%2Fb&repo=c%2Fd&repo=e%2Ff');
      render({
        getItems: itemsByQuery({
          'repo:a/b,c/d,e/f': [item('PR_1', 'Multi-repo PR')],
          '': [item('PR_1', 'Multi-repo PR'), item('PR_2', 'Other PR')],
        }),
      });

      expect(await screen.findByText('Multi-repo PR')).toBeDefined();
      expect(queryPillTexts()).toEqual(['repo:a/b,c/d,e/f']);

      removeQueryClause('repo:a/b,c/d,e/f');
      expect(await screen.findByText('Other PR')).toBeDefined();
      expect(window.location.search).toBe('');
    });

    it('filters by milestone from the overflow menu and removes it with the chip', async () => {
      const m1 = item('PR_1', 'Milestone 1.32 PR', { milestone: { title: 'v1.32' } });
      const m2 = item('PR_2', 'Milestone 1.33 PR', { milestone: { title: 'v1.33' } });
      const { daemon } = render({
        getItems: itemsByQuery({ '': [m1, m2], 'milestone:v1.32': [m1] }),
        getFacets: facets({ selector: { [Field.MILESTONE]: [['v1.32', 1], ['v1.33', 1]] } }),
      });
      expect(await screen.findByText('Milestone 1.33 PR')).toBeDefined();

      fireEvent.click(screen.getByRole('button', { name: /More filters/i }));
      fireEvent.click(screen.getByRole('button', { name: /Filter by milestone/i }));
      fireEvent.click(await screen.findByRole('option', { name: /^v1\.32$/i }));
      await waitFor(() => expect(screen.queryByText('Milestone 1.33 PR')).toBeNull());
      expect(lastItemsQuery(daemon)).toBe('milestone:v1.32');
      expect(queryPillTexts()).toContain('milestone:v1.32');
      expect(window.location.search).toBe('?q=milestone:v1.32');
      assertNoLegacyUrlKeys();

      removeQueryClause('milestone:v1.32');
      expect(await screen.findByText('Milestone 1.33 PR')).toBeDefined();
      expect(window.location.search).toBe('');
    });

    it('filters by multiple labels, showing the facet label color, and removes the predicate with the chip', async () => {
      const bug = item('PR_1', 'Fix issue 1', { labels: [{ name: 'kind/bug', color: 'd73a4a' }] });
      const feature = item('PR_2', 'Feature 2', { labels: [{ name: 'kind/feature', color: 'a2eeef' }] });
      const docs = item('PR_3', 'Docs 3', { labels: [{ name: 'kind/docs', color: '0075ca' }] });
      const { daemon } = render({
        getItems: itemsByQuery({
          '': [bug, feature, docs],
          'label:kind/bug': [bug],
          'label:kind/bug,kind/feature': [bug, feature],
        }),
        getFacets: facets({
          selector: {
            [Field.LABEL]: [
              ['kind/bug', 1, { color: 'd73a4a' }],
              ['kind/feature', 1, { color: 'a2eeef' }],
              ['kind/docs', 1, { color: '0075ca' }],
            ],
          },
        }),
      });
      expect(await screen.findByText('Docs 3')).toBeDefined();

      fireEvent.click(screen.getByRole('button', { name: /Filter by label/i }));
      const bugOption = await screen.findByRole('option', { name: /kind\/bug/i });
      const swatch = bugOption.querySelector('span[style]') as HTMLElement;
      expect(swatch.style.backgroundColor).toBe('rgb(215, 58, 74)');

      fireEvent.click(bugOption);
      await waitFor(() => expect(screen.queryByText('Docs 3')).toBeNull());
      expect(lastItemsQuery(daemon)).toBe('label:kind/bug');
      expect(queryPillTexts()).toContain('label:kind/bug');
      expect(window.location.search).toBe('?q=label:kind/bug');
      assertNoLegacyUrlKeys();

      // Menu stays open; tick a second label
      fireEvent.click(screen.getByRole('option', { name: /kind\/feature/i }));
      await waitFor(() => expect(lastItemsQuery(daemon)).toBe('label:kind/bug,kind/feature'));
      expect(window.location.search).toBe('?q=label:kind/bug,kind/feature');
      assertNoLegacyUrlKeys();

      removeQueryClause('label:kind/bug,kind/feature');
      expect(await screen.findByText('Docs 3')).toBeDefined();
    });

    it('filters by activity from the Activity menu, updates chips on Acked + Mentions, and resets to new:any on sidebar New', async () => {
      const mentioned = item('PR_1', 'Mentioned PR');
      const newAny = item('PR_2', 'New activity PR');
      const allInbox = item('PR_3', 'Idle PR');
      const { daemon } = render({
        getItems: itemsByQuery({
          '': [mentioned, newAny, allInbox],
          'new:mention': [mentioned],
          'new:any': [mentioned, newAny],
          'triage:acked new:mention': [],
        }),
        getFacets: facets({
          selector: {
            [Field.NEW]: [
              ['item', 1],
              ['mention', 2],
              ['comment', 0],
              ['code', 3],
              ['noise', 0],
            ],
          },
        }),
      });
      expect(await screen.findByText('Idle PR')).toBeDefined();

      const activityTrigger = screen.getByRole('button', { name: /Filter by activity/i });
      fireEvent.click(activityTrigger);
      fireEvent.click(screen.getByRole('option', { name: /^Mentions$/i }));
      await waitFor(() => expect(lastItemsQuery(daemon)).toBe('new:mention'));
      expect(window.location.search).toBe('?q=new:mention');
      assertNoLegacyUrlKeys();
      expect(queryPillTexts()).toContain('new:mention');

      // Switch to Acked via the title menu: new:mention survives alongside triage:acked
      fireEvent.click(screen.getByLabelText(/Select triage status/i));
      fireEvent.click(
        within(screen.getByRole('dialog', { name: 'Triage status' })).getByRole('button', {
          name: /Acked/i,
        })
      );
      await waitFor(() => expect(lastItemsQuery(daemon)).toBe('triage:acked new:mention'));
      expect(window.location.search).toBe('?q=triage:acked+new:mention');
      assertNoLegacyUrlKeys();
      expect(queryPillTexts()).toContain('triage:acked');
      expect(queryPillTexts()).toContain('new:mention');

      // Switch to the New tab via the sidebar: query becomes new:any, sidebar New stays highlighted, and Any is ticked in the menu
      const sidebarNew = screen.getAllByRole('button', { name: /^New/i })[0];
      fireEvent.click(sidebarNew);
      await waitFor(() => expect(lastItemsQuery(daemon)).toBe('new:any'));
      expect(window.location.search).toBe('?q=new:any');
      assertNoLegacyUrlKeys();
      expect(queryPillTexts()).toContain('new:any');
      expect(queryPillTexts()).not.toContain('new:mention');
      expect(sidebarNew.className).toContain('bg-blue-600');

      fireEvent.click(activityTrigger);
      const anyOption = screen.getByRole('option', { name: /^New Activity$/i });
      expect(anyOption.getAttribute('aria-selected')).toBe('true');
    });

    it('distinguishes sidebar New (full workflow reset) from title-menu New (in-place tab switch)', async () => {
      window.history.pushState(null, '', '/?label=bug&sort=created&order=asc');
      const { daemon } = render({
        getItems: itemsByQuery({
          'label:bug': [item('PR_1', 'Bug in inbox')],
          'new:any label:bug': [item('PR_2', 'New bug')],
          'new:any': [item('PR_3', 'All new items')],
        }),
      });
      expect(await screen.findByText('Bug in inbox')).toBeDefined();
      expect(daemon.lastRequest<GetItemsRequest>('GetItems')!.sort).toMatchObject({
        key: SortKey.CREATED,
        order: SortOrder.ASC,
      });

      // Title menu New switches the tab in place: keeps label:bug and sort=created&order=asc
      const titleDropdown = screen.getByLabelText(/Select triage status/i);
      fireEvent.click(titleDropdown);
      const titleMenu = titleDropdown.parentElement!;
      fireEvent.click(within(titleMenu).getByRole('button', { name: /^New$/i }));
      expect(await screen.findByText('New bug')).toBeDefined();
      expect(lastItemsQuery(daemon)).toBe('new:any label:bug');
      expect(window.location.search).toBe('?q=new:any+label:bug&sort=created&order=asc');
      assertNoLegacyUrlKeys();
      expect(daemon.lastRequest<GetItemsRequest>('GetItems')!.sort).toMatchObject({
        key: SortKey.CREATED,
        order: SortOrder.ASC,
      });

      // Sidebar New resets the entire query to new:any and resets sort to default
      const sidebarNew = screen.getAllByRole('button', { name: /^New/i })[0];
      fireEvent.click(sidebarNew);
      expect(await screen.findByText('All new items')).toBeDefined();
      expect(lastItemsQuery(daemon)).toBe('new:any');
      expect(window.location.search).toBe('?q=new:any');
      assertNoLegacyUrlKeys();
      expect(daemon.lastRequest<GetItemsRequest>('GetItems')!.sort).toMatchObject({
        key: SortKey.UPDATED,
        order: SortOrder.DESC,
      });
    });

    it('initializes from the URL and follows popstate', async () => {
      window.history.pushState(null, '', '/?triage=acked&repo=golang%2Fgo');
      const { daemon } = render({
        getItems: itemsByQuery({
          'triage:acked repo:golang/go': [item('PR_1', 'Go PR', { repo: 'golang/go' })],
          '': [item('PR_2', 'Go Unacked PR', { repo: 'golang/go' })],
        }),
      });

      expect(await screen.findByText('Go PR')).toBeDefined();
      expect(describeQuery(daemon.requestsFor<GetItemsRequest>('GetItems')[0].query)).toBe('triage:acked repo:golang/go');

      act(() => {
        window.history.pushState(null, '', '/');
        window.dispatchEvent(new PopStateEvent('popstate'));
      });

      expect(await screen.findByText('Go Unacked PR')).toBeDefined();
      expect(screen.queryByText('Go PR')).toBeNull();
    });

    it('shows URL-only predicates (negation, multiple values) as query chips and removes them', async () => {
      window.history.pushState(null, '', '/?-label=bug&label=a&label=b');
      const { daemon } = render({
        getItems: itemsByQuery({
          '-label:bug label:a,b': [item('PR_1', 'Narrow result')],
          'label:a,b': [item('PR_1', 'Narrow result'), item('PR_2', 'Wider result')],
        }),
      });

      expect(await screen.findByText('Narrow result')).toBeDefined();
      expect(queryPillTexts()).toEqual(['-label:bug', 'label:a,b']);
      expect(screen.getAllByTestId('query-pill')[0].dataset.negated).toBe('true');

      removeQueryClause('-label:bug');
      expect(await screen.findByText('Wider result')).toBeDefined();
      expect(lastItemsQuery(daemon)).toBe('label:a,b');
      expect(window.location.search).toBe('?q=label:a,b');
      assertNoLegacyUrlKeys();
    });

    it('keeps a negated filter when picking a value from the same selector', async () => {
      window.history.pushState(null, '', '/?-label=bug');
      const { daemon } = render({
        getItems: itemsByQuery({
          '-label:bug': [item('PR_1', 'Not bug 1'), item('PR_2', 'Not bug 2')],
          '-label:bug label:a': [item('PR_1', 'Not bug 1')],
        }),
        getFacets: facets({
          selector: { [Field.LABEL]: [['a', 1], ['b', 1]] },
        }),
      });

      expect(await screen.findByText('Not bug 2')).toBeDefined();
      expect(lastItemsQuery(daemon)).toBe('-label:bug');

      fireEvent.click(screen.getByRole('button', { name: /Filter by label/i }));
      fireEvent.click(await screen.findByRole('option', { name: /^a$/i }));
      await waitFor(() => expect(screen.queryByText('Not bug 2')).toBeNull());
      expect(lastItemsQuery(daemon)).toBe('-label:bug label:a');
      expect(window.location.search).toBe('?q=-label:bug+label:a');
      assertNoLegacyUrlKeys();
    });

    it('debounces search typing into one TEXT predicate per word or phrase', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const { daemon } = render({
        getItems: (req) => ({ items: [item('PR_1', `Result for "${describeQuery(req.query)}"`)] }),
      });
      await screen.findByText('Result for ""');
      const input = screen.getByRole('combobox', { name: /Filter or search query/i }) as HTMLTextAreaElement;

      act(() => {
        fireEvent.change(input, { target: { value: 'f', selectionStart: 1 } });
        fireEvent.change(input, { target: { value: 'fla', selectionStart: 3 } });
        fireEvent.change(input, { target: { value: 'flaky "big test"', selectionStart: 16 } });
      });
      expect(queryPillTexts()).toEqual(['flaky', '"big test"']);
      expect(window.location.search).toBe('?q=flaky+%22big+test%22');

      await act(async () => {
        await vi.advanceTimersByTimeAsync(250);
      });

      expect(await screen.findByText('Result for "text:flaky text:big test"')).toBeDefined();
      const textQueries = daemon
        .requestsFor<GetItemsRequest>('GetItems')
        .map((r) => describeQuery(r.query))
        .filter((q) => q !== '');
      expect(new Set(textQueries)).toEqual(new Set(['text:flaky text:big test']));
    });

    it('types is:open label:bug into QueryInput, edits label via menu in place, and edits the clause as text (§13 2.6)', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const { daemon } = render({
        getItems: itemsByQuery({
          '': [item('PR_0', 'All items')],
          'state:open label:bug': [item('PR_1', 'Open bug PR')],
          'state:open label:bug,flake': [item('PR_2', 'Open bug or flake PR')],
          'state:open label:flake': [item('PR_3', 'Open flake PR')],
        }),
        getFacets: facets({
          selector: { [Field.LABEL]: [['bug', 1], ['flake', 1]] },
        }),
      });
      expect(await screen.findByText('All items')).toBeDefined();
      const input = screen.getByRole('combobox', { name: /Filter or search query/i }) as HTMLTextAreaElement;

      // 1. Type `is:open label:bug ` -> two pills, sends `state:open label:bug`
      act(() => {
        fireEvent.change(input, {
          target: { value: 'is:open label:bug ', selectionStart: 18 },
        });
      });
      expect(queryPillTexts()).toEqual(['is:open', 'label:bug']);
      expect(window.location.search).toBe('?q=is:open+label:bug');

      await act(async () => {
        await vi.advanceTimersByTimeAsync(250);
      });
      expect(await screen.findByText('Open bug PR')).toBeDefined();
      expect(lastItemsQuery(daemon)).toBe('state:open label:bug');

      // 2. Tick `flake` in the Label menu -> edits only the label clause in place (`is:open` stays `is:open`)
      fireEvent.click(screen.getByRole('button', { name: /Filter by label/i }));
      fireEvent.click(await screen.findByRole('option', { name: /^flake$/i }));
      expect(await screen.findByText('Open bug or flake PR')).toBeDefined();
      expect(lastItemsQuery(daemon)).toBe('state:open label:bug,flake');
      expect(window.location.search).toBe('?q=is:open+label:bug,flake');
      expect(queryPillTexts()).toEqual(['is:open', 'label:bug,flake']);
      expect(input.value).toBe('is:open label:bug,flake');

      // Close Label menu, focus input, delete `bug,` from the label clause as text, press Enter
      fireEvent.keyDown(window, { key: 'Escape' });
      act(() => input.focus());
      fireEvent.change(input, { target: { value: 'is:open label:flake', selectionStart: 14 } });
      fireEvent.keyDown(input, { key: 'Enter' });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(250);
      });
      expect(await screen.findByText('Open flake PR')).toBeDefined();
      expect(lastItemsQuery(daemon)).toBe('state:open label:flake');
      expect(window.location.search).toBe('?q=is:open+label:flake');
    });

    it('clears only the query text on × (U8), returning title to Inbox while keeping sort=created', async () => {
      window.history.pushState(null, '', '/?q=triage:acked+label:bug&sort=created');
      const { daemon } = render({
        getItems: itemsByQuery({
          'triage:acked label:bug': [item('PR_1', 'Acked bug')],
          '': [item('PR_2', 'Inbox item')],
        }),
      });

      expect(await screen.findByText('Acked bug')).toBeDefined();
      const titleDropdown = screen.getByLabelText(/Select triage status/i);
      expect(titleDropdown.textContent).toContain('Acked');

      // Click the QueryInput × button
      fireEvent.click(screen.getByRole('button', { name: 'Clear query' }));

      expect(await screen.findByText('Inbox item')).toBeDefined();
      expect(queryPillTexts()).toHaveLength(0);
      expect(titleDropdown.textContent).toContain('Inbox');
      expect(window.location.search).toBe('?sort=created');
      expect(lastItemsQuery(daemon)).toBe('');
      expect(daemon.lastRequest<GetItemsRequest>('GetItems')!.sort).toMatchObject({
        key: SortKey.CREATED,
        order: SortOrder.DESC,
      });
    });
  });

  describe('selector options come from GetFacets', () => {
    const selector: FacetMap = {
      [Field.AUTHOR]: [['alice', 1], ['bob', 1], ['charlie', 0]],
      [Field.MILESTONE]: [['v1.0', 1], ['v1.1', 1], ['v2.0', 0]],
      [Field.REPO]: [['kubernetes/kubernetes', 1], ['kubernetes/minikube', 1], ['golang/go', 0]],
      [Field.ORG]: [['kubernetes', 2], ['golang', 0]],
    };

    it('requests every selector field for the current query in one call', async () => {
      window.history.pushState(null, '', '/?triage=activity&-label=x');
      const { daemon } = render({ getFacets: facets({ selector }) });

      await waitFor(() =>
        expect(daemon.requestsFor<GetFacetsRequest>('GetFacets').some((r) => r.fields.includes(Field.AUTHOR))).toBe(true)
      );
      const selectorRequests = daemon.requestsFor<GetFacetsRequest>('GetFacets').filter((r) => r.fields.includes(Field.AUTHOR));
      expect(selectorRequests[0].fields).toEqual([
        Field.REPO,
        Field.ORG,
        Field.AUTHOR,
        Field.ASSIGNEE,
        Field.MILESTONE,
        Field.LABEL,
        Field.NEW,
      ]);
      expect(describeQuery(selectorRequests[0].query)).toBe('new:any -label:x');
    });

    it('shows values with matches by default and zero-count values with Show all', async () => {
      render({ getFacets: facets({ selector }) });
      const authorTrigger = await screen.findByRole('button', { name: /Filter by author/i });
      await waitFor(() => {
        fireEvent.click(authorTrigger);
        expect(screen.getByRole('option', { name: /@alice/i })).toBeDefined();
      });
      expect(screen.getByRole('option', { name: /@bob/i })).toBeDefined();
      expect(screen.queryByRole('option', { name: /@charlie/i })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: /^Show all$/i }));
      expect(screen.getByRole('option', { name: /@charlie/i })).toBeDefined();
      // Closing the menu resets it to the default view.
      fireEvent.keyDown(window, { key: 'Escape' });
      fireEvent.click(authorTrigger);
      expect(screen.queryByRole('option', { name: /@charlie/i })).toBeNull();
      fireEvent.keyDown(window, { key: 'Escape' });

      fireEvent.click(screen.getByRole('button', { name: /More filters/i }));
      fireEvent.click(screen.getByRole('button', { name: /Filter by milestone/i }));
      expect(screen.getByRole('option', { name: /^v1\.0$/i })).toBeDefined();
      expect(screen.queryByRole('option', { name: /^v2\.0$/i })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: /^Show all$/i }));
      expect(screen.getByRole('option', { name: /^v2\.0$/i })).toBeDefined();
      fireEvent.keyDown(window, { key: 'Escape' });

      fireEvent.click(screen.getByRole('button', { name: /More filters/i }));
      fireEvent.click(screen.getByRole('button', { name: /Filter by repository/i }));
      expect(screen.getByRole('option', { name: /kubernetes\/minikube/i })).toBeDefined();
      expect(screen.queryByRole('option', { name: /^golang$/i })).toBeNull();
      expect(screen.queryByRole('option', { name: /golang\/go/i })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: /^Show all$/i }));
      expect(screen.getByRole('option', { name: /^golang$/i })).toBeDefined();
      expect(screen.getByRole('option', { name: /golang\/go/i })).toBeDefined();
    });

    it('hides Show all when every value has matches', async () => {
      render({
        getFacets: facets({
          selector: { [Field.AUTHOR]: [['alice', 1]], [Field.MILESTONE]: [['v1.0', 1]], [Field.REPO]: [['kubernetes/kubernetes', 1]], [Field.ORG]: [['kubernetes', 1]] },
        }),
      });
      const authorTrigger = await screen.findByRole('button', { name: /Filter by author/i });
      await waitFor(() => {
        fireEvent.click(authorTrigger);
        expect(within(authorTrigger.parentElement!).getByRole('option', { name: /@alice/i })).toBeDefined();
      });
      expect(within(authorTrigger.parentElement!).queryByRole('button', { name: /^Show all$/i })).toBeNull();
      fireEvent.keyDown(window, { key: 'Escape' });

      fireEvent.click(screen.getByRole('button', { name: /More filters/i }));
      fireEvent.click(screen.getByRole('button', { name: /Filter by repository/i }));
      expect(screen.getByRole('option', { name: /kubernetes\/kubernetes/i })).toBeDefined();
      expect(screen.queryByRole('button', { name: /^Show all$/i })).toBeNull();
    });

    it('always lists the selected value, even when the facet does not contain it or has zero count', async () => {
      window.history.pushState(null, '', '/?author=zed&author=charlie');
      render({ getItems: itemsByQuery({ 'author:zed,charlie': [] }), getFacets: facets({ selector }) });
      const authorTrigger = await screen.findByRole('button', { name: /Filter by author/i });
      await waitFor(() => {
        fireEvent.click(authorTrigger);
        expect(screen.getByRole('option', { name: /@alice/i })).toBeDefined();
      });
      expect(screen.getByRole('option', { name: /@zed/i })).toBeDefined();
      expect(screen.getByRole('option', { name: /@charlie/i })).toBeDefined();
    });

    it('autocompletes label: and assignee: from selector facets without extra GetFacets calls, and finishes chip on Enter (§13 2.7)', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const { daemon } = render({
        getItems: itemsByQuery({
          '': [item('PR_0', 'Inbox item')],
          'label:kind/bug': [item('PR_1', 'Bug PR')],
        }),
        getFacets: facets({
          selector: {
            [Field.LABEL]: [['kind/bug', 2], ['area/api', 1]],
            [Field.ASSIGNEE]: [['alice', 3], ['bob', 1]],
          },
        }),
      });

      expect(await screen.findByText('Inbox item')).toBeDefined();
      await waitFor(() =>
        expect(
          daemon
            .requestsFor<GetFacetsRequest>('GetFacets')
            .some((r) => r.fields.includes(Field.LABEL))
        ).toBe(true)
      );

      const facetCallsBefore = daemon.requestsFor<GetFacetsRequest>('GetFacets').length;
      const input = screen.getByRole('combobox', {
        name: /Filter or search query/i,
      }) as HTMLTextAreaElement;
      act(() => input.focus());

      // 1. Typing `label:` lists labels from the selector facets.
      fireEvent.change(input, { target: { value: 'label:', selectionStart: 6 } });
      const listbox = screen.getByRole('listbox', { name: 'Query suggestions' });
      expect(within(listbox).getByRole('option', { name: /kind\/bug/i })).toBeDefined();
      expect(within(listbox).getByRole('option', { name: /area\/api/i })).toBeDefined();
      expect(daemon.requestsFor<GetFacetsRequest>('GetFacets').length).toBe(facetCallsBefore);

      // 2. Typing `assignee:` lists assignees from the same selector facets (no extra GetFacets call).
      fireEvent.change(input, { target: { value: 'assignee:', selectionStart: 9 } });
      expect(within(listbox).getByRole('option', { name: /@me/i })).toBeDefined();
      expect(within(listbox).getByRole('option', { name: /alice/i })).toBeDefined();
      expect(within(listbox).getByRole('option', { name: /bob/i })).toBeDefined();
      expect(daemon.requestsFor<GetFacetsRequest>('GetFacets').length).toBe(facetCallsBefore);

      // 3. Pressing Enter on a label value finishes the chip and updates the query.
      fireEvent.change(input, { target: { value: 'label:kind/', selectionStart: 11 } });
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(queryPillTexts()).toEqual(['label:kind/bug']);
      expect(input.value).toBe('label:kind/bug ');
      expect(window.location.search).toBe('?q=label:kind/bug');

      await act(async () => {
        await vi.advanceTimersByTimeAsync(250);
      });
      expect(await screen.findByText('Bug PR')).toBeDefined();
      expect(lastItemsQuery(daemon)).toBe('label:kind/bug');
    });
  });

  describe('sidebar counts come from GetFacets', () => {
    const now = Date.now();
    const sidebarHandlers = (): OctoDeckHandlers => ({
      getConfig: () => ({
        config: { pollingIntervalMin: 15, savedSearches: [] },
        currentUserLogin: 'testuser',
      }),
      getItems: (req) => {
        const key = describeQuery(req.query);
        return { items: key === 'repo:kubernetes/kubernetes' ? [item('PR_1', 'Repo-scoped PR')] : [item('PR_0', 'Inbox PR')] };
      },
      getFacets: facets({
        sidebar: {
          [Field.REPO]: [
            ['kubernetes/kubernetes', 2, { latestMs: now, newCount: 1 }],
            ['kubernetes/community', 1, { latestMs: now - DAY_MS, newCount: 0 }],
            ['kubernetes/quiet', 3, { latestMs: now - 2 * DAY_MS, newCount: 0 }],
            ['kubernetes/website', 0, { latestMs: now - 3 * DAY_MS, newCount: 0 }],
            ['kubernetes/stale-repo', 0, { latestMs: now - 40 * DAY_MS, newCount: 0 }],
          ],
          [Field.TRIAGE]: [
            ['inbox', 7, { newCount: 2 }],
            ['acked', 3, { newCount: 0 }],
          ],
        },
      }),
    });

    it('shows the Inbox, New and Acked totals from the triage facets', async () => {
      const { daemon } = render(sidebarHandlers());
      await waitFor(() => expect(within(screen.getByRole('button', { name: /^Inbox/i })).getByText('7')).toBeDefined());
      expect(within(screen.getByRole('button', { name: /^New/i })).getByText('2')).toBeDefined();
      expect(within(screen.getAllByRole('button', { name: /^Acked/i })[0]).getByText('3')).toBeDefined();

      const sidebarRequests = daemon.requestsFor<GetFacetsRequest>('GetFacets').filter((r) => !r.fields.includes(Field.AUTHOR));
      expect(sidebarRequests).toHaveLength(1);
      expect(sidebarRequests[0].query === undefined || describeQuery(sidebarRequests[0].query) === '').toBe(true);
      expect(sidebarRequests[0].fields).toEqual([Field.REPO, Field.TRIAGE]);
      expect(daemon.requestsFor<GetFacetsRequest>('GetFacets').some((r) => describeQuery(r.query) === 'new:any')).toBe(false);
    });

    it('shows per-repo inbox counts, orange when the repo has new activity and slate otherwise', async () => {
      render(sidebarHandlers());
      const k8s = await screen.findByTestId('repo-count-kubernetes/kubernetes');
      expect(k8s.textContent).toBe('2');
      expect(k8s.className).toContain('bg-orange-100');

      const community = screen.getByTestId('repo-count-kubernetes/community');
      expect(community.textContent).toBe('1');
      expect(community.className).toContain('bg-slate-200');
      expect(community.className).not.toContain('bg-orange-100');

      // A repo without items has no badge.
      expect(screen.queryByTestId('repo-count-kubernetes/website')).toBeNull();
    });

    it('lists repositories and hides repos without activity in 30 days behind More', async () => {
      render(sidebarHandlers());
      expect(await screen.findByRole('button', { name: /kubernetes\/website/i })).toBeDefined();
      expect(screen.getByText('Pinned')).toBeDefined();
      expect(screen.getByText('Repositories')).toBeDefined();
      await screen.findByText('kubernetes/community');

      const toggle = screen.getByTestId('toggle-hidden-repos');
      expect(toggle.textContent).toContain('More');
      expect(screen.queryByTestId('hidden-repos-list')).toBeNull();
      fireEvent.click(toggle);
      expect(within(screen.getByTestId('hidden-repos-list')).getByText('kubernetes/stale-repo')).toBeDefined();
      fireEvent.click(toggle);
      expect(screen.queryByTestId('hidden-repos-list')).toBeNull();
    });

    it('filters by a sidebar repo and clears it with the chip', async () => {
      const { daemon } = render(sidebarHandlers());
      await screen.findByText('Inbox PR');
      await screen.findByTestId('repo-count-kubernetes/kubernetes');

      fireEvent.click(screen.getAllByRole('button', { name: /kubernetes\/kubernetes/i })[0]);
      expect(await screen.findByText('Repo-scoped PR')).toBeDefined();
      expect(lastItemsQuery(daemon)).toBe('repo:kubernetes/kubernetes');
      expect(window.location.search).toBe('?q=repo:kubernetes/kubernetes');
      assertNoLegacyUrlKeys();

      removeQueryClause('repo:kubernetes/kubernetes');
      expect(await screen.findByText('Inbox PR')).toBeDefined();
      expect(window.location.search).toBe('');
    });
  });

  describe('errors and the selected item', () => {
    it('sends one TEXT predicate for ?q=flaky', async () => {
      window.history.pushState(null, '', '/?q=flaky');
      const { daemon } = render({
        getItems: itemsByQuery({ 'text:flaky': [item('PR_1', 'Flaky test PR')] }),
      });

      expect(await screen.findByText('Flaky test PR')).toBeDefined();
      expect(lastItemsQuery(daemon)).toBe('text:flaky');
      expect(window.location.search).toBe('?q=flaky');
    });

    it('excludes an invalid clause from the request and reports it in the summary line', async () => {
      window.history.pushState(null, '', '/?q=lable:bug+state:open');
      const { daemon } = render({
        getItems: itemsByQuery({ 'state:open': [item('PR_1', 'Open PR')] }),
      });

      expect(await screen.findByText('Open PR')).toBeDefined();
      expect(lastItemsQuery(daemon)).toBe('state:open');
      const alert = screen.getByTestId('invalid-query');
      expect(alert.textContent).toContain(
        '1 part of the query is ignored: lable is not a known filter. Quote it to search for the text: "lable:bug"'
      );
      expect(screen.queryByTestId('daemon-disconnected-banner')).toBeNull();
    });

    it('reports a server ExprError inline and maps its path across skipped invalid clauses', async () => {
      window.history.pushState(null, '', '/?q=lable:bug+state:merged');
      render({
        getItems: () => {
          throw new ConnectError('invalid query', Code.InvalidArgument, undefined, [
            {
              desc: ExprErrorSchema,
              value: create(ExprErrorSchema, {
                path: 'and.exprs[0]',
                message: 'state "merged" is not supported here',
              }),
            },
          ]);
        },
      });

      const alert = await screen.findByTestId('invalid-query');
      expect(alert.textContent).toContain('2 parts of the query are ignored:');
      expect(alert.textContent).toContain('lable is not a known filter');

      expect(queryPillTexts()).toEqual(['lable:bug', 'state:merged']);
      const mergedPill = screen.getAllByTestId('query-pill')[1];
      expect(mergedPill.dataset.status).toBe('error');
      expect(mergedPill.dataset.tone).toBe('error');
      const input = screen.getByRole('combobox', { name: /Filter or search query/i });
      expect(input.getAttribute('aria-invalid')).toBe('true');

      expect(screen.queryByTestId('daemon-disconnected-banner')).toBeNull();
      expect(screen.queryByTestId('daemon-offline-empty-state')).toBeNull();
    });

    it('reports a root-path server ExprError only in the summary line without marking any chip as error', async () => {
      window.history.pushState(null, '', '/?q=state:open+label:bug');
      render({
        getItems: () => {
          throw new ConnectError('invalid query', Code.InvalidArgument, undefined, [
            {
              desc: ExprErrorSchema,
              value: create(ExprErrorSchema, {
                path: '',
                message: 'query exceeds maximum complexity',
              }),
            },
          ]);
        },
      });

      const summary = await screen.findByTestId('invalid-query');
      expect(summary.textContent).toBe(
        '1 part of the query is ignored: query exceeds maximum complexity'
      );

      const pills = screen.getAllByTestId('query-pill');
      expect(pills).toHaveLength(2);
      pills.forEach((pill) => {
        expect(pill.dataset.status).toBe('ok');
      });

      expect(screen.queryByTestId('daemon-disconnected-banner')).toBeNull();
      expect(screen.queryByTestId('daemon-offline-empty-state')).toBeNull();
    });

    it('does not reset scroll anchoring when editing only an error clause', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      window.history.pushState(null, '', '/?q=state:open+lable:x');
      render({
        getItems: itemsByQuery({
          'state:open': [item('PR_1', 'Open PR 1'), item('PR_2', 'Open PR 2')],
          'state:closed': [item('PR_3', 'Closed PR 3')],
        }),
      });

      const pr1 = await screen.findByText('Open PR 1');
      const scrollContainer = pr1.closest('.overflow-y-auto') as HTMLDivElement;
      scrollContainer.scrollTop = 120;

      const input = screen.getByRole('combobox', { name: /Filter or search query/i }) as HTMLTextAreaElement;
      act(() => {
        fireEvent.focus(input);
        fireEvent.change(input, { target: { value: 'state:open lable:xy', selectionStart: 19 } });
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(250);
      });

      // Editing only the error clause leaves the valid predicate list unchanged, so scrollTop is preserved
      expect(scrollContainer.scrollTop).toBe(120);

      // Editing the valid clause via State switch changes settledKey and resets scrollTop to 0
      fireEvent.click(screen.getByRole('button', { name: /^Closed$/i }));
      await screen.findByText('Closed PR 3');
      expect(scrollContainer.scrollTop).toBe(0);
    });

    it('shows the offline state when the daemon is unreachable', async () => {
      render({
        getItems: () => {
          throw new ConnectError('daemon down', Code.Unavailable);
        },
      });
      expect(await screen.findByTestId('daemon-offline-empty-state')).toBeDefined();
      expect(screen.getByTestId('daemon-disconnected-banner')).toBeDefined();
    });

    it('fetches a selected item that is outside the current result with GetItem', async () => {
      window.history.pushState(null, '', '/?item=PR_X');
      const { daemon } = render({
        getItems: itemsByQuery({ '': [item('PR_1', 'Inbox PR')] }),
        getItem: (req) => ({ item: item(req.itemId, 'Deep linked acked PR', { local: { computedStatus: ItemStatus.ACKED } }) }),
        viewItem: () => ({}),
      });

      await screen.findByText('Inbox PR');
      expect(await screen.findByText('Deep linked acked PR')).toBeDefined();
      expect(daemon.requestsFor<GetItemRequest>('GetItem').map((r) => r.itemId)).toContain('PR_X');
      expect(screen.queryByTestId('daemon-disconnected-banner')).toBeNull();
    });

    it('does not call GetItem when the selected item is in the result', async () => {
      window.history.pushState(null, '', '/?item=PR_1');
      const { daemon } = render({ getItems: itemsByQuery({ '': [item('PR_1', 'Selected PR')] }), viewItem: () => ({}) });

      await waitFor(() => expect(screen.getAllByText('Selected PR').length).toBeGreaterThan(1));
      expect(daemon.requestsFor('GetItem')).toEqual([]);
    });
  });

  describe('saved searches hook and RPC integration', () => {
    it('issues exactly one sidebar GetFacets call per poll with queries for valid searches in order', async () => {
      const { daemon } = render({
        getConfig: () => ({
          config: {
            pollingIntervalMin: 15,
            pinnedRepos: [],
            savedSearches: [
              { id: 's1', name: 'K8s', query: 'repo:kubernetes/kubernetes' },
              { id: 's2', name: 'Bad', query: 'state:bogus' },
              { id: 's3', name: 'Open PRs', query: 'type:pr is:open' },
            ],
          },
          currentUserLogin: 'testuser',
        }),
        getFacets: (req) => {
          if (req.fields.includes(Field.REPO) && req.fields.includes(Field.TRIAGE)) {
            return {
              facets: req.fields.map((field) => ({ field, values: [] })),
              counts: [
                { count: 5, newCount: 1, inboxCount: 4 },
                { count: 12, newCount: 0, inboxCount: 10 },
              ],
            };
          }
          return { facets: req.fields.map((field) => ({ field, values: [] })), counts: [] };
        },
      });

      await waitFor(() => {
        const sidebarRequests = daemon
          .requestsFor<GetFacetsRequest>('GetFacets')
          .filter((r) => r.fields.includes(Field.REPO) && r.fields.includes(Field.TRIAGE));
        expect(sidebarRequests.length).toBeGreaterThan(0);
      });

      const sidebarRequests = daemon
        .requestsFor<GetFacetsRequest>('GetFacets')
        .filter((r) => r.fields.includes(Field.REPO) && r.fields.includes(Field.TRIAGE));
      expect(sidebarRequests).toHaveLength(1);
      const req = sidebarRequests[0];
      // Exactly 2 queries in request (skipping invalid s2)
      expect(req.queries).toHaveLength(2);
      expect(describeQuery(req.queries[0])).toBe('repo:kubernetes/kubernetes');
      expect(describeQuery(req.queries[1])).toBe('type:pr state:open');
    });

    it('optimistically reorders saved searches and rolls back on FailedPrecondition', async () => {
      const initialSearches = [
        { id: 's1', name: 'Search 1', query: 'repo:k8s/k8s' },
        { id: 's2', name: 'Search 2', query: 'repo:k8s/website' },
        { id: 's3', name: 'Search 3', query: 'repo:k8s/community' },
      ];
      let reorderCalls = 0;
      let rejectReorder!: (err: unknown) => void;
      const reorderPromise = new Promise<never>((_, reject) => {
        rejectReorder = reject;
      });

      const daemon = createMockDaemon(
        defaultHandlers({
          getConfig: () => ({
            config: {
              pollingIntervalMin: 15,
              savedSearches: initialSearches,
            },
            currentUserLogin: 'testuser',
          }),
          reorderSavedSearches: () => {
            reorderCalls++;
            return reorderPromise;
          },
        })
      );
      const queryClient = createTestQueryClient();
      const wrapper = ({ children }: { children: React.ReactNode }) => (
        <TransportProvider transport={daemon.transport}>
          <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
        </TransportProvider>
      );

      const { result } = renderHook(() => useSavedSearches(), { wrapper });

      await waitFor(() => expect(result.current.searches).toHaveLength(3));
      expect(result.current.searches.map((s) => s.id)).toEqual(['s1', 's2', 's3']);

      // Attempt reorder with ids ['s3', 's1', 's2']
      let reorderError: unknown;
      act(() => {
        result.current.reorder(['s3', 's1', 's2']).catch((err) => {
          reorderError = err;
        });
      });

      // Verify optimistic update took effect before the server responded
      expect(result.current.searches.map((s) => s.id)).toEqual(['s3', 's1', 's2']);
      await waitFor(() => expect(reorderCalls).toBe(1));

      // Reject the server call with FailedPrecondition
      act(() => {
        rejectReorder(new ConnectError('stale order', Code.FailedPrecondition));
      });

      await waitFor(() => expect(reorderError).toBeDefined());
      expect((reorderError as ConnectError).code).toBe(Code.FailedPrecondition);

      // After rollback, searches return to original order
      await waitFor(() => {
        expect(result.current.searches.map((s) => s.id)).toEqual(['s1', 's2', 's3']);
      });
    });

    it('ignores earlier reorder failure when a newer reorder is in flight', async () => {
      const initialSearches = [
        { id: 's1', name: 'Search 1', query: 'repo:k8s/k8s' },
        { id: 's2', name: 'Search 2', query: 'repo:k8s/website' },
        { id: 's3', name: 'Search 3', query: 'repo:k8s/community' },
      ];
      let rejectFirst!: (err: unknown) => void;
      const firstPromise = new Promise<never>((_, reject) => {
        rejectFirst = reject;
      });
      let resolveSecond!: (val: ReorderSavedSearchesResponse) => void;
      const secondPromise = new Promise<ReorderSavedSearchesResponse>((resolve) => {
        resolveSecond = resolve;
      });

      let callCount = 0;
      const daemon = createMockDaemon(
        defaultHandlers({
          getConfig: () => ({
            config: {
              pollingIntervalMin: 15,
              savedSearches: initialSearches,
            },
            currentUserLogin: 'testuser',
          }),
          reorderSavedSearches: () => {
            callCount++;
            return callCount === 1 ? firstPromise : secondPromise;
          },
        })
      );
      const queryClient = createTestQueryClient();
      const wrapper = ({ children }: { children: React.ReactNode }) => (
        <TransportProvider transport={daemon.transport}>
          <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
        </TransportProvider>
      );

      const { result } = renderHook(() => useSavedSearches(), { wrapper });
      await waitFor(() => expect(result.current.searches).toHaveLength(3));

      // Launch first reorder: ['s2', 's1', 's3']
      let firstError: unknown;
      act(() => {
        result.current.reorder(['s2', 's1', 's3']).catch((err) => {
          firstError = err;
        });
      });
      expect(result.current.searches.map((s) => s.id)).toEqual(['s2', 's1', 's3']);
      await waitFor(() => expect(callCount).toBe(1));

      // Launch second reorder before first completes: ['s3', 's2', 's1']
      let secondResolved = false;
      act(() => {
        result.current.reorder(['s3', 's2', 's1']).then(() => {
          secondResolved = true;
        });
      });
      expect(result.current.searches.map((s) => s.id)).toEqual(['s3', 's2', 's1']);
      await waitFor(() => expect(callCount).toBe(2));

      // Reject the first reorder: its rollback must NOT overwrite the second reorder's optimistic order
      act(() => {
        rejectFirst(new ConnectError('stale order', Code.FailedPrecondition));
      });
      await waitFor(() => expect(firstError).toBeDefined());
      expect(result.current.searches.map((s) => s.id)).toEqual(['s3', 's2', 's1']);

      // Resolve the second reorder
      act(() => {
        resolveSecond(
          create(ReorderSavedSearchesResponseSchema, {
            savedSearches: [
              initialSearches[2],
              initialSearches[1],
              initialSearches[0],
            ],
          })
        );
      });
      await waitFor(() => expect(secondResolved).toBe(true));
      expect(result.current.searches.map((s) => s.id)).toEqual(['s3', 's2', 's1']);
    });

    it('creates a saved search from the current query and sort via the pin button modal', async () => {
      window.history.pushState(null, '', '/?q=repo:kubernetes/kubernetes&sort=created&order=asc');
      const { daemon } = render({
        createSavedSearch: (req) =>
          create(CreateSavedSearchResponseSchema, {
            savedSearch: req.savedSearch ? { ...req.savedSearch, id: 'new-id' } : undefined,
            savedSearches: req.savedSearch ? [{ ...req.savedSearch, id: 'new-id' }] : [],
          }),
      });

      const pinButton = (await screen.findByTestId('pin-search-button')) as HTMLButtonElement;
      expect(pinButton.disabled).toBe(false);
      expect(pinButton.getAttribute('data-active')).toBe('false');

      fireEvent.click(pinButton);
      expect(screen.getByRole('dialog')).toBeDefined();
      expect(screen.getByRole('heading', { name: 'Pin search' })).toBeDefined();

      const nameInput = screen.getByLabelText(/^Name$/i);
      fireEvent.change(nameInput, { target: { value: 'K8s Core' } });

      fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));

      await waitFor(() => {
        expect(daemon.requestsFor('CreateSavedSearch')).toHaveLength(1);
      });
      const req = daemon.lastRequest<CreateSavedSearchRequest>('CreateSavedSearch');
      expect(req?.savedSearch?.name).toBe('K8s Core');
      expect(req?.savedSearch?.query).toBe('repo:kubernetes/kubernetes');
      expect(req?.savedSearch?.sort?.key).toBe(SortKey.CREATED);
      expect(req?.savedSearch?.sort?.order).toBe(SortOrder.ASC);
    });

    it('shows the pin filled when a saved search is active (including unscoped on Acked tab) and opens edit mode', async () => {
      const savedSearches = [
        { id: 's1', name: 'K8s', query: 'repo:kubernetes/kubernetes' },
      ];
      // Unscoped search opened on Acked tab: ?q=triage:acked repo:kubernetes/kubernetes
      window.history.pushState(null, '', '/?q=triage:acked repo:kubernetes/kubernetes');
      render({
        getConfig: () => ({
          config: {
            pollingIntervalMin: 15,
            savedSearches,
          },
          currentUserLogin: 'testuser',
        }),
      });

      const pinButton = await screen.findByTestId('pin-search-button');
      expect(pinButton.getAttribute('data-active')).toBe('true');
      expect(pinButton.getAttribute('aria-label')).toBe('Edit pinned search K8s');

      fireEvent.click(pinButton);
      expect(screen.getByRole('dialog')).toBeDefined();
      expect(screen.getByRole('heading', { name: 'Edit pinned search' })).toBeDefined();
      expect((screen.getByLabelText(/^Name$/i) as HTMLInputElement).value).toBe('K8s');
    });

    it('saves changes in edit mode using update mask name only', async () => {
      const savedSearches = [
        {
          id: 's1',
          name: 'K8s',
          query: 'repo:kubernetes/kubernetes',
          sort: { key: SortKey.CREATED, order: SortOrder.ASC },
        },
      ];
      window.history.pushState(null, '', '/?q=repo:kubernetes/kubernetes&sort=updated&order=desc');
      const { daemon } = render({
        getConfig: () => ({
          config: {
            pollingIntervalMin: 15,
            savedSearches,
          },
          currentUserLogin: 'testuser',
        }),
        updateSavedSearch: (req) =>
          create(UpdateSavedSearchResponseSchema, {
            savedSearches: [{ ...savedSearches[0], name: req.savedSearch?.name ?? 'K8s' }],
          }),
      });

      const pinButton = await screen.findByTestId('pin-search-button');
      fireEvent.click(pinButton);

      const nameInput = screen.getByLabelText(/^Name$/i);
      fireEvent.change(nameInput, { target: { value: 'K8s Renamed' } });

      fireEvent.click(screen.getByRole('button', { name: /^Update$/i }));

      await waitFor(() => {
        expect(daemon.requestsFor('UpdateSavedSearch')).toHaveLength(1);
      });
      const req = daemon.lastRequest<UpdateSavedSearchRequest>('UpdateSavedSearch');
      expect(req?.savedSearch?.id).toBe('s1');
      expect(req?.savedSearch?.name).toBe('K8s Renamed');
      expect(req?.updateMask?.paths).toEqual(['name']);
    });

    it('deletes a saved search via the edit modal', async () => {
      const savedSearches = [
        { id: 's1', name: 'To Delete', query: 'repo:kubernetes/kubernetes' },
      ];
      window.history.pushState(null, '', '/?q=repo:kubernetes/kubernetes');
      const { daemon } = render({
        getConfig: () => ({
          config: {
            pollingIntervalMin: 15,
            savedSearches,
          },
          currentUserLogin: 'testuser',
        }),
        deleteSavedSearch: () =>
          create(DeleteSavedSearchResponseSchema, { savedSearches: [] }),
      });

      const pinButton = await screen.findByTestId('pin-search-button');
      fireEvent.click(pinButton);

      fireEvent.click(screen.getByRole('button', { name: /^Delete$/i }));
      fireEvent.click(screen.getByTestId('confirm-delete-saved-search'));

      await waitFor(() => {
        expect(daemon.requestsFor('DeleteSavedSearch')).toHaveLength(1);
      });
      const req = daemon.lastRequest<DeleteSavedSearchRequest>('DeleteSavedSearch');
      expect(req?.id).toBe('s1');
    });

    it('disables the pin button for empty or invalid queries', async () => {
      // Empty query (Inbox)
      window.history.pushState(null, '', '/');
      render({});
      let pinButton = (await screen.findByTestId('pin-search-button')) as HTMLButtonElement;
      expect(pinButton.disabled).toBe(true);

      // Invalid query
      window.history.pushState(null, '', '/?q=state:bogus');
      render({});
      pinButton = (await screen.findByTestId('pin-search-button')) as HTMLButtonElement;
      expect(pinButton.disabled).toBe(true);
    });

    it('displays AlreadyExists and ResourceExhausted errors inline in the modal', async () => {
      window.history.pushState(null, '', '/?q=repo:kubernetes/kubernetes');
      let errorCode = Code.AlreadyExists;
      render({
        createSavedSearch: () => {
          throw new ConnectError('error', errorCode);
        },
      });

      const pinButton = await screen.findByTestId('pin-search-button');
      fireEvent.click(pinButton);

      const saveBtn = screen.getByRole('button', { name: /^Save$/i });
      fireEvent.click(saveBtn);
      expect(await screen.findByText('A saved search with this name already exists.')).toBeDefined();

      // Change error to ResourceExhausted
      errorCode = Code.ResourceExhausted;
      fireEvent.change(screen.getByLabelText(/^Name$/i), { target: { value: 'Different Name' } });
      fireEvent.click(saveBtn);
      expect(await screen.findByText('Maximum of 50 saved searches reached (limit 50).')).toBeDefined();
    });
  });

  describe('saved searches sidebar (Commit 3.9)', () => {
    it('displays badges per scope from sidebar GetFacets counts and hides zero counts', async () => {
      const savedSearches = [
        { id: 's1', name: 'Inbox Slate', query: 'repo:kubernetes/kubernetes' },
        { id: 's2', name: 'Inbox Orange', query: 'repo:kubernetes/website' },
        { id: 's3', name: 'Inbox Zero', query: 'repo:kubernetes/zero' },
        { id: 's4', name: 'New Orange', query: 'new:mention repo:kubernetes/kubernetes' },
        { id: 's5', name: 'Acked Faded', query: 'triage:acked label:bug' },
        { id: 's6', name: 'All Inbox', query: 'triage:all label:bug' },
        { id: 's7', name: 'All Orange', query: 'triage:all repo:kubernetes/kubernetes' },
        { id: 's8', name: 'All Acked', query: 'triage:all label:docs' },
        { id: 's9', name: 'All Zero', query: 'triage:all label:none' },
        { id: 's10', name: 'Invalid Query', query: 'state:bogus' },
      ];

      const { daemon } = render({
        getConfig: () => ({
          config: { pollingIntervalMin: 15, savedSearches },
          currentUserLogin: 'testuser',
        }),
        getFacets: (req) => {
          if (req.fields.includes(Field.REPO) && req.fields.includes(Field.TRIAGE)) {
            return {
              facets: req.fields.map((field) => ({ field, values: [] })),
              counts: [
                { count: 3, newCount: 0, inboxCount: 3 }, // s1
                { count: 2, newCount: 1, inboxCount: 2 }, // s2
                { count: 0, newCount: 0, inboxCount: 0 }, // s3
                { count: 4, newCount: 4, inboxCount: 4 }, // s4
                { count: 5, newCount: 0, inboxCount: 0 }, // s5
                { count: 6, newCount: 0, inboxCount: 2 }, // s6
                { count: 7, newCount: 1, inboxCount: 3 }, // s7
                { count: 8, newCount: 0, inboxCount: 0 }, // s8
                { count: 0, newCount: 0, inboxCount: 0 }, // s9
              ],
            };
          }
          return { facets: req.fields.map((field) => ({ field, values: [] })), counts: [] };
        },
      });

      // s1: inbox scope, count 3, newCount 0 -> slate bubble, aria-label '3 items'
      const s1Badge = await screen.findByTestId('saved-search-count-Inbox Slate');
      const s1Row = screen.getByTestId('saved-search-row-Inbox Slate');
      expect(s1Row.getAttribute('data-scope')).toBe('inbox');
      expect(s1Badge.textContent).toBe('3');
      expect(s1Badge.className).toContain('bg-slate-200');
      expect(s1Badge.getAttribute('aria-label')).toBe('3 items');

      // s2: inbox scope, count 2, newCount 1 -> orange bubble, aria-label '2 items, some with new activity'
      const s2Row = screen.getByTestId('saved-search-row-Inbox Orange');
      expect(s2Row.getAttribute('data-scope')).toBe('inbox');
      const s2Badge = screen.getByTestId('saved-search-count-Inbox Orange');
      expect(s2Badge.textContent).toBe('2');
      expect(s2Badge.className).toContain('bg-orange-100');
      expect(s2Badge.getAttribute('aria-label')).toBe('2 items, some with new activity');

      // s3: inbox scope, count 0 -> hidden
      expect(screen.queryByTestId('saved-search-count-Inbox Zero')).toBeNull();

      // s4: new scope, count 4 -> always orange bubble, aria-label '4 items with new activity'
      const s4Row = screen.getByTestId('saved-search-row-New Orange');
      expect(s4Row.getAttribute('data-scope')).toBe('new');
      const s4Badge = screen.getByTestId('saved-search-count-New Orange');
      expect(s4Badge.textContent).toBe('4');
      expect(s4Badge.className).toContain('bg-orange-100');
      expect(s4Badge.getAttribute('aria-label')).toBe('4 items with new activity');

      // s5: acked scope, count 5 -> faded count, aria-label '5 acked items'
      const s5Row = screen.getByTestId('saved-search-row-Acked Faded');
      expect(s5Row.getAttribute('data-scope')).toBe('acked');
      const s5Badge = screen.getByTestId('saved-search-count-Acked Faded');
      expect(s5Badge.textContent).toBe('5');
      expect(s5Badge.className).toContain('text-slate-400');
      expect(s5Badge.className).not.toContain('bg-');
      expect(s5Badge.getAttribute('aria-label')).toBe('5 acked items');

      // s6: all scope, inboxCount 2 > 0, newCount 0 -> inbox badge showing inboxCount (2), slate bubble
      const s6Row = screen.getByTestId('saved-search-row-All Inbox');
      expect(s6Row.getAttribute('data-scope')).toBe('all');
      const s6Badge = screen.getByTestId('saved-search-count-All Inbox');
      expect(s6Badge.textContent).toBe('2');
      expect(s6Badge.className).toContain('bg-slate-200');
      expect(s6Badge.getAttribute('aria-label')).toBe('2 items');

      // s7: all scope, inboxCount 3 > 0, newCount 1 -> orange bubble showing inboxCount (3)
      const s7Row = screen.getByTestId('saved-search-row-All Orange');
      expect(s7Row.getAttribute('data-scope')).toBe('all');
      const s7Badge = screen.getByTestId('saved-search-count-All Orange');
      expect(s7Badge.textContent).toBe('3');
      expect(s7Badge.className).toContain('bg-orange-100');
      expect(s7Badge.getAttribute('aria-label')).toBe('3 items, some with new activity');

      // s8: all scope, inboxCount 0 -> faded count showing total count (8)
      const s8Row = screen.getByTestId('saved-search-row-All Acked');
      expect(s8Row.getAttribute('data-scope')).toBe('all');
      const s8Badge = screen.getByTestId('saved-search-count-All Acked');
      expect(s8Badge.textContent).toBe('8');
      expect(s8Badge.className).toContain('text-slate-400');
      expect(s8Badge.className).not.toContain('bg-');
      expect(s8Badge.getAttribute('aria-label')).toBe('8 acked items');

      // s9: all scope, count 0 -> hidden
      expect(screen.queryByTestId('saved-search-count-All Zero')).toBeNull();

      // s10: invalid query -> error badge
      const s10Row = screen.getByTestId('saved-search-row-Invalid Query');
      expect(s10Row.getAttribute('data-scope')).toBe('error');
      const s10Badge = screen.getByTestId('saved-search-count-Invalid Query');
      expect(s10Badge.querySelector('svg')).toBeDefined();

      // Still exactly one sidebar GetFacets call per poll
      const sidebarRequests = daemon
        .requestsFor<GetFacetsRequest>('GetFacets')
        .filter((r) => r.fields.includes(Field.REPO) && r.fields.includes(Field.TRIAGE));
      expect(sidebarRequests).toHaveLength(1);
    });

    it('shows error badge for invalid saved search text and still opens it', async () => {
      const savedSearches = [
        { id: 's1', name: 'Broken Query', query: 'state:bogus' },
      ];
      render({
        getConfig: () => ({
          config: { pollingIntervalMin: 15, savedSearches },
          currentUserLogin: 'testuser',
        }),
      });

      const row = await screen.findByTestId('saved-search-row-Broken Query');
      expect(row.getAttribute('data-scope')).toBe('error');
      expect(screen.getByTestId('saved-search-count-Broken Query')).toBeDefined();

      fireEvent.click(row);
      expect(window.location.search).toBe('?q=state:bogus');
    });

    it('does not change saved search badges when active tab changes', async () => {
      const savedSearches = [
        { id: 's1', name: 'Inbox Repo', query: 'repo:kubernetes/kubernetes' },
      ];
      render({
        getConfig: () => ({
          config: { pollingIntervalMin: 15, savedSearches },
          currentUserLogin: 'testuser',
        }),
        getFacets: (req) => {
          if (req.fields.includes(Field.REPO) && req.fields.includes(Field.TRIAGE)) {
            return {
              facets: req.fields.map((field) => ({ field, values: [] })),
              counts: [{ count: 3, newCount: 0, inboxCount: 3 }],
            };
          }
          return { facets: req.fields.map((field) => ({ field, values: [] })), counts: [] };
        },
      });

      const badge = await screen.findByTestId('saved-search-count-Inbox Repo');
      expect(badge.textContent).toBe('3');

      // Switch to Acked tab
      fireEvent.click(screen.getAllByRole('button', { name: /^Acked/i })[0]);
      await waitFor(() => expect(window.location.search).toBe('?q=triage:acked'));
      expect(screen.getByTestId('saved-search-count-Inbox Repo').textContent).toBe('3');

      // Switch to New tab
      fireEvent.click(screen.getByRole('button', { name: /^New/i }));
      await waitFor(() => expect(window.location.search).toBe('?q=new:any'));
      expect(screen.getByTestId('saved-search-count-Inbox Repo').textContent).toBe('3');
    });

    it('clicking an unscoped search on Acked tab sends triage:acked and applies saved sort', async () => {
      window.history.pushState(null, '', '/?q=triage:acked');
      const savedSearches = [
        {
          id: 's1',
          name: 'My Repo',
          query: 'repo:kubernetes/kubernetes',
          sort: { key: SortKey.CREATED, order: SortOrder.ASC },
        },
      ];
      const { daemon } = render({
        getConfig: () => ({
          config: { pollingIntervalMin: 15, savedSearches },
          currentUserLogin: 'testuser',
        }),
        getItems: itemsByQuery({
          'triage:acked': [],
          'triage:acked repo:kubernetes/kubernetes': [],
        }),
      });

      const row = await screen.findByTestId('saved-search-row-My Repo');
      fireEvent.click(row);

      await waitFor(() => {
        expect(lastItemsQuery(daemon)).toBe('triage:acked repo:kubernetes/kubernetes');
      });
      const lastReq = daemon.lastRequest<GetItemsRequest>('GetItems');
      expect(lastReq?.sort?.key).toBe(SortKey.CREATED);
      expect(lastReq?.sort?.order).toBe(SortOrder.ASC);
      expect(window.location.search).toContain('sort=created');
      expect(window.location.search).toContain('order=asc');
    });

    it('clicking a scoped search replaces whole query and applies sort', async () => {
      window.history.pushState(null, '', '/?q=triage:acked');
      const savedSearches = [
        {
          id: 's1',
          name: 'Scoped New',
          query: 'new:any repo:kubernetes/kubernetes',
          sort: { key: SortKey.UPDATED, order: SortOrder.DESC },
        },
        {
          id: 's2',
          name: 'Scoped Acked',
          query: 'triage:acked label:bug',
          sort: { key: SortKey.CREATED, order: SortOrder.ASC },
        },
      ];
      const { daemon } = render({
        getConfig: () => ({
          config: { pollingIntervalMin: 15, savedSearches },
          currentUserLogin: 'testuser',
        }),
        getItems: itemsByQuery({
          'triage:acked': [],
          'new:any repo:kubernetes/kubernetes': [],
          'triage:acked label:bug': [],
        }),
      });

      // Click Scoped New: replaces whole query (does NOT keep triage:acked)
      const row1 = await screen.findByTestId('saved-search-row-Scoped New');
      fireEvent.click(row1);
      await waitFor(() => {
        expect(lastItemsQuery(daemon)).toBe('new:any repo:kubernetes/kubernetes');
      });
      expect(window.location.search).toBe('?q=new:any+repo:kubernetes/kubernetes');

      // Click Scoped Acked: replaces whole query
      const row2 = screen.getByTestId('saved-search-row-Scoped Acked');
      fireEvent.click(row2);
      await waitFor(() => {
        expect(lastItemsQuery(daemon)).toBe('triage:acked label:bug');
      });
      const lastReq = daemon.lastRequest<GetItemsRequest>('GetItems');
      expect(lastReq?.sort?.key).toBe(SortKey.CREATED);
      expect(lastReq?.sort?.order).toBe(SortOrder.ASC);
    });

    it('clicking active saved search row resets query to tab clauses and sort to default', async () => {
      const savedSearches = [
        {
          id: 's1',
          name: 'K8s',
          query: 'repo:kubernetes/kubernetes',
          sort: { key: SortKey.CREATED, order: SortOrder.ASC },
        },
      ];
      render({
        getConfig: () => ({
          config: { pollingIntervalMin: 15, savedSearches },
          currentUserLogin: 'testuser',
        }),
        getItems: itemsByQuery({
          '': [],
          'repo:kubernetes/kubernetes': [],
          'new:any': [],
          'new:any repo:kubernetes/kubernetes': [],
        }),
      });

      const row = await screen.findByTestId('saved-search-row-K8s');
      // 1. Click to activate on Inbox
      fireEvent.click(row);
      await waitFor(() => expect(window.location.search).toContain('q=repo:kubernetes/kubernetes'));
      expect(screen.getByTestId('saved-search-row-K8s').getAttribute('aria-current')).toBe('true');
      expect(window.location.search).toContain('sort=created');

      // Click again to deactivate: resets to empty query ('') and default sort
      fireEvent.click(screen.getByTestId('saved-search-row-K8s'));
      await waitFor(() => expect(window.location.search).toBe(''));
      expect(screen.getByTestId('saved-search-row-K8s').getAttribute('aria-current')).toBeNull();

      // 2. Test on New tab
      fireEvent.click(screen.getByRole('button', { name: /^New/i }));
      await waitFor(() => expect(window.location.search).toBe('?q=new:any'));

      fireEvent.click(screen.getByTestId('saved-search-row-K8s'));
      await waitFor(() => expect(window.location.search).toContain('q=new:any+repo:kubernetes/kubernetes'));
      expect(screen.getByTestId('saved-search-row-K8s').getAttribute('aria-current')).toBe('true');

      fireEvent.click(screen.getByTestId('saved-search-row-K8s'));
      await waitFor(() => expect(window.location.search).toBe('?q=new:any'));
      expect(screen.getByTestId('saved-search-row-K8s').getAttribute('aria-current')).toBeNull();
    });

    it('renders empty state hint when there are no saved searches', async () => {
      render({
        getConfig: () => ({
          config: { pollingIntervalMin: 15, savedSearches: [] },
          currentUserLogin: 'testuser',
        }),
      });

      expect(await screen.findByText('Pin a search with the pin button in the search box')).toBeDefined();
    });
  });

  describe('saved searches sidebar edit, reorder and delete (Commit 3.10)', () => {
    it('renames a saved search with mask name keeping stored sort even when dashboard sort differs', async () => {
      // Dashboard has sort=created
      window.history.pushState(null, '', '/?sort=created');
      const savedSearches = [
        {
          id: 's1',
          name: 'Old Name',
          query: 'repo:kubernetes/kubernetes',
          sort: { key: SortKey.UPDATED, order: SortOrder.DESC },
        },
      ];
      let updateReq: UpdateSavedSearchRequest | undefined;
      const { daemon } = render({
        getConfig: () => ({
          config: { pollingIntervalMin: 15, savedSearches },
          currentUserLogin: 'testuser',
        }),
        updateSavedSearch: (req) => {
          updateReq = req;
          return create(UpdateSavedSearchResponseSchema, {
            savedSearches: [
              {
                id: 's1',
                name: req.savedSearch?.name ?? 'Old Name',
                query: 'repo:kubernetes/kubernetes',
                sort: { key: SortKey.UPDATED, order: SortOrder.DESC },
              },
            ],
          });
        },
      });

      // Enter edit mode
      const editBtn = await screen.findByTestId('edit-saved-searches-button');
      fireEvent.click(editBtn);

      const rowEditBtn = screen.getByTestId('edit-saved-search-Old Name');
      fireEvent.click(rowEditBtn);

      expect(screen.getByRole('heading', { name: 'Edit pinned search' })).toBeDefined();
      const input = screen.getByLabelText(/^Name$/i);
      fireEvent.change(input, { target: { value: 'New Name' } });
      fireEvent.click(screen.getByRole('button', { name: /^Update$/i }));

      await waitFor(() => {
        expect(daemon.requestsFor('UpdateSavedSearch')).toHaveLength(1);
      });
      expect(updateReq).toBeDefined();
      expect(updateReq?.savedSearch?.id).toBe('s1');
      expect(updateReq?.savedSearch?.name).toBe('New Name');
      expect(updateReq?.updateMask?.paths).toEqual(['name']);
      // Stored sort is not in the request mask (not overwritten by the dashboard's current sort=created)
      expect(updateReq?.savedSearch?.sort).toBeUndefined();
    });

    it('updates a saved search query via the pin button when search terms are modified', async () => {
      const savedSearches = [
        {
          id: 's1',
          name: 'K8s Bugs',
          query: 'repo:kubernetes/kubernetes label:kind/bug',
          sort: { key: SortKey.UPDATED, order: SortOrder.DESC },
        },
      ];
      let updateReq: UpdateSavedSearchRequest | undefined;
      const { daemon } = render({
        getConfig: () => ({
          config: { pollingIntervalMin: 15, savedSearches },
          currentUserLogin: 'testuser',
        }),
        updateSavedSearch: (req) => {
          updateReq = req;
          return create(UpdateSavedSearchResponseSchema, {
            savedSearches: [
              {
                id: 's1',
                name: req.savedSearch?.name ?? 'K8s Bugs',
                query: req.savedSearch?.query ?? savedSearches[0].query,
                sort: req.savedSearch?.sort ?? savedSearches[0].sort,
              },
            ],
          });
        },
      });

      // Click the saved search in sidebar to open it and set originSearchId
      const searchRow = await screen.findByTestId('saved-search-row-K8s Bugs');
      fireEvent.click(searchRow);

      // Pin button is active
      const pinButton = await screen.findByTestId('pin-search-button');
      expect(pinButton.getAttribute('data-active')).toBe('true');

      // Edit query text in search box to add is:open
      const input = screen.getByRole('combobox', { name: /Filter or search query/i });
      fireEvent.change(input, {
        target: { value: 'repo:kubernetes/kubernetes label:kind/bug is:open' },
      });

      // Pin button transitions to modified state
      expect(pinButton.getAttribute('data-active')).toBe('modified');
      expect(pinButton.getAttribute('aria-label')).toBe('Update pinned search K8s Bugs');

      // Click pin button to open modal in modified mode
      fireEvent.click(pinButton);
      expect(screen.getByRole('dialog')).toBeDefined();
      expect(screen.getByRole('heading', { name: 'Edit pinned search' })).toBeDefined();
      expect(screen.getByTestId('save-as-new-button')).toBeDefined();
      expect(screen.getByTestId('update-saved-search-button')).toBeDefined();

      // Submit the update
      fireEvent.click(screen.getByTestId('update-saved-search-button'));

      await waitFor(() => {
        expect(daemon.requestsFor('UpdateSavedSearch')).toHaveLength(1);
      });
      expect(updateReq).toBeDefined();
      expect(updateReq?.savedSearch?.id).toBe('s1');
      expect(updateReq?.savedSearch?.name).toBe('K8s Bugs');
      expect(updateReq?.savedSearch?.query).toBe(
        'repo:kubernetes/kubernetes label:kind/bug is:open'
      );
      expect(updateReq?.updateMask?.paths).toContain('query');
    });

    it('deletes a saved search via sidebar delete button with confirmation', async () => {
      const savedSearches = [
        { id: 's1', name: 'To Delete', query: 'repo:kubernetes/kubernetes' },
      ];
      let deleteReq: DeleteSavedSearchRequest | undefined;
      const { daemon } = render({
        getConfig: () => ({
          config: { pollingIntervalMin: 15, savedSearches },
          currentUserLogin: 'testuser',
        }),
        deleteSavedSearch: (req) => {
          deleteReq = req;
          return create(DeleteSavedSearchResponseSchema, {});
        },
      });

      const editBtn = await screen.findByTestId('edit-saved-searches-button');
      fireEvent.click(editBtn);

      fireEvent.click(screen.getByTestId('delete-saved-search-To Delete'));
      fireEvent.click(screen.getByTestId('confirm-delete-saved-search-To Delete'));

      await waitFor(() => {
        expect(daemon.requestsFor('DeleteSavedSearch')).toHaveLength(1);
      });
      expect(deleteReq?.id).toBe('s1');
    });

    it('reorders saved searches via keyboard and rolls back on FailedPrecondition', async () => {
      const savedSearches = [
        { id: 's1', name: 'First', query: 'repo:k8s/first' },
        { id: 's2', name: 'Second', query: 'repo:k8s/second' },
      ];
      let rejectReorder!: (err: unknown) => void;
      const reorderPromise = new Promise<never>((_, reject) => {
        rejectReorder = reject;
      });

      const { daemon } = render({
        getConfig: () => ({
          config: { pollingIntervalMin: 15, savedSearches },
          currentUserLogin: 'testuser',
        }),
        reorderSavedSearches: () => reorderPromise,
      });

      const editBtn = await screen.findByTestId('edit-saved-searches-button');
      fireEvent.click(editBtn);

      const handle = screen.getByLabelText('Reorder First');
      // Press ArrowDown to move First down
      fireEvent.keyDown(handle, { key: 'ArrowDown' });

      await waitFor(() => {
        expect(daemon.requestsFor('ReorderSavedSearches')).toHaveLength(1);
      });
      const req = daemon.lastRequest<ReorderSavedSearchesRequest>('ReorderSavedSearches');
      expect(req?.ids).toEqual(['s2', 's1']);

      // Optimistic order is displayed before server responds
      const optimisticRows = screen.getAllByTestId(/^saved-search-edit-row-/);
      expect(optimisticRows[0].getAttribute('data-testid')).toBe('saved-search-edit-row-Second');
      expect(optimisticRows[1].getAttribute('data-testid')).toBe('saved-search-edit-row-First');

      // Server rejects with FailedPrecondition
      act(() => {
        rejectReorder(new ConnectError('stale ids', Code.FailedPrecondition));
      });

      // Rollback on FailedPrecondition: order is restored
      await waitFor(() => {
        const rows = screen.getAllByTestId(/^saved-search-edit-row-/);
        expect(rows[0].getAttribute('data-testid')).toBe('saved-search-edit-row-First');
        expect(rows[1].getAttribute('data-testid')).toBe('saved-search-edit-row-Second');
      });

      // Verify the error toast was displayed
      expect(await screen.findByText('stale ids')).toBeDefined();
    });

    it('aligns placeholder counts by saved search id during reorder so rows never display a neighbour badge', async () => {
      const savedSearches = [
        { id: 's1', name: 'Alpha', query: 'repo:k8s/alpha' },
        { id: 's2', name: 'Beta', query: 'repo:k8s/beta' },
      ];
      let facetsCall = 0;
      let resolveSecondFacets!: () => void;
      const secondFacetsPromise = new Promise<void>((resolve) => {
        resolveSecondFacets = resolve;
      });

      render({
        getConfig: () => ({
          config: { pollingIntervalMin: 15, savedSearches },
          currentUserLogin: 'testuser',
        }),
        getFacets: async (req) => {
          if (req.queries.length > 0) {
            facetsCall++;
            if (facetsCall === 1) {
              return {
                facets: req.fields.map((field) => ({ field, values: [] })),
                counts: [
                  { count: 10, newCount: 0, inboxCount: 10 }, // Alpha (index 0) has 10
                  { count: 5, newCount: 0, inboxCount: 5 }, // Beta (index 1) has 5
                ],
              };
            }
            // Hold the second call on deferred promise so placeholder data is active
            await secondFacetsPromise;
            return {
              facets: req.fields.map((field) => ({ field, values: [] })),
              counts: [
                { count: 5, newCount: 0, inboxCount: 5 }, // Beta (index 0) has 5
                { count: 10, newCount: 0, inboxCount: 10 }, // Alpha (index 1) has 10
              ],
            };
          }
          return { facets: req.fields.map((field) => ({ field, values: [] })), counts: [] };
        },
        reorderSavedSearches: () => ({
          savedSearches: [savedSearches[1], savedSearches[0]],
        }),
      });

      // Initial settle: Alpha has 10, Beta has 5
      expect(await screen.findByTestId('saved-search-count-Alpha')).toBeDefined();
      expect(screen.getByTestId('saved-search-count-Alpha').textContent).toBe('10');
      expect(screen.getByTestId('saved-search-count-Beta').textContent).toBe('5');

      // Enter edit mode and reorder (move Alpha down so Beta is first)
      fireEvent.click(screen.getByTestId('edit-saved-searches-button'));
      fireEvent.keyDown(screen.getByLabelText('Reorder Alpha'), { key: 'ArrowDown' });

      // Exit edit mode to inspect normal sidebar rows and badges while second GetFacets is still in flight
      fireEvent.click(screen.getByTestId('edit-saved-searches-button'));

      // In placeholder state, Beta is first and Alpha is second, but each keeps its own count!
      await waitFor(() => {
        expect(screen.getByTestId('saved-search-row-Beta')).toBeDefined();
      });
      expect(screen.getByTestId('saved-search-count-Beta').textContent).toBe('5');
      expect(screen.getByTestId('saved-search-count-Alpha').textContent).toBe('10');

      // Resolve the second GetFacets call
      act(() => {
        resolveSecondFacets();
      });

      await waitFor(() => {
        expect(screen.getByTestId('saved-search-count-Beta').textContent).toBe('5');
        expect(screen.getByTestId('saved-search-count-Alpha').textContent).toBe('10');
      });
    });

    it('saving as new with sort-only change preserves the query without toggling off', async () => {
      window.history.pushState(null, '', '/?q=repo:kubernetes/kubernetes');
      let createdReq: CreateSavedSearchRequest | undefined;
      const { daemon } = render({
        createSavedSearch: (req) => {
          createdReq = req;
          return create(CreateSavedSearchResponseSchema, {
            savedSearch: req.savedSearch ? { ...req.savedSearch, id: 'new-id' } : undefined,
            savedSearches: req.savedSearch ? [{ ...req.savedSearch, id: 'new-id' }] : [],
          });
        },
      });

      const pinButton = await screen.findByTestId('pin-search-button');
      fireEvent.click(pinButton);

      const sortBtn = within(screen.getByTestId('saved-search-preview')).getByRole('button', { name: 'Sort options' });
      fireEvent.click(sortBtn);
      fireEvent.click(screen.getByRole('button', { name: /^Creation Date$/i }));
      fireEvent.click(sortBtn);
      fireEvent.click(screen.getByRole('button', { name: /^Ascending$/i }));

      fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));

      await waitFor(() => {
        expect(daemon.requestsFor('CreateSavedSearch')).toHaveLength(1);
      });
      expect(createdReq?.savedSearch?.sort?.key).toBe(SortKey.CREATED);
      expect(createdReq?.savedSearch?.sort?.order).toBe(SortOrder.ASC);

      expect(window.location.search).toContain('q=repo:kubernetes/kubernetes');
      expect(window.location.search).toContain('sort=created');
      expect(window.location.search).toContain('order=asc');
      const input = screen.getByRole('combobox', { name: /Filter or search query/i });
      expect((input as HTMLTextAreaElement).value).toBe('repo:kubernetes/kubernetes');
    });

    it('updating an active unscoped search while on the Acked tab preserves tab clauses and pushes a single history entry', async () => {
      const savedSearches = [
        {
          id: 's1',
          name: 'K8s',
          query: 'repo:kubernetes/kubernetes',
          sort: { key: SortKey.UPDATED, order: SortOrder.DESC },
        },
      ];
      window.history.pushState(null, '', '/?q=triage:acked repo:kubernetes/kubernetes');
      let updateReq: UpdateSavedSearchRequest | undefined;
      const { daemon } = render({
        getConfig: () => ({
          config: { pollingIntervalMin: 15, savedSearches },
          currentUserLogin: 'testuser',
        }),
        updateSavedSearch: (req) => {
          updateReq = req;
          return create(UpdateSavedSearchResponseSchema, {
            savedSearches: [
              {
                id: 's1',
                name: req.savedSearch?.name ?? 'K8s',
                query: req.savedSearch?.query ?? 'repo:kubernetes/kubernetes',
                sort: req.savedSearch?.sort ?? savedSearches[0].sort,
              },
            ],
          });
        },
      });

      const editBtn = await screen.findByTestId('edit-saved-searches-button');
      fireEvent.click(editBtn);

      const rowEditBtn = screen.getByTestId('edit-saved-search-K8s');
      fireEvent.click(rowEditBtn);

      const pushSpy = vi.spyOn(window.history, 'pushState');

      const sortBtn = within(screen.getByTestId('saved-search-preview')).getByRole('button', { name: 'Sort options' });
      fireEvent.click(sortBtn);
      fireEvent.click(screen.getByRole('button', { name: /^Creation Date$/i }));
      fireEvent.click(sortBtn);
      fireEvent.click(screen.getByRole('button', { name: /^Ascending$/i }));

      fireEvent.click(screen.getByRole('button', { name: /^Update$/i }));

      await waitFor(() => {
        expect(daemon.requestsFor('UpdateSavedSearch')).toHaveLength(1);
      });
      expect(updateReq?.savedSearch?.id).toBe('s1');

      // Atomic update pushes a single history entry
      expect(pushSpy).toHaveBeenCalledTimes(1);

      // Preserves triage:acked tab and applies new sort
      expect(window.location.search).toContain('q=triage:acked+repo:kubernetes/kubernetes');
      expect(window.location.search).toContain('sort=created');
      expect(window.location.search).toContain('order=asc');

      pushSpy.mockRestore();
    });

    it('clearing the query text to empty resets originSearchId so new queries are not marked as updates', async () => {
      const savedSearches = [
        {
          id: 's1',
          name: 'K8s',
          query: 'repo:kubernetes/kubernetes',
          sort: { key: SortKey.UPDATED, order: SortOrder.DESC },
        },
      ];
      render({
        getConfig: () => ({
          config: { pollingIntervalMin: 15, savedSearches },
          currentUserLogin: 'testuser',
        }),
      });

      const searchRow = await screen.findByTestId('saved-search-row-K8s');
      fireEvent.click(searchRow);

      const pinButton = await screen.findByTestId('pin-search-button');
      expect(pinButton.getAttribute('data-active')).toBe('true');

      // Clear query input to empty
      const input = screen.getByRole('combobox', { name: /Filter or search query/i });
      fireEvent.change(input, { target: { value: '' } });

      expect(pinButton.getAttribute('data-active')).toBe('false');

      // Type a completely new query
      fireEvent.change(input, { target: { value: 'repo:kubernetes/website is:open' } });

      // Pin button is default "Pin search", not "Update pinned search K8s"
      expect(pinButton.getAttribute('data-active')).toBe('false');
      expect(pinButton.getAttribute('aria-label')).toBe('Pin search');
    });
  });
});
