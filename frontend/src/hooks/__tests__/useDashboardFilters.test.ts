import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDashboardFilters } from '../useDashboardFilters';
import { DEFAULT_FILTER_STATE } from '../../types/filters';

describe('useDashboardFilters hook', () => {
  beforeEach(() => {
    // Reset window.location and history
    window.history.pushState(null, '', '/');
  });

  it('initializes with default filters when URL search is empty', () => {
    const { result } = renderHook(() => useDashboardFilters());
    expect(result.current.filters).toEqual(DEFAULT_FILTER_STATE);
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

    expect(result.current.filters).toEqual(DEFAULT_FILTER_STATE);
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

    expect(result.current.filters).toEqual(DEFAULT_FILTER_STATE);
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
    expect(window.location.search).toContain('label=kind%2Fbug');

    act(() => {
      result.current.setFilter('label', null);
    });

    expect(result.current.filters.label).toBeNull();
    expect(window.location.search).not.toContain('label=');
  });
});
