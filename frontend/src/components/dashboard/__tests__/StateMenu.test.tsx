import { useState } from 'react';
import { create } from '@bufbuild/protobuf';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FacetValueSchema } from '../../../api/octodeck/v1/query_pb';
import { resolveActivityValues } from '../../../logic/query/predicates';
import { DEFAULT_FILTER_CONTROLS, type FilterControls } from '../../../types/filters';
import { StateMenu } from '../StateMenu';
import { filterTriggerClass } from '../menuStyles';

const fc = (value: string, count: number) => create(FacetValueSchema, { value, count });

function Harness({
  initialFilters = {},
}: {
  initialFilters?: Partial<FilterControls>;
}) {
  const [filters, setFiltersState] = useState<FilterControls>({
    ...DEFAULT_FILTER_CONTROLS,
    ...initialFilters,
  });
  const [open, setOpen] = useState(false);

  const setFilter = <K extends keyof FilterControls>(
    key: K,
    value: FilterControls[K]
  ) => {
    setFiltersState((prev) => {
      if (key === 'activity') {
        return {
          ...prev,
          activity: resolveActivityValues(prev.activity, value as FilterControls['activity']),
        };
      }
      return { ...prev, [key]: value };
    });
  };

  return (
    <StateMenu
      state={filters.state}
      tracking={filters.tracking}
      triage={filters.triage}
      activity={filters.activity}
      activityFacets={[
        fc('item', 2),
        fc('mention', 4),
        fc('comment', 0),
        fc('code', 1),
        fc('noise', 0),
      ]}
      open={open}
      onToggle={() => setOpen((o) => !o)}
      onClose={() => setOpen(false)}
      setFilter={setFilter}
    />
  );
}

describe('StateMenu', () => {
  it('toggles multiple activity options without closing the menu and closes on state or tracking selection', () => {
    render(<Harness />);

    const trigger = screen.getByRole('button', { name: /Filter by state/i });
    expect(trigger.textContent).toBe('State');

    fireEvent.click(trigger);

    // Ticking Mentions and New commits keeps the menu open
    fireEvent.click(screen.getByRole('option', { name: /^Mentions$/i }));
    expect(screen.getByRole('listbox', { name: 'New activity' })).toBeDefined();
    expect(trigger.textContent).toBe('State');
    expect(trigger.className).toContain('bg-blue-50');

    fireEvent.click(screen.getByRole('option', { name: /^New commits$/i }));
    expect(trigger.textContent).toBe('State');
    expect(trigger.className).toContain('bg-blue-50');

    // Selecting Open closes the menu and keeps the trigger highlighted without a count
    fireEvent.click(screen.getByRole('button', { name: /^Open$/i }));
    expect(screen.queryByRole('listbox', { name: 'New activity' })).toBeNull();
    expect(trigger.textContent).toBe('State');
    expect(trigger.className).toContain('bg-blue-50');
  });

  it('does not count new:any toward the State highlight when on the New tab', () => {
    render(<Harness initialFilters={{ triage: 'activity', activity: ['any'] }} />);

    const trigger = screen.getByRole('button', { name: /Filter by state/i });
    expect(trigger.textContent).toBe('State');
  });

  it('uses the shared toolbar trigger classes in both states', () => {
    const { unmount } = render(<Harness />);
    expect(screen.getByRole('button', { name: /Filter by state/i }).className).toBe(
      filterTriggerClass(false)
    );
    unmount();

    render(<Harness initialFilters={{ state: 'open' }} />);
    expect(screen.getByRole('button', { name: /Filter by state/i }).className).toBe(
      filterTriggerClass(true)
    );
  });

  it('supports keyboard navigation across state rows and activity options and returns focus to the trigger', () => {
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: /Filter by state/i });
    trigger.focus();
    fireEvent.click(trigger);

    // ArrowDown from the focused panel moves to the first row
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /^Open$/i }));

    // End jumps to the last activity option; Space toggles it without closing the menu
    fireEvent.keyDown(document.activeElement as Element, { key: 'End' });
    const options = screen.getAllByRole('option');
    const last = options[options.length - 1];
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(last, { key: ' ' });
    expect(last.getAttribute('aria-selected')).toBe('true');
    expect(trigger.className).toBe(filterTriggerClass(true));

    // ArrowDown at the end is clamped
    fireEvent.keyDown(last, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(last);

    // Escape closes the panel and returns focus to the trigger
    fireEvent.keyDown(last, { key: 'Escape' });
    expect(screen.queryByRole('listbox', { name: 'New activity' })).toBeNull();
    expect(document.activeElement).toBe(trigger);

    // Selecting a state row also returns focus to the trigger
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('button', { name: /^Closed$/i }));
    expect(document.activeElement).toBe(trigger);
  });
});
