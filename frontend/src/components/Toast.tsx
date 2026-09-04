import { useState, useEffect, type MouseEvent } from 'react';
import { AlertCircle, AlertTriangle, CheckCircle, Info, X, Terminal, Copy, Check } from 'lucide-react';
import type { ToastItem, ToastType } from '../context/ToastContext';

export interface ToastContainerProps {
  toasts: ToastItem[];
  onDismiss: (id: string) => void;
}

export function ToastContainer({ toasts, onDismiss }: ToastContainerProps) {
  if (!toasts || toasts.length === 0) {
    return null;
  }

  return (
    <div
      className="fixed bottom-4 right-4 z-50 flex flex-col gap-2.5 max-w-md w-full sm:w-96 pointer-events-none px-4 sm:px-0"
      aria-label="Notifications"
      tabIndex={-1}
    >
      {toasts.map((toast) => (
        <ToastItemComponent key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

export interface ToastItemComponentProps {
  toast: ToastItem;
  onDismiss: (id: string) => void;
}

function getToastIcon(type: ToastType) {
  switch (type) {
    case 'error':
      return <AlertCircle size={18} className="text-red-600 dark:text-red-400 shrink-0 mt-0.5" />;
    case 'warning':
      return <AlertTriangle size={18} className="text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />;
    case 'success':
      return <CheckCircle size={18} className="text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />;
    case 'info':
    default:
      return <Info size={18} className="text-blue-600 dark:text-blue-400 shrink-0 mt-0.5" />;
  }
}

function getToastBorderClasses(type: ToastType): string {
  switch (type) {
    case 'error':
      return 'border-red-300 dark:border-red-800/80';
    case 'warning':
      return 'border-amber-300 dark:border-amber-800/80';
    case 'success':
      return 'border-emerald-300 dark:border-emerald-800/80';
    case 'info':
    default:
      return 'border-blue-300 dark:border-blue-800/80';
  }
}

export function ToastItemComponent({ toast, onDismiss }: ToastItemComponentProps) {
  const [copied, setCopied] = useState(false);
  const [isHovered, setIsHovered] = useState(false);

  // Auto-dismiss timer with pause on hover
  useEffect(() => {
    if (toast.persistent || !toast.duration || toast.duration <= 0 || isHovered) {
      return;
    }

    const timer = setTimeout(() => {
      onDismiss(toast.id);
    }, toast.duration);

    return () => clearTimeout(timer);
  }, [toast.id, toast.duration, toast.persistent, isHovered, onDismiss]);

  const handleCopy = async (e: MouseEvent) => {
    e.stopPropagation();
    if (!toast.command) return;

    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(toast.command);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } else {
        console.warn('Clipboard API not available in this context');
      }
    } catch (err) {
      console.warn('Failed to copy remediation command to clipboard:', err);
    }
  };

  const role = toast.type === 'error' ? 'alert' : 'status';
  const ariaLive = toast.type === 'error' ? 'assertive' : 'polite';
  const borderClasses = getToastBorderClasses(toast.type);

  return (
    <div
      role={role}
      aria-live={ariaLive}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      data-testid={`toast-${toast.id}`}
      data-toast-type={toast.type}
      className={`pointer-events-auto bg-white dark:bg-slate-900 border ${borderClasses} rounded-lg shadow-lg p-3.5 flex flex-col gap-1 transition-all duration-200 text-slate-900 dark:text-slate-100`}
    >
      <div className="flex items-start justify-between gap-2.5">
        <div className="flex items-start gap-2.5 min-w-0 flex-1">
          {getToastIcon(toast.type)}
          <div className="flex-1 min-w-0">
            {toast.title && (
              <h4 className="text-xs font-semibold text-slate-900 dark:text-slate-100 leading-tight">
                {toast.title}
              </h4>
            )}
            <p className="text-xs text-slate-700 dark:text-slate-300 leading-normal break-words">
              {toast.message}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => onDismiss(toast.id)}
          className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-1 -mr-1 -mt-1 rounded transition cursor-pointer shrink-0"
          title="Dismiss"
          aria-label="Dismiss notification"
          data-testid="toast-dismiss-button"
        >
          <X size={14} />
        </button>
      </div>

      {toast.command && (
        <div className="mt-1.5 flex items-center justify-between gap-2 bg-slate-100 dark:bg-slate-800/90 border border-slate-200 dark:border-slate-700/80 rounded px-2.5 py-1.5 font-mono text-xs text-slate-900 dark:text-slate-100">
          <div className="flex items-center gap-1.5 min-w-0">
            <Terminal size={12} className="text-slate-500 shrink-0" />
            <span className="truncate select-all" data-testid="toast-command-text">
              {toast.command}
            </span>
          </div>
          <button
            type="button"
            onClick={handleCopy}
            className="p-1 hover:bg-slate-200 dark:hover:bg-slate-700 rounded text-slate-500 hover:text-slate-900 dark:hover:text-slate-100 transition cursor-pointer shrink-0 flex items-center gap-1"
            title={copied ? 'Copied!' : 'Copy command'}
            aria-label="Copy remediation command"
            data-testid="toast-copy-button"
          >
            {copied ? (
              <>
                <Check size={13} className="text-emerald-500" />
                <span className="text-[10px] font-sans font-medium text-emerald-600 dark:text-emerald-400">
                  Copied!
                </span>
              </>
            ) : (
              <>
                <Copy size={13} />
                <span className="text-[10px] font-sans font-medium">Copy</span>
              </>
            )}
          </button>
        </div>
      )}
    </div>
  );
}
