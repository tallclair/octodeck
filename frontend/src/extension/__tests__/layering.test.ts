import { describe, it, expect } from 'vitest';
import { isHashedClassToken, selectorProblems } from '../content/dom/hygiene';

// Layering and hygiene rules (docs/internal/extension_dom_engine_design.md 3, 4.6, 11.5).
const featureSources = import.meta.glob('../content/features/**/*.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const capabilitySources = import.meta.glob('../content/capabilities/**/*.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

describe('layering', () => {
  it('features never import variants or the resolver, and never query GitHub selectors directly', () => {
    for (const [file, src] of Object.entries(featureSources)) {
      expect(src, file).not.toMatch(/from ['"][./]*\/(variants|dom\/resolver)/);
      expect(src, file).not.toMatch(/querySelector(All)?\(\s*['"`]/);
      expect(src, file).not.toMatch(/\.closest\(\s*['"`]/);
      expect(src, file).not.toMatch(/\.matches\(\s*['"`]/);
    }
  });

  it('capabilities contain no GitHub selector literals (those belong in variants)', () => {
    for (const [file, src] of Object.entries(capabilitySources)) {
      // Generic structural queries such as '[id]' are fine; class/id selectors and attribute values aren't.
      expect(src, file).not.toMatch(/querySelector(All)?\(\s*['"`][^'"`]*([.#]|\[[\w-]+[*^$~|]?=)/);
    }
  });
});

describe('selector hygiene helpers', () => {
  it('recognizes hashed classes', () => {
    expect(isHashedClassToken('prc-Timeline-TimelineBadge-u0qSm')).toBe(true);
    expect(isHashedClassToken('sidebarContent__xBd6hp')).toBe(true);
    expect(isHashedClassToken('row-module__timelineBodyContent__nmY90')).toBe(true);
    expect(isHashedClassToken('TimelineItem')).toBe(false);
    expect(isHashedClassToken('js-timeline-item')).toBe(false);
    expect(isHashedClassToken('Label--secondary')).toBe(false);
    expect(isHashedClassToken('Box__header')).toBe(false);
    expect(isHashedClassToken('d-contents__KzrRnz')).toBe(true);
  });

  it('flags hashed classes, primary partial matches and invalid selectors', () => {
    expect(selectorProblems('.js-discussion .TimelineItem', true)).toEqual([]);
    expect(selectorProblems('.prc-Timeline-TimelineBadge-u0qSm', false)).toEqual(['hashed class .prc-Timeline-TimelineBadge-u0qSm']);
    expect(selectorProblems('div[class*="sidebarContent"]', true)).toHaveLength(1);
    expect(selectorProblems('div[class*="sidebarContent"]', false)).toEqual([]);
    expect(selectorProblems('div[', false)).toContain('invalid selector');
  });
});
