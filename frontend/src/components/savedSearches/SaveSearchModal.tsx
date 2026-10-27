import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import { Code, ConnectError } from '@connectrpc/connect';
import { useQuery } from '@connectrpc/connect-query';
import { keepPreviousData } from '@tanstack/react-query';
import { Pin, Trash2, X } from 'lucide-react';
import { getItems } from '../../api/octodeck/v1/service-OctoDeckService_connectquery';
import type { Item } from '../../api/octodeck/v1/resources_pb';
import { exprErrorOf } from '../../api/errors';
import { SEARCH_DEBOUNCE_MS } from '../../hooks/useDashboardData';
import { useMenuGroup } from '../../hooks/useMenuGroup';
import type { QuerySuggestionFacets } from '../../hooks/useQuerySuggestions';
import { fromDisplay } from '../../logic/query/displayText';
import { toExpr, toSort } from '../../logic/query/expr';
import { mapServerErrorToRequest } from '../../logic/query/predicates';
import { parseQuery, type ParsedQuery } from '../../logic/query/syntax';
import {
  MAX_SAVED_SEARCH_QUERY_LENGTH,
  suggestName,
  validateSavedSearchName,
  type SavedSearchView,
} from '../../logic/savedSearches';
import type { SortOption, SortOrder } from '../../types/filters';
import { SortMenu } from '../dashboard/SortMenu';
import { QueryInput } from '../query/QueryInput';

export type SaveSearchModalMode = 'create' | 'edit' | 'modified';

export interface UpdateSavedSearchModalPatch {
  name: string;
  text?: string;
  sort?: SortOption;
  order?: SortOrder;
}

export interface SaveSearchModalProps {
  readonly isOpen?: boolean;
  readonly mode?: SaveSearchModalMode;
  readonly savedSearch?: SavedSearchView | null;
  readonly queryText: string;
  readonly parsed?: ParsedQuery;
  readonly sort: SortOption;
  readonly order: SortOrder;
  readonly facets?: QuerySuggestionFacets;
  readonly existingSearches?: readonly { id: string; name: string }[];
  readonly onClose: () => void;
  readonly onSave?: (input: {
    name: string;
    text: string;
    sort: SortOption;
    order: SortOrder;
  }) => Promise<unknown> | void;
  readonly onUpdate?: (
    id: string,
    patch: UpdateSavedSearchModalPatch
  ) => Promise<unknown> | void;
  readonly onRename?: (id: string, name: string) => Promise<unknown> | void;
  readonly onDelete?: (id: string) => Promise<unknown> | void;
}

interface ModalSessionSnapshot {
  readonly mode: SaveSearchModalMode;
  readonly savedSearch: SavedSearchView | null;
  readonly queryText: string;
  readonly parsed: ParsedQuery;
  readonly sort: SortOption;
  readonly order: SortOrder;
}

const NO_PREVIEW_ITEMS: readonly Item[] = [];

function buildSnapshot(
  mode: SaveSearchModalMode | undefined,
  savedSearch: SavedSearchView | null | undefined,
  queryText: string,
  parsed: ParsedQuery | undefined,
  sort: SortOption,
  order: SortOrder
): ModalSessionSnapshot {
  const resolvedMode: SaveSearchModalMode =
    mode === 'modified' && savedSearch
      ? 'modified'
      : (mode ? mode === 'edit' : Boolean(savedSearch)) && Boolean(savedSearch)
        ? 'edit'
        : 'create';
  const resolvedParsed = parsed ?? parseQuery(queryText);
  return {
    mode: resolvedMode,
    savedSearch: resolvedMode !== 'create' && savedSearch ? savedSearch : null,
    queryText,
    parsed: resolvedParsed,
    sort,
    order,
  };
}

function resolveInitialDraftQuery(snapshot: ModalSessionSnapshot): string {
  if (snapshot.mode === 'edit' && snapshot.savedSearch) {
    return snapshot.savedSearch.text;
  }
  // Create and modified modes start from the full current text, tab clauses included: unscoped
  // searches always open on the implicit Inbox tab, so a tab clause here was added on purpose.
  return snapshot.queryText;
}

function validateSavedSearchQueryText(text: string): string | null {
  if (text.includes('\n') || text.includes('\r')) {
    return 'Query cannot contain line breaks.';
  }
  const trimmed = text.trim();
  if (!trimmed) {
    return 'Query is required.';
  }
  if (Array.from(text).length > MAX_SAVED_SEARCH_QUERY_LENGTH) {
    return `Query cannot exceed ${MAX_SAVED_SEARCH_QUERY_LENGTH} characters.`;
  }
  const parsed = parseQuery(text);
  if (parsed.issues.length > 0) {
    return 'Fix the highlighted parts of the query first';
  }
  return null;
}

function formatMutationError(err: unknown): string {
  if (err instanceof ConnectError) {
    if (err.code === Code.AlreadyExists) {
      return 'A saved search with this name already exists.';
    }
    if (err.code === Code.ResourceExhausted) {
      return 'Maximum of 50 saved searches reached (limit 50).';
    }
    if (err.code === Code.InvalidArgument) {
      return err.rawMessage || 'Invalid saved search.';
    }
    return err.rawMessage || err.message || 'Failed to save search.';
  }
  if (err instanceof Error) {
    return err.message;
  }
  return 'Failed to save search.';
}

export function SaveSearchModal({
  isOpen = true,
  mode,
  savedSearch = null,
  queryText,
  parsed,
  sort,
  order,
  facets,
  existingSearches,
  onClose,
  onSave,
  onUpdate,
  onRename,
  onDelete,
}: SaveSearchModalProps) {
  const [wasOpen, setWasOpen] = useState(isOpen);
  const [snapshot, setSnapshot] = useState<ModalSessionSnapshot>(() =>
    buildSnapshot(mode, savedSearch, queryText, parsed, sort, order)
  );
  const [name, setName] = useState(() =>
    snapshot.mode !== 'create' && snapshot.savedSearch
      ? snapshot.savedSearch.name
      : suggestName(snapshot.parsed)
  );
  const [draftQuery, setDraftQuery] = useState(() => resolveInitialDraftQuery(snapshot));
  const [debouncedQuery, setDebouncedQuery] = useState(() =>
    resolveInitialDraftQuery(snapshot)
  );
  const [draftSort, setDraftSort] = useState<SortOption>(() =>
    snapshot.mode === 'edit' && snapshot.savedSearch
      ? snapshot.savedSearch.sort
      : snapshot.sort
  );
  const [draftOrder, setDraftOrder] = useState<SortOrder>(() =>
    snapshot.mode === 'edit' && snapshot.savedSearch
      ? snapshot.savedSearch.order
      : snapshot.order
  );
  const [error, setError] = useState<string | null>(null);
  const [queryError, setQueryError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const modalMenus = useMenuGroup();
  const { anyOpen: modalMenuOpen, close: closeModalMenus } = modalMenus;

  if (isOpen && !wasOpen) {
    const nextSnapshot = buildSnapshot(mode, savedSearch, queryText, parsed, sort, order);
    const initialDraft = resolveInitialDraftQuery(nextSnapshot);
    setWasOpen(true);
    setSnapshot(nextSnapshot);
    setName(
      nextSnapshot.mode !== 'create' && nextSnapshot.savedSearch
        ? nextSnapshot.savedSearch.name
        : suggestName(nextSnapshot.parsed)
    );
    setDraftQuery(initialDraft);
    setDebouncedQuery(initialDraft);
    setDraftSort(
      nextSnapshot.mode === 'edit' && nextSnapshot.savedSearch
        ? nextSnapshot.savedSearch.sort
        : nextSnapshot.sort
    );
    setDraftOrder(
      nextSnapshot.mode === 'edit' && nextSnapshot.savedSearch
        ? nextSnapshot.savedSearch.order
        : nextSnapshot.order
    );
    setError(null);
    setQueryError(null);
    setConfirmingDelete(false);
    setIsSubmitting(false);
  } else if (!isOpen && wasOpen) {
    setWasOpen(false);
  }

  useEffect(() => {
    if (!isOpen) return;
    if (draftQuery === debouncedQuery) return;
    const timer = setTimeout(() => {
      setDebouncedQuery(draftQuery);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [isOpen, draftQuery, debouncedQuery]);

  const currentDraftParsed = useMemo(() => parseQuery(draftQuery), [draftQuery]);
  const debouncedParsed = useMemo(() => parseQuery(debouncedQuery), [debouncedQuery]);
  const canFetchPreview =
    isOpen &&
    debouncedQuery.trim() !== '' &&
    !debouncedQuery.includes('\n') &&
    !debouncedQuery.includes('\r') &&
    Array.from(debouncedQuery).length <= MAX_SAVED_SEARCH_QUERY_LENGTH &&
    debouncedParsed.issues.length === 0;

  const previewExpr = useMemo(() => toExpr(debouncedParsed), [debouncedParsed]);
  const previewSort = useMemo(() => toSort(draftSort, draftOrder), [draftSort, draftOrder]);

  const previewQ = useQuery(
    getItems,
    { query: previewExpr, sort: previewSort },
    {
      enabled: canFetchPreview,
      placeholderData: keepPreviousData,
    }
  );

  const rawPreviewInvalidQuery = exprErrorOf(previewQ.error);
  const previewInvalidQuery = useMemo(
    () => mapServerErrorToRequest(debouncedParsed, rawPreviewInvalidQuery),
    [debouncedParsed, rawPreviewInvalidQuery]
  );

  const resolvedPreviewItems =
    draftQuery.trim() === '' || currentDraftParsed.issues.length > 0
      ? NO_PREVIEW_ITEMS
      : (previewQ.data?.items ?? NO_PREVIEW_ITEMS);
  const topPreviewItems = resolvedPreviewItems.slice(0, 3);
  const remainingPreviewCount = resolvedPreviewItems.length - topPreviewItems.length;

  const dialogRef = useRef<HTMLDivElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const queryInputRef = useRef<HTMLTextAreaElement>(null);
  const deleteTriggerBtnRef = useRef<HTMLButtonElement>(null);
  const confirmDeleteBtnRef = useRef<HTMLButtonElement>(null);
  const didToggleConfirmRef = useRef(false);

  useEffect(() => {
    if (!isOpen) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    const input = nameInputRef.current;
    if (input) {
      input.focus();
      input.select();
    }
    return () => {
      if (
        previousFocus &&
        typeof previousFocus.focus === 'function' &&
        document.contains(previousFocus)
      ) {
        previousFocus.focus();
      }
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || !didToggleConfirmRef.current) return;
    if (confirmingDelete) {
      confirmDeleteBtnRef.current?.focus();
    } else {
      deleteTriggerBtnRef.current?.focus();
    }
  }, [isOpen, confirmingDelete]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (e.defaultPrevented || modalMenuOpen) {
          if (modalMenuOpen) {
            e.stopPropagation();
            closeModalMenus();
          }
          return;
        }
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key === 'Tab' && dialogRef.current) {
        const focusable = Array.from(
          dialogRef.current.querySelectorAll<HTMLElement>(
            'input:not([disabled]):not([tabindex="-1"]), textarea:not([disabled]):not([tabindex="-1"]), select:not([disabled]):not([tabindex="-1"]), button:not([disabled]):not([tabindex="-1"]), [tabindex]:not([tabindex="-1"])'
          )
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const active = document.activeElement as HTMLElement | null;
        if (e.shiftKey) {
          if (active === first || !dialogRef.current.contains(active)) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (active === last || !dialogRef.current.contains(active)) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, modalMenuOpen, closeModalMenus, onClose]);

  if (!isOpen) return null;

  const activeSearch = snapshot.savedSearch;
  const isEditOrModified = activeSearch !== null;

  // QueryInput's onChange normalizes inter-clause spacing, whereas the textarea holds the raw
  // untrimmed text; reading fromDisplay(textarea.value) keeps untrimmed length checks and verbatim
  // storage consistent with the backend.
  const readCurrentQueryText = (): string => {
    if (queryInputRef.current) {
      return fromDisplay(queryInputRef.current.value);
    }
    return draftQuery;
  };

  const validateQueryOrReport = (rawQuery: string): boolean => {
    const queryValidationError = validateSavedSearchQueryText(rawQuery);
    if (!queryValidationError) {
      return true;
    }
    queryInputRef.current?.blur();
    setQueryError(queryValidationError);
    return false;
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;

    const validationError = validateSavedSearchName(
      name,
      existingSearches,
      isEditOrModified && activeSearch ? activeSearch.id : undefined
    );
    if (validationError) {
      setError(validationError);
      return;
    }

    const currentQuery = readCurrentQueryText();
    if (!validateQueryOrReport(currentQuery)) {
      return;
    }

    const trimmedName = name.trim();
    setError(null);
    setQueryError(null);
    setIsSubmitting(true);
    try {
      if (isEditOrModified && activeSearch) {
        if (onUpdate) {
          const queryChanged = currentQuery !== activeSearch.text;
          const sortChanged =
            draftSort !== activeSearch.sort || draftOrder !== activeSearch.order;
          await onUpdate(activeSearch.id, {
            name: trimmedName,
            ...(queryChanged ? { text: currentQuery } : {}),
            ...(sortChanged ? { sort: draftSort, order: draftOrder } : {}),
          });
        } else {
          await onRename?.(activeSearch.id, trimmedName);
        }
      } else {
        await onSave?.({
          name: trimmedName,
          text: currentQuery,
          sort: draftSort,
          order: draftOrder,
        });
      }
      onClose();
    } catch (err) {
      setError(formatMutationError(err));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSaveAsNew = async () => {
    if (!isEditOrModified || !activeSearch || isSubmitting) return;

    const trimmedName = name.trim();
    if (trimmedName.toLowerCase() === activeSearch.name.trim().toLowerCase()) {
      const input = nameInputRef.current;
      if (input) {
        input.focus();
        input.select();
      }
      setError('Give the new pinned search a different name');
      return;
    }

    const validationError = validateSavedSearchName(name, existingSearches);
    if (validationError) {
      const input = nameInputRef.current;
      if (input) {
        input.focus();
        input.select();
      }
      setError(validationError);
      return;
    }

    const currentQuery = readCurrentQueryText();
    if (!validateQueryOrReport(currentQuery)) {
      return;
    }

    setError(null);
    setQueryError(null);
    setIsSubmitting(true);
    try {
      await onSave?.({
        name: trimmedName,
        text: currentQuery,
        sort: draftSort,
        order: draftOrder,
      });
      onClose();
    } catch (err) {
      setError(formatMutationError(err));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleConfirmDelete = async () => {
    if (!isEditOrModified || !activeSearch || isSubmitting) return;
    setError(null);
    setIsSubmitting(true);
    try {
      await onDelete?.(activeSearch.id);
      onClose();
    } catch (err) {
      setError(formatMutationError(err));
    } finally {
      setIsSubmitting(false);
    }
  };

  const modalTitle = isEditOrModified ? 'Edit pinned search' : 'Pin search';

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="save-search-modal-title"
      data-testid="save-search-modal"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs animate-in fade-in duration-150"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        ref={dialogRef}
        className="w-full max-w-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-2xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 rounded-t-xl border-b border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/80">
          <div className="flex items-center gap-2 text-slate-800 dark:text-slate-100 font-semibold text-base">
            <Pin size={18} className="text-blue-600 dark:text-blue-400 rotate-45" />
            <h2 id="save-search-modal-title">{modalTitle}</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close dialog"
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
          >
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          {/* Content */}
          <div className="p-6 space-y-4">
            <div className="space-y-1.5">
              <label
                htmlFor="saved-search-name-input"
                className="block text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400"
              >
                Name
              </label>
              <input
                ref={nameInputRef}
                id="saved-search-name-input"
                type="text"
                value={name}
                aria-invalid={error ? 'true' : 'false'}
                aria-describedby={error ? 'saved-search-name-error' : undefined}
                onChange={(e) => {
                  setName(e.target.value);
                  if (error) setError(null);
                }}
                placeholder="e.g. k8s bugs"
                className={`w-full px-3 py-2 text-sm rounded-lg border bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 transition-colors ${
                  error
                    ? 'border-red-500 dark:border-red-500 focus:ring-red-500/30'
                    : 'border-slate-300 dark:border-slate-700 focus:border-blue-500 focus:ring-blue-500/20'
                }`}
              />
              {error && (
                <p
                  id="saved-search-name-error"
                  role="alert"
                  data-testid="saved-search-name-error"
                  className="text-xs text-red-600 dark:text-red-400 mt-1"
                >
                  {error}
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <div className="block text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                Query
              </div>
              <QueryInput
                value={draftQuery}
                inputRef={queryInputRef}
                textareaTestId="saved-search-query-input"
                facets={facets}
                invalidQuery={previewInvalidQuery}
                onChange={(next) => {
                  setDraftQuery(next);
                  if (queryError) setQueryError(null);
                }}
                onClear={() => {
                  setDraftQuery('');
                  if (queryError) setQueryError(null);
                }}
              />
              {queryError && (
                <p
                  id="saved-search-query-error"
                  role="alert"
                  data-testid="saved-search-query-error"
                  className="text-xs text-red-600 dark:text-red-400 mt-1"
                >
                  {queryError}
                </p>
              )}
            </div>

            {/* Live Preview & Sort Menu */}
            <div
              data-testid="saved-search-preview"
              className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-950/60"
            >
              <div className="flex items-center justify-between px-3 py-1.5 border-b border-slate-200/70 dark:border-slate-800/60 text-xs select-none">
                <span
                  data-testid="saved-search-preview-count"
                  aria-live="polite"
                  className="text-xs text-slate-500 dark:text-slate-400 font-mono"
                >
                  {resolvedPreviewItems.length}{' '}
                  {resolvedPreviewItems.length === 1 ? 'item' : 'items'}
                </span>

                <SortMenu
                  sort={draftSort}
                  order={draftOrder}
                  onSelectSort={setDraftSort}
                  onSelectOrder={setDraftOrder}
                  isOpen={modalMenus.isOpen('sort')}
                  onToggle={() => modalMenus.toggle('sort')}
                  onClose={() => modalMenus.close()}
                  menuRef={modalMenus.refFor('sort')}
                />
              </div>

              <div className="divide-y divide-slate-200/60 dark:divide-slate-800/50">
                {topPreviewItems.length > 0 ? (
                  <>
                    {topPreviewItems.map((item) => (
                      <div
                        key={item.id || `${item.repo}#${item.number}`}
                        data-testid="saved-search-preview-item"
                        className="px-3 py-1.5 text-xs flex items-center gap-2 min-w-0"
                      >
                        <span className="font-mono text-slate-500 dark:text-slate-400 shrink-0">
                          {item.repo ? `${item.repo}#${item.number}` : item.id}
                        </span>
                        <span className="text-slate-700 dark:text-slate-200 truncate">
                          {item.title}
                        </span>
                      </div>
                    ))}
                    {remainingPreviewCount > 0 && (
                      <div
                        data-testid="saved-search-preview-more"
                        className="px-3 py-1.5 text-xs text-slate-400 dark:text-slate-500"
                      >
                        {`... and ${remainingPreviewCount} more`}
                      </div>
                    )}
                  </>
                ) : (
                  <div
                    data-testid="saved-search-preview-empty"
                    className="px-3 py-2 text-xs text-slate-400 dark:text-slate-500"
                  >
                    No matching items
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Footer */}
          <div className="px-6 py-3 rounded-b-xl border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/50 flex items-center justify-between gap-2">
            {isEditOrModified && activeSearch && confirmingDelete ? (
              <div
                data-testid="delete-confirm-prompt"
                className="flex items-center justify-between w-full gap-2"
              >
                <span className="text-xs font-medium text-red-600 dark:text-red-400 truncate">
                  Delete “{activeSearch.name}”?
                </span>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    ref={confirmDeleteBtnRef}
                    type="button"
                    disabled={isSubmitting}
                    data-testid="confirm-delete-saved-search"
                    onClick={handleConfirmDelete}
                    className="px-3 py-1.5 text-xs font-semibold text-white bg-red-600 hover:bg-red-700 rounded-lg transition-colors cursor-pointer disabled:opacity-50"
                  >
                    Delete
                  </button>
                  <button
                    type="button"
                    disabled={isSubmitting}
                    onClick={() => {
                      didToggleConfirmRef.current = true;
                      setConfirmingDelete(false);
                    }}
                    className="px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-300 bg-white dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 border border-slate-300 dark:border-slate-700 rounded-lg transition-colors cursor-pointer"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <>
                <div>
                  {isEditOrModified && activeSearch && (
                    <button
                      ref={deleteTriggerBtnRef}
                      type="button"
                      disabled={isSubmitting}
                      onClick={() => {
                        didToggleConfirmRef.current = true;
                        setConfirmingDelete(true);
                      }}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 rounded-lg transition-colors cursor-pointer"
                    >
                      <Trash2 size={14} />
                      <span>Delete</span>
                    </button>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={isSubmitting}
                    onClick={onClose}
                    className="px-4 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-300 bg-white dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 border border-slate-300 dark:border-slate-700 rounded-lg transition-colors cursor-pointer"
                  >
                    Cancel
                  </button>
                  {isEditOrModified ? (
                    <>
                      <button
                        type="button"
                        disabled={isSubmitting}
                        data-testid="save-as-new-button"
                        onClick={handleSaveAsNew}
                        className="px-4 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-300 bg-white dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 border border-slate-300 dark:border-slate-700 rounded-lg transition-colors cursor-pointer disabled:opacity-50"
                      >
                        Save as new
                      </button>
                      <button
                        type="submit"
                        disabled={isSubmitting}
                        data-testid="update-saved-search-button"
                        className="px-4 py-1.5 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors cursor-pointer disabled:opacity-50"
                      >
                        Update
                      </button>
                    </>
                  ) : (
                    <button
                      type="submit"
                      disabled={isSubmitting}
                      className="px-4 py-1.5 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors cursor-pointer disabled:opacity-50"
                    >
                      Save
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
