import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { FilterControls } from '../../../types/filters';
import { TypeMenu } from '../TypeMenu';
import { filterTriggerClass } from '../menuStyles';

function Harness({
  initialType = 'all',
}: {
  initialType?: FilterControls['type'];
}) {
  const [type, setType] = useState<FilterControls['type']>(initialType);
  const [open, setOpen] = useState(false);

  return (
    <TypeMenu
      type={type}
      open={open}
      onToggle={() => setOpen((o) => !o)}
      onClose={() => setOpen(false)}
      setFilter={(_key, val) => setType(val as FilterControls['type'])}
    />
  );
}

describe('TypeMenu', () => {
  it('renders trigger with Type label and correct accessible attributes', () => {
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: /Filter by type/i });
    expect(trigger.textContent).toBe('Type');
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(trigger.className).toBe(filterTriggerClass(false));
  });

  it('highlights trigger when type filter is active', () => {
    const { rerender } = render(<Harness initialType="pr" />);
    const trigger = screen.getByRole('button', { name: /Filter by type/i });
    expect(trigger.className).toBe(filterTriggerClass(true));

    rerender(<Harness initialType="issue" />);
    expect(trigger.className).toBe(filterTriggerClass(true));
  });

  it('toggles options: selects unselected option, and toggles active option back to all', () => {
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: /Filter by type/i });

    // Open menu
    fireEvent.click(trigger);
    expect(screen.getByRole('dialog', { name: 'Type filter' })).toBeDefined();

    // Select Pull requests
    fireEvent.click(screen.getByRole('button', { name: /^Pull requests$/i }));
    // Menu closes and trigger becomes active
    expect(screen.queryByRole('dialog', { name: 'Type filter' })).toBeNull();
    expect(trigger.className).toBe(filterTriggerClass(true));

    // Reopen menu: Pull requests has check mark
    fireEvent.click(trigger);
    expect(screen.getByRole('dialog', { name: 'Type filter' })).toBeDefined();

    // Clicking Pull requests again toggles it back to 'all'
    fireEvent.click(screen.getByRole('button', { name: /^Pull requests$/i }));
    expect(screen.queryByRole('dialog', { name: 'Type filter' })).toBeNull();
    expect(trigger.className).toBe(filterTriggerClass(false));

    // Open and select Issues
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('button', { name: /^Issues$/i }));
    expect(screen.queryByRole('dialog', { name: 'Type filter' })).toBeNull();
    expect(trigger.className).toBe(filterTriggerClass(true));
  });

  it('supports keyboard navigation and returns focus to trigger', () => {
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: /Filter by type/i });
    trigger.focus();
    fireEvent.click(trigger);

    // ArrowDown moves focus to first option
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /^Pull requests$/i }));

    // ArrowDown moves focus to second option
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /^Issues$/i }));

    // ArrowDown at end is clamped
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /^Issues$/i }));

    // Escape closes menu and returns focus to trigger
    fireEvent.keyDown(document.activeElement as Element, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Type filter' })).toBeNull();
    expect(document.activeElement).toBe(trigger);

    // Enter on option selects it and returns focus to trigger
    fireEvent.click(trigger);
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowDown' });
    fireEvent.click(document.activeElement as Element);
    expect(screen.queryByRole('dialog', { name: 'Type filter' })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
