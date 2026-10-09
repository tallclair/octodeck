// Test-only helpers that mock the daemon at the RPC level: requests flow through the real
// connect-query hooks, a real QueryClient and a router transport backed by in-memory handlers.
import type { ReactElement, ReactNode } from 'react';
import { render, type RenderOptions } from '@testing-library/react';
import type { MessageInitShape } from '@bufbuild/protobuf';
import {
  Code,
  ConnectError,
  createRouterTransport,
  type Interceptor,
  type ServiceImpl,
  type Transport,
} from '@connectrpc/connect';
import { TransportProvider } from '@connectrpc/connect-query';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OctoDeckService, type GetFacetsResponseSchema } from '../api/octodeck/v1/service_pb';
import type { Expr, Field } from '../api/octodeck/v1/query_pb';

export type OctoDeckHandlers = Partial<ServiceImpl<typeof OctoDeckService>>;

/** A request observed by the mock transport, in arrival order. */
export interface RecordedCall {
  method: string;
  request: unknown;
}

export interface MockDaemon {
  transport: Transport;
  calls: RecordedCall[];
  /** Requests received for one method (by RPC name, e.g. 'GetItems'). */
  requestsFor<T = unknown>(rpcName: string): T[];
  /** The most recent request for one method, or undefined. */
  lastRequest<T = unknown>(rpcName: string): T | undefined;
}

/**
 * Creates a router transport serving the given handlers. Methods without a handler fail with
 * Code.Unimplemented, which makes a forgotten mock visible instead of silently returning empty data.
 */
export function createMockDaemon(handlers: OctoDeckHandlers): MockDaemon {
  const calls: RecordedCall[] = [];
  const recorder: Interceptor = (next) => async (req) => {
    if (!req.stream) {
      calls.push({ method: req.method.name, request: req.message });
    }
    return next(req);
  };
  const transport = createRouterTransport(({ service }) => service(OctoDeckService, handlers), {
    transport: { interceptors: [recorder] },
  });
  const requestsFor = <T,>(rpcName: string): T[] =>
    calls.filter((c) => c.method === rpcName).map((c) => c.request as T);
  return {
    transport,
    calls,
    requestsFor,
    lastRequest: <T,>(rpcName: string): T | undefined => requestsFor<T>(rpcName).at(-1),
  };
}

/** A QueryClient tuned for tests: no retries (errors surface immediately), no cache GC timers. */
export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
}

/**
 * Handlers for every RPC the dashboard issues on load, returning empty data. Tests spread their
 * own handlers over these and only override what they assert.
 */
export function defaultHandlers(overrides: OctoDeckHandlers = {}): OctoDeckHandlers {
  return {
    getConfig: () => ({
      config: { pollingIntervalMin: 15, watchedRepos: ['kubernetes/kubernetes'], pinnedRepos: [] },
      currentUserLogin: 'testuser',
    }),
    getSyncStatus: () => ({ status: { isSyncing: false } }),
    getItems: () => ({ items: [] }),
    // One facet per requested field, in request order (the daemon's contract).
    getFacets: (req) => ({ facets: req.fields.map((field) => ({ field, values: [] })) }),
    getItem: () => {
      throw new ConnectError('item not found', Code.NotFound);
    },
    ...overrides,
  };
}

export interface PlainPredicate {
  field: Field;
  values: string[];
  negated: boolean;
}

/**
 * Flattens a request Expr into its predicates: a single predicate, or the predicate children of
 * a top-level AND. Written independently of the production builders so assertions are not
 * tautological. Fails on shapes the dashboard never sends.
 */
export function predicatesOf(expr: Expr | undefined): PlainPredicate[] {
  if (!expr || expr.kind.case === undefined) return [];
  const plain = (e: Expr): PlainPredicate => {
    if (e.kind.case !== 'predicate') throw new Error(`unexpected nested ${String(e.kind.case)}`);
    const { field, values, negated } = e.kind.value;
    return { field, values: [...values], negated };
  };
  if (expr.kind.case === 'and') return expr.kind.value.exprs.map(plain);
  return [plain(expr)];
}

export type FacetSpec = [value: string, count: number, extra?: { color?: string; latestMs?: number }];

/** Builds a GetFacets response for the requested fields from per-field value lists. */
export function facetResponse(
  fields: readonly Field[],
  values: Partial<Record<Field, FacetSpec[]>>
): MessageInitShape<typeof GetFacetsResponseSchema> {
  return {
    facets: fields.map((field) => ({
      field,
      values: (values[field] ?? []).map(([value, count, extra]) => ({
        value,
        count,
        color: extra?.color ?? '',
        latestActivityAt:
          extra?.latestMs === undefined
            ? undefined
            : { seconds: BigInt(Math.floor(extra.latestMs / 1000)), nanos: (extra.latestMs % 1000) * 1_000_000 },
      })),
    })),
  };
}

export function renderWithDaemon(
  ui: ReactElement,
  handlers: OctoDeckHandlers,
  options: Omit<RenderOptions, 'wrapper'> & { queryClient?: QueryClient } = {}
) {
  const daemon = createMockDaemon(handlers);
  const queryClient = options.queryClient ?? createTestQueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <TransportProvider transport={daemon.transport}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </TransportProvider>
  );
  const result = render(ui, { ...options, wrapper });
  return { ...result, daemon, queryClient };
}
