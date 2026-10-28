import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useRefreshOnReveal } from '../useRefreshOnReveal';

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('useRefreshOnReveal', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    setVisibility('visible');
  });

  it('refreshes on mount', () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    renderHook(() => useRefreshOnReveal(refresh));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('refreshes when the tab becomes visible, not when it is hidden', () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    renderHook(() => useRefreshOnReveal(refresh));
    refresh.mockClear();

    setVisibility('hidden');
    expect(refresh).not.toHaveBeenCalled();

    setVisibility('visible');
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('refreshes when the window regains focus', () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    renderHook(() => useRefreshOnReveal(refresh));
    refresh.mockClear();

    window.dispatchEvent(new Event('focus'));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('ignores refresh failures', async () => {
    // Vitest fails the run on unhandled rejections, so a leaked failure would surface here.
    const refresh = vi.fn().mockRejectedValue(new Error('daemon unreachable'));
    renderHook(() => useRefreshOnReveal(refresh));
    window.dispatchEvent(new Event('focus'));
    await vi.runAllTimersAsync();
    expect(refresh).toHaveBeenCalledTimes(2);

    // Later reveals still refresh.
    setVisibility('visible');
    await vi.runAllTimersAsync();
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it('uses the latest callback without re-registering', () => {
    const first = vi.fn().mockResolvedValue(undefined);
    const second = vi.fn().mockResolvedValue(undefined);
    const { rerender } = renderHook(({ refresh }) => useRefreshOnReveal(refresh), {
      initialProps: { refresh: first },
    });
    rerender({ refresh: second });

    window.dispatchEvent(new Event('focus'));
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('stops listening on unmount', () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const { unmount } = renderHook(() => useRefreshOnReveal(refresh));
    unmount();
    refresh.mockClear();

    window.dispatchEvent(new Event('focus'));
    setVisibility('visible');
    expect(refresh).not.toHaveBeenCalled();
  });
});
