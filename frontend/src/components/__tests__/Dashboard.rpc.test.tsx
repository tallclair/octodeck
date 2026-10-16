// Dashboard tests with the daemon mocked at the RPC level: requests go through the real
// connect-query hooks and a router transport. Each test asserts the request the dashboard sends
// (the structured query, sort and facet fields) and renders exactly what the daemon returns —
// the client does no filtering, option extraction or counting of its own.
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { create, type MessageInitShape } from '@bufbuild/protobuf';
import { Code, ConnectError } from '@connectrpc/connect';
import { Dashboard } from '../Dashboard';
import {
  defaultHandlers,
  facetResponse,
  predicatesOf,
  renderWithDaemon,
  type FacetSpec,
  type OctoDeckHandlers,
} from '../../test/rpcTestUtils';
import { queryPillTexts, removeQueryClause, stubQueryPillLayout } from '../../test/queryInput';
import { ItemState, ItemStatus, ItemType, SubscriptionState, type Item, type ItemSchema } from '../../api/octodeck/v1/resources_pb';
import { ExprErrorSchema, Field, SortKey, SortOrder, type Expr } from '../../api/octodeck/v1/query_pb';
import type { GetFacetsRequest, GetItemRequest, GetItemsRequest } from '../../api/octodeck/v1/service_pb';

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
      expect(daemon.requestsFor('GetFacets').length).toBeGreaterThanOrEqual(facetCalls + 3);
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
      await waitFor(() => expect(daemon.requestsFor('GetFacets').length).toBeGreaterThanOrEqual(facetCalls + 3));
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
        config: { pollingIntervalMin: 15, pinnedRepos: ['kubernetes/kubernetes', 'kubernetes/website'] },
        currentUserLogin: 'testuser',
      }),
      getItems: (req) => {
        const key = describeQuery(req.query);
        return { items: key === 'repo:kubernetes/kubernetes' ? [item('PR_1', 'Repo-scoped PR')] : [item('PR_0', 'Inbox PR')] };
      },
      getFacets: facets({
        sidebar: {
          [Field.REPO]: [
            ['kubernetes/kubernetes', 2, { latestMs: now }],
            ['kubernetes/community', 1, { latestMs: now - DAY_MS }],
            ['kubernetes/quiet', 3, { latestMs: now - 2 * DAY_MS }],
            ['kubernetes/stale-repo', 0, { latestMs: now - 40 * DAY_MS }],
          ],
          [Field.TRIAGE]: [['inbox', 7], ['acked', 3]],
        },
        unread: {
          [Field.REPO]: [['kubernetes/kubernetes', 1], ['kubernetes/community', 0], ['kubernetes/quiet', 0]],
          [Field.TRIAGE]: [['inbox', 2], ['acked', 0]],
        },
      }),
    });

    it('shows the Inbox, New and Acked totals from the triage facets', async () => {
      const { daemon } = render(sidebarHandlers());
      await waitFor(() => expect(within(screen.getByRole('button', { name: /^Inbox/i })).getByText('7')).toBeDefined());
      expect(within(screen.getByRole('button', { name: /^New/i })).getByText('2')).toBeDefined();
      expect(within(screen.getAllByRole('button', { name: /^Acked/i })[0]).getByText('3')).toBeDefined();

      const sidebarRequests = daemon.requestsFor<GetFacetsRequest>('GetFacets').filter((r) => !r.fields.includes(Field.AUTHOR));
      expect(sidebarRequests.some((r) => r.query === undefined && r.fields.join() === [Field.REPO, Field.TRIAGE].join())).toBe(true);
      expect(sidebarRequests.some((r) => describeQuery(r.query) === 'new:any')).toBe(true);
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

      // A pinned repo without items has no badge.
      expect(screen.queryByTestId('repo-count-kubernetes/website')).toBeNull();
    });

    it('lists pinned repos first and hides repos without activity in 30 days behind More', async () => {
      render(sidebarHandlers());
      expect(await screen.findByText('Pinned')).toBeDefined();
      expect(screen.getByText('Other Repositories')).toBeDefined();
      expect(screen.getAllByRole('button', { name: /kubernetes\/website/i }).length).toBeGreaterThan(0);
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
});
