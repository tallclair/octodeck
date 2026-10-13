import { describe, expect, it } from 'vitest';
import {
  INITIAL_TOOLBAR_COLLAPSE,
  nextToolbarCollapse,
  type ToolbarCollapseState,
} from '../useToolbarCollapse';

describe('nextToolbarCollapse', () => {
  it('keeps the same state object when the content fits at level 0', () => {
    const next = nextToolbarCollapse(INITIAL_TOOLBAR_COLLAPSE, { available: 800, required: 800 }, 2);
    expect(next).toBe(INITIAL_TOOLBAR_COLLAPSE);
  });

  it('collapses one level per overflowing measurement and records the width each level needed', () => {
    const one = nextToolbarCollapse(INITIAL_TOOLBAR_COLLAPSE, { available: 600, required: 760 }, 2);
    expect(one).toEqual({ level: 1, expandWidths: [760] });

    const two = nextToolbarCollapse(one, { available: 600, required: 650 }, 2);
    expect(two).toEqual({ level: 2, expandWidths: [760, 650] });
  });

  it('never collapses past maxLevel', () => {
    const atMax: ToolbarCollapseState = { level: 2, expandWidths: [760, 650] };
    expect(nextToolbarCollapse(atMax, { available: 400, required: 560 }, 2)).toBe(atMax);
  });

  it('expands only once the available width reaches what the previous level needed (no oscillation)', () => {
    const collapsed: ToolbarCollapseState = { level: 2, expandWidths: [760, 650] };

    // Wider than level 2 needs, but narrower than level 1 needed: stay collapsed
    expect(nextToolbarCollapse(collapsed, { available: 649, required: 560 }, 2)).toBe(collapsed);

    const one = nextToolbarCollapse(collapsed, { available: 700, required: 560 }, 2);
    expect(one).toEqual({ level: 1, expandWidths: [760] });

    // Level 1 fits at 700 but level 0 needed 760: stay at level 1
    expect(nextToolbarCollapse(one, { available: 700, required: 700 }, 2)).toBe(one);

    expect(nextToolbarCollapse(one, { available: 760, required: 760 }, 2)).toEqual(
      INITIAL_TOOLBAR_COLLAPSE
    );
  });

  it('collapses again (re-recording the width) when an expanded level overflows anyway', () => {
    const one: ToolbarCollapseState = { level: 1, expandWidths: [760] };
    const zero = nextToolbarCollapse(one, { available: 760, required: 760 }, 2);
    expect(zero.level).toBe(0);
    expect(nextToolbarCollapse(zero, { available: 760, required: 790 }, 2)).toEqual({
      level: 1,
      expandWidths: [790],
    });
  });
});
