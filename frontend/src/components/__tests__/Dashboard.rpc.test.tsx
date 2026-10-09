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

function render(handlers: OctoDeckHandlers) {
  return renderWithDaemon(<Dashboard />, defaultHandlers(handlers));
}

describe('Dashboard (RPC-level)', () => {
  beforeEach(() => {
    window.history.pushState(null, '', '/');
  });

  afterEach(() => {
    vi.useRealTimers();
    window.history.pushState(null, '', '/');
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

    it('sends the legacy example URL as the equivalent structured query, in URL order', async () => {
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
      expect(window.location.search).toBe('?repo=a/b&author=x&triage=acked&state=closed&label=bug');
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
          if (describeQuery(req.query) === 'type:pr') {
            await pending;
            return { items: [item('PR_2', 'Only PRs')] };
          }
          return { items: [item('PR_1', 'Everything')] };
        },
      });
      expect(await screen.findByText('Everything')).toBeDefined();

      fireEvent.click(within(screen.getByRole('group', { name: /Filter item type/i })).getByRole('button', { name: /PRs/i }));
      await act(async () => {
        await new Promise((r) => setTimeout(r, 50));
      });
      expect(screen.queryByText(/Connecting to OctoDeck Daemon/i)).toBeNull();
      expect(screen.getByText('Everything')).toBeDefined();

      release();
      expect(await screen.findByText('Only PRs')).toBeDefined();
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
    it('filters by type with the segmented control', async () => {
      const pr = item('PR_1', 'Fix bug PR');
      const issue = item('ISSUE_1', 'Open feature issue', { type: ItemType.ISSUE });
      const { daemon } = render({ getItems: itemsByQuery({ '': [pr, issue], 'type:pr': [pr], 'type:issue': [issue] }) });
      expect(await screen.findByText('Open feature issue')).toBeDefined();
      const typeGroup = screen.getByRole('group', { name: /Filter item type/i });

      fireEvent.click(within(typeGroup).getByRole('button', { name: /PRs/i }));
      await waitFor(() => expect(screen.queryByText('Open feature issue')).toBeNull());
      expect(lastItemsQuery(daemon)).toBe('type:pr');
      expect(window.location.search).toBe('?type=pr');

      fireEvent.click(within(typeGroup).getByRole('button', { name: /Issues/i }));
      await waitFor(() => expect(screen.queryByText('Fix bug PR')).toBeNull());
      expect(lastItemsQuery(daemon)).toBe('type:issue');

      fireEvent.click(within(typeGroup).getByRole('button', { name: /^All$/i }));
      expect(await screen.findByText('Fix bug PR')).toBeDefined();
      // Back to the unfiltered query: its cached result is shown (the query key includes the request).
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
      expect(window.location.search).toBe('?triage=activity');

      const titleDropdown = screen.getByLabelText(/Select triage status/i);
      fireEvent.click(titleDropdown);
      fireEvent.click(screen.getAllByRole('button', { name: /Acked/i })[1]);
      expect(await screen.findByText('Acked PR')).toBeDefined();
      expect(screen.queryByText('New PR')).toBeNull();
      expect(lastItemsQuery(daemon)).toBe('triage:acked');
      expect(window.location.search).toBe('?triage=acked');

      fireEvent.click(titleDropdown);
      fireEvent.click(screen.getAllByRole('button', { name: /Inbox/i })[1]);
      expect(await screen.findByText('Idle PR')).toBeDefined();
      // Back to the unfiltered query: its cached result is shown (the query key includes the request).
    });

    it('filters by state with the state menu', async () => {
      const open = item('PR_1', 'Open PR');
      const closed = item('PR_2', 'Closed PR', { state: ItemState.CLOSED });
      const { daemon } = render({ getItems: itemsByQuery({ '': [open, closed], 'state:closed': [closed], 'state:open': [open] }) });
      expect(await screen.findByText('Closed PR')).toBeDefined();
      const stateTrigger = screen.getByRole('button', { name: /Filter by state/i });

      fireEvent.click(stateTrigger);
      fireEvent.click(screen.getByRole('button', { name: /^Closed$/i }));
      await waitFor(() => expect(screen.queryByText('Open PR')).toBeNull());
      expect(lastItemsQuery(daemon)).toBe('state:closed');

      fireEvent.click(stateTrigger);
      fireEvent.click(within(stateTrigger.parentElement!).getByRole('button', { name: /^Open$/i }));
      await waitFor(() => expect(screen.queryByText('Closed PR')).toBeNull());
      expect(lastItemsQuery(daemon)).toBe('state:open');
      expect(window.location.search).toBe('?state=open');
    });

    it('filters by tracking and removes the filter with its chip', async () => {
      const tracked = item('PR_T', 'Tracked PR', { viewerSubscription: SubscriptionState.SUBSCRIBED });
      const untracked = item('PR_U', 'Untracked PR', { viewerSubscription: SubscriptionState.UNSUBSCRIBED });
      const { daemon } = render({
        getItems: itemsByQuery({ '': [tracked, untracked], 'tracking:false': [untracked], 'tracking:true': [tracked] }),
      });
      expect(await screen.findByText('Tracked PR')).toBeDefined();
      const stateTrigger = screen.getByRole('button', { name: /Filter by state/i });

      fireEvent.click(stateTrigger);
      fireEvent.click(within(stateTrigger.parentElement!).getByRole('button', { name: /^Untracked$/i }));
      await waitFor(() => expect(screen.queryByText('Tracked PR')).toBeNull());
      expect(lastItemsQuery(daemon)).toBe('tracking:false');
      expect(window.location.search).toBe('?tracking=untracked');
      expect(screen.getByText('Tracking:')).toBeDefined();

      fireEvent.click(stateTrigger);
      fireEvent.click(within(stateTrigger.parentElement!).getByRole('button', { name: /^Tracked$/i }));
      await waitFor(() => expect(screen.queryByText('Untracked PR')).toBeNull());
      expect(lastItemsQuery(daemon)).toBe('tracking:true');

      fireEvent.click(screen.getByRole('button', { name: /Remove tracking filter/i }));
      expect(await screen.findByText('Untracked PR')).toBeDefined();
      expect(screen.queryByText('Tracking:')).toBeNull();
      // Back to the unfiltered query: its cached result is shown (the query key includes the request).
      expect(window.location.search).toBe('');
    });

    it('filters by assignee:@me with the Assigned to me toggle', async () => {
      const mine = item('PR_1', 'Assigned PR');
      const other = item('PR_2', 'Unassigned PR');
      const { daemon } = render({ getItems: itemsByQuery({ '': [mine, other], 'assignee:@me': [mine] }) });
      expect(await screen.findByText('Unassigned PR')).toBeDefined();
      const toggle = screen.getByRole('button', { name: /Assigned to me/i });

      fireEvent.click(toggle);
      await waitFor(() => expect(screen.queryByText('Unassigned PR')).toBeNull());
      expect(lastItemsQuery(daemon)).toBe('assignee:@me');
      expect(window.location.search).toBe('?assigned=me');

      fireEvent.click(toggle);
      expect(await screen.findByText('Unassigned PR')).toBeDefined();
      expect(window.location.search).toBe('');
    });

    it('filters by author from the facet options and clears with Reset filters', async () => {
      const alice = item('PR_1', 'Alice PR', { author: { login: 'alice' } });
      const bob = item('PR_2', 'Bob PR', { author: { login: 'bob' } });
      const { daemon } = render({
        getItems: itemsByQuery({ '': [alice, bob], 'author:alice': [alice] }),
        getFacets: facets({ selector: { [Field.AUTHOR]: [['alice', 1], ['bob', 1]] } }),
      });
      expect(await screen.findByText('Bob PR')).toBeDefined();

      fireEvent.click(screen.getByRole('button', { name: /Filter by author/i }));
      fireEvent.click(await screen.findByRole('button', { name: /@alice/i }));
      await waitFor(() => expect(screen.queryByText('Bob PR')).toBeNull());
      expect(lastItemsQuery(daemon)).toBe('author:alice');
      expect(window.location.search).toBe('?author=alice');

      fireEvent.click(screen.getByRole('button', { name: /Reset filters/i }));
      expect(await screen.findByText('Bob PR')).toBeDefined();
      // Back to the unfiltered query: its cached result is shown (the query key includes the request).
    });

    it('filters by org and then repo from the combined selector', async () => {
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
      const repoTrigger = screen.getByRole('button', { name: /Filter by repository/i });
      const repoMenu = repoTrigger.parentElement!;

      fireEvent.click(repoTrigger);
      fireEvent.click(within(repoMenu).getByRole('button', { name: /^kubernetes$/i }));
      await waitFor(() => expect(screen.queryByText('Go lang')).toBeNull());
      expect(lastItemsQuery(daemon)).toBe('org:kubernetes');
      expect(window.location.search).toBe('?org=kubernetes');

      fireEvent.click(repoTrigger);
      fireEvent.click(within(repoMenu).getByRole('button', { name: /kubernetes\/minikube/i }));
      await waitFor(() => expect(screen.queryByText('K8s core')).toBeNull());
      expect(lastItemsQuery(daemon)).toBe('repo:kubernetes/minikube');
      expect(window.location.search).toBe('?repo=kubernetes/minikube');
    });

    it('filters by milestone and removes it with the chip', async () => {
      const m1 = item('PR_1', 'Milestone 1.32 PR', { milestone: { title: 'v1.32' } });
      const m2 = item('PR_2', 'Milestone 1.33 PR', { milestone: { title: 'v1.33' } });
      const { daemon } = render({
        getItems: itemsByQuery({ '': [m1, m2], 'milestone:v1.32': [m1] }),
        getFacets: facets({ selector: { [Field.MILESTONE]: [['v1.32', 1], ['v1.33', 1]] } }),
      });
      expect(await screen.findByText('Milestone 1.33 PR')).toBeDefined();

      fireEvent.click(screen.getByRole('button', { name: /Filter by milestone/i }));
      fireEvent.click(await screen.findByRole('button', { name: /^v1\.32$/i }));
      await waitFor(() => expect(screen.queryByText('Milestone 1.33 PR')).toBeNull());
      expect(lastItemsQuery(daemon)).toBe('milestone:v1.32');
      expect(screen.getByText('Milestone:')).toBeDefined();
      expect(window.location.search).toBe('?milestone=v1.32');

      fireEvent.click(screen.getByRole('button', { name: /Remove milestone filter/i }));
      expect(await screen.findByText('Milestone 1.33 PR')).toBeDefined();
      expect(window.location.search).toBe('');
    });

    it('filters by label, showing the facet label color, and removes it with the chip', async () => {
      const bug = item('PR_1', 'Fix issue 1', { labels: [{ name: 'kind/bug', color: 'd73a4a' }] });
      const feature = item('PR_2', 'Feature 2', { labels: [{ name: 'kind/feature', color: 'a2eeef' }] });
      const { daemon } = render({
        getItems: itemsByQuery({ '': [bug, feature], 'label:kind/bug': [bug] }),
        getFacets: facets({
          selector: { [Field.LABEL]: [['kind/bug', 1, { color: 'd73a4a' }], ['kind/feature', 1, { color: 'a2eeef' }]] },
        }),
      });
      expect(await screen.findByText('Feature 2')).toBeDefined();

      fireEvent.click(screen.getByRole('button', { name: /Filter by label/i }));
      const bugOption = await screen.findByRole('button', { name: /kind\/bug/i });
      const swatch = bugOption.querySelector('span[style]') as HTMLElement;
      expect(swatch.style.backgroundColor).toBe('rgb(215, 58, 74)');

      fireEvent.click(bugOption);
      await waitFor(() => expect(screen.queryByText('Feature 2')).toBeNull());
      expect(lastItemsQuery(daemon)).toBe('label:kind/bug');
      expect(screen.getByText('Label:')).toBeDefined();
      expect(window.location.search).toBe('?label=kind/bug');

      fireEvent.click(screen.getByRole('button', { name: /Remove label filter/i }));
      expect(await screen.findByText('Feature 2')).toBeDefined();
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

    it('shows URL-only predicates (negation, multiple values) as chips and removes them', async () => {
      window.history.pushState(null, '', '/?-label=bug&label=a&label=b');
      const { daemon } = render({
        getItems: itemsByQuery({
          '-label:bug label:a,b': [item('PR_1', 'Narrow result')],
          'label:a,b': [item('PR_1', 'Narrow result'), item('PR_2', 'Wider result')],
        }),
      });

      expect(await screen.findByText('Narrow result')).toBeDefined();
      const chips = screen.getAllByTestId('extra-filter-chip');
      expect(chips.map((c) => c.textContent)).toEqual(['Not Label:bug', 'Label:a, b']);

      fireEvent.click(within(chips[0]).getByRole('button'));
      expect(await screen.findByText('Wider result')).toBeDefined();
      expect(lastItemsQuery(daemon)).toBe('label:a,b');
      expect(window.location.search).toBe('?label=a&label=b');
    });

    it('debounces search typing into one TEXT predicate per word or phrase', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const { daemon } = render({
        getItems: (req) => ({ items: [item('PR_1', `Result for "${describeQuery(req.query)}"`)] }),
      });
      await screen.findByText('Result for ""');
      const input = screen.getByPlaceholderText(/Search title and body/i) as HTMLInputElement;

      act(() => {
        fireEvent.change(input, { target: { value: 'f' } });
        fireEvent.change(input, { target: { value: 'fla' } });
        fireEvent.change(input, { target: { value: 'flaky "big test"' } });
      });
      expect(input.value).toBe('flaky "big test"');
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
      expect(selectorRequests[0].fields).toEqual([Field.REPO, Field.ORG, Field.AUTHOR, Field.MILESTONE, Field.LABEL]);
      expect(describeQuery(selectorRequests[0].query)).toBe('new:any -label:x');
    });

    it('shows values with matches by default and zero-count values with Show all', async () => {
      render({ getFacets: facets({ selector }) });
      const authorTrigger = await screen.findByRole('button', { name: /Filter by author/i });
      await waitFor(() => {
        fireEvent.click(authorTrigger);
        expect(screen.getByRole('button', { name: /@alice/i })).toBeDefined();
      });
      expect(screen.getByRole('button', { name: /@bob/i })).toBeDefined();
      expect(screen.queryByRole('button', { name: /@charlie/i })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: /^Show all$/i }));
      expect(screen.getByRole('button', { name: /@charlie/i })).toBeDefined();
      // Closing the menu resets it to the default view.
      fireEvent.keyDown(window, { key: 'Escape' });
      fireEvent.click(authorTrigger);
      expect(screen.queryByRole('button', { name: /@charlie/i })).toBeNull();
      fireEvent.keyDown(window, { key: 'Escape' });

      fireEvent.click(screen.getByRole('button', { name: /Filter by milestone/i }));
      expect(screen.getByRole('button', { name: /^v1\.0$/i })).toBeDefined();
      expect(screen.queryByRole('button', { name: /^v2\.0$/i })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: /^Show all$/i }));
      expect(screen.getByRole('button', { name: /^v2\.0$/i })).toBeDefined();
      fireEvent.keyDown(window, { key: 'Escape' });

      const repoTrigger = screen.getByRole('button', { name: /Filter by repository/i });
      const repoMenu = repoTrigger.parentElement!;
      fireEvent.click(repoTrigger);
      expect(within(repoMenu).getByRole('button', { name: /kubernetes\/minikube/i })).toBeDefined();
      expect(within(repoMenu).queryByRole('button', { name: /^golang$/i })).toBeNull();
      expect(within(repoMenu).queryByRole('button', { name: /golang\/go/i })).toBeNull();
      fireEvent.click(within(repoMenu).getByRole('button', { name: /^Show all$/i }));
      expect(within(repoMenu).getByRole('button', { name: /^golang$/i })).toBeDefined();
      expect(within(repoMenu).getByRole('button', { name: /golang\/go/i })).toBeDefined();
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
        expect(within(authorTrigger.parentElement!).getByRole('button', { name: /@alice/i })).toBeDefined();
      });
      expect(within(authorTrigger.parentElement!).queryByRole('button', { name: /^Show all$/i })).toBeNull();
      fireEvent.keyDown(window, { key: 'Escape' });

      const repoTrigger = screen.getByRole('button', { name: /Filter by repository/i });
      fireEvent.click(repoTrigger);
      expect(within(repoTrigger.parentElement!).getByRole('button', { name: /kubernetes\/kubernetes/i })).toBeDefined();
      expect(within(repoTrigger.parentElement!).queryByRole('button', { name: /^Show all$/i })).toBeNull();
    });

    it('always lists the selected value, even when the facet does not contain it', async () => {
      window.history.pushState(null, '', '/?author=zed');
      render({ getItems: itemsByQuery({ 'author:zed': [] }), getFacets: facets({ selector }) });
      const authorTrigger = await screen.findByRole('button', { name: /Filter by author/i });
      await waitFor(() => {
        fireEvent.click(authorTrigger);
        expect(screen.getByRole('button', { name: /@alice/i })).toBeDefined();
      });
      expect(screen.getByRole('button', { name: /@zed/i })).toBeDefined();
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
      expect(window.location.search).toBe('?repo=kubernetes/kubernetes');

      fireEvent.click(screen.getByLabelText(/Remove repository filter/i));
      expect(await screen.findByText('Inbox PR')).toBeDefined();
      expect(window.location.search).toBe('');
    });
  });

  describe('errors and the selected item', () => {
    it('reports an invalid query inline instead of as a disconnection', async () => {
      window.history.pushState(null, '', '/?state=merged');
      render({
        getItems: () => {
          throw new ConnectError('invalid query', Code.InvalidArgument, undefined, [
            { desc: ExprErrorSchema, value: create(ExprErrorSchema, { path: 'and.exprs[0]', message: 'state "merged" is not supported here' }) },
          ]);
        },
      });

      const alert = await screen.findByTestId('invalid-query');
      expect(alert.textContent).toContain('state "merged" is not supported here');
      expect(screen.queryByTestId('daemon-disconnected-banner')).toBeNull();
      expect(screen.queryByTestId('daemon-offline-empty-state')).toBeNull();
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
