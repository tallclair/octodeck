import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useStableOptions, type StableOptionItem } from '../useStableOptions';

describe('useStableOptions', () => {
  it('retains options removed from props while open with count 0, and resets when closed', () => {
    const initial: StableOptionItem[] = [
      { value: 'charlie', count: 1 },
      { value: 'alice', count: 3 },
    ];

    const { result, rerender } = renderHook(
      ({ open, options }) => useStableOptions(open, options),
      { initialProps: { open: true, options: initial } }
    );

    expect(result.current).toEqual([
      { value: 'alice', count: 3 },
      { value: 'charlie', count: 1 },
    ]);

    // Facet refresh removes 'charlie' and adds 'bob', updating 'alice' count
    rerender({
      open: true,
      options: [
        { value: 'alice', count: 5 },
        { value: 'bob', count: 2 },
      ],
    });

    expect(result.current).toEqual([
      { value: 'alice', count: 5 },
      { value: 'bob', count: 2 },
      { value: 'charlie', count: 0 },
    ]);

    // Closing and reopening clears stale options
    rerender({
      open: false,
      options: [
        { value: 'alice', count: 5 },
        { value: 'bob', count: 2 },
      ],
    });
    rerender({
      open: true,
      options: [
        { value: 'alice', count: 5 },
        { value: 'bob', count: 2 },
      ],
    });

    expect(result.current).toEqual([
      { value: 'alice', count: 5 },
      { value: 'bob', count: 2 },
    ]);
  });

  it('keeps pinned options first before sorted options', () => {
    const options: StableOptionItem[] = [
      { value: 'zebra', count: 1 },
      { value: '@me', count: 2, pinned: true },
      { value: 'alpha', count: 4 },
    ];

    const { result } = renderHook(() => useStableOptions(true, options));
    expect(result.current.map((o) => o.value)).toEqual(['@me', 'alpha', 'zebra']);
  });

  it('orders grouped options by group, header first, then value when sort is false', () => {
    const initial: StableOptionItem[] = [
      { value: 'octo', count: null, group: 'octo', isGroupHeader: true },
      { value: 'octo/beta', count: 2, group: 'octo' },
      { value: 'acme', count: null, group: 'acme', isGroupHeader: true },
      { value: 'acme/zeta', count: 1, group: 'acme' },
    ];

    const { result, rerender } = renderHook(
      ({ open, options }) => useStableOptions(open, options, { sort: false }),
      { initialProps: { open: true, options: initial } }
    );

    expect(result.current.map((o) => o.value)).toEqual([
      'acme',
      'acme/zeta',
      'octo',
      'octo/beta',
    ]);

    // Adding a newly revealed repo keeps it under its org header in alphabetical order
    rerender({
      open: true,
      options: [
        ...initial,
        { value: 'octo/alpha', count: 0, group: 'octo' },
      ],
    });

    expect(result.current.map((o) => o.value)).toEqual([
      'acme',
      'acme/zeta',
      'octo',
      'octo/alpha',
      'octo/beta',
    ]);
  });
});
