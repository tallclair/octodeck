import { useToast } from '../context/ToastContext';
import { useState, useEffect, useMemo, useRef } from 'react';
import { Search, CheckCircle, AlertTriangle, RefreshCw } from 'lucide-react';
import { useQuery, useMutation } from '@connectrpc/connect-query';
import { useQueryClient } from '@tanstack/react-query';
import {
  ackItem,
  starItem,
  setNotes,
  getConfig,
  viewItem,
  getSyncStatus,
  updateSubscription,
} from '../api/octodeck/v1/service-OctoDeckService_connectquery';
import { SubscriptionState, type Item } from '../api/octodeck/v1/resources_pb';
import { client, checkStatus } from '../api/client';
import { PullRequestCard } from './PullRequestCard';
import { DetailsPane } from './DetailsPane';
import { SyncStatusDisplay } from './SyncStatusDisplay';
import { KeyboardShortcutsModal } from './KeyboardShortcutsModal';
import { Settings } from '../Settings';
import { useDashboardFilters } from '../hooks/useDashboardFilters';
import { useDashboardData } from '../hooks/useDashboardData';
import { useScrollAnchoring } from '../hooks/useScrollAnchoring';
import { useKeyboardNavigation } from '../hooks/useKeyboardNavigation';
import { useMenuGroup } from '../hooks/useMenuGroup';
import { TriageTitleMenu } from './dashboard/TriageTitleMenu';
import { FilterToolbar } from './dashboard/FilterToolbar';
import { ActiveFilterChips } from './dashboard/ActiveFilterChips';
import { SortMenu } from './dashboard/SortMenu';
import { DashboardSidebar } from './dashboard/DashboardSidebar';

interface DashboardProps {
  onOpenDebug?: (targetItemId?: string) => void;
}

export function Dashboard({ onOpenDebug }: DashboardProps) {
  const { data: configData, isError: isConfigError, refetch: refetchConfig } = useQuery(getConfig, {});
  const { data: syncStatusData, isError: isSyncStatusError, refetch: refetchSyncStatus } = useQuery(
    getSyncStatus,
    {},
    {
      refetchInterval: 2000,
      staleTime: 1000,
    }
  );

  const queryClient = useQueryClient();
  const { mutateAsync: ackItemMutate } = useMutation(ackItem);
  const { mutateAsync: starItemMutate } = useMutation(starItem);
  const { mutateAsync: setNotesMutate } = useMutation(setNotes);
  const { mutateAsync: viewItemMutate } = useMutation(viewItem);
  const { mutateAsync: updateSubscriptionMutate } = useMutation(updateSubscription);

  const { showError } = useToast();
  const [isSyncing, setIsSyncing] = useState(false);

  // Daemon version state for Settings
  const [daemonVersion, setDaemonVersion] = useState<string>(() => {
    return typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev';
  });
  const [statusHasNotificationsScope, setStatusHasNotificationsScope] = useState<boolean>(true);

  // Fetch daemon version and OAuth scope status
  useEffect(() => {
    checkStatus()
      .then((status) => {
        if (status.version) {
          setDaemonVersion(status.version);
        }
        if (typeof status.has_notifications_scope === 'boolean') {
          setStatusHasNotificationsScope(status.has_notifications_scope);
        }
      })
      .catch(() => {
        // Retain fallback version if status query fails
      });
  }, []);

  const [showSettings, setShowSettings] = useState(false);
  const menus = useMenuGroup();

  const [showAllRepos, setShowAllRepos] = useState(false);
  const [showAllAuthors, setShowAllAuthors] = useState(false);
  const [showAllMilestones, setShowAllMilestones] = useState(false);
  const [showAllLabels, setShowAllLabels] = useState(false);

  if (!menus.isOpen('repo') && showAllRepos) setShowAllRepos(false);
  if (!menus.isOpen('author') && showAllAuthors) setShowAllAuthors(false);
  if (!menus.isOpen('milestone') && showAllMilestones) setShowAllMilestones(false);
  if (!menus.isOpen('label') && showAllLabels) setShowAllLabels(false);

  const [debugMode, setDebugMode] = useState<boolean>(() => {
    try {
      return (
        typeof localStorage !== 'undefined' &&
        (localStorage.getItem('octodeck_debug_mode') === 'true' ||
          localStorage.getItem('octodeck_debug_show_item_ids') === 'true')
      );
    } catch {
      return false;
    }
  });

  const {
    query,
    filters,
    extraPredicates,
    setFilter,
    setFilters,
    applyWorkflowShortcut,
    toggleRepo,
    clearSecondaryFilters,
    removePredicateAt,
  } = useDashboardFilters();

  const selectedItemId = filters.item;
  const [dismissingIds, setDismissingIds] = useState<Set<string>>(new Set());

  const handleToggleDebugMode = (enabled: boolean) => {
    setDebugMode(enabled);
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('octodeck_debug_mode', String(enabled));
        localStorage.setItem('octodeck_debug_show_item_ids', String(enabled));
      }
    } catch (e) {
      console.warn('Failed to save debug setting to localStorage', e);
    }
  };

  const configPinnedRepos = configData?.config?.pinnedRepos;
  const pinnedRepos = useMemo(() => configPinnedRepos || [], [configPinnedRepos]);
  const currentUser = configData?.currentUserLogin || null;

  // Items, dropdown options and sidebar counts, all filtered and counted by the daemon.
  const data = useDashboardData({
    query,
    filters,
    pinnedRepos,
    showAll: {
      repos: showAllRepos,
      authors: showAllAuthors,
      milestones: showAllMilestones,
      labels: showAllLabels,
    },
  });
  const { items, refreshAll } = data;
  // An invalid query is reported inline; only connectivity failures mean "disconnected".
  const isDisconnected = data.hasConnectivityError || isConfigError || isSyncStatusError;

  const hasActiveChips = useMemo(
    () =>
      filters.state !== 'all' ||
      filters.tracking !== 'all' ||
      Boolean(filters.repo) ||
      Boolean(filters.org) ||
      Boolean(filters.author) ||
      Boolean(filters.milestone) ||
      Boolean(filters.label) ||
      filters.assigned === 'me' ||
      extraPredicates.length > 0,
    [filters, extraPredicates]
  );

  const itemIds = useMemo(() => items.map((i) => i.id), [items]);

  const { scrollContainerRef } = useScrollAnchoring({
    itemIds,
    // The key of the result on screen, so a filter change resets the scroll when its result arrives.
    filterKey: data.settledKey,
    animationDurationMs: 400,
  });

  const lastUpdateKey = syncStatusData?.status?.lastUpdateReceivedAt
    ? `${syncStatusData.status.lastUpdateReceivedAt.seconds}_${syncStatusData.status.lastUpdateReceivedAt.nanos || 0}`
    : '';
  const lastSyncKey = syncStatusData?.status?.lastSuccessfulSyncAt
    ? `${syncStatusData.status.lastSuccessfulSyncAt.seconds}_${syncStatusData.status.lastSuccessfulSyncAt.nanos || 0}`
    : '';
  const daemonIsSyncing = Boolean(syncStatusData?.status?.isSyncing);
  const hasNotificationsScope =
    syncStatusData?.status?.hasNotificationsScope ?? statusHasNotificationsScope;

  const prevSyncingRef = useRef(daemonIsSyncing);
  useEffect(() => {
    if (prevSyncingRef.current && !daemonIsSyncing) {
      // Daemon just finished syncing, immediately refresh items
      refreshAll();
    }
    prevSyncingRef.current = daemonIsSyncing;
  }, [daemonIsSyncing, refreshAll]);

  const prevTimestampsRef = useRef<{ updateKey: string; syncKey: string } | null>(null);
  useEffect(() => {
    if (prevTimestampsRef.current === null) {
      // Initial mount: record initial timestamps, avoid duplicate immediate refetch
      if (lastUpdateKey || lastSyncKey) {
        prevTimestampsRef.current = { updateKey: lastUpdateKey, syncKey: lastSyncKey };
      }
      return;
    }
    if (
      (lastUpdateKey && lastUpdateKey !== prevTimestampsRef.current.updateKey) ||
      (lastSyncKey && lastSyncKey !== prevTimestampsRef.current.syncKey)
    ) {
      prevTimestampsRef.current = { updateKey: lastUpdateKey, syncKey: lastSyncKey };
      refreshAll();
    }
  }, [lastUpdateKey, lastSyncKey, refreshAll]);

  const handleManualSync = async () => {
    setIsSyncing(true);
    try {
      for await (const res of client.sync({})) {
        if (res.message) {
          console.debug('Sync progress:', res.message);
        }
      }
      await refreshAll();
      await refetchSyncStatus();
    } catch (err) {
      console.error('Failed to trigger manual sync from GitHub:', err);
      showError(err, 'Failed to trigger manual sync from GitHub');
    } finally {
      setIsSyncing(false);
    }
  };

  const handleAck = async (id: string) => {
    try {
      const willDisappear = filters.triage !== 'all' && filters.triage !== 'acked';
      if (willDisappear) {
        setDismissingIds((prev) => new Set(prev).add(id));
      }
      setFilter('item', null);

      const mutationPromise = ackItemMutate({ itemId: id, acked: true });
      if (willDisappear) {
        await Promise.all([mutationPromise, new Promise((resolve) => setTimeout(resolve, 280))]);
      } else {
        await mutationPromise;
      }
      await refreshAll();
    } catch (err) {
      console.error('Failed to ack item:', err);
      showError(err, 'Failed to acknowledge item');
    } finally {
      setDismissingIds((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  const handleUnack = async (id: string) => {
    try {
      await ackItemMutate({ itemId: id, acked: false });
      await refreshAll();
    } catch (err) {
      console.error('Failed to unack item:', err);
      showError(err, 'Failed to un-acknowledge item');
    }
  };

  const handleStar = async (id: string, starred: boolean) => {
    try {
      await starItemMutate({ itemId: id, starred });
      await refreshAll();
    } catch (err) {
      console.error('Failed to star item:', err);
      showError(err, `Failed to ${starred ? 'star' : 'unstar'} item`);
    }
  };

  const handleSetNotes = async (id: string, notes: string) => {
    try {
      await setNotesMutate({ itemId: id, notes });
      await refreshAll();
    } catch (err) {
      console.error('Failed to set notes for item:', id, err);
      showError(err, 'Failed to save notes');
    }
  };

  const handleSubscribe = async (id: string) => {
    try {
      const res = await updateSubscriptionMutate({
        itemId: id,
        state: SubscriptionState.SUBSCRIBED,
      });

      if (queryClient?.setQueriesData) {
        queryClient.setQueriesData({ queryKey: ['connect-query'] }, (oldData: unknown) => {
          const dataObj = oldData as { items?: Item[] } | undefined;
          if (!dataObj || !Array.isArray(dataObj.items)) return oldData;
          return {
            ...dataObj,
            items: dataObj.items.map((it: Item) =>
              it.id === id
                ? (res?.item ?? { ...it, viewerSubscription: SubscriptionState.SUBSCRIBED })
                : it
            ),
          };
        });
      }

      if (queryClient?.invalidateQueries) {
        await queryClient.invalidateQueries();
      }
      await refreshAll();
    } catch (err) {
      console.error('Failed to subscribe to item:', id, err);
      showError(err, 'Failed to subscribe to item on GitHub');
    }
  };

  // From the current result, or fetched directly when it is outside the query.
  const selectedItem = data.selectedItem;

  const [prevSelectedItem, setPrevSelectedItem] = useState<Item | null>(null);
  const [recentItem, setRecentItem] = useState<Item | null>(selectedItem);
  if (selectedItem && selectedItem !== prevSelectedItem) {
    setPrevSelectedItem(selectedItem);
    setRecentItem(selectedItem);
  }

  useEffect(() => {
    if (selectedItemId) {
      viewItemMutate({ itemId: selectedItemId })
        .then(() => refreshAll())
        .catch((err) => console.error('Failed to record view for item:', selectedItemId, err));
    }
  }, [selectedItemId, viewItemMutate, refreshAll]);

  const { focusedItemId, showShortcutsModal, setShowShortcutsModal } = useKeyboardNavigation({
    items,
    selectedItemId,
    onSelectItem: (id) => setFilter('item', id),
    onAckItem: handleAck,
    onStarItem: handleStar,
    isDetailsOpen: Boolean(selectedItemId),
    disabled: showSettings || menus.anyOpen,
  });

  // Determine active workflow shortcut (no secondary filters, type=all, no search text)
  const hasNoSecondaryFilters = !hasActiveChips && filters.type === 'all' && !filters.q.trim();

  if (data.isInitialLoading && !isDisconnected) {
    return (
      <div className="min-h-screen bg-slate-50 dark:bg-slate-950 flex items-center justify-center text-slate-500">
        <div className="animate-pulse flex flex-col items-center">
          <div className="h-4 w-32 bg-slate-200 dark:bg-slate-800 rounded mb-2"></div>
          <div className="text-xs text-slate-500 dark:text-slate-600">Connecting to OctoDeck Daemon...</div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen bg-slate-50 dark:bg-slate-950 text-slate-800 dark:text-slate-100 font-sans antialiased selection:bg-blue-600 selection:text-white">
      {/* Prominent Warning Banner for Backend Disconnection */}
      {isDisconnected && (
        <div
          role="alert"
          data-testid="daemon-disconnected-banner"
          className="bg-red-600 dark:bg-red-700 text-white px-4 py-2.5 flex items-center justify-between gap-3 shadow-md z-30 shrink-0 text-sm font-medium"
        >
          <div className="flex items-center gap-2.5 min-w-0">
            <AlertTriangle className="h-5 w-5 shrink-0 text-white" />
            <span className="truncate">
              Disconnected from OctoDeck daemon. Make sure the local server is running (
              <code className="bg-red-800/80 dark:bg-red-900/80 px-1.5 py-0.5 rounded font-mono text-xs text-white">
                octodeck serve
              </code>
              ).
            </span>
          </div>
          <button
            type="button"
            onClick={async () => {
              await Promise.allSettled([refreshAll(), refetchConfig(), refetchSyncStatus()]);
            }}
            className="px-3 py-1 bg-white text-red-700 hover:bg-red-50 active:bg-red-100 rounded-md text-xs font-bold shrink-0 transition-colors shadow-xs cursor-pointer flex items-center gap-1.5"
          >
            <RefreshCw size={13} className="shrink-0" />
            <span>Reconnect</span>
          </button>
        </div>
      )}

      {/* Top Navigation */}
      <nav className="h-14 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between px-4 bg-white/80 dark:bg-slate-950/80 backdrop-blur sticky top-0 z-40">
        <div className="flex items-center gap-2 shrink-0">
          <img src="/logo.png" alt="OctoDeck logo" className="w-5 h-5 object-contain" />
          <h1 className="font-bold text-base tracking-tight bg-gradient-to-r from-slate-900 to-slate-600 dark:from-white dark:to-slate-400 bg-clip-text text-transparent">
            OctoDeck
          </h1>
        </div>

        {/* Center Search Input */}
        <div className="flex-1 max-w-md mx-auto relative hidden md:block">
          <Search size={14} className="absolute left-3 top-2.5 text-slate-400 dark:text-slate-500" />
          <input
            type="text"
            placeholder="Search title and body..."
            value={filters.q}
            onChange={(e) => setFilter('q', e.target.value, true)}
            className="w-full bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-full py-1.5 pl-9 pr-4 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-slate-800 dark:text-slate-300 placeholder:text-slate-400 dark:placeholder:text-slate-500"
          />
        </div>

        {/* Right Side: Sync Status Display & Hovercard */}
        <div className="flex items-center gap-3 shrink-0">
          <SyncStatusDisplay
            status={syncStatusData?.status}
            isSyncing={isSyncing}
            isDisconnected={isDisconnected}
            onManualSync={handleManualSync}
          />
        </div>
      </nav>

      {/* Settings Modal Dialog */}
      {showSettings && (
        <Settings
          onClose={() => setShowSettings(false)}
          onSave={() => {
            refreshAll();
            refetchConfig();
            refetchSyncStatus();
          }}
          onOpenDebug={() => {
            setShowSettings(false);
            onOpenDebug?.();
          }}
          debugMode={debugMode}
          onToggleDebugMode={handleToggleDebugMode}
          daemonVersion={daemonVersion}
          canSubscribe={hasNotificationsScope}
        />
      )}

      {/* Keyboard Shortcuts Modal */}
      {showShortcutsModal && (
        <KeyboardShortcutsModal
          isOpen={showShortcutsModal}
          onClose={() => setShowShortcutsModal(false)}
        />
      )}

      {/* Main Content Area */}
      <div className="flex flex-1 overflow-hidden relative">
        <DashboardSidebar
          filters={filters}
          hasNoSecondaryFilters={hasNoSecondaryFilters}
          sidebar={data.sidebar}
          repoInboxCounts={data.repoInboxCounts}
          repoHasUnread={data.repoHasUnread}
          totals={data.totals}
          applyWorkflowShortcut={applyWorkflowShortcut}
          toggleRepo={toggleRepo}
          showSettings={showSettings}
          setShowSettings={setShowSettings}
          setShowShortcutsModal={setShowShortcutsModal}
        />

        {/* List Pane */}
        <div className="flex-1 min-w-0 flex flex-col border-r border-slate-200 dark:border-slate-800 relative bg-slate-50 dark:bg-slate-950 overflow-hidden">
          <div className="flex flex-col h-full">
            {/* List Header */}
            <header className="px-6 py-3.5 border-b border-slate-200 dark:border-slate-800 shrink-0 bg-white/80 dark:bg-slate-950/80 backdrop-blur z-10 sticky top-0">
              <div className="flex w-full items-center transition-all duration-300 ease-in-out">
                <div
                  className={`transition-all duration-300 ease-in-out ${
                    selectedItem ? 'w-6 flex-none' : 'flex-1'
                  }`}
                />

                <div className="max-w-4xl w-full shrink-0 space-y-3">
                  <TriageTitleMenu
                    triage={filters.triage}
                    onSelect={(tab) => setFilter('triage', tab)}
                    isOpen={menus.isOpen('status')}
                    onToggle={() => menus.toggle('status')}
                    onClose={() => menus.close()}
                    menuRef={menus.refFor('status')}
                  />

                  <FilterToolbar
                    filters={filters}
                    setFilter={setFilter}
                    setFilters={setFilters}
                    currentUser={currentUser}
                    options={data.options}
                    showAll={{
                      repos: showAllRepos,
                      authors: showAllAuthors,
                      milestones: showAllMilestones,
                      labels: showAllLabels,
                    }}
                    setShowAll={{
                      repos: setShowAllRepos,
                      authors: setShowAllAuthors,
                      milestones: setShowAllMilestones,
                      labels: setShowAllLabels,
                    }}
                    menus={menus}
                  />

                  <ActiveFilterChips
                    filters={filters}
                    extraPredicates={extraPredicates}
                    setFilter={setFilter}
                    removePredicateAt={removePredicateAt}
                    clearSecondaryFilters={clearSecondaryFilters}
                  />
                </div>

                <div className="flex-1" />
              </div>
            </header>

            <div className="flex-1 overflow-y-auto" ref={scrollContainerRef}>
              <div className="flex min-h-full w-full">
                <div
                  className={`transition-all duration-300 ease-in-out ${
                    selectedItem ? 'w-6 flex-none' : 'flex-1'
                  }`}
                />

                <div className="max-w-4xl w-full shrink-0 border-x border-slate-200/70 dark:border-slate-800/50 min-h-full bg-white dark:bg-slate-950">
                  {/* Top of list row: Item count left-aligned, subtle borderless sort control right-aligned */}
                  <div className="flex items-center justify-between px-4 py-2 border-b border-slate-200/70 dark:border-slate-800/40 text-xs select-none">
                    <span className="text-xs text-slate-500 dark:text-slate-400 font-mono">
                      {items.length} {items.length === 1 ? 'item' : 'items'}
                    </span>

                    <SortMenu
                      sort={filters.sort}
                      order={filters.order}
                      onSelectSort={(sort) => setFilter('sort', sort)}
                      onSelectOrder={(order) => setFilter('order', order)}
                      isOpen={menus.isOpen('sort')}
                      onToggle={() => menus.toggle('sort')}
                      onClose={() => menus.close()}
                      menuRef={menus.refFor('sort')}
                    />
                  </div>
                  {data.invalidQuery && (
                    <div
                      role="alert"
                      data-testid="invalid-query"
                      className="m-4 px-3 py-2 text-xs rounded border border-amber-300 dark:border-amber-700/60 bg-amber-50 dark:bg-amber-950/30 text-amber-800 dark:text-amber-300"
                    >
                      Invalid filter: {data.invalidQuery.message}
                    </div>
                  )}
                  {items.map((item) => (
                    <div
                      key={item.id}
                      data-item-id={item.id}
                      className={dismissingIds.has(item.id) ? 'animate-item-ack' : ''}
                    >
                      <PullRequestCard
                        item={item}
                        isSelected={selectedItemId === item.id}
                        isFocused={focusedItemId === item.id}
                        onSelect={() =>
                          setFilter('item', selectedItemId === item.id ? null : item.id)
                        }
                        onAck={handleAck}
                        onUnack={handleUnack}
                        onSubscribe={handleSubscribe}
                        canSubscribe={hasNotificationsScope}
                        showItemId={debugMode}
                        onOpenDebug={debugMode ? onOpenDebug : undefined}
                        grayAckedBackground={filters.triage === 'all'}
                      />
                    </div>
                  ))}
                  {items.length === 0 && isDisconnected ? (
                    <div
                      data-testid="daemon-offline-empty-state"
                      className="p-12 text-center text-red-600 dark:text-red-400 bg-red-50/60 dark:bg-red-950/20 border border-red-200 dark:border-red-900/60 rounded-lg m-6"
                    >
                      <AlertTriangle size={48} className="mx-auto mb-4 text-red-500 dark:text-red-400" />
                      <h3 className="font-bold text-lg mb-2">
                        Daemon Offline — Please start octodeck serve
                      </h3>
                      <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
                        OctoDeck daemon is currently unreachable. Please run{' '}
                        <code className="bg-red-100 dark:bg-red-900/60 px-1 py-0.5 rounded font-mono text-xs">
                          octodeck serve
                        </code>{' '}
                        to start the backend server.
                      </p>
                    </div>
                  ) : items.length === 0 && !data.invalidQuery ? (
                    <div className="p-12 text-center text-slate-400 dark:text-slate-500">
                      <CheckCircle size={48} className="mx-auto mb-4 text-slate-300 dark:text-slate-700" />
                      <p>No items found matching the current filters.</p>
                    </div>
                  ) : null}
                </div>

                <div className="flex-1" />
              </div>
            </div>
          </div>

          {/* Details Pane Overlay */}
          <div
            className={`absolute top-0 right-0 bottom-0 w-[750px] bg-white dark:bg-slate-900 border-l border-slate-200 dark:border-slate-800 shadow-2xl z-30 flex flex-col transition-transform duration-300 ease-in-out ${
              selectedItem
                ? 'translate-x-0 pointer-events-auto'
                : 'translate-x-full pointer-events-none'
            }`}
          >
            {(selectedItem || recentItem) && (
              <DetailsPane
                item={selectedItem || recentItem!}
                onAck={handleAck}
                onUnack={handleUnack}
                onStar={handleStar}
                onSetNotes={handleSetNotes}
                onSubscribe={handleSubscribe}
                canSubscribe={hasNotificationsScope}
                onClose={() => setFilter('item', null)}
                showItemId={debugMode}
                onOpenDebug={debugMode ? onOpenDebug : undefined}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
