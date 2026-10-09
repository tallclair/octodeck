import { screen, waitFor } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { DataBrowser } from '../DataBrowser';
import { predicatesOf, renderWithDaemon } from '../../test/rpcTestUtils';
import { Field } from '../../api/octodeck/v1/query_pb';
import type { GetItemsRequest } from '../../api/octodeck/v1/service_pb';
import { ItemState, ItemStatus, ItemType } from '../../api/octodeck/v1/resources_pb';

describe('DataBrowser (RPC-level)', () => {
  it('requests every cached item with triage:all and renders the response', async () => {
    const { daemon } = renderWithDaemon(<DataBrowser onBack={() => {}} />, {
      getItems: () => ({
        items: [
          {
            id: 'PR_1',
            repo: 'kubernetes/kubernetes',
            number: 137999,
            type: ItemType.PR,
            state: ItemState.OPEN,
            title: 'Fix kubelet panic in pod resize',
            url: 'https://github.com/kubernetes/kubernetes/pull/137999',
            local: { computedStatus: ItemStatus.ACKED, isAcked: true },
          },
        ],
      }),
      getConfig: () => ({ config: { pollingIntervalMin: 15 } }),
      getSyncTraces: () => ({}),
      getDatabaseStats: () => ({}),
    });

    // The acked item is listed: the request opted out of the implicit triage:inbox scope.
    expect(await screen.findByText('Cached Items (1)')).toBeDefined();
    expect(screen.getByText('Fix kubelet panic in pod resize')).toBeDefined();

    await waitFor(() => expect(daemon.requestsFor('GetItems').length).toBeGreaterThan(0));
    for (const req of daemon.requestsFor<GetItemsRequest>('GetItems')) {
      expect(predicatesOf(req.query)).toEqual([{ field: Field.TRIAGE, values: ['all'], negated: false }]);
    }
  });
});
