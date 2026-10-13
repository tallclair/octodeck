import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDashboardFilters } from '../useDashboardFilters';
import { Field } from '../../api/octodeck/v1/query_pb';
import { DEFAULT_FILTER_CONTROLS } from '../../types/filters';

describe('useDashboardFilters hook', () => {
  beforeEach(() => {
    window.history.pushState(null, '', '/');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('initializes with default filters when URL search is empty', () => {
    const { result } = renderHook(() => useDashboardFilters());
    expect(result.current.filters).toEqual(DEFAULT_FILTER_CONTROLS);
    expect(result.current.state.text).toBe('');
    expect(result.current.requestText).toBe('');
    expect(result.current.isDefault).toBe(true);
    expect(result.current.activeCount).toBe(0);
  });

  it('migrates legacy URL query parameters on load and rewrites URL with replaceState', () => {
    window.history.pushState(null, '', '/?triage=activity&repo=kubernetes%2Fkubernetes&assigned=me');
    const replaceStateSpy = vi.spyOn(window.history, 'replaceState');
    const pushStateSpy = vi.spyOn(window.history, 'pushState');
    const { result } = renderHook(() => useDashboardFilters());

    expect(result.current.state.text).toBe('new:any repo:kubernetes/kubernetes assignee:@me');
    expect(result.current.filters.triage).toBe('activity');
    expect(result.current.filters.repo).toEqual(['kubernetes/kubernetes']);
    expect(result.current.filters.assignee).toEqual(['@me']);
    expect(result.current.isDefault).toBe(false);
    expect(result.current.activeCount).toBe(3);
    expect(replaceStateSpy).toHaveBeenCalledWith(
      null,
      '',
      '/?q=new:any+repo:kubernetes/kubernetes+assignee:@me'
    );
    expect(pushStateSpy).not.toHaveBeenCalled();

    replaceStateSpy.mockRestore();
    pushStateSpy.mockRestore();
  });

  it('does not touch browser history on mount when the URL is already canonical', () => {
    window.history.pushState(null, '', '/?q=repo:a/b+label:bug,flake');
    const pushStateSpy = vi.spyOn(window.history, 'pushState');
    const replaceStateSpy = vi.spyOn(window.history, 'replaceState');
    renderHook(() => useDashboardFilters());

    expect(pushStateSpy).not.toHaveBeenCalled();
    expect(replaceStateSpy).not.toHaveBeenCalled();
    pushStateSpy.mockRestore();
    replaceStateSpy.mockRestore();
  });

  it('rewrites legacy and un-normalized URLs with replaceState on popstate', () => {
    const { result } = renderHook(() => useDashboardFilters());
    const replaceStateSpy = vi.spyOn(window.history, 'replaceState');

    act(() => {
      window.history.pushState(null, '', '/?triage=activity&repo=golang%2Fgo');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });

    expect(result.current.state.text).toBe('new:any repo:golang/go');
    expect(result.current.filters.triage).toBe('activity');
    expect(result.current.filters.repo).toEqual(['golang/go']);
    expect(replaceStateSpy).toHaveBeenCalledWith(null, '', '/?q=new:any+repo:golang/go');
    expect(window.location.search).toBe('?q=new:any+repo:golang/go');

    replaceStateSpy.mockRestore();
  });

  it('updates state and pushes ?q= to browser history when setFilter is called', () => {
    const pushStateSpy = vi.spyOn(window.history, 'pushState');
    const { result } = renderHook(() => useDashboardFilters());

    act(() => {
      result.current.setFilter('triage', 'acked');
    });

    expect(result.current.filters.triage).toBe('acked');
    expect(result.current.state.text).toBe('triage:acked');
    expect(pushStateSpy).toHaveBeenCalledWith(null, '', '/?q=triage:acked');

    pushStateSpy.mockRestore();
  });

  it('applies workflow shortcut by resetting other filters to default', () => {
    window.history.pushState(null, '', '/?triage=acked&repo=kubernetes%2Fkubernetes&author=alice');
    const { result } = renderHook(() => useDashboardFilters());

    act(() => {
      result.current.applyWorkflowShortcut('inbox');
    });

    expect(result.current.filters).toEqual(DEFAULT_FILTER_CONTROLS);
    expect(result.current.state.text).toBe('');
    expect(window.location.search).toBe('');
  });

  it('toggles repo selection', () => {
    const { result } = renderHook(() => useDashboardFilters());

    act(() => {
      result.current.toggleRepo('kubernetes/kubernetes');
    });
    expect(result.current.filters.repo).toEqual(['kubernetes/kubernetes']);
    expect(window.location.search).toBe('?q=repo:kubernetes/kubernetes');

    act(() => {
      result.current.toggleRepo('kubernetes/kubernetes');
    });
    expect(result.current.filters.repo).toEqual([]);
    expect(window.location.search).toBe('');
  });

  it('resets all filters when resetFilters is called and clears only text when clearQuery is called', () => {
    window.history.pushState(null, '', '/?triage=acked&state=closed&sort=created');
    const { result } = renderHook(() => useDashboardFilters());

    act(() => {
      result.current.clearQuery();
    });
    expect(result.current.state.text).toBe('');
    expect(result.current.state.sort).toBe('created');
    expect(window.location.search).toBe('?sort=created');

    act(() => {
      result.current.resetFilters();
    });
    expect(result.current.filters).toEqual(DEFAULT_FILTER_CONTROLS);
    expect(window.location.search).toBe('');
  });

  it('updates milestone filter and pushes ?q= to URL search params', () => {
    const { result } = renderHook(() => useDashboardFilters());

    act(() => {
      result.current.setFilter('milestone', ['v1.32']);
    });

    expect(result.current.filters.milestone).toEqual(['v1.32']);
    expect(window.location.search).toBe('?q=milestone:v1.32');

    act(() => {
      result.current.setFilter('milestone', []);
    });

    expect(result.current.filters.milestone).toEqual([]);
    expect(window.location.search).toBe('');
  });

  it('updates label filter (including multiple values) and writes comma-joined values in ?q=', () => {
    const { result } = renderHook(() => useDashboardFilters());

    act(() => {
      result.current.setFilter('label', ['a', 'b']);
    });

    expect(result.current.filters.label).toEqual(['a', 'b']);
    expect(window.location.search).toBe('?q=label:a,b');

    act(() => {
      result.current.setFilter('label', []);
    });

    expect(result.current.filters.label).toEqual([]);
    expect(window.location.search).toBe('');
  });

  it('writes assignee:@me and assignee:@me,alice into ?q=', () => {
    const { result } = renderHook(() => useDashboardFilters());

    act(() => {
      result.current.toggleAssignedToMe();
    });
    expect(result.current.filters.assignee).toEqual(['@me']);
    expect(window.location.search).toBe('?q=assignee:@me');

    act(() => {
      result.current.setFilter('assignee', ['@me', 'alice']);
    });
    expect(result.current.filters.assignee).toEqual(['@me', 'alice']);
    expect(window.location.search).toBe('?q=assignee:@me,alice');
  });

  it('initializes and updates tracking filter as tracking:true / tracking:false in ?q=', () => {
    window.history.pushState(null, '', '/?tracking=untracked');
    const { result } = renderHook(() => useDashboardFilters());

    expect(result.current.filters.tracking).toBe('untracked');
    expect(result.current.state.text).toBe('tracking:false');
    expect(result.current.isDefault).toBe(false);
    expect(result.current.activeCount).toBe(1);

    act(() => {
      result.current.setFilter('tracking', 'tracked');
    });
    expect(result.current.filters.tracking).toBe('tracked');
    expect(window.location.search).toBe('?q=tracking:true');

    act(() => {
      result.current.setFilter('tracking', 'all');
    });
    expect(result.current.filters.tracking).toBe('all');
    expect(window.location.search).toBe('');
  });

  it('initializes the parsed predicates from the legacy example URL in URL order and preserves order on clear', () => {
    window.history.pushState(null, '', '/?repo=a/b&author=x&triage=acked&state=closed&label=bug');
    const pushStateSpy = vi.spyOn(window.history, 'pushState');
    const { result } = renderHook(() => useDashboardFilters());

    expect(result.current.parsed.predicates).toEqual([
      { field: Field.REPO, values: ['a/b'], negated: false },
      { field: Field.AUTHOR, values: ['x'], negated: false },
      { field: Field.TRIAGE, values: ['acked'], negated: false },
      { field: Field.STATE, values: ['closed'], negated: false },
      { field: Field.LABEL, values: ['bug'], negated: false },
    ]);
    expect(result.current.filters).toMatchObject({
      repo: ['a/b'],
      author: ['x'],
      triage: 'acked',
      state: 'closed',
      label: ['bug'],
    });
    expect(result.current.extraPredicates).toEqual([]);

    act(() => {
      result.current.setFilter('label', []);
    });

    expect(pushStateSpy).toHaveBeenCalledWith(
      null,
      '',
      '/?q=repo:a/b+author:x+triage:acked+state:closed'
    );
    pushStateSpy.mockRestore();
  });

  it('keeps raw text in state, writes it trimmed with replaceState, and debounces requestText on typing', () => {
    vi.useFakeTimers();
    const replaceStateSpy = vi.spyOn(window.history, 'replaceState');
    const { result } = renderHook(() => useDashboardFilters());

    act(() => {
      result.current.setText('foo ', 'typing');
    });

    expect(result.current.state.text).toBe('foo ');
    expect(result.current.requestText).toBe('');
    expect(replaceStateSpy).toHaveBeenCalledWith(null, '', '/?q=foo');

    act(() => {
      vi.advanceTimersByTime(200);
    });

    expect(result.current.requestText).toBe('foo ');
    replaceStateSpy.mockRestore();
  });

  it('race: typing followed by a dropdown edit within 200ms applies immediately and is never overwritten by the pending debounce', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useDashboardFilters());

    act(() => {
      result.current.setText('flaky', 'typing');
    });
    expect(result.current.state.text).toBe('flaky');
    expect(result.current.requestText).toBe('');

    act(() => {
      vi.advanceTimersByTime(50);
      result.current.setControl('state', 'closed');
    });

    // Dropdown edit ('edit' kind) takes effect immediately on both state.text and requestText
    expect(result.current.state.text).toBe('state:closed flaky');
    expect(result.current.requestText).toBe('state:closed flaky');

    // Advancing past the original 200ms typing debounce must not revert requestText to 'flaky'
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(result.current.requestText).toBe('state:closed flaky');
  });

  it('stale splice: committing an unfinished draft and clicking a dropdown option in the same tick keeps both edits', () => {
    const { result } = renderHook(() => useDashboardFilters());

    act(() => {
      // Simulate blur committing the draft 'label:bu' immediately before a State option click
      result.current.setText('label:bu', 'typing');
      result.current.setControl('state', 'closed');
    });

    expect(result.current.state.text).toBe('state:closed label:bu');
    expect(result.current.requestText).toBe('state:closed label:bu');
    expect(window.location.search).toBe('?q=state:closed+label:bu');
  });

  it('stores the New tab as new:any and writes ?q=new:any', () => {
    const { result } = renderHook(() => useDashboardFilters());

    act(() => {
      result.current.setFilter('triage', 'activity');
    });

    expect(window.location.search).toBe('?q=new:any');
    expect(result.current.parsed.predicates).toEqual([
      { field: Field.NEW, values: ['any'], negated: false },
    ]);
    expect(result.current.filters.triage).toBe('activity');
  });

  it('projects repeated parameters onto the control and reports negated parameters as extra predicates (excluding TEXT terms)', () => {
    window.history.pushState(null, '', '/?-label=bug&label=a&label=b&q=flaky');
    const { result } = renderHook(() => useDashboardFilters());

    expect(result.current.filters.label).toEqual(['a', 'b']);
    expect(result.current.extraPredicates).toEqual([
      { predicate: { field: Field.LABEL, values: ['bug'], negated: true }, index: 0 },
    ]);
    expect(result.current.activeCount).toBe(3);

    act(() => {
      result.current.removePredicateAt(0);
    });

    expect(window.location.search).toBe('?q=label:a,b+flaky');
    expect(result.current.extraPredicates).toEqual([]);
  });

  it('clears secondary filters but keeps the triage tab, type and free-text search terms', () => {
    window.history.pushState(null, '', '/?triage=acked&type=pr&repo=a/b&-label=x&q=foo');
    const { result } = renderHook(() => useDashboardFilters());

    act(() => {
      result.current.clearSecondaryFilters();
    });

    expect(window.location.search).toBe('?q=triage:acked+type:pr+foo');
    expect(result.current.extraPredicates).toEqual([]);
  });
});
