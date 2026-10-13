import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Field } from '../../../api/octodeck/v1/query_pb';
import { DEFAULT_FILTER_CONTROLS, type FilterControls } from '../../../types/filters';
import type { ExtraPredicate } from '../../../logic/query/predicates';
import { ActiveFilterChips, type ActiveFilterChipsProps } from '../ActiveFilterChips';

function renderChips(
  filterOverrides: Partial<FilterControls> = {},
  extraPredicates: readonly ExtraPredicate[] = []
) {
  const setFilter = vi.fn<ActiveFilterChipsProps['setFilter']>();
  const removePredicateAt = vi.fn<ActiveFilterChipsProps['removePredicateAt']>();
  const clearSecondaryFilters = vi.fn<ActiveFilterChipsProps['clearSecondaryFilters']>();
  const onOpenMenu = vi.fn<NonNullable<ActiveFilterChipsProps['onOpenMenu']>>();
  const filters: FilterControls = { ...DEFAULT_FILTER_CONTROLS, ...filterOverrides };

  const utils = render(
    <ActiveFilterChips
      filters={filters}
      extraPredicates={extraPredicates}
      setFilter={setFilter}
      removePredicateAt={removePredicateAt}
      clearSecondaryFilters={clearSecondaryFilters}
      onOpenMenu={onOpenMenu}
    />
  );

  return { ...utils, setFilter, removePredicateAt, clearSecondaryFilters, onOpenMenu };
}

describe('ActiveFilterChips', () => {
  it('renders a negated chip with the NOT badge, data-negated="true", sr-only exclusion text, and no line-through', () => {
    const extra: ExtraPredicate[] = [
      {
        index: 0,
        predicate: {
          field: Field.LABEL,
          values: ['kind/bug', 'area/api'],
          negated: true,
        },
      },
    ];
    const { container, removePredicateAt } = renderChips({}, extra);

    const chip = screen.getByTestId('extra-filter-chip');
    expect(chip.getAttribute('data-negated')).toBe('true');
    expect(chip.getAttribute('aria-label')).toBeNull();
    expect(within(chip).getByText('NOT')).toBeDefined();
    expect(within(chip).getByText('Label:')).toBeDefined();
    expect(within(chip).getByText('kind/bug, area/api')).toBeDefined();

    // Accessible indication of exclusion via sr-only text and remove button name
    const srOnly = chip.querySelector('.sr-only');
    expect(srOnly?.textContent).toBe('Excluding ');
    const removeBtn = within(chip).getByRole('button', {
      name: 'Remove negated label filter kind/bug, area/api',
    });
    expect(removeBtn).toBeDefined();

    // U9: No element uses strikethrough (line-through)
    expect(container.querySelector('.line-through')).toBeNull();

    fireEvent.click(removeBtn);
    expect(removePredicateAt).toHaveBeenCalledWith(0);
  });

  it('truncates 3+ values to "+N" with full title, renders the chip body as a button, and lists all values in remove button aria-label', () => {
    const { setFilter, onOpenMenu } = renderChips({
      repo: ['a/b', 'c/d', 'e/f'],
    });

    const summary = screen.getByText('a/b +2');
    expect(summary.getAttribute('title')).toBe('a/b, c/d, e/f');

    // Chip body is a keyboard-reachable button that opens the repo menu
    const bodyButton = summary.closest('button');
    expect(bodyButton).not.toBeNull();
    fireEvent.click(bodyButton!);
    expect(onOpenMenu).toHaveBeenCalledWith('repo');

    // Clicking × removes the whole predicate without opening the menu
    onOpenMenu.mockClear();
    const removeBtn = screen.getByRole('button', {
      name: 'Remove repository filter a/b, c/d, e/f',
    });
    expect(removeBtn).not.toBe(bodyButton);
    fireEvent.click(removeBtn);
    expect(setFilter).toHaveBeenCalledWith('repo', []);
    expect(onOpenMenu).not.toHaveBeenCalled();
  });

  it('formats author and assignee chips with a single leading @', () => {
    renderChips({
      author: ['alice', '@bob'],
      assignee: ['@me', 'carol'],
    });

    expect(screen.getByText('@alice, @bob')).toBeDefined();
    expect(screen.getByText('@me, @carol')).toBeDefined();
  });

  it('opens the State menu when clicking the Activity chip and opens overflow drill-downs for Assignee and Milestone chips', () => {
    const { onOpenMenu } = renderChips({
      activity: ['mention'],
      assignee: ['alice'],
      milestone: ['v1.0'],
    });

    fireEvent.click(screen.getByText('Mentions').closest('button')!);
    expect(onOpenMenu).toHaveBeenCalledWith('state');

    onOpenMenu.mockClear();
    fireEvent.click(screen.getByText('@alice').closest('button')!);
    expect(onOpenMenu).toHaveBeenCalledWith('assignee');

    onOpenMenu.mockClear();
    fireEvent.click(screen.getByText('v1.0').closest('button')!);
    expect(onOpenMenu).toHaveBeenCalledWith('milestone');
  });
});
