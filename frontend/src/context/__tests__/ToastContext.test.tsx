import { render, screen, act } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ConnectError, Code } from '@connectrpc/connect';
import { ToastProvider, useToast, parseErrorDetails } from '../ToastContext';

function TestToastConsumer() {
  const { toasts, showToast, showError, dismissToast, clearToasts } = useToast();

  return (
    <div>
      <div data-testid="toast-count">{toasts.length}</div>
      <button onClick={() => showToast('Simple info message')}>Show Info</button>
      <button
        onClick={() =>
          showToast({
            title: 'Custom Title',
            message: 'Warning message',
            type: 'warning',
            duration: 3000,
          })
        }
      >
        Show Warning
      </button>
      <button
        onClick={() =>
          showError(
            new Error("Token expired; run 'gh auth refresh -s notifications' to fix"),
            'Failed to sync'
          )
        }
      >
        Show Error
      </button>
      <button
        onClick={() =>
          showError(
            new Error('Network failure'),
            'Failed to update',
            'gh auth refresh -s notifications'
          )
        }
      >
        Show Error Explicit Command
      </button>
      <button onClick={() => clearToasts()}>Clear All</button>
      {toasts.map((t) => (
        <button key={t.id} onClick={() => dismissToast(t.id)} data-testid={`test-dismiss-${t.id}`}>
          Dismiss {t.id}
        </button>
      ))}
    </div>
  );
}

describe('ToastContext & parseErrorDetails', () => {
  describe('parseErrorDetails', () => {
    it('handles standard Error instance', () => {
      const err = new Error('Standard failure');
      const details = parseErrorDetails(err);
      expect(details.message).toBe('Standard failure');
      expect(details.command).toBeUndefined();
    });

    it('handles string errors', () => {
      const details = parseErrorDetails('Direct string error');
      expect(details.message).toBe('Direct string error');
      expect(details.command).toBeUndefined();
    });

    it('handles ConnectError instance and strips code prefix', () => {
      const err = new ConnectError(
        "Missing scope: run 'gh auth refresh -s notifications' to grant permissions",
        Code.PermissionDenied
      );
      const details = parseErrorDetails(err);
      expect(details.message).toContain("Missing scope: run 'gh auth refresh -s notifications' to grant permissions");
      expect(details.message.startsWith('[permission_denied]')).toBe(false);
      expect(details.command).toBe('gh auth refresh -s notifications');
    });

    it('extracts command enclosed in double quotes', () => {
      const details = parseErrorDetails('Run "gh auth refresh -s notifications" to proceed.');
      expect(details.command).toBe('gh auth refresh -s notifications');
    });

    it('extracts command enclosed in backticks', () => {
      const details = parseErrorDetails('Please execute `gh auth refresh -s notifications`');
      expect(details.command).toBe('gh auth refresh -s notifications');
    });

    it('extracts command with run keyword prefix without quotes', () => {
      const details = parseErrorDetails('Please run gh auth refresh -s notifications to grant scope');
      expect(details.command).toBe('gh auth refresh -s notifications');
    });

    it('extracts direct standalone gh command matching /gh\\s+[a-z0-9_\\-\\s]+/i', () => {
      const details = parseErrorDetails('gh auth refresh -s notifications');
      expect(details.command).toBe('gh auth refresh -s notifications');
    });

    it('does not extract commands from words ending in gh like rough, high, although', () => {
      expect(parseErrorDetails('A rough error occurred').command).toBeUndefined();
      expect(parseErrorDetails('High load on the server').command).toBeUndefined();
      expect(parseErrorDetails('Failed although network was available').command).toBeUndefined();
      expect(parseErrorDetails('Thorough check completed').command).toBeUndefined();
      expect(parseErrorDetails('Through connection timeout').command).toBeUndefined();
    });

    it('does not leak subsequent lines into extracted command for multiline strings', () => {
      const multilineQuoted = "Error on line 42:\n'gh auth refresh -s notifications'\nPlease try again";
      expect(parseErrorDetails(multilineQuoted).command).toBe('gh auth refresh -s notifications');

      const multilineUnquoted = "Error on line 42:\ngh auth refresh -s notifications\nPlease try again";
      expect(parseErrorDetails(multilineUnquoted).command).toBe('gh auth refresh -s notifications');

      const multilineFalsePositive = 'Job failed in high\npriority queue\nStatus 500';
      expect(parseErrorDetails(multilineFalsePositive).command).toBeUndefined();
    });

    it('correctly extracts commands containing dots and slashes', () => {
      const quotedHost = parseErrorDetails("Run 'gh auth refresh -s notifications --hostname github.com'");
      expect(quotedHost.command).toBe('gh auth refresh -s notifications --hostname github.com');

      const unquotedHost = parseErrorDetails('Run gh auth refresh -s notifications --hostname github.com to fix');
      expect(unquotedHost.command).toBe('gh auth refresh -s notifications --hostname github.com');

      const quotedRepo = parseErrorDetails("Run 'gh repo clone owner/repo'");
      expect(quotedRepo.command).toBe('gh repo clone owner/repo');

      const unquotedRepo = parseErrorDetails('Run gh repo clone owner/repo');
      expect(unquotedRepo.command).toBe('gh repo clone owner/repo');
    });

    it('falls back to provided fallback message for null/undefined/empty errors', () => {
      expect(parseErrorDetails(null, 'Custom fallback').message).toBe('Custom fallback');
      expect(parseErrorDetails(undefined, 'Custom fallback').message).toBe('Custom fallback');
      expect(parseErrorDetails('', 'Custom fallback').message).toBe('Custom fallback');
    });
  });

  describe('useToast outside Provider', () => {
    it('returns safe fallback without throwing', () => {
      render(<TestToastConsumer />);
      expect(screen.getByTestId('toast-count').textContent).toBe('0');

      // Interacting with buttons does not throw
      act(() => {
        screen.getByText('Show Info').click();
        screen.getByText('Clear All').click();
      });
      expect(screen.getByTestId('toast-count').textContent).toBe('0');
    });
  });

  describe('ToastProvider operations', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.restoreAllMocks();
      vi.useRealTimers();
    });

    it('adds and displays toast from showToast and auto-dismisses after duration', () => {
      render(
        <ToastProvider>
          <TestToastConsumer />
        </ToastProvider>
      );

      act(() => {
        screen.getByText('Show Info').click();
      });

      expect(screen.getByTestId('toast-count').textContent).toBe('1');
      expect(screen.getByText('Simple info message')).toBeDefined();

      // Fast forward past 5000ms default duration
      act(() => {
        vi.advanceTimersByTime(5100);
      });

      expect(screen.getByTestId('toast-count').textContent).toBe('0');
    });

    it('adds error toast with parsed command via showError and auto-dismisses after 8000ms', () => {
      render(
        <ToastProvider>
          <TestToastConsumer />
        </ToastProvider>
      );

      act(() => {
        screen.getByText('Show Error').click();
      });

      expect(screen.getByTestId('toast-count').textContent).toBe('1');
      expect(screen.getByTestId('toast-command-text').textContent).toBe('gh auth refresh -s notifications');

      // 5000ms is not enough for error toast (default 8000ms)
      act(() => {
        vi.advanceTimersByTime(6000);
      });
      expect(screen.getByTestId('toast-count').textContent).toBe('1');

      // Advance past 8000ms
      act(() => {
        vi.advanceTimersByTime(2500);
      });
      expect(screen.getByTestId('toast-count').textContent).toBe('0');
    });

    it('prioritizes explicitCommand when provided to showError', () => {
      render(
        <ToastProvider>
          <TestToastConsumer />
        </ToastProvider>
      );

      act(() => {
        screen.getByText('Show Error Explicit Command').click();
      });

      expect(screen.getByTestId('toast-command-text').textContent).toBe('gh auth refresh -s notifications');
    });

    it('deduplicates rapid identical toasts with same type and message', () => {
      render(
        <ToastProvider>
          <TestToastConsumer />
        </ToastProvider>
      );

      act(() => {
        screen.getByText('Show Info').click();
        screen.getByText('Show Info').click();
      });

      expect(screen.getByTestId('toast-count').textContent).toBe('1');
    });

    it('returns existing active toast ID on deduplication allowing callers to dismiss it', () => {
      let firstId = '';
      let secondId = '';

      function DedupeTestConsumer() {
        const { showToast, dismissToast, toasts } = useToast();
        return (
          <div>
            <button
              onClick={() => {
                firstId = showToast('Duplicate test message');
              }}
            >
              First
            </button>
            <button
              onClick={() => {
                secondId = showToast('Duplicate test message');
              }}
            >
              Second
            </button>
            <button onClick={() => dismissToast(secondId)}>Dismiss Second</button>
            <div data-testid="active-toasts">{toasts.length}</div>
          </div>
        );
      }

      render(
        <ToastProvider>
          <DedupeTestConsumer />
        </ToastProvider>
      );

      act(() => {
        screen.getByText('First').click();
      });
      expect(screen.getByTestId('active-toasts').textContent).toBe('1');
      expect(firstId).toBeTruthy();

      act(() => {
        screen.getByText('Second').click();
      });
      expect(screen.getByTestId('active-toasts').textContent).toBe('1');
      expect(secondId).toBe(firstId);

      act(() => {
        screen.getByText('Dismiss Second').click();
      });
      expect(screen.getByTestId('active-toasts').textContent).toBe('0');
    });

    it('dismisses toast manually via dismissToast', () => {
      render(
        <ToastProvider>
          <TestToastConsumer />
        </ToastProvider>
      );

      act(() => {
        screen.getByText('Show Info').click();
      });

      expect(screen.getByTestId('toast-count').textContent).toBe('1');

      act(() => {
        screen.getByTestId('toast-dismiss-button').click();
      });

      expect(screen.getByTestId('toast-count').textContent).toBe('0');
    });

    it('clears all active toasts via clearToasts', () => {
      render(
        <ToastProvider>
          <TestToastConsumer />
        </ToastProvider>
      );

      act(() => {
        screen.getByText('Show Info').click();
        screen.getByText('Show Warning').click();
      });

      expect(screen.getByTestId('toast-count').textContent).toBe('2');

      act(() => {
        screen.getByText('Clear All').click();
      });

      expect(screen.getByTestId('toast-count').textContent).toBe('0');
    });
  });
});
