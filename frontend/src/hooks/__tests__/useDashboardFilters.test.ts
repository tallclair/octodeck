import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDashboardFilters } from '../useDashboardFilters';
import { Field } from '../../api/octodeck/v1/query_pb';
import { DEFAULT_FILTER_CONTROLS } from '../../types/filters';

describe('useDashboardFilters hook', () => {
  beforeEach(() => {
    // Reset window.location and history
    window.history.pushState(null, '', '/');
  });

  it('initializes with default filters when URL search is empty', () => {
    const { result } = renderHook(() => useDashboardFilters());
    expect(result.current.filters).toEqual(DEFAULT_FILTER_CONTROLS);
    expect(result.current.isDefault).toBe(true);
    expect(result.current.activeCount).toBe(0);
  });

  it('initializes from existing URL query parameters', () => {
    window.history.pushState(null, '', '/?triage=activity&repo=kubernetes%2Fkubernetes&assigned=me');
    const { result } = renderHook(() => useDashboardFilters());

    expect(result.current.filters.triage).toBe('activity');
    expect(result.current.filters.repo).toBe('kubernetes/kubernetes');
    expect(result.current.filters.assigned).toBe('me');
    expect(result.current.isDefault).toBe(false);
    expect(result.current.activeCount).toBe(3);
  });

  it('updates state and pushes to browser history when setFilter is called', () => {
    const pushStateSpy = vi.spyOn(window.history, 'pushState');
    const { result } = renderHook(() => useDashboardFilters());

    act(() => {
      result.current.setFilter('triage', 'acked');
    });

    expect(result.current.filters.triage).toBe('acked');
    expect(pushStateSpy).toHaveBeenCalledWith(null, '', '/?triage=acked');

    pushStateSpy.mockRestore();
  });

  it('applies workflow shortcut by resetting other filters to default', () => {
    window.history.pushState(null, '', '/?triage=acked&repo=kubernetes%2Fkubernetes&author=alice');
    const { result } = renderHook(() => useDashboardFilters());

    act(() => {
      result.current.applyWorkflowShortcut('inbox');
    });

    expect(result.current.filters).toEqual(DEFAULT_FILTER_CONTROLS);
    expect(window.location.search).toBe('');
  });

  it('toggles repo selection', () => {
    const { result } = renderHook(() => useDashboardFilters());

    act(() => {
      result.current.toggleRepo('kubernetes/kubernetes');
    });
    expect(result.current.filters.repo).toBe('kubernetes/kubernetes');

    act(() => {
      result.current.toggleRepo('kubernetes/kubernetes');
    });
    expect(result.current.filters.repo).toBeNull();
  });

  it('resets all filters when resetFilters is called', () => {
    window.history.pushState(null, '', '/?triage=activity&state=closed&type=pr');
    const { result } = renderHook(() => useDashboardFilters());

    act(() => {
      result.current.resetFilters();
    });

    expect(result.current.filters).toEqual(DEFAULT_FILTER_CONTROLS);
    expect(window.location.search).toBe('');
  });

  it('responds to browser popstate events', () => {
    const { result } = renderHook(() => useDashboardFilters());

    act(() => {
      window.history.pushState(null, '', '/?triage=activity&repo=golang%2Fgo');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });

    expect(result.current.filters.triage).toBe('activity');
    expect(result.current.filters.repo).toBe('golang/go');
  });

  it('updates milestone filter and pushes to URL search params', () => {
    const { result } = renderHook(() => useDashboardFilters());

    act(() => {
      result.current.setFilter('milestone', 'v1.32');
    });

    expect(result.current.filters.milestone).toBe('v1.32');
    expect(window.location.search).toContain('milestone=v1.32');

    act(() => {
      result.current.setFilter('milestone', null);
    });

    expect(result.current.filters.milestone).toBeNull();
    expect(window.location.search).not.toContain('milestone=');
  });

  it('updates label filter and pushes to URL search params', () => {
    const { result } = renderHook(() => useDashboardFilters());

    act(() => {
      result.current.setFilter('label', 'kind/bug');
    });

    expect(result.current.filters.label).toBe('kind/bug');
    expect(window.location.search).toContain('label=kind/bug');

    act(() => {
      result.current.setFilter('label', null);
    });

    expect(result.current.filters.label).toBeNull();
    expect(window.location.search).not.toContain('label=');
  });

  it('initializes tracking filter from URL query parameter', () => {
    window.history.pushState(null, '', '/?tracking=untracked');
    const { result } = renderHook(() => useDashboardFilters());

    expect(result.current.filters.tracking).toBe('untracked');
    expect(result.current.isDefault).toBe(false);
    expect(result.current.activeCount).toBe(1);
  });

  it('updates tracking filter and pushes to URL search params', () => {
    const { result } = renderHook(() => useDashboardFilters());

    act(() => {
      result.current.setFilter('tracking', 'tracked');
    });

    expect(result.current.filters.tracking).toBe('tracked');
    expect(window.location.search).toContain('tracking=tracked');

    act(() => {
      result.current.setFilter('tracking', 'untracked');
    });

    expect(result.current.filters.tracking).toBe('untracked');
    expect(window.location.search).toContain('tracking=untracked');

    act(() => {
      result.current.setFilter('tracking', 'all');
    });

    expect(result.current.filters.tracking).toBe('all');
    expect(window.location.search).not.toContain('tracking=');
  });

  it('resets tracking filter when resetFilters is called', () => {
    window.history.pushState(null, '', '/?tracking=untracked&triage=activity');
    const { result } = renderHook(() => useDashboardFilters());

    act(() => {
      result.current.resetFilters();
    });

    expect(result.current.filters.tracking).toBe('all');
    expect(window.location.search).toBe('');
  });

  it('responds to browser popstate events for tracking filter', () => {
    const { result } = renderHook(() => useDashboardFilters());

    act(() => {
      window.history.pushState(null, '', '/?tracking=untracked');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });

    expect(result.current.filters.tracking).toBe('untracked');
  });

  it('initializes the predicate list from the legacy example URL, in URL order', () => {
    window.history.pushState(null, '', '/?repo=a/b&author=x&triage=acked&state=closed&label=bug');
    const { result } = renderHook(() => useDashboardFilters());

    expect(result.current.query.predicates).toEqual([
      { field: Field.REPO, values: ['a/b'], negated: false },
      { field: Field.AUTHOR, values: ['x'], negated: false },
      { field: Field.TRIAGE, values: ['acked'], negated: false },
      { field: Field.STATE, values: ['closed'], negated: false },
      { field: Field.LABEL, values: ['bug'], negated: false },
    ]);
    expect(result.current.filters).toMatchObject({ repo: 'a/b', author: 'x', triage: 'acked', state: 'closed', label: 'bug' });
    expect(result.current.extraPredicates).toEqual([]);
  });

  it('keeps the remaining parameter order when a control is cleared', () => {
    window.history.pushState(null, '', '/?repo=a/b&author=x&triage=acked&state=closed&label=bug');
    const pushStateSpy = vi.spyOn(window.history, 'pushState');
    const { result } = renderHook(() => useDashboardFilters());

    act(() => {
      result.current.setFilter('label', null);
    });

    expect(pushStateSpy).toHaveBeenCalledWith(null, '', '/?repo=a/b&author=x&triage=acked&state=closed');
    pushStateSpy.mockRestore();
  });

  it('keeps raw search text in state and writes it trimmed with replaceState', () => {
    const replaceStateSpy = vi.spyOn(window.history, 'replaceState');
    const { result } = renderHook(() => useDashboardFilters());

    act(() => {
      result.current.setFilter('q', 'foo ', true);
    });

    expect(result.current.filters.q).toBe('foo ');
    expect(result.current.query.q).toBe('foo ');
    expect(replaceStateSpy).toHaveBeenCalledWith(null, '', '/?q=foo');
    replaceStateSpy.mockRestore();
  });

  it('stores the New tab as new:any and writes triage=activity', () => {
    const { result } = renderHook(() => useDashboardFilters());

    act(() => {
      result.current.setFilter('triage', 'activity');
    });

    expect(window.location.search).toBe('?triage=activity');
    expect(result.current.query.predicates).toEqual([{ field: Field.NEW, values: ['any'], negated: false }]);
    expect(result.current.filters.triage).toBe('activity');
  });

  it('reports repeated and negated parameters as extra predicates and removes them by index', () => {
    window.history.pushState(null, '', '/?-label=bug&label=a&label=b');
    const { result } = renderHook(() => useDashboardFilters());

    expect(result.current.filters.label).toBeNull();
    expect(result.current.extraPredicates).toEqual([
      { predicate: { field: Field.LABEL, values: ['bug'], negated: true }, index: 0 },
      { predicate: { field: Field.LABEL, values: ['a', 'b'], negated: false }, index: 1 },
    ]);
    expect(result.current.activeCount).toBe(2);

    act(() => {
      result.current.removePredicateAt(0);
    });

    expect(window.location.search).toBe('?label=a&label=b');
    expect(result.current.extraPredicates).toHaveLength(1);
  });

  it('clears secondary filters but keeps the triage tab, type and search text', () => {
    window.history.pushState(null, '', '/?triage=acked&type=pr&repo=a/b&-label=x&q=foo');
    const { result } = renderHook(() => useDashboardFilters());

    act(() => {
      result.current.clearSecondaryFilters();
    });

    expect(window.location.search).toBe('?triage=acked&type=pr&q=foo');
    expect(result.current.extraPredicates).toEqual([]);
  });

  it('re-parses repeated and negated parameters on popstate', () => {
    const { result } = renderHook(() => useDashboardFilters());

    act(() => {
      window.history.pushState(null, '', '/?author=a&author=b&-repo=x/y');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });

    expect(result.current.query.predicates).toEqual([
      { field: Field.AUTHOR, values: ['a', 'b'], negated: false },
      { field: Field.REPO, values: ['x/y'], negated: true },
    ]);
  });

  it('does not touch browser history on mount', () => {
    window.history.pushState(null, '', '/?repo=a%2Fb&triage=inbox');
    const pushStateSpy = vi.spyOn(window.history, 'pushState');
    const replaceStateSpy = vi.spyOn(window.history, 'replaceState');
    renderHook(() => useDashboardFilters());

    expect(pushStateSpy).not.toHaveBeenCalled();
    expect(replaceStateSpy).not.toHaveBeenCalled();
    pushStateSpy.mockRestore();
    replaceStateSpy.mockRestore();
  });
});
