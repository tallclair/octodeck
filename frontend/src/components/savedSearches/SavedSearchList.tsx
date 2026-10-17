import { useRef, useState } from 'react';
import { Pencil } from 'lucide-react';
import { parseQuery, type ParsedQuery } from '../../logic/query/syntax';
import {
  isActive,
  moveItem,
  type SavedSearchView,
} from '../../logic/savedSearches';
import { SidebarRow } from '../dashboard/SidebarRow';
import { SavedSearchEditRow } from './SavedSearchEditRow';

export interface SavedSearchListProps {
  readonly searches: readonly SavedSearchView[];
  readonly currentQueryText?: string;
  readonly currentParsed?: ParsedQuery;
  readonly onSelectSearch: (search: SavedSearchView) => void;
  readonly onEditSearch?: (search: SavedSearchView) => void;
  readonly onRename?: (id: string, name: string) => Promise<void> | void;
  readonly onDelete?: (id: string) => Promise<void> | void;
  readonly onReorder?: (ids: string[]) => Promise<void> | void;
}

interface DropTargetState {
  readonly rowIndex: number;
  readonly position: 'before' | 'after';
  readonly toIndex: number;
}

function computeDropTarget(
  fromIndex: number,
  overIndex: number,
  e: React.DragEvent<HTMLDivElement>,
  total: number
): DropTargetState | null {
  if (fromIndex === overIndex || total <= 1) {
    return null;
  }
  const rect = e.currentTarget.getBoundingClientRect();
  if (rect.height <= 0) {
    const position = overIndex > fromIndex ? 'after' : 'before';
    return {
      rowIndex: overIndex,
      position,
      toIndex: overIndex,
    };
  }

  const midpoint = rect.top + rect.height / 2;
  const isAfter = e.clientY >= midpoint;
  const rawSlot = isAfter ? overIndex + 1 : overIndex;
  const adjusted = rawSlot > fromIndex ? rawSlot - 1 : rawSlot;
  const toIndex = Math.max(0, Math.min(total - 1, adjusted));
  if (toIndex === fromIndex) {
    return null;
  }
  return {
    rowIndex: overIndex,
    position: isAfter ? 'after' : 'before',
    toIndex,
  };
}

export function SavedSearchList({
  searches,
  currentQueryText = '',
  currentParsed,
  onSelectSearch,
  onEditSearch,
  onDelete,
  onReorder,
}: SavedSearchListProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [dropTarget, setDropTarget] = useState<DropTargetState | null>(null);
  const [liveAnnouncement, setLiveAnnouncement] = useState('');
  const [focusRequest, setFocusRequest] = useState<{ id: string; seq: number } | null>(null);

  const dragFromIndexRef = useRef<number | null>(null);
  const dropTargetRef = useRef<DropTargetState | null>(null);

  if (searches.length === 0 && isEditing) {
    setIsEditing(false);
  }

  const activeEditing = isEditing && searches.length > 0;
  const resolvedParsed = currentParsed ?? parseQuery(currentQueryText);

  const performReorder = (fromIndex: number, toIndex: number, refocusOnRollback = false) => {
    if (
      fromIndex < 0 ||
      fromIndex >= searches.length ||
      toIndex < 0 ||
      toIndex >= searches.length ||
      fromIndex === toIndex
    ) {
      return;
    }
    const moved = searches[fromIndex];
    const ids = searches.map((s) => s.id);
    const nextIds = moveItem(ids, fromIndex, toIndex);
    setLiveAnnouncement(`Moved ${moved.name} to position ${toIndex + 1} of ${searches.length}`);
    Promise.resolve(onReorder?.(nextIds)).catch(() => {
      setLiveAnnouncement(`Failed to move ${moved.name}; order restored`);
      if (refocusOnRollback) {
        setFocusRequest((prev) => ({ id: moved.id, seq: (prev?.seq ?? 0) + 1 }));
      }
    });
  };

  const handleKeyboardReorder = (fromIndex: number, toIndex: number) => {
    const moved = searches[fromIndex];
    if (moved) {
      setFocusRequest((prev) => ({ id: moved.id, seq: (prev?.seq ?? 0) + 1 }));
    }
    performReorder(fromIndex, toIndex, true);
  };

  const handleDragStartRow = (index: number, e: React.DragEvent<HTMLDivElement>) => {
    dragFromIndexRef.current = index;
    dropTargetRef.current = null;
    setDropTarget(null);
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData?.('text/plain', searches[index]?.id ?? String(index));
    }
  };

  const handleDragOverRow = (overIndex: number, e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'move';
    }
    const fromIndex = dragFromIndexRef.current;
    if (fromIndex === null) {
      return;
    }
    const target = computeDropTarget(fromIndex, overIndex, e, searches.length);
    dropTargetRef.current = target;
    setDropTarget(target);
  };

  const handleDropRow = (dropIndex: number, e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const fromIndex = dragFromIndexRef.current;
    const target =
      dropTargetRef.current ??
      (fromIndex !== null ? computeDropTarget(fromIndex, dropIndex, e, searches.length) : null);
    dragFromIndexRef.current = null;
    dropTargetRef.current = null;
    setDropTarget(null);
    if (fromIndex !== null && target !== null && target.toIndex !== fromIndex) {
      performReorder(fromIndex, target.toIndex);
    }
  };

  const handleDragEndRow = () => {
    dragFromIndexRef.current = null;
    dropTargetRef.current = null;
    setDropTarget(null);
  };

  const handleToggleEditing = () => {
    setIsEditing((prev) => !prev);
    setDropTarget(null);
  };

  return (
    <div className="mt-6 mb-2" data-testid="saved-searches-section">
      <div className="group/pinned-header flex items-center justify-between px-2 mb-2">
        <div className="text-xs font-bold text-slate-500 dark:text-slate-500 uppercase tracking-wider">
          <span>Pinned</span>
        </div>
        {searches.length > 0 && (
          <button
            type="button"
            data-testid="edit-saved-searches-button"
            aria-label={activeEditing ? undefined : 'Edit pinned searches'}
            onClick={handleToggleEditing}
            className={`text-xs text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 px-1.5 py-0.5 rounded hover:bg-slate-200/60 dark:hover:bg-slate-800 transition-[color,background-color,opacity] cursor-pointer inline-flex items-center gap-1 ${
              activeEditing
                ? ''
                : 'opacity-0 group-hover/pinned-header:opacity-100 focus-visible:opacity-100'
            }`}
          >
            {activeEditing ? <span>Done</span> : <Pencil size={12} />}
          </button>
        )}
      </div>

      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-testid="saved-searches-live-region"
        className="sr-only"
      >
        {liveAnnouncement}
      </div>

      {searches.length === 0 ? (
        <div
          data-testid="saved-searches-empty"
          className="px-2 py-1.5 text-xs text-slate-400 dark:text-slate-500"
        >
          Pin a search with the pin button in the search box
        </div>
      ) : activeEditing ? (
        <div className="space-y-1" data-testid="saved-searches-edit-list">
          {searches.map((search, index) => (
            <SavedSearchEditRow
              key={search.id || search.name}
              search={search}
              index={index}
              total={searches.length}
              dropIndicator={dropTarget?.rowIndex === index ? dropTarget.position : null}
              focusHandleSeq={focusRequest?.id === search.id ? focusRequest.seq : 0}
              onEdit={onEditSearch}
              onDelete={onDelete}
              onMoveByKeyboard={handleKeyboardReorder}
              onDragStartRow={handleDragStartRow}
              onDragOverRow={handleDragOverRow}
              onDropRow={handleDropRow}
              onDragEndRow={handleDragEndRow}
            />
          ))}
        </div>
      ) : (
        <div className="space-y-0.5" data-testid="saved-searches-list">
          {searches.map((search) => {
            const active = isActive(resolvedParsed, search);
            return (
              <SidebarRow
                key={search.id || search.name}
                label={search.name}
                isSelected={active}
                scope={search.scope}
                count={search.count}
                newCount={search.newCount}
                inboxCount={search.inboxCount}
                error={search.error}
                testId={`saved-search-row-${search.name}`}
                badgeTestId={`saved-search-count-${search.name}`}
                onClick={() => onSelectSearch(search)}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
