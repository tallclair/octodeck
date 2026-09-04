/* eslint-disable react-refresh/only-export-components */
import {
  createContext,
  useContext,
  useState,
  useRef,
  useEffect,
  useCallback,
  useMemo,
  type ReactNode,
} from 'react';
import { ConnectError } from '@connectrpc/connect';
import { ToastContainer } from '../components/Toast';

export type ToastType = 'error' | 'warning' | 'info' | 'success';

export interface ToastOptions {
  id?: string;
  type?: ToastType;
  title?: string;
  message: string;
  command?: string;      // Actionable remediation command (e.g. 'gh auth refresh -s notifications')
  duration?: number;     // Auto-dismiss duration in ms (default: 8000ms for errors, 5000ms for others, 0 for persistent)
  persistent?: boolean;  // If true, will not auto-dismiss
}

export interface ToastItem extends ToastOptions {
  id: string;
  type: ToastType;
  createdAt: number;
}

export interface ToastContextValue {
  toasts: ToastItem[];
  showToast: (options: ToastOptions | string) => string;
  showError: (error: unknown, fallbackMessage?: string, explicitCommand?: string) => string;
  dismissToast: (id: string) => void;
  clearToasts: () => void;
}

export const ToastContext = createContext<ToastContextValue | null>(null);

/**
 * Extracts human-readable message and actionable remediation command matching
 * /gh\s+[a-z0-9_\-\s]+/i from unknown errors, ConnectError, or Error objects.
 */
export function parseErrorDetails(
  error: unknown,
  fallbackMessage = 'An unexpected error occurred'
): { message: string; command?: string } {
  let rawMessage = fallbackMessage;

  if (error instanceof ConnectError) {
    rawMessage = error.rawMessage || error.message || fallbackMessage;
  } else if (error instanceof Error) {
    rawMessage = error.message || fallbackMessage;
  } else if (typeof error === 'string' && error.trim()) {
    rawMessage = error.trim();
  } else if (
    error &&
    typeof error === 'object' &&
    'message' in error &&
    typeof (error as { message: unknown }).message === 'string'
  ) {
    rawMessage = (error as { message: string }).message.trim();
  }

  // Strip ConnectRPC error code prefix like "[permission_denied] " or "[internal] "
  const message = rawMessage.replace(/^\[[a-z_]+\]\s*/i, '').trim();

  // Extract actionable command matching gh CLI invocations
  // Priority 1: Delimited command in quotes or backticks ('gh ...', "gh ...", `gh ...`)
  let command: string | undefined;
  const quotedMatch = message.match(/(?:run|execute|use)?\s*[:\s]?\s*['`"](\bgh\b[^'`"\r\n]+)['`"]/i);
  if (quotedMatch) {
    let candidate = quotedMatch[1].trim();
    // Strip trailing punctuation if any
    candidate = candidate.replace(/[.,;:]+$/, '').trim();
    if (candidate) {
      command = candidate;
    }
  } else {
    // Priority 2: Unquoted command preceded by "run" or standalone
    const unquotedMatch = message.match(
      /(?:^|[^\w])(\bgh\b[ \t]+(?:--?[a-z0-9_\-./]+|[a-z0-9_\-./]+)(?:[ \t]+(?:--?[a-z0-9_\-./]+|[a-z0-9_\-./]+))*)/i
    );
    if (unquotedMatch) {
      let candidate = unquotedMatch[1].trim();
      // Strip trailing English continuation clauses if present (e.g. " to grant scope", " in terminal")
      candidate = candidate.replace(/[ \t]+(?:to|in|for|before|after|and|or|then)[ \t]+.*$/i, '').trim();
      // Strip trailing punctuation if any
      candidate = candidate.replace(/[.,;:]+$/, '').trim();
      if (candidate && candidate.includes(' ')) {
        command = candidate;
      }
    }
  }

  return {
    message: message || fallbackMessage,
    command,
  };
}

export interface ToastProviderProps {
  children: ReactNode;
}

export function ToastProvider({ children }: ToastProviderProps) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const toastsRef = useRef<ToastItem[]>(toasts);

  useEffect(() => {
    toastsRef.current = toasts;
  }, [toasts]);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => {
      const next = prev.filter((t) => t.id !== id);
      toastsRef.current = next;
      return next;
    });
  }, []);

  const clearToasts = useCallback(() => {
    toastsRef.current = [];
    setToasts([]);
  }, []);

  const showToast = useCallback((options: ToastOptions | string): string => {
    const opts: ToastOptions = typeof options === 'string' ? { message: options } : options;
    const type: ToastType = opts.type ?? 'info';
    const message = (opts.message || '').trim();
    if (!message) return '';

    // Check if an identical toast already exists in state
    const existing = toastsRef.current.find((t) => t.message === message && t.type === type);
    if (existing && !opts.id) {
      return existing.id;
    }

    const id = opts.id || `toast-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    const duration = opts.duration ?? (type === 'error' ? 8000 : 5000);

    const newItem: ToastItem = {
      ...opts,
      id,
      type,
      message,
      duration,
      createdAt: Date.now(),
    };

    setToasts((prev) => {
      // Deduplicate: If an identical toast with the same message and type was created recently, avoid spam
      const currentExisting = prev.find((t) => t.message === message && t.type === type);
      if (currentExisting && !opts.id) {
        return prev;
      }
      const updated = [...prev, newItem];
      const next = updated.slice(-5);
      toastsRef.current = next;
      return next;
    });

    toastsRef.current = [...toastsRef.current.filter((t) => t.id !== id), newItem].slice(-5);

    return id;
  }, []);

  const showError = useCallback(
    (error: unknown, fallbackMessage = 'An unexpected error occurred', explicitCommand?: string): string => {
      const { message, command: parsedCommand } = parseErrorDetails(error, fallbackMessage);
      return showToast({
        type: 'error',
        message,
        command: explicitCommand || parsedCommand,
        duration: 8000,
      });
    },
    [showToast]
  );

  const contextValue = useMemo<ToastContextValue>(
    () => ({
      toasts,
      showToast,
      showError,
      dismissToast,
      clearToasts,
    }),
    [toasts, showToast, showError, dismissToast, clearToasts]
  );

  return (
    <ToastContext.Provider value={contextValue}>
      {children}
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) {
    // Safe graceful fallback for isolated component testing outside ToastProvider
    return {
      toasts: [],
      showToast: () => '',
      showError: () => '',
      dismissToast: () => {},
      clearToasts: () => {},
    };
  }
  return context;
}
