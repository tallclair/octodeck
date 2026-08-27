import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { KeyboardShortcutsModal } from '../KeyboardShortcutsModal';

describe('KeyboardShortcutsModal', () => {
  it('does not render when isOpen is false', () => {
    render(<KeyboardShortcutsModal isOpen={false} onClose={vi.fn()} />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('renders all shortcut sections and keys when isOpen is true', () => {
    render(<KeyboardShortcutsModal isOpen={true} onClose={vi.fn()} />);

    expect(screen.getByRole('dialog')).toBeDefined();
    expect(screen.getByRole('heading', { name: /Keyboard Shortcuts/i })).toBeDefined();

    // Check key descriptions
    expect(screen.getByText('Focus next item')).toBeDefined();
    expect(screen.getByText('Focus previous item')).toBeDefined();
    expect(screen.getByText('Open details panel')).toBeDefined();
    expect(screen.getByText('Acknowledge (Ack) item')).toBeDefined();
    expect(screen.getByText('Star / unstar item')).toBeDefined();
    expect(screen.getByText('Open item on GitHub')).toBeDefined();
    expect(screen.getByText('Toggle keyboard shortcuts')).toBeDefined();

    // Check specific keys
    expect(screen.getByText('j')).toBeDefined();
    expect(screen.getByText('k')).toBeDefined();
    expect(screen.getByText('x')).toBeDefined();
    expect(screen.getByText('e')).toBeDefined();
    expect(screen.getByText('s')).toBeDefined();
    expect(screen.getByText('o')).toBeDefined();
    expect(screen.getByText('?')).toBeDefined();
  });

  it('calls onClose when clicking close button', () => {
    const onClose = vi.fn();
    render(<KeyboardShortcutsModal isOpen={true} onClose={onClose} />);

    const closeBtn = screen.getByRole('button', { name: /Close keyboard shortcuts/i });
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when clicking backdrop overlay', () => {
    const onClose = vi.fn();
    render(<KeyboardShortcutsModal isOpen={true} onClose={onClose} />);

    const dialogBackdrop = screen.getByRole('dialog');
    fireEvent.click(dialogBackdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when clicking "Got it" button', () => {
    const onClose = vi.fn();
    render(<KeyboardShortcutsModal isOpen={true} onClose={onClose} />);

    const gotItBtn = screen.getByRole('button', { name: /Got it/i });
    fireEvent.click(gotItBtn);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when pressing Escape key', () => {
    const onClose = vi.fn();
    render(<KeyboardShortcutsModal isOpen={true} onClose={onClose} />);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
