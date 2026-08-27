import { useState, useEffect, useRef, useMemo } from 'react';
import {
  ArrowLeft,
  Database,
  Trash2,
  RefreshCw,
  RotateCw,
  LayoutDashboard,
  Activity,
  Sliders,
  AlertCircle,
  CheckCircle2,
  Clock,
  Search,
  Copy,
  Check,
  HardDrive,
  Boxes,
  GitPullRequest,
  Inbox,
} from 'lucide-react';
import { useQuery, useMutation } from '@connectrpc/connect-query';
import {
  getItems,
  getConfig,
  getSyncTraces,
  getDatabaseStats,
  refetchItem,
  deleteItem,
} from '../api/octodeck/v1/service-OctoDeckService_connectquery';
import { client } from '../api/client';
import { type Item, type SyncTrace } from '../api/octodeck/v1/resources_pb';
import { formatExactDateTime, formatCompactTime } from '../utils/time';

interface DataBrowserProps {
  onBack: (targetItemId?: string) => void;
  initialSelectedItemId?: string;
  initialTab?: 'items' | 'traces' | 'database' | 'config';
}

function safeJsonStringify(obj: unknown): string {
  return JSON.stringify(
    obj,
    (_key, value) => (typeof value === 'bigint' ? value.toString() : value),
    2
  );
}

function TraceTypeBadge({ type }: { type: string }) {
  let color = 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 border-slate-300 dark:border-slate-700';
  if (type === 'heartbeat') {
    color = 'bg-blue-100 dark:bg-blue-950/60 text-blue-800 dark:text-blue-300 border-blue-300 dark:border-blue-700/50';
  } else if (type === 'notification_sync') {
    color = 'bg-cyan-100 dark:bg-cyan-950/60 text-cyan-800 dark:text-cyan-300 border-cyan-300 dark:border-cyan-700/50';
  } else if (type === 'inventory') {
    color = 'bg-purple-100 dark:bg-purple-950/60 text-purple-800 dark:text-purple-300 border-purple-300 dark:border-purple-700/50';
  } else if (type === 'refetch') {
    color = 'bg-amber-100 dark:bg-amber-950/60 text-amber-800 dark:text-amber-300 border-amber-300 dark:border-amber-700/50';
  } else if (type === 'backfill') {
    color = 'bg-emerald-100 dark:bg-emerald-950/60 text-emerald-800 dark:text-emerald-300 border-emerald-300 dark:border-emerald-700/50';
  } else if (type === 'garbage_collection') {
    color = 'bg-rose-100 dark:bg-rose-950/60 text-rose-800 dark:text-rose-300 border-rose-300 dark:border-rose-700/50';
  }

  return (
    <span className={`px-2 py-0.5 rounded text-xs font-mono font-bold uppercase border ${color}`}>
      {type}
    </span>
  );
}

interface NotificationSyncPayloadData {
  http_status?: number;
  last_modified?: string;
  notifications_count?: number;
  reasons_breakdown?: Record<string, number>;
  unsupported_types?: Record<string, number>;
  filtered_by_repo_count?: number;
  hydrated_items?: string[];
  hydration_errors?: Record<string, string>;
  error?: string;
}

function parseNotificationSyncPayload(rawPayload?: string): NotificationSyncPayloadData | null {
  if (!rawPayload) return null;
  try {
    return JSON.parse(rawPayload);
  } catch {
    return null;
  }
}

function formatBytes(bytes?: bigint | number | null): string {
  if (bytes === undefined || bytes === null) return '0 B';
  const num = Number(bytes);
  if (isNaN(num) || num <= 0) return '0 B';
  if (num < 1024) return `${num} B`;
  if (num < 1024 * 1024) return `${(num / 1024).toFixed(1)} KB`;
  if (num < 1024 * 1024 * 1024) return `${(num / (1024 * 1024)).toFixed(2)} MB`;
  return `${(num / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function DataBrowser({ onBack, initialSelectedItemId, initialTab = 'items' }: DataBrowserProps) {
  const [activeTab, setActiveTab] = useState<'items' | 'traces' | 'database' | 'config'>(() => {
    if (typeof window !== 'undefined') {
      const searchParams = new URLSearchParams(window.location.search);
      const tabParam = searchParams.get('tab');
      if (tabParam === 'traces' || tabParam === 'database' || tabParam === 'config' || tabParam === 'items') {
        return tabParam;
      }
    }
    return initialTab;
  });

  const handleTabChange = (newTab: 'items' | 'traces' | 'database' | 'config') => {
    setActiveTab(newTab);
    try {
      if (typeof window !== 'undefined' && window.history) {
        const url = new URL(window.location.href);
        if (newTab === 'items') {
          url.searchParams.delete('tab');
        } else {
          url.searchParams.set('tab', newTab);
        }
        window.history.pushState(null, '', url.pathname + url.search);
      }
    } catch (e) {
      console.warn('Failed to update URL tab parameter', e);
    }
  };

  useEffect(() => {
    const handlePopState = () => {
      const searchParams = new URLSearchParams(window.location.search);
      const tabParam = searchParams.get('tab');
      if (tabParam === 'traces' || tabParam === 'database' || tabParam === 'config' || tabParam === 'items') {
        setActiveTab(tabParam);
      } else {
        setActiveTab('items');
      }
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const {
    data: protoItemsData,
    isLoading: isProtoItemsLoading,
    error: protoItemsError,
    refetch: refetchItems,
  } = useQuery(getItems, {});

  const { data: protoConfigData, refetch: refetchConfig } = useQuery(getConfig, {});

  const {
    data: protoTracesData,
    isLoading: isTracesLoading,
    error: tracesError,
    refetch: refetchTraces,
  } = useQuery(getSyncTraces, { limit: 100, includePayload: true });

  const {
    data: protoDbStatsData,
    isLoading: isDbStatsLoading,
    error: dbStatsError,
    refetch: refetchDbStats,
  } = useQuery(getDatabaseStats, {});

  const { mutateAsync: refetchItemMutate } = useMutation(refetchItem);
  const { mutateAsync: deleteItemMutate } = useMutation(deleteItem);

  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [refetchingId, setRefetchingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<{ id: string; message: string } | null>(null);

  const [traceTypeFilter, setTraceTypeFilter] = useState<string>('all');
  const [traceSearchQuery, setTraceSearchQuery] = useState<string>('');
  const [copiedTraceId, setCopiedTraceId] = useState<string | null>(null);
  const [copiedDbPath, setCopiedDbPath] = useState(false);

  const itemRefs = useRef<Record<string, HTMLDetailsElement | null>>({});

  const items: Item[] = useMemo(() => protoItemsData?.items ?? [], [protoItemsData?.items]);
  const traces: SyncTrace[] = useMemo(() => protoTracesData?.traces ?? [], [protoTracesData?.traces]);

  const filteredTraces = useMemo(() => {
    return traces.filter((trace) => {
      if (traceTypeFilter !== 'all' && trace.traceType !== traceTypeFilter) {
        return false;
      }
      if (traceSearchQuery.trim()) {
        const q = traceSearchQuery.toLowerCase();
        const matchesId = trace.id.toLowerCase().includes(q);
        const matchesType = trace.traceType.toLowerCase().includes(q);
        const matchesQuery = (trace.queryString || '').toLowerCase().includes(q);
        const matchesError = (trace.errorMessage || '').toLowerCase().includes(q);
        const matchesSource = trace.triggerSource.toLowerCase().includes(q);
        const matchesRepos = (trace.reposEvaluated || []).some((r) => r.toLowerCase().includes(q));
        if (!matchesId && !matchesType && !matchesQuery && !matchesError && !matchesSource && !matchesRepos) {
          return false;
        }
      }
      return true;
    });
  }, [traces, traceTypeFilter, traceSearchQuery]);

  const handleRefetchItem = async (id: string) => {
    setRefetchingId(id);
    setActionError(null);
    try {
      await refetchItemMutate({ itemId: id });
      await Promise.all([refetchItems(), refetchTraces()]);
    } catch (err) {
      console.error('Failed to refetch item:', err);
      setActionError({ id, message: String(err) });
    } finally {
      setRefetchingId(null);
    }
  };

  const handleDeleteItem = async (id: string) => {
    if (!confirm(`Are you sure you want to delete item ${id}?`)) {
      return;
    }
    setDeletingId(id);
    setActionError(null);
    try {
      await deleteItemMutate({ itemId: id });
      await refetchItems();
    } catch (err) {
      console.error('Failed to delete item:', err);
      setActionError({ id, message: String(err) });
    } finally {
      setDeletingId(null);
    }
  };

  useEffect(() => {
    if (initialSelectedItemId && itemRefs.current[initialSelectedItemId]) {
      const el = itemRefs.current[initialSelectedItemId];
      if (el) {
        el.open = true;
        if (typeof el.scrollIntoView === 'function') {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }
    }
  }, [initialSelectedItemId, items]);

  const handleRefresh = async () => {
    setIsRefreshing(true);
    try {
      await Promise.all([refetchItems(), refetchConfig(), refetchTraces(), refetchDbStats()]);
    } catch (err) {
      console.error('Failed to refresh debug data:', err);
    } finally {
      setIsRefreshing(false);
    }
  };

  const handleForceSync = async () => {
    setIsSyncing(true);
    setSyncError(null);
    try {
      for await (const res of client.sync({})) {
        if (res.message) {
          console.debug('Sync progress:', res.message);
        }
      }
      await Promise.all([refetchTraces(), refetchItems(), refetchDbStats()]);
    } catch (err) {
      console.error('Failed to trigger manual sync from GitHub:', err);
      setSyncError(String(err));
    } finally {
      setIsSyncing(false);
    }
  };

  const handleClearStorage = async () => {
    if (confirm('Are you sure you want to clear client storage and local settings?')) {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        await chrome.storage.local.clear();
      }
      if (typeof localStorage !== 'undefined') {
        localStorage.clear();
      }
      window.location.reload();
    }
  };

  const clientSettings = {
    debugMode:
      typeof localStorage !== 'undefined' &&
      (localStorage.getItem('octodeck_debug_mode') === 'true' ||
        localStorage.getItem('octodeck_debug_show_item_ids') === 'true'),
    showItemIds:
      typeof localStorage !== 'undefined' &&
      (localStorage.getItem('octodeck_debug_mode') === 'true' ||
        localStorage.getItem('octodeck_debug_show_item_ids') === 'true'),
  };

  const handleCopyPayload = (traceId: string, payload: string) => {
    navigator.clipboard.writeText(payload);
    setCopiedTraceId(traceId);
    setTimeout(() => setCopiedTraceId(null), 2000);
  };

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 text-slate-800 dark:text-slate-200 font-sans p-6">
      <header className="max-w-6xl mx-auto flex items-center justify-between mb-6 border-b border-slate-200 dark:border-slate-800 pb-4">
        <div className="flex items-center gap-4">
          <button
            onClick={() => onBack()}
            className="p-2 hover:bg-slate-200 dark:hover:bg-slate-800 rounded-full transition-colors text-slate-700 dark:text-slate-300 cursor-pointer"
            title="Back to Dashboard"
          >
            <ArrowLeft size={20} />
          </button>
          <div className="flex items-center gap-3">
            <Database className="text-blue-600 dark:text-blue-400" />
            <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Debug Data Browser</h1>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleForceSync}
            disabled={isSyncing}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 dark:bg-blue-600 dark:hover:bg-blue-500 text-white rounded text-xs font-medium transition-colors disabled:opacity-50 cursor-pointer shadow-xs"
            title="Trigger GitHub sync in daemon (records a new trace)"
          >
            <RotateCw size={13} className={isSyncing ? 'animate-spin' : ''} />
            {isSyncing ? 'Syncing GitHub...' : 'Sync from GitHub'}
          </button>
          <button
            onClick={handleRefresh}
            disabled={isRefreshing}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 border border-slate-300 dark:border-slate-700 rounded hover:bg-slate-100 dark:hover:bg-slate-700 text-xs font-medium transition-colors disabled:opacity-50 cursor-pointer shadow-xs"
            title="Reload items and traces from local database"
          >
            <RefreshCw size={13} className={isRefreshing ? 'animate-spin' : ''} />
            Refresh Local
          </button>
        </div>
      </header>

      {/* Top Navigation Tabs */}
      <div className="max-w-6xl mx-auto mb-6 flex border-b border-slate-200 dark:border-slate-800 gap-2">
        <button
          onClick={() => handleTabChange('items')}
          className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors cursor-pointer ${
            activeTab === 'items'
              ? 'border-blue-600 dark:border-blue-400 text-blue-600 dark:text-blue-400'
              : 'border-transparent text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
          }`}
        >
          <Database size={16} />
          Cached Items
          <span className="ml-1 px-1.5 py-0.5 rounded-full text-xs bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-300">
            {items.length}
          </span>
        </button>

        <button
          onClick={() => handleTabChange('traces')}
          className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors cursor-pointer ${
            activeTab === 'traces'
              ? 'border-blue-600 dark:border-blue-400 text-blue-600 dark:text-blue-400'
              : 'border-transparent text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
          }`}
        >
          <Activity size={16} />
          Sync Traces (24h)
          <span className="ml-1 px-1.5 py-0.5 rounded-full text-xs bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-300">
            {traces.length}
          </span>
        </button>

        <button
          onClick={() => handleTabChange('database')}
          className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors cursor-pointer ${
            activeTab === 'database'
              ? 'border-blue-600 dark:border-blue-400 text-blue-600 dark:text-blue-400'
              : 'border-transparent text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
          }`}
        >
          <HardDrive size={16} />
          Database Stats
        </button>

        <button
          onClick={() => handleTabChange('config')}
          className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors cursor-pointer ${
            activeTab === 'config'
              ? 'border-blue-600 dark:border-blue-400 text-blue-600 dark:text-blue-400'
              : 'border-transparent text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
          }`}
        >
          <Sliders size={16} />
          Config & Storage
        </button>
      </div>

      <main className="max-w-6xl mx-auto space-y-6">
        {syncError && (
          <div className="p-3 bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 text-xs rounded-lg flex items-center justify-between">
            <span><strong>Sync Error:</strong> {syncError}</span>
            <button onClick={() => setSyncError(null)} className="text-red-500 hover:text-red-700 font-bold ml-2">Dismiss</button>
          </div>
        )}

        {/* TAB 1: CACHED ITEMS */}
        {activeTab === 'items' && (
          <section>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-lg font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider text-xs">
                Cached Items ({items.length})
              </h2>
            </div>

            {isProtoItemsLoading && (
              <div className="p-6 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg text-slate-500 dark:text-slate-400 text-sm animate-pulse">
                Loading items from daemon...
              </div>
            )}

            {protoItemsError && (
              <div className="p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/50 rounded-lg text-red-700 dark:text-red-400 text-sm">
                Failed to load items from daemon: {String(protoItemsError)}
              </div>
            )}

            {!isProtoItemsLoading && items.length === 0 && (
              <div className="p-8 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg text-center text-slate-500 text-sm">
                No items stored in daemon database or local cache.
              </div>
            )}

            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg divide-y divide-slate-200 dark:divide-slate-800 shadow-xs">
              {items.map((item) => {
                const repo = item.repo;
                const isTarget = Boolean(initialSelectedItemId && item.id === initialSelectedItemId);

                return (
                  <details
                    key={item.id}
                    ref={(el) => {
                      itemRefs.current[item.id] = el;
                    }}
                    open={isTarget ? true : undefined}
                    className={`group open:bg-slate-50 dark:open:bg-slate-800/50 transition-colors ${
                      isTarget ? 'ring-1 ring-blue-500/80 bg-blue-50/50 dark:bg-blue-950/20' : ''
                    }`}
                  >
                    <summary className="cursor-pointer p-3 text-sm font-mono flex items-center gap-2 hover:text-blue-600 dark:hover:text-blue-400 outline-none select-none">
                      <span className="font-bold text-slate-800 dark:text-slate-300">{repo || 'unknown/repo'}</span>
                      <span className="text-slate-500">#{item.number}</span>
                      <span className="truncate flex-1 text-slate-600 dark:text-slate-400">{item.title}</span>
                      <span
                        className={`text-xs font-mono ${
                          isTarget
                            ? 'text-blue-600 dark:text-blue-400 font-semibold'
                            : 'text-slate-400 dark:text-slate-500'
                        }`}
                      >
                        ID: {item.id}
                      </span>
                    </summary>
                    <div className="p-4 border-t border-slate-200 dark:border-slate-800/50 bg-slate-50/50 dark:bg-slate-950/30 relative">
                      {/* Action Controls */}
                      <div className="absolute top-3 right-4 flex items-center gap-1 z-10">
                        <a
                          href={`/?item=${encodeURIComponent(item.id)}`}
                          onClick={(e) => {
                            e.preventDefault();
                            onBack(item.id);
                          }}
                          className="px-2 py-1 bg-white dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 text-blue-600 dark:text-blue-300 hover:text-blue-700 dark:hover:text-blue-200 border border-slate-200 dark:border-slate-700/60 rounded transition-colors flex items-center gap-1.5 text-xs font-sans font-medium shadow-xs"
                          title="View in Dashboard"
                        >
                          <LayoutDashboard size={14} />
                          <span>View in Dashboard</span>
                        </a>
                        <button
                          type="button"
                          onClick={() => handleRefetchItem(item.id)}
                          disabled={refetchingId === item.id || deletingId === item.id}
                          className="p-1 text-slate-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-slate-200 dark:hover:bg-slate-800 rounded transition-colors disabled:opacity-50 cursor-pointer"
                          title="Refetch item"
                        >
                          <RefreshCw size={14} className={refetchingId === item.id ? 'animate-spin' : ''} />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDeleteItem(item.id)}
                          disabled={deletingId === item.id || refetchingId === item.id}
                          className="p-1 text-slate-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-slate-200 dark:hover:bg-slate-800 rounded transition-colors disabled:opacity-50 cursor-pointer"
                          title="Delete item"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>

                      {actionError && actionError.id === item.id && (
                        <div className="mb-4 p-2 bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 text-xs rounded">
                          {actionError.message}
                        </div>
                      )}

                      <div className="space-y-4">
                        <div className="grid grid-cols-2 gap-4">
                          <div>
                            <h4 className="text-xs font-bold text-slate-500 mb-1">Local State</h4>
                            <pre className="text-[10px] text-blue-700 dark:text-blue-300 font-mono bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-transparent p-2 rounded">
                              {safeJsonStringify(item.local)}
                            </pre>
                          </div>
                          <div>
                            <h4 className="text-xs font-bold text-slate-500 mb-1">Sub-resources</h4>
                            <div className="text-[11px] text-slate-700 dark:text-slate-300 font-mono bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-transparent p-2 rounded space-y-1">
                              <div>Comments: {item.comments?.length ?? 0}</div>
                              <div>Commits: {item.commits?.length ?? 0}</div>
                              <div>Reviews: {item.reviews?.length ?? 0}</div>
                              <div>Assignees: {item.assignees?.length ?? 0}</div>
                              <div>Author: {item.author?.login ?? 'unknown'}</div>
                            </div>
                          </div>
                        </div>

                        <div>
                          <h4 className="text-xs font-bold text-slate-500 mb-1">Full Protobuf Item Data</h4>
                          <pre className="text-[10px] text-slate-600 dark:text-slate-400 font-mono bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-transparent p-2 rounded max-h-96 overflow-auto">
                            {safeJsonStringify(item)}
                          </pre>
                        </div>
                      </div>
                    </div>
                  </details>
                );
              })}
            </div>
          </section>
        )}

        {/* TAB 2: SYNC TRACES */}
        {activeTab === 'traces' && (
          <section className="space-y-4">
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">Type:</span>
                {['all', 'notification_sync', 'heartbeat', 'inventory', 'refetch', 'backfill', 'garbage_collection'].map((t) => (
                  <button
                    key={t}
                    onClick={() => setTraceTypeFilter(t)}
                    className={`px-2.5 py-1 rounded text-xs font-medium transition cursor-pointer capitalize ${
                      traceTypeFilter === t
                        ? 'bg-blue-600 text-white'
                        : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-800 hover:bg-slate-100 dark:hover:bg-slate-800'
                    }`}
                  >
                    {t.replace('_', ' ')}
                  </button>
                ))}
              </div>

              <div className="relative w-full sm:w-64">
                <Search className="absolute left-2.5 top-2 text-slate-400" size={14} />
                <input
                  type="text"
                  placeholder="Search traces..."
                  value={traceSearchQuery}
                  onChange={(e) => setTraceSearchQuery(e.target.value)}
                  className="w-full pl-8 pr-3 py-1.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded text-xs text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>
            </div>

            {isTracesLoading && (
              <div className="p-6 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg text-slate-500 dark:text-slate-400 text-sm animate-pulse">
                Loading synchronization traces...
              </div>
            )}

            {tracesError && (
              <div className="p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/50 rounded-lg text-red-700 dark:text-red-400 text-sm">
                Failed to load sync traces: {String(tracesError)}
              </div>
            )}

            {!isTracesLoading && filteredTraces.length === 0 && (
              <div className="p-8 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg text-center text-slate-500 text-sm">
                No sync traces found matching the current filters.
              </div>
            )}

            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg divide-y divide-slate-200 dark:divide-slate-800 shadow-xs">
              {filteredTraces.map((trace) => {
                const isError = Boolean(trace.errorMessage);
                const isNotifSync = trace.traceType === 'notification_sync';
                const notifPayload = isNotifSync ? parseNotificationSyncPayload(trace.rawPayload) : null;

                return (
                  <details
                    key={trace.id}
                    className="group open:bg-slate-50 dark:open:bg-slate-800/50 transition-colors"
                  >
                    <summary className="cursor-pointer p-3 text-xs font-mono flex flex-wrap items-center gap-3 hover:text-blue-600 dark:hover:text-blue-400 outline-none select-none">
                      <TraceTypeBadge type={trace.traceType} />
                      <span className="text-slate-500 font-sans font-medium">via {trace.triggerSource}</span>
                      <span className="text-slate-400 dark:text-slate-500 flex items-center gap-1 font-sans" title={formatExactDateTime(trace.createdAt)}>
                        <Clock size={12} />
                        {formatCompactTime(trace.createdAt)}
                      </span>
                      <span className="text-slate-600 dark:text-slate-400 font-mono">{trace.durationMs}ms</span>
                      {isNotifSync && notifPayload ? (
                        notifPayload.http_status === 304 ? (
                          <span
                            className="px-2 py-0.5 rounded text-[11px] font-mono font-semibold bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border border-slate-300 dark:border-slate-700"
                            data-testid="status-304"
                          >
                            304 Not Modified
                          </span>
                        ) : (
                          <span
                            className="px-2 py-0.5 rounded text-[11px] font-mono font-semibold bg-emerald-100 dark:bg-emerald-950/60 text-emerald-800 dark:text-emerald-300 border border-emerald-300 dark:border-emerald-700/50"
                            data-testid="status-200"
                          >
                            {notifPayload.http_status ?? 200} OK ({notifPayload.notifications_count ?? trace.itemsFetched} notifs)
                          </span>
                        )
                      ) : (
                        <span className="text-slate-600 dark:text-slate-400">
                          {trace.itemsFetched} fetched / {trace.itemsPersisted} saved
                        </span>
                      )}
                      <div className="ml-auto flex items-center gap-2">
                        {isError ? (
                          <span className="flex items-center gap-1 text-red-600 dark:text-red-400 font-sans font-medium text-xs">
                            <AlertCircle size={14} /> Error
                          </span>
                        ) : (
                          <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400 font-sans font-medium text-xs">
                            <CheckCircle2 size={14} /> OK
                          </span>
                        )}
                        <span className="text-[11px] text-slate-400 truncate max-w-[140px]">{trace.id}</span>
                      </div>
                    </summary>

                    <div className="p-4 border-t border-slate-200 dark:border-slate-800/50 bg-slate-50/50 dark:bg-slate-950/30 space-y-4 text-xs">
                      {trace.errorMessage && (
                        <div className="p-3 bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 rounded font-mono">
                          <strong>Error:</strong> {trace.errorMessage}
                        </div>
                      )}

                      {/* Notification Sync Specific Metrics Card */}
                      {isNotifSync && notifPayload && (
                        <div className="p-3 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md space-y-3">
                          <div className="flex flex-wrap items-center gap-4 text-xs">
                            <div>
                              <span className="font-bold text-slate-500 mr-1.5">HTTP Status:</span>
                              <span className="font-mono font-semibold">{notifPayload.http_status ?? 200}</span>
                            </div>
                            {notifPayload.last_modified && (
                              <div>
                                <span className="font-bold text-slate-500 mr-1.5">Last-Modified:</span>
                                <span className="font-mono text-slate-600 dark:text-slate-400">{notifPayload.last_modified}</span>
                              </div>
                            )}
                            <div>
                              <span className="font-bold text-slate-500 mr-1.5">Notifications Received:</span>
                              <span className="font-mono">{notifPayload.notifications_count ?? 0}</span>
                            </div>
                            {Number(notifPayload.filtered_by_repo_count) > 0 && (
                              <div>
                                <span className="font-bold text-slate-500 mr-1.5">Filtered Non-Tracked Repos:</span>
                                <span className="font-mono text-slate-600 dark:text-slate-400">{notifPayload.filtered_by_repo_count}</span>
                              </div>
                            )}
                          </div>

                          {notifPayload.reasons_breakdown && Object.keys(notifPayload.reasons_breakdown).length > 0 && (
                            <div>
                              <span className="font-bold text-slate-500 block mb-1">Reasons Breakdown:</span>
                              <div className="flex flex-wrap gap-1.5" data-testid="reasons-breakdown">
                                {Object.entries(notifPayload.reasons_breakdown).map(([reason, count]) => (
                                  <span
                                    key={reason}
                                    className="px-2 py-0.5 bg-blue-50 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800/50 rounded font-mono text-[11px]"
                                  >
                                    {reason}: {count}
                                  </span>
                                ))}
                              </div>
                            </div>
                          )}

                          {notifPayload.unsupported_types && Object.keys(notifPayload.unsupported_types).length > 0 && (
                            <div>
                              <span className="font-bold text-slate-500 block mb-1">Unsupported Types:</span>
                              <div className="flex flex-wrap gap-1.5" data-testid="unsupported-types">
                                {Object.entries(notifPayload.unsupported_types).map(([uType, count]) => (
                                  <span
                                    key={uType}
                                    className="px-2 py-0.5 bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-700 rounded font-mono text-[11px]"
                                  >
                                    {uType}: {count}
                                  </span>
                                ))}
                              </div>
                            </div>
                          )}

                          {notifPayload.hydrated_items && notifPayload.hydrated_items.length > 0 && (
                            <div>
                              <span className="font-bold text-slate-500 block mb-1">
                                Hydrated Items ({notifPayload.hydrated_items.length}):
                              </span>
                              <div className="flex flex-wrap gap-1.5 font-mono text-[11px] text-slate-700 dark:text-slate-300">
                                {notifPayload.hydrated_items.map((itemId) => (
                                  <span
                                    key={itemId}
                                    className="px-2 py-0.5 bg-slate-100 dark:bg-slate-800 rounded border border-slate-200 dark:border-slate-700"
                                  >
                                    {itemId}
                                  </span>
                                ))}
                              </div>
                            </div>
                          )}

                          {notifPayload.hydration_errors && Object.keys(notifPayload.hydration_errors).length > 0 && (
                            <div>
                              <span className="font-bold text-red-600 dark:text-red-400 block mb-1">Hydration Errors:</span>
                              <div className="space-y-1 font-mono text-[11px] text-red-700 dark:text-red-300">
                                {Object.entries(notifPayload.hydration_errors).map(([id, errMsg]) => (
                                  <div key={id} className="p-1.5 bg-red-50 dark:bg-red-950/30 rounded border border-red-200 dark:border-red-800/50">
                                    <span className="font-bold">{id}:</span> {errMsg}
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      )}

                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div className="space-y-2">
                          <div>
                            <span className="font-bold text-slate-500 block mb-1">Query:</span>
                            <pre className="font-mono text-blue-700 dark:text-blue-300 bg-slate-100 dark:bg-slate-900 p-2 rounded break-all whitespace-pre-wrap">
                              {trace.queryString || '(none)'}
                            </pre>
                          </div>
                          <div>
                            <span className="font-bold text-slate-500 block mb-1">Since Cutoff:</span>
                            <span className="font-mono text-slate-700 dark:text-slate-300">
                              {trace.sinceTimestamp || '(none)'}
                            </span>
                          </div>
                        </div>

                        <div className="space-y-2">
                          <div>
                            <span className="font-bold text-slate-500 block mb-1">Evaluated Repositories:</span>
                            <div className="flex flex-wrap gap-1">
                              {trace.reposEvaluated && trace.reposEvaluated.length > 0 ? (
                                trace.reposEvaluated.map((r) => (
                                  <span
                                    key={r}
                                    className="px-2 py-0.5 bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-300 rounded font-mono text-[11px]"
                                  >
                                    {r}
                                  </span>
                                ))
                              ) : (
                                <span className="text-slate-400">(none)</span>
                              )}
                            </div>
                          </div>
                          {trace.rateLimitRemaining !== undefined && trace.rateLimitRemaining !== 0 && (
                            <div>
                              <span className="font-bold text-slate-500 block mb-1">Rate Limit Remaining:</span>
                              <span className="font-mono text-slate-700 dark:text-slate-300">
                                {trace.rateLimitRemaining}
                              </span>
                            </div>
                          )}
                        </div>
                      </div>

                      {trace.rawPayload && (
                        <div>
                          <div className="flex items-center justify-between mb-1">
                            <span className="font-bold text-slate-500">Raw Request / Response Payload</span>
                            <button
                              type="button"
                              onClick={() => handleCopyPayload(trace.id, trace.rawPayload)}
                              className="flex items-center gap-1 text-slate-500 hover:text-blue-600 dark:hover:text-blue-400 text-[11px] cursor-pointer"
                            >
                              {copiedTraceId === trace.id ? (
                                <>
                                  <Check size={12} className="text-emerald-500" /> Copied
                                </>
                              ) : (
                                <>
                                  <Copy size={12} /> Copy Payload
                                </>
                              )}
                            </button>
                          </div>
                          <pre className="text-[10px] text-slate-700 dark:text-slate-300 font-mono bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-transparent p-3 rounded max-h-72 overflow-auto">
                            {trace.rawPayload}
                          </pre>
                        </div>
                      )}
                    </div>
                  </details>
                );
              })}
            </div>
          </section>
        )}

        {/* TAB 3: DATABASE STATS */}
        {activeTab === 'database' && (
          <section className="space-y-6">
            <div>
              <h2 className="text-lg font-bold text-slate-500 dark:text-slate-400 mb-3 uppercase tracking-wider text-xs">
                Local Database & Storage Overview
              </h2>
            </div>

            {isDbStatsLoading && (
              <div className="p-6 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg text-slate-500 dark:text-slate-400 text-sm animate-pulse">
                Loading database statistics...
              </div>
            )}

            {dbStatsError && (
              <div className="p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/50 rounded-lg text-red-700 dark:text-red-400 text-sm">
                Failed to load database statistics: {String(dbStatsError)}
              </div>
            )}

            {protoDbStatsData?.stats && (
              <div className="space-y-6">
                {/* KPI Metrics Grid */}
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                  {/* Total Items */}
                  <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-xs">
                    <div className="flex items-center justify-between text-slate-500 dark:text-slate-400 text-xs font-medium mb-1">
                      <span>Total Items</span>
                      <Boxes size={16} className="text-blue-500" />
                    </div>
                    <div className="text-2xl font-bold font-mono text-slate-900 dark:text-white">
                      {protoDbStatsData.stats.totalItems.toString()}
                    </div>
                    <div className="text-xs text-slate-500 dark:text-slate-400 mt-2 flex items-center gap-2">
                      <span className="text-emerald-600 dark:text-emerald-400 font-medium">
                        {protoDbStatsData.stats.openItems.toString()} open
                      </span>
                      <span>·</span>
                      <span className="text-slate-500">
                        {protoDbStatsData.stats.closedItems.toString()} closed
                      </span>
                    </div>
                  </div>

                  {/* Types Breakdown */}
                  <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-xs">
                    <div className="flex items-center justify-between text-slate-500 dark:text-slate-400 text-xs font-medium mb-1">
                      <span>Item Types</span>
                      <GitPullRequest size={16} className="text-purple-500" />
                    </div>
                    <div className="text-2xl font-bold font-mono text-slate-900 dark:text-white">
                      {protoDbStatsData.stats.prItems.toString()}
                    </div>
                    <div className="text-xs text-slate-500 dark:text-slate-400 mt-2 flex items-center gap-2">
                      <span>PRs: {protoDbStatsData.stats.prItems.toString()}</span>
                      <span>·</span>
                      <span>Issues: {protoDbStatsData.stats.issueItems.toString()}</span>
                    </div>
                  </div>

                  {/* Triage State */}
                  <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-xs">
                    <div className="flex items-center justify-between text-slate-500 dark:text-slate-400 text-xs font-medium mb-1">
                      <span>Triage State</span>
                      <Inbox size={16} className="text-orange-500" />
                    </div>
                    <div className="text-2xl font-bold font-mono text-slate-900 dark:text-white">
                      {protoDbStatsData.stats.unackedItems.toString()}
                    </div>
                    <div className="text-xs text-slate-500 dark:text-slate-400 mt-2 flex items-center gap-2">
                      <span className="text-orange-600 dark:text-orange-400 font-medium">
                        {protoDbStatsData.stats.unackedItems.toString()} inbox
                      </span>
                      <span>·</span>
                      <span className="text-slate-500">
                        {protoDbStatsData.stats.ackedItems.toString()} acked
                      </span>
                    </div>
                  </div>

                  {/* Database Size */}
                  <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-xs">
                    <div className="flex items-center justify-between text-slate-500 dark:text-slate-400 text-xs font-medium mb-1">
                      <span>Database File Size</span>
                      <HardDrive size={16} className="text-cyan-500" />
                    </div>
                    <div className="text-2xl font-bold font-mono text-slate-900 dark:text-white">
                      {formatBytes(protoDbStatsData.stats.dbSizeBytes)}
                    </div>
                    <div className="text-xs text-slate-500 dark:text-slate-400 mt-2">
                      <span>SQLite Local Storage</span>
                    </div>
                  </div>
                </div>

                {/* Storage Details Table */}
                <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 shadow-xs">
                  <h3 className="text-sm font-semibold text-slate-900 dark:text-white mb-4">
                    Storage & Schema Metadata
                  </h3>
                  <div className="divide-y divide-slate-100 dark:divide-slate-800 text-xs">
                    <div className="py-2.5 flex items-center justify-between">
                      <span className="text-slate-500 dark:text-slate-400">Database File Path</span>
                      <div className="flex items-center gap-2">
                        <code className="font-mono bg-slate-100 dark:bg-slate-800 px-2 py-1 rounded text-slate-800 dark:text-slate-200">
                          {protoDbStatsData.stats.dbPath || 'In-Memory'}
                        </code>
                        {protoDbStatsData.stats.dbPath && (
                          <button
                            type="button"
                            onClick={() => {
                              navigator.clipboard.writeText(protoDbStatsData.stats!.dbPath);
                              setCopiedDbPath(true);
                              setTimeout(() => setCopiedDbPath(false), 2000);
                            }}
                            className="p-1 hover:bg-slate-100 dark:hover:bg-slate-800 rounded text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 transition cursor-pointer"
                            title="Copy Path"
                          >
                            {copiedDbPath ? <Check size={14} className="text-emerald-500" /> : <Copy size={14} />}
                          </button>
                        )}
                      </div>
                    </div>

                    <div className="py-2.5 flex items-center justify-between">
                      <span className="text-slate-500 dark:text-slate-400">Distinct Repositories Cached</span>
                      <span className="font-mono font-medium text-slate-800 dark:text-slate-200">
                        {protoDbStatsData.stats.totalRepos.toString()}
                      </span>
                    </div>

                    <div className="py-2.5 flex items-center justify-between">
                      <span className="text-slate-500 dark:text-slate-400">Sync Traces Retained (24h)</span>
                      <span className="font-mono font-medium text-slate-800 dark:text-slate-200">
                        {protoDbStatsData.stats.totalTraces.toString()}
                      </span>
                    </div>

                    <div className="py-2.5 flex items-center justify-between">
                      <span className="text-slate-500 dark:text-slate-400">Data Retention & Pruning</span>
                      <span className="text-slate-600 dark:text-slate-300 text-right">
                        Traces pruned after 24h · Closed items pruned after 90d
                      </span>
                    </div>
                  </div>
                </div>

                {/* Client Storage & Reset */}
                <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 shadow-xs">
                  <div className="flex items-center justify-between">
                    <div>
                      <h3 className="text-sm font-semibold text-slate-900 dark:text-white flex items-center gap-2">
                        <Trash2 size={16} className="text-red-500" />
                        Clear Client Storage
                      </h3>
                      <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                        Clear local browser settings, cached filters, UI preferences, and extension local storage.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={handleClearStorage}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 border border-red-200 dark:border-red-900/50 rounded hover:bg-red-100 dark:hover:bg-red-900/40 text-xs font-medium transition-colors cursor-pointer shadow-xs shrink-0"
                    >
                      <Trash2 size={13} />
                      Clear Storage
                    </button>
                  </div>
                </div>
              </div>
            )}
          </section>
        )}

        {/* TAB 4: CONFIG & STORAGE */}
        {activeTab === 'config' && (
          <section className="space-y-6">
            {protoConfigData?.config && (
              <div>
                <h2 className="text-lg font-bold text-slate-500 dark:text-slate-400 mb-3 uppercase tracking-wider text-xs">
                  Daemon Configuration
                </h2>
                <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-4 shadow-xs">
                  <pre className="text-xs text-blue-700 dark:text-blue-300 font-mono overflow-auto max-h-64">
                    {safeJsonStringify(protoConfigData.config)}
                  </pre>
                </div>
              </div>
            )}

            <div>
              <h2 className="text-lg font-bold text-slate-500 dark:text-slate-400 mb-3 uppercase tracking-wider text-xs">
                Client Settings & Storage
              </h2>
              <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-4 shadow-xs">
                <pre className="text-xs text-emerald-700 dark:text-green-400 font-mono overflow-auto max-h-64">
                  {safeJsonStringify(clientSettings)}
                </pre>
              </div>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
