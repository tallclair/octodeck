import { useEffect, useRef, useState } from 'react';
import { GripVertical, Pencil, Trash2 } from 'lucide-react';
import {
  formatSavedSearchSort,
  isDefaultSavedSearchSort,
  type SavedSearchView,
} from '../../logic/savedSearches';

export interface SavedSearchEditRowProps {
  readonly search: SavedSearchView;
  readonly index: number;
  readonly total: number;
  readonly dropIndicator?: 'before' | 'after' | null;
  readonly focusHandleSeq?: number;
  readonly onEdit?: (search: SavedSearchView) => void;
  readonly onDelete?: (id: string) => Promise<void> | void;
  readonly onMoveByKeyboard?: (fromIndex: number, toIndex: number) => void;
  readonly onDragStartRow?: (index: number, e: React.DragEvent<HTMLDivElement>) => void;
  readonly onDragOverRow?: (index: number, e: React.DragEvent<HTMLDivElement>) => void;
  readonly onDropRow?: (index: number, e: React.DragEvent<HTMLDivElement>) => void;
  readonly onDragEndRow?: () => void;
}

export function SavedSearchEditRow({
  search,
  index,
  total,
  dropIndicator = null,
  focusHandleSeq = 0,
  onEdit,
  onDelete,
  onMoveByKeyboard,
  onDragStartRow,
  onDragOverRow,
  onDropRow,
  onDragEndRow,
}: SavedSearchEditRowProps) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isHandlePressed, setIsHandlePressed] = useState(false);

  const handleBtnRef = useRef<HTMLButtonElement>(null);
  const deleteTriggerBtnRef = useRef<HTMLButtonElement>(null);
  const confirmDeleteBtnRef = useRef<HTMLButtonElement>(null);
  const didToggleConfirmRef = useRef(false);

  useEffect(() => {
    if (focusHandleSeq > 0) {
      handleBtnRef.current?.focus();
    }
  }, [focusHandleSeq]);

  useEffect(() => {
    if (!didToggleConfirmRef.current) return;
    if (confirmingDelete) {
      confirmDeleteBtnRef.current?.focus();
    } else {
      deleteTriggerBtnRef.current?.focus();
    }
  }, [confirmingDelete]);

  const showSortPreview = !isDefaultSavedSearchSort(search.sort, search.order);
  const sortPreview = formatSavedSearchSort(search.sort, search.order);

  const handleConfirmDelete = async () => {
    if (isDeleting) return;
    setIsDeleting(true);
    try {
      await onDelete?.(search.id);
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <div
      data-testid={`saved-search-edit-row-${search.name}`}
      draggable={isHandlePressed}
      onDragStart={(e) => onDragStartRow?.(index, e)}
      onDragOver={(e) => onDragOverRow?.(index, e)}
      onDrop={(e) => {
        setIsHandlePressed(false);
        onDropRow?.(index, e);
      }}
      onDragEnd={() => {
        setIsHandlePressed(false);
        onDragEndRow?.();
      }}
      className="relative"
    >
      {dropIndicator === 'before' && (
        <div
          data-testid="saved-search-drop-indicator"
          data-position="before"
          className="pointer-events-none absolute inset-x-1 -top-0.5 h-0.5 rounded-full bg-blue-500 z-10"
        />
      )}

      {confirmingDelete ? (
        <div
          data-testid={`saved-search-delete-confirm-${search.name}`}
          className="flex items-center justify-between gap-1.5 px-2 py-1.5 rounded-md bg-red-50/70 dark:bg-red-950/30 border border-red-200 dark:border-red-900/50 text-xs"
        >
          <span className="text-slate-700 dark:text-slate-200 truncate">
            {`Delete “${search.name}”?`}
          </span>
          <div className="flex items-center gap-1 shrink-0">
            <button
              ref={confirmDeleteBtnRef}
              type="button"
              disabled={isDeleting}
              data-testid={`confirm-delete-saved-search-${search.name}`}
              onClick={() => {
                void handleConfirmDelete();
              }}
              className="px-2 py-0.5 rounded bg-red-600 hover:bg-red-700 text-white font-medium transition-colors cursor-pointer disabled:opacity-50"
            >
              Delete
            </button>
            <button
              type="button"
              disabled={isDeleting}
              data-testid={`cancel-delete-saved-search-${search.name}`}
              onClick={() => {
                didToggleConfirmRef.current = true;
                setConfirmingDelete(false);
              }}
              className="px-2 py-0.5 rounded text-slate-600 dark:text-slate-300 hover:bg-slate-200/70 dark:hover:bg-slate-800 transition-colors cursor-pointer disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-1 px-1 py-1 rounded-md">
          <button
            ref={handleBtnRef}
            type="button"
            aria-label={`Reorder ${search.name}`}
            data-testid={`reorder-saved-search-${search.name}`}
            onPointerDown={() => setIsHandlePressed(true)}
            onPointerUp={() => setIsHandlePressed(false)}
            onPointerCancel={() => setIsHandlePressed(false)}
            onMouseDown={() => setIsHandlePressed(true)}
            onMouseUp={() => setIsHandlePressed(false)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowUp') {
                e.preventDefault();
                if (index > 0) {
                  onMoveByKeyboard?.(index, index - 1);
                }
              } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                if (index < total - 1) {
                  onMoveByKeyboard?.(index, index + 1);
                }
              }
            }}
            className="p-0.5 rounded text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 cursor-grab active:cursor-grabbing shrink-0"
          >
            <GripVertical size={14} />
          </button>

          <div className="flex-1 min-w-0 flex flex-col px-1">
            <span className="text-xs text-slate-700 dark:text-slate-200 truncate">
              {search.name}
            </span>
            {showSortPreview && (
              <div
                data-testid={`saved-search-sort-preview-${search.name}`}
                className="text-[11px] text-slate-400 dark:text-slate-500 truncate"
              >
                {sortPreview}
              </div>
            )}
          </div>

          <button
            type="button"
            aria-label={`Edit ${search.name}`}
            data-testid={`edit-saved-search-${search.name}`}
            onClick={() => onEdit?.(search)}
            className="p-1 rounded text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-200/60 dark:hover:bg-slate-800 transition-colors cursor-pointer shrink-0"
          >
            <Pencil size={13} />
          </button>

          <button
            ref={deleteTriggerBtnRef}
            type="button"
            aria-label={`Delete ${search.name}`}
            data-testid={`delete-saved-search-${search.name}`}
            onClick={() => {
              didToggleConfirmRef.current = true;
              setConfirmingDelete(true);
            }}
            className="p-1 rounded text-slate-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 transition-colors cursor-pointer shrink-0"
          >
            <Trash2 size={14} />
          </button>
        </div>
      )}

      {dropIndicator === 'after' && (
        <div
          data-testid="saved-search-drop-indicator"
          data-position="after"
          className="pointer-events-none absolute inset-x-1 -bottom-0.5 h-0.5 rounded-full bg-blue-500 z-10"
        />
      )}
    </div>
  );
}
