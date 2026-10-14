import { createElement, StrictMode, type ReactNode } from 'react';
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
    expect(result.current.controls).toEqual(DEFAULT_FILTER_CONTROLS);
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
    expect(result.current.controls.triage).toBe('activity');
    expect(result.current.controls.repo).toEqual(['kubernetes/kubernetes']);
    expect(result.current.controls.assignee).toEqual(['@me']);
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
    expect(result.current.controls.triage).toBe('activity');
    expect(result.current.controls.repo).toEqual(['golang/go']);
    expect(replaceStateSpy).toHaveBeenCalledWith(null, '', '/?q=new:any+repo:golang/go');
    expect(window.location.search).toBe('?q=new:any+repo:golang/go');

    replaceStateSpy.mockRestore();
  });

  it('updates state and pushes ?q= to browser history when setTriageTab is called', () => {
    const pushStateSpy = vi.spyOn(window.history, 'pushState');
    const { result } = renderHook(() => useDashboardFilters());

    act(() => {
      result.current.setTriageTab('acked');
    });

    expect(result.current.controls.triage).toBe('acked');
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

    expect(result.current.controls).toEqual(DEFAULT_FILTER_CONTROLS);
    expect(result.current.state.text).toBe('');
    expect(window.location.search).toBe('');
  });

  it('toggles repo selection', () => {
    const { result } = renderHook(() => useDashboardFilters());

    act(() => {
      result.current.toggleRepo('kubernetes/kubernetes');
    });
    expect(result.current.controls.repo).toEqual(['kubernetes/kubernetes']);
    expect(window.location.search).toBe('?q=repo:kubernetes/kubernetes');

    act(() => {
      result.current.toggleRepo('kubernetes/kubernetes');
    });
    expect(result.current.controls.repo).toEqual([]);
    expect(window.location.search).toBe('');
  });

  it('clears only text when clearQuery is called while keeping sort and order', () => {
    window.history.pushState(null, '', '/?triage=acked&state=closed&sort=created');
    const { result } = renderHook(() => useDashboardFilters());

    act(() => {
      result.current.clearQuery();
    });
    expect(result.current.state.text).toBe('');
    expect(result.current.state.sort).toBe('created');
    expect(window.location.search).toBe('?sort=created');
  });

  it('updates milestone filter and pushes ?q= to URL search params', () => {
    const { result } = renderHook(() => useDashboardFilters());

    act(() => {
      result.current.setControl('milestone', ['v1.32']);
    });

    expect(result.current.controls.milestone).toEqual(['v1.32']);
    expect(window.location.search).toBe('?q=milestone:v1.32');

    act(() => {
      result.current.setControl('milestone', []);
    });

    expect(result.current.controls.milestone).toEqual([]);
    expect(window.location.search).toBe('');
  });

  it('updates label filter (including multiple values) and writes comma-joined values in ?q=', () => {
    const { result } = renderHook(() => useDashboardFilters());

    act(() => {
      result.current.setControl('label', ['a', 'b']);
    });

    expect(result.current.controls.label).toEqual(['a', 'b']);
    expect(window.location.search).toBe('?q=label:a,b');

    act(() => {
      result.current.setControl('label', []);
    });

    expect(result.current.controls.label).toEqual([]);
    expect(window.location.search).toBe('');
  });

  it('writes assignee:@me and assignee:@me,alice into ?q=', () => {
    const { result } = renderHook(() => useDashboardFilters());

    act(() => {
      result.current.toggleAssignedToMe();
    });
    expect(result.current.controls.assignee).toEqual(['@me']);
    expect(window.location.search).toBe('?q=assignee:@me');

    act(() => {
      result.current.setControl('assignee', ['@me', 'alice']);
    });
    expect(result.current.controls.assignee).toEqual(['@me', 'alice']);
    expect(window.location.search).toBe('?q=assignee:@me,alice');
  });

  it('initializes and updates tracking filter as tracking:true / tracking:false in ?q=', () => {
    window.history.pushState(null, '', '/?tracking=untracked');
    const { result } = renderHook(() => useDashboardFilters());

    expect(result.current.controls.tracking).toBe('untracked');
    expect(result.current.state.text).toBe('tracking:false');
    expect(result.current.isDefault).toBe(false);
    expect(result.current.activeCount).toBe(1);

    act(() => {
      result.current.setControl('tracking', 'tracked');
    });
    expect(result.current.controls.tracking).toBe('tracked');
    expect(window.location.search).toBe('?q=tracking:true');

    act(() => {
      result.current.setControl('tracking', 'all');
    });
    expect(result.current.controls.tracking).toBe('all');
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
    expect(result.current.controls).toMatchObject({
      repo: ['a/b'],
      author: ['x'],
      triage: 'acked',
      state: 'closed',
      label: ['bug'],
    });

    act(() => {
      result.current.setControl('label', []);
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

  it('StrictMode: performs pure state updates and exact replaceState/pushState calls and history.length delta for typing followed by a dropdown edit in one act', () => {
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(StrictMode, null, children);
    const replaceStateSpy = vi.spyOn(window.history, 'replaceState');
    const pushStateSpy = vi.spyOn(window.history, 'pushState');
    const initialHistoryLength = window.history.length;

    const { result } = renderHook(() => useDashboardFilters(), { wrapper });

    // 1. Typing alone in StrictMode calls replaceState once and does not change history.length
    act(() => {
      result.current.setText('flaky', 'typing');
    });
    expect(replaceStateSpy).toHaveBeenCalledTimes(1);
    expect(replaceStateSpy).toHaveBeenLastCalledWith(null, '', '/?q=flaky');
    expect(pushStateSpy).not.toHaveBeenCalled();
    expect(window.history.length - initialHistoryLength).toBe(0);

    // 2. Typing (e.g. draft commit on blur) followed by a dropdown edit in one act in StrictMode
    // commits a single pushState for the combined result without duplicate StrictMode history entries
    replaceStateSpy.mockClear();
    pushStateSpy.mockClear();
    const beforeCombinedLength = window.history.length;

    act(() => {
      result.current.setText('flaky label:bu', 'typing');
      result.current.setControl('state', 'closed');
    });

    expect(result.current.state.text).toBe('state:closed flaky label:bu');
    expect(result.current.requestText).toBe('state:closed flaky label:bu');
    expect(replaceStateSpy).not.toHaveBeenCalled();
    expect(pushStateSpy).toHaveBeenCalledTimes(1);
    expect(pushStateSpy).toHaveBeenCalledWith(null, '', '/?q=state:closed+flaky+label:bu');
    expect(window.history.length - beforeCombinedLength).toBe(1);

    replaceStateSpy.mockRestore();
    pushStateSpy.mockRestore();
  });

  it('stores the New tab as new:any and writes ?q=new:any', () => {
    const { result } = renderHook(() => useDashboardFilters());

    act(() => {
      result.current.setTriageTab('activity');
    });

    expect(window.location.search).toBe('?q=new:any');
    expect(result.current.parsed.predicates).toEqual([
      { field: Field.NEW, values: ['any'], negated: false },
    ]);
    expect(result.current.controls.triage).toBe('activity');
    expect(result.current.hasNoSecondaryFilters).toBe(true);
  });

  it('projects repeated parameters onto the control while keeping negated parameters in the query text', () => {
    window.history.pushState(null, '', '/?-label=bug&label=a&label=b&q=flaky');
    const { result } = renderHook(() => useDashboardFilters());

    expect(result.current.controls.label).toEqual(['a', 'b']);
    expect(result.current.activeCount).toBe(3);
    expect(result.current.hasNoSecondaryFilters).toBe(false);
  });
});

