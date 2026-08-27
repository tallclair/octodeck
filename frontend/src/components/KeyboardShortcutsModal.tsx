import { useEffect, useRef } from 'react';
import { X, Keyboard } from 'lucide-react';

interface KeyboardShortcutsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

interface ShortcutItem {
  keys: string[];
  description: string;
}

interface ShortcutSection {
  title: string;
  shortcuts: ShortcutItem[];
}

const SHORTCUT_SECTIONS: ShortcutSection[] = [
  {
    title: 'Navigation',
    shortcuts: [
      { keys: ['j', '↓'], description: 'Focus next item' },
      { keys: ['k', '↑'], description: 'Focus previous item' },
      { keys: ['Enter'], description: 'Open details panel' },
      { keys: ['Esc'], description: 'Close details panel or dialog' },
    ],
  },
  {
    title: 'Actions',
    shortcuts: [
      { keys: ['x', 'e'], description: 'Acknowledge (Ack) item' },
      { keys: ['s'], description: 'Star / unstar item' },
      { keys: ['o'], description: 'Open item on GitHub' },
    ],
  },
  {
    title: 'General',
    shortcuts: [
      { keys: ['?'], description: 'Toggle keyboard shortcuts' },
    ],
  },
];

export function KeyboardShortcutsModal({ isOpen, onClose }: KeyboardShortcutsModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isOpen) {
      const handleKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        }
      };
      window.addEventListener('keydown', handleKeyDown);
      return () => window.removeEventListener('keydown', handleKeyDown);
    }
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="shortcuts-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs animate-in fade-in duration-150"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        ref={dialogRef}
        className="w-full max-w-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-2xl overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/80">
          <div className="flex items-center gap-2 text-slate-800 dark:text-slate-100 font-semibold text-base">
            <Keyboard size={20} className="text-blue-600 dark:text-blue-400" />
            <h2 id="shortcuts-modal-title">Keyboard Shortcuts</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close keyboard shortcuts"
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
          >
            <X size={18} />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-6 max-h-[75vh] overflow-y-auto">
          {SHORTCUT_SECTIONS.map((section) => (
            <div key={section.title} className="space-y-3">
              <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500">
                {section.title}
              </h3>
              <div className="grid grid-cols-1 gap-2">
                {section.shortcuts.map((sc, idx) => (
                  <div
                    key={idx}
                    className="flex items-center justify-between py-1.5 px-2 rounded hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors"
                  >
                    <span className="text-sm text-slate-700 dark:text-slate-300">
                      {sc.description}
                    </span>
                    <div className="flex items-center gap-1.5 shrink-0">
                      {sc.keys.map((k) => (
                        <kbd
                          key={k}
                          className="min-w-[24px] px-2 py-0.5 text-center text-xs font-mono font-semibold text-slate-700 dark:text-slate-200 bg-slate-100 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded shadow-xs"
                        >
                          {k}
                        </kbd>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/50 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-300 bg-white dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 border border-slate-300 dark:border-slate-700 rounded-lg transition-colors cursor-pointer"
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}
