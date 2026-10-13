import { render, screen } from '@testing-library/react';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useMenuGroup, type DashboardMenuId } from '../../../hooks/useMenuGroup';
import type { SelectorFacets } from '../../../hooks/useDashboardData';
import { DEFAULT_FILTER_CONTROLS, type FilterControls } from '../../../types/filters';
import { FilterToolbar } from '../FilterToolbar';
import { filterTriggerClass } from '../menuStyles';

const EMPTY_FACETS: SelectorFacets = {
  repos: [],
  orgs: [],
  authors: [],
  assignees: [],
  milestones: [],
  labels: [],
  activity: [],
};

function Harness({ filters }: { filters: FilterControls }) {
  const menus = useMenuGroup<DashboardMenuId>();
  return (
    <FilterToolbar
      filters={filters}
      setFilter={() => {}}
      setFilters={() => {}}
      setOrgOrRepo={() => {}}
      toggleAssignedToMe={() => {}}
      currentUser="alice"
      facets={EMPTY_FACETS}
      pinnedRepos={[]}
      menus={menus}
    />
  );
}

const BORDERED_TRIGGERS = [
  /Filter by state/i,
  /Filter by repository/i,
  /Filter by author/i,
  /Filter by label/i,
  /Assigned to me/i,
];

/** The height utility class of an element; every toolbar control must use the same one. */
const heightClass = (el: Element) => el.className.split(/\s+/).filter((c) => /^h-/.test(c));

describe('FilterToolbar', () => {
  it('renders every bordered trigger (hand-rolled or MultiSelectMenu) with identical classes', () => {
    const { unmount } = render(<Harness filters={DEFAULT_FILTER_CONTROLS} />);
    for (const name of BORDERED_TRIGGERS) {
      expect(screen.getByRole('button', { name }).className).toBe(filterTriggerClass(false));
    }
    unmount();

    render(
      <Harness
        filters={{
          ...DEFAULT_FILTER_CONTROLS,
          state: 'open',
          repo: ['a/b'],
          author: ['bob'],
          label: ['bug'],
          assignee: ['@me'],
        }}
      />
    );
    for (const name of BORDERED_TRIGGERS) {
      expect(screen.getByRole('button', { name }).className).toBe(filterTriggerClass(true));
    }
  });

  it('gives the segmented control, the triggers and the overflow trigger the same height', () => {
    render(<Harness filters={DEFAULT_FILTER_CONTROLS} />);
    const expected = heightClass(screen.getByRole('button', { name: /Filter by state/i }));
    expect(expected).toHaveLength(1);
    expect(heightClass(screen.getByRole('group', { name: 'Filter item type' }))).toEqual(expected);
    expect(heightClass(screen.getByRole('button', { name: /More filters/i }))).toEqual(expected);
  });

  it('exposes the selected item type and the Assigned to me toggle state via aria-pressed', () => {
    render(<Harness filters={{ ...DEFAULT_FILTER_CONTROLS, type: 'pr' }} />);
    expect(screen.getByRole('button', { name: 'PRs' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'All' }).getAttribute('aria-pressed')).toBe('false');
    expect(
      screen.getByRole('button', { name: /Assigned to me/i }).getAttribute('aria-pressed')
    ).toBe('false');
  });

  describe('responsive collapse', () => {
    let rowWidth = 1000;
    let observerCallback: (() => void) | null = null;

    // The row's scroll width is modelled as 100px per toolbar control it contains, so removing a
    // control from the row shrinks the width it needs.
    const installLayoutStubs = () => {
      vi.stubGlobal(
        'ResizeObserver',
        class {
          constructor(cb: () => void) {
            observerCallback = cb;
          }
          observe() {}
          disconnect() {}
        }
      );
      vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => rowWidth);
      vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (
        this: HTMLElement
      ) {
        return this.querySelectorAll('button').length * 100;
      });
    };

    afterEach(() => {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
      observerCallback = null;
    });

    const resize = (width: number) => {
      rowWidth = width;
      act(() => observerCallback?.());
    };

    it('moves Repository into the overflow menu, then drops Assigned to me, and expands again', () => {
      installLayoutStubs();
      // 3 segments + State + Repository + Author + Label + Assigned to me + More = 9 buttons
      rowWidth = 900;
      render(<Harness filters={DEFAULT_FILTER_CONTROLS} />);
      expect(screen.getByRole('button', { name: /Filter by repository/i })).toBeDefined();
      expect(screen.getByRole('button', { name: /Assigned to me/i })).toBeDefined();

      // Level 1: Repository leaves the row and becomes a row of the overflow menu
      resize(850);
      expect(screen.queryByRole('button', { name: /Filter by repository/i })).toBeNull();
      expect(screen.getByRole('button', { name: /Assigned to me/i })).toBeDefined();
      act(() => screen.getByRole('button', { name: /More filters/i }).click());
      expect(screen.getByRole('button', { name: /Filter by repository/i })).toBeDefined();
      act(() => screen.getByRole('button', { name: /More filters/i }).click());

      // Level 2: Assigned to me is dropped too
      resize(750);
      expect(screen.queryByRole('button', { name: /Assigned to me/i })).toBeNull();

      // 800px fits level 1 (8 buttons) and matches the width it needed: expand one level only
      resize(800);
      expect(screen.getByRole('button', { name: /Assigned to me/i })).toBeDefined();
      expect(screen.queryByRole('button', { name: /Filter by repository/i })).toBeNull();

      // Back to full width
      resize(900);
      expect(screen.getByRole('button', { name: /Filter by repository/i })).toBeDefined();
    });

    it('stays fully expanded without ResizeObserver (jsdom)', () => {
      expect(typeof ResizeObserver).toBe('undefined');
      render(<Harness filters={DEFAULT_FILTER_CONTROLS} />);
      expect(screen.getByRole('button', { name: /Filter by repository/i })).toBeDefined();
      expect(screen.getByRole('button', { name: /Assigned to me/i })).toBeDefined();
    });
  });
});
