import { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { create } from '@bufbuild/protobuf';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { FacetValueSchema, type FacetValue } from '../../../api/octodeck/v1/query_pb';
import { buildLabelOptions } from '../../../logic/query/facets';
import { MultiSelectMenu } from '../MultiSelectMenu';
import { MENU_LISTBOX_SCROLL_CLASS } from '../menuStyles';

const fv = (value: string, count: number, color = ''): FacetValue =>
  create(FacetValueSchema, { value, count, color });

const DEFAULT_FACETS: readonly FacetValue[] = [
  fv('kind/bug', 4, 'd73a4a'),
  fv('area/api', 2, '0075ca'),
  fv('size/L', 0, 'ededed'),
];

function Harness({
  initialSelected = [],
  initialOpen = true,
  facets = DEFAULT_FACETS,
  onChangeSpy,
}: {
  initialSelected?: string[];
  initialOpen?: boolean;
  facets?: readonly FacetValue[];
  onChangeSpy?: (next: string[]) => void;
}) {
  const [selected, setSelected] = useState<string[]>(initialSelected);
  const [open, setOpen] = useState(initialOpen);

  return (
    <MultiSelectMenu
      label="Label"
      open={open}
      onToggle={() => setOpen((o) => !o)}
      onClose={() => setOpen(false)}
      selected={selected}
      onChange={(next) => {
        setSelected(next);
        onChangeSpy?.(next);
      }}
      buildOptions={(showAll) => buildLabelOptions(facets, selected, showAll)}
    />
  );
}

describe('MultiSelectMenu', () => {
  it('renders a multiselectable listbox with option roles and aria-selected', () => {
    render(<Harness initialSelected={['kind/bug']} />);

    const listbox = screen.getByRole('listbox', { name: 'Label' });
    expect(listbox.getAttribute('aria-multiselectable')).toBe('true');

    const options = within(listbox).getAllByRole('option');
    expect(options.map((o) => o.textContent)).toContain('area/api2');
    const bugOption = within(listbox).getByRole('option', { name: 'kind/bug' });
    const apiOption = within(listbox).getByRole('option', { name: 'area/api' });
    expect(bugOption.getAttribute('aria-selected')).toBe('true');
    expect(apiOption.getAttribute('aria-selected')).toBe('false');
  });

  it('does not render role="separator" inside the listbox when dividers are shown', () => {
    render(
      <MultiSelectMenu
        label="Activity"
        open={true}
        onToggle={() => {}}
        onClose={() => {}}
        selected={[]}
        onChange={() => {}}
        searchable={false}
        sortOptions={false}
        buildOptions={() => ({
          list: [
            { value: 'any', label: 'Any new activity', count: null },
            { value: 'item', label: 'New items', count: 2, dividerBefore: true },
          ],
          hasMore: false,
        })}
      />
    );

    const listbox = screen.getByRole('listbox', { name: 'Activity' });
    expect(within(listbox).queryByRole('separator')).toBeNull();
  });

  it('toggles values without closing the menu and supports Clear', () => {
    const onChangeSpy = vi.fn();
    render(<Harness onChangeSpy={onChangeSpy} />);

    fireEvent.click(screen.getByRole('option', { name: 'kind/bug' }));
    expect(onChangeSpy).toHaveBeenLastCalledWith(['kind/bug']);
    expect(screen.getByRole('listbox')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Filter by label' }).textContent).toBe('Label');

    fireEvent.click(screen.getByRole('option', { name: 'area/api' }));
    expect(onChangeSpy).toHaveBeenLastCalledWith(['kind/bug', 'area/api']);
    expect(screen.getByRole('button', { name: 'Filter by label' }).textContent).toBe('Label');

    // Unticking removes only that option
    fireEvent.click(screen.getByRole('option', { name: 'kind/bug' }));
    expect(onChangeSpy).toHaveBeenLastCalledWith(['area/api']);

    // Clear button clears the entire selection
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(onChangeSpy).toHaveBeenLastCalledWith([]);
    expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull();
  });

  it('filters options case-insensitively with the filter input', () => {
    render(<Harness />);

    const input = screen.getByPlaceholderText('Filter labels…');
    expect(document.activeElement).toBe(input);

    fireEvent.change(input, { target: { value: 'API' } });
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(1);
    expect(options[0].getAttribute('aria-selected')).toBe('false');
    expect(screen.getByRole('option', { name: 'area/api' })).toBeDefined();
  });

  it('reveals dimmed zero-count options on Show all and resets Show all after closing and reopening', () => {
    render(<Harness />);

    // Zero-count 'size/L' is hidden initially
    expect(screen.queryByRole('option', { name: 'size/L' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Show all' }));
    const zeroOption = screen.getByRole('option', { name: 'size/L' });
    expect(zeroOption.getAttribute('data-zero-count')).toBe('true');
    expect(zeroOption.className).toContain('opacity-50');
    expect(screen.queryByRole('button', { name: 'Show all' })).toBeNull();

    // Close and reopen via trigger button -> Show all is reset
    const trigger = screen.getByRole('button', { name: 'Filter by label' });
    fireEvent.click(trigger);
    expect(screen.queryByRole('listbox')).toBeNull();

    fireEvent.click(trigger);
    expect(screen.queryByRole('option', { name: 'size/L' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Show all' })).toBeDefined();
  });

  it('keeps an unticked option in place with count 0 when a facet refresh drops its count to 0', () => {
    const initialFacets = [fv('kind/bug', 2), fv('area/api', 1)];
    const { rerender } = render(
      <MultiSelectMenu
        label="Label"
        open={true}
        onToggle={() => {}}
        onClose={() => {}}
        selected={[]}
        onChange={() => {}}
        buildOptions={(showAll) => buildLabelOptions(initialFacets, [], showAll)}
      />
    );

    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      'area/api1',
      'kind/bug2',
    ]);

    // Next facet response reports count 0 for unticked 'area/api' (so buildLabelOptions omits it when showAll is false)
    const refreshedFacets = [fv('kind/bug', 3), fv('area/api', 0)];
    rerender(
      <MultiSelectMenu
        label="Label"
        open={true}
        onToggle={() => {}}
        onClose={() => {}}
        selected={[]}
        onChange={() => {}}
        buildOptions={(showAll) => buildLabelOptions(refreshedFacets, [], showAll)}
      />
    );

    // 'area/api' stays in place with count 0
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      'area/api0',
      'kind/bug3',
    ]);
    expect(screen.getByRole('option', { name: 'area/api' }).getAttribute('data-zero-count')).toBe('true');
  });

  it('supports keyboard navigation (ArrowDown, ArrowUp, Space) and returns focus to trigger on Escape and Tab', () => {
    const onChangeSpy = vi.fn();
    render(<Harness onChangeSpy={onChangeSpy} />);

    const trigger = screen.getByRole('button', { name: 'Filter by label' });
    const input = screen.getByPlaceholderText('Filter labels…');
    const firstOption = screen.getByRole('option', { name: 'area/api' });
    const secondOption = screen.getByRole('option', { name: 'kind/bug' });

    // ArrowDown moves from filter input to first option, then second option
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(firstOption);

    fireEvent.keyDown(firstOption, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(secondOption);

    // Space toggles the focused option and keeps the menu open
    fireEvent.keyDown(secondOption, { key: ' ' });
    expect(onChangeSpy).toHaveBeenLastCalledWith(['kind/bug']);
    expect(screen.getByRole('listbox')).toBeDefined();

    // ArrowUp moves back to first option, then back to input
    fireEvent.keyDown(secondOption, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(firstOption);

    fireEvent.keyDown(firstOption, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(input);

    // Escape closes the menu and returns focus to the trigger button
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(document.activeElement).toBe(trigger);

    // Reopen and press Tab -> closes the menu and keeps focus on the trigger button
    fireEvent.click(trigger);
    const reopenedInput = screen.getByPlaceholderText('Filter labels…');
    fireEvent.keyDown(reopenedInput, { key: 'Tab' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('caps and scrolls the option list itself rather than relying on the panel to shrink it', () => {
    render(<Harness />);
    const listbox = screen.getByRole('listbox', { name: 'Label' });
    for (const cls of MENU_LISTBOX_SCROLL_CLASS.split(' ')) {
      expect(listbox.classList.contains(cls)).toBe(true);
    }
    expect(listbox.className).not.toMatch(/\bflex-1\b/);
    // The panel must not clip the list with a smaller max height of its own
    expect(listbox.parentElement?.className).not.toMatch(/\bmax-h-/);
  });
});
