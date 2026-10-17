import { createRef, useState } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { TriageFilter } from '../../../types/filters';
import { TriageTitleMenu } from '../TriageTitleMenu';

function Harness({
  triage: controlledTriage,
  initialTriage = 'inbox',
  onSelect = vi.fn(),
}: {
  triage?: TriageFilter;
  initialTriage?: TriageFilter;
  onSelect?: (tab: TriageFilter) => void;
}) {
  const [triage, setTriage] = useState<TriageFilter>(initialTriage);
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = createRef<HTMLDivElement>();

  const currentTriage = controlledTriage ?? triage;

  return (
    <TriageTitleMenu
      triage={currentTriage}
      isOpen={isOpen}
      onToggle={() => setIsOpen((prev) => !prev)}
      onClose={() => setIsOpen(false)}
      onSelect={(tab) => {
        setTriage(tab);
        onSelect(tab);
      }}
      menuRef={menuRef}
    />
  );
}

describe('TriageTitleMenu', () => {
  it('renders trigger button with correct label for each triage filter', () => {
    const { rerender } = render(<Harness triage="inbox" />);
    expect(screen.getByRole('button', { name: /Select triage status/i }).textContent).toContain(
      'Inbox'
    );

    rerender(<Harness triage="activity" />);
    expect(screen.getByRole('button', { name: /Select triage status/i }).textContent).toContain(
      'New Activity'
    );

    rerender(<Harness triage="acked" />);
    expect(screen.getByRole('button', { name: /Select triage status/i }).textContent).toContain(
      'Acked'
    );

    rerender(<Harness triage="all" />);
    expect(screen.getByRole('button', { name: /Select triage status/i }).textContent).toContain(
      'All Items'
    );
  });

  it('opens dialog on trigger click and closes on option select', () => {
    const onSelect = vi.fn();
    render(<Harness initialTriage="inbox" onSelect={onSelect} />);

    const trigger = screen.getByRole('button', { name: /Select triage status/i });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('dialog', { name: 'Triage status' })).toBeNull();

    // Click to open
    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const dialog = screen.getByRole('dialog', { name: 'Triage status' });
    expect(dialog).toBeDefined();

    // Contains buttons: Inbox, New Activity, Acked, All Items
    expect(within(dialog).getByRole('button', { name: /^Inbox$/i })).toBeDefined();
    expect(within(dialog).getByRole('button', { name: /^New Activity$/i })).toBeDefined();
    expect(within(dialog).getByRole('button', { name: /^Acked$/i })).toBeDefined();
    expect(within(dialog).getByRole('button', { name: /^All Items$/i })).toBeDefined();

    // Select "New Activity"
    const newActivityBtn = within(dialog).getByRole('button', { name: /^New Activity$/i });
    fireEvent.click(newActivityBtn);

    expect(onSelect).toHaveBeenCalledWith('activity');
    // Dialog closes
    expect(screen.queryByRole('dialog', { name: 'Triage status' })).toBeNull();
    // Trigger updates
    expect(trigger.textContent).toContain('New Activity');
  });

  it('closes dialog on toggle', () => {
    render(<Harness initialTriage="inbox" />);
    const trigger = screen.getByRole('button', { name: /Select triage status/i });

    // Open
    fireEvent.click(trigger);
    expect(screen.getByRole('dialog', { name: 'Triage status' })).toBeDefined();

    // Toggle closed
    fireEvent.click(trigger);
    expect(screen.queryByRole('dialog', { name: 'Triage status' })).toBeNull();
  });
});
