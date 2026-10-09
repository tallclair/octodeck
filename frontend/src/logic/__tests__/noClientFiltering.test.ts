// Guard: filtering, option extraction and counting happen in the daemon (GetItems/GetFacets).
// The client-side engine must not come back in production code.
import { describe, it, expect } from 'vitest';

const productionSources = import.meta.glob<string>(
  ['../../**/*.{ts,tsx}', '!../../**/__tests__/**', '!../../api/**', '!../../test/**'],
  { query: '?raw', import: 'default', eager: true }
);

describe('no client-side filter engine in production code', () => {
  it('scans a non-trivial set of files', () => {
    expect(Object.keys(productionSources)).toContain('../../components/Dashboard.tsx');
  });

  it.each([
    'applyFilters',
    'extractUniqueOrgsAndRepos',
    'extractUniqueAuthors',
    'extractUniqueMilestones',
    'extractUniqueLabels',
    // Only the removed client-side "Last Acked" sort used it; the daemon sorts now.
    'getAckedActionMs',
    // The flat single-value filter state was replaced by a predicate list.
    'DashboardFilterState',
  ])(
    '%s is not referenced',
    (symbol) => {
      const offenders = Object.entries(productionSources)
        .filter(([, src]) => new RegExp(`\\b${symbol}\\b`).test(src))
        .map(([file]) => file);
      expect(offenders).toEqual([]);
    }
  );
});
