import { render, screen, act, fireEvent } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ToastContainer, ToastItemComponent } from '../Toast';
import type { ToastItem } from '../../context/ToastContext';

describe('Toast Component', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe('ToastContainer', () => {
    it('renders null when toasts array is empty', () => {
      const { container } = render(<ToastContainer toasts={[]} onDismiss={vi.fn()} />);
      expect(container.firstChild).toBeNull();
    });

    it('renders toast items in container with accessibility label', () => {
      const mockToasts: ToastItem[] = [
        {
          id: '1',
          type: 'info',
          message: 'First notification',
          createdAt: Date.now(),
        },
        {
          id: '2',
          type: 'error',
          message: 'Second notification',
          createdAt: Date.now(),
        },
      ];

      render(<ToastContainer toasts={mockToasts} onDismiss={vi.fn()} />);
      expect(screen.getByLabelText('Notifications')).toBeDefined();
      expect(screen.getByText('First notification')).toBeDefined();
      expect(screen.getByText('Second notification')).toBeDefined();
    });
  });

  describe('ToastItemComponent', () => {
    it('renders error toast with alert role and assertive aria-live', () => {
      const toast: ToastItem = {
        id: 'err-1',
        type: 'error',
        message: 'Something went wrong',
        createdAt: Date.now(),
      };

      render(<ToastItemComponent toast={toast} onDismiss={vi.fn()} />);
      const item = screen.getByRole('alert');
      expect(item).toBeDefined();
      expect(item.getAttribute('aria-live')).toBe('assertive');
      expect(item.getAttribute('data-toast-type')).toBe('error');
    });

    it('renders warning, success, and info toasts with status role and polite aria-live', () => {
      const warningToast: ToastItem = {
        id: 'warn-1',
        type: 'warning',
        message: 'Proceed with caution',
        createdAt: Date.now(),
      };

      const { unmount } = render(<ToastItemComponent toast={warningToast} onDismiss={vi.fn()} />);
      const warnItem = screen.getByRole('status');
      expect(warnItem).toBeDefined();
      expect(warnItem.getAttribute('aria-live')).toBe('polite');
      unmount();

      const successToast: ToastItem = {
        id: 'succ-1',
        type: 'success',
        message: 'Operation succeeded',
        createdAt: Date.now(),
      };
      render(<ToastItemComponent toast={successToast} onDismiss={vi.fn()} />);
      expect(screen.getByRole('status')).toBeDefined();
    });

    it('renders title when present', () => {
      const toast: ToastItem = {
        id: 'title-1',
        type: 'info',
        title: 'Heads up',
        message: 'New version available',
        createdAt: Date.now(),
      };

      render(<ToastItemComponent toast={toast} onDismiss={vi.fn()} />);
      expect(screen.getByText('Heads up')).toBeDefined();
      expect(screen.getByText('New version available')).toBeDefined();
    });

    it('calls onDismiss when close button is clicked', () => {
      const onDismiss = vi.fn();
      const toast: ToastItem = {
        id: 'dismiss-1',
        type: 'info',
        message: 'Dismiss me',
        createdAt: Date.now(),
      };

      render(<ToastItemComponent toast={toast} onDismiss={onDismiss} />);
      const closeBtn = screen.getByTestId('toast-dismiss-button');
      fireEvent.click(closeBtn);

      expect(onDismiss).toHaveBeenCalledTimes(1);
      expect(onDismiss).toHaveBeenCalledWith('dismiss-1');
    });

    it('auto-dismisses after duration', () => {
      const onDismiss = vi.fn();
      const toast: ToastItem = {
        id: 'timer-1',
        type: 'info',
        message: 'Auto dismiss me',
        duration: 3000,
        createdAt: Date.now(),
      };

      render(<ToastItemComponent toast={toast} onDismiss={onDismiss} />);
      expect(onDismiss).not.toHaveBeenCalled();

      act(() => {
        vi.advanceTimersByTime(2999);
      });
      expect(onDismiss).not.toHaveBeenCalled();

      act(() => {
        vi.advanceTimersByTime(2);
      });
      expect(onDismiss).toHaveBeenCalledWith('timer-1');
    });

    it('pauses auto-dismiss on mouse enter and resumes on mouse leave', () => {
      const onDismiss = vi.fn();
      const toast: ToastItem = {
        id: 'pause-1',
        type: 'error',
        message: 'Hovering should pause me',
        duration: 4000,
        createdAt: Date.now(),
      };

      render(<ToastItemComponent toast={toast} onDismiss={onDismiss} />);
      const toastEl = screen.getByRole('alert');

      // Hover over toast
      fireEvent.mouseEnter(toastEl);

      // Fast forward past duration while hovered
      act(() => {
        vi.advanceTimersByTime(5000);
      });
      expect(onDismiss).not.toHaveBeenCalled();

      // Mouse leaves toast
      fireEvent.mouseLeave(toastEl);

      // Advance by duration after leaving
      act(() => {
        vi.advanceTimersByTime(4001);
      });
      expect(onDismiss).toHaveBeenCalledWith('pause-1');
    });

    it('does not auto-dismiss when persistent is true or duration is 0', () => {
      const onDismiss = vi.fn();
      const toast: ToastItem = {
        id: 'persist-1',
        type: 'warning',
        message: 'Persistent warning',
        persistent: true,
        duration: 2000,
        createdAt: Date.now(),
      };

      render(<ToastItemComponent toast={toast} onDismiss={onDismiss} />);
      act(() => {
        vi.advanceTimersByTime(10000);
      });
      expect(onDismiss).not.toHaveBeenCalled();
    });

    it('renders remediation command pill and handles copy to clipboard', async () => {
      const writeTextMock = vi.fn().mockResolvedValue(undefined);
      Object.assign(navigator, {
        clipboard: {
          writeText: writeTextMock,
        },
      });

      const toast: ToastItem = {
        id: 'cmd-1',
        type: 'error',
        message: 'Missing permissions to update notifications.',
        command: 'gh auth refresh -s notifications',
        createdAt: Date.now(),
      };

      render(<ToastItemComponent toast={toast} onDismiss={vi.fn()} />);

      const commandText = screen.getByTestId('toast-command-text');
      expect(commandText.textContent).toBe('gh auth refresh -s notifications');

      const copyBtn = screen.getByTestId('toast-copy-button');
      expect(copyBtn.textContent).toContain('Copy');

      // Click copy button
      await act(async () => {
        fireEvent.click(copyBtn);
      });

      expect(writeTextMock).toHaveBeenCalledWith('gh auth refresh -s notifications');
      expect(copyBtn.textContent).toContain('Copied!');

      // Fast forward past 2000ms copy state reset
      act(() => {
        vi.advanceTimersByTime(2100);
      });

      expect(copyBtn.textContent).toContain('Copy');
    });

    it('does not set copied state when clipboard API is unavailable', async () => {
      const originalClipboard = navigator.clipboard;
      Object.defineProperty(navigator, 'clipboard', {
        value: undefined,
        configurable: true,
        writable: true,
      });

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const toast: ToastItem = {
        id: 'cmd-no-clip',
        type: 'error',
        message: 'Missing permissions.',
        command: 'gh auth refresh -s notifications',
        createdAt: Date.now(),
      };

      render(<ToastItemComponent toast={toast} onDismiss={vi.fn()} />);

      const copyBtn = screen.getByTestId('toast-copy-button');
      expect(copyBtn.textContent).toContain('Copy');

      await act(async () => {
        fireEvent.click(copyBtn);
      });

      expect(copyBtn.textContent).toContain('Copy');
      expect(copyBtn.textContent).not.toContain('Copied!');
      expect(warnSpy).toHaveBeenCalledWith('Clipboard API not available in this context');

      Object.defineProperty(navigator, 'clipboard', {
        value: originalClipboard,
        configurable: true,
        writable: true,
      });
    });

    it('does not set copied state when clipboard writeText rejects', async () => {
      const writeTextMock = vi.fn().mockRejectedValue(new Error('Permission denied'));
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: writeTextMock },
        configurable: true,
        writable: true,
      });

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const toast: ToastItem = {
        id: 'cmd-clip-err',
        type: 'error',
        message: 'Missing permissions.',
        command: 'gh auth refresh -s notifications',
        createdAt: Date.now(),
      };

      render(<ToastItemComponent toast={toast} onDismiss={vi.fn()} />);

      const copyBtn = screen.getByTestId('toast-copy-button');
      expect(copyBtn.textContent).toContain('Copy');

      await act(async () => {
        fireEvent.click(copyBtn);
      });

      expect(copyBtn.textContent).toContain('Copy');
      expect(copyBtn.textContent).not.toContain('Copied!');
      expect(warnSpy).toHaveBeenCalled();
    });
  });
});
