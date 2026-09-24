import { useState, useEffect, useMemo, useCallback } from 'react';
import { useQuery, useMutation } from '@connectrpc/connect-query';
import { useQueryClient } from '@tanstack/react-query';
import { getConfig, updateConfig } from './api/octodeck/v1/service-OctoDeckService_connectquery';
import { Save, CheckCircle, AlertCircle, AlertTriangle, RefreshCw, X, Settings as SettingsIcon, Terminal, Sun, Moon, Monitor, ChevronDown, ChevronUp, Plus, Pencil, Trash2, Bell } from 'lucide-react';
import type { Config, TrackedQueryWarning } from './api/octodeck/v1/service_pb';
import {
  DEFAULT_POLLING_INTERVAL_MIN,
  DEFAULT_AUTO_ACK_OWN_ACTIVITY,
  DEFAULT_DISCOVERY_INTERVAL_MIN,
  MIN_DISCOVERY_INTERVAL_MIN,
} from './utils/constants';
import { useTheme } from './context/ThemeContext';
import { useToast } from './context/ToastContext';
import { validateLabelFilterPatterns } from './utils/labels';
import {
  validateRepoFilterPatterns,
  parseFilterPatterns,
  serializeFilterPatterns,
} from './utils/repos';

const SCOPE_QUALIFIER_REGEX = /(?:^|[\s(])(?:(?:org|user):[^\s)]+|repo:[^\s)/]+\/[^\s)]+)/i;

function validateSingleTrackedQuery(raw: string): string | null {
  const q = raw.trim();
  if (!q) {
    return 'Search query cannot be empty.';
  }
  if (q.includes('\0')) {
    return 'Search query cannot contain null characters.';
  }
  if (/(?:^|[\s(])(?:-)?updated:/i.test(q)) {
    return "Discovery queries cannot contain an 'updated' filter.";
  }
  if (!SCOPE_QUALIFIER_REGEX.test(q)) {
    return `Query "${q}" must include a positive scope qualifier ('repo:owner/name', 'org:name', or 'user:name') to prevent unbounded searches.`;
  }
  if (q.length > 500) {
    return 'Search query cannot exceed 500 characters.';
  }
  return null;
}

export interface SettingsProps {
  onClose?: () => void;
  onSave?: () => void;
  onOpenDebug?: () => void;
  debugMode?: boolean;
  onToggleDebugMode?: (enabled: boolean) => void;
  showItemIds?: boolean;
  onToggleShowItemIds?: (enabled: boolean) => void;
  daemonVersion?: string;
  canSubscribe?: boolean;
}

function getInitialKnownBots(bots?: string[]): string {
  if (bots && bots.length > 0) {
    return bots.join('\n');
  }
  return '';
}

function getInitialTrackedQueriesList(queries?: string[]): string[] {
  if (queries && queries.length > 0) {
    return queries.map((q) => q.trim()).filter(Boolean);
  }
  return [];
}

export function Settings({
  onClose,
  onSave,
  onOpenDebug,
  debugMode,
  onToggleDebugMode,
  showItemIds,
  onToggleShowItemIds,
  daemonVersion,
  canSubscribe = true,
}: SettingsProps) {
  const queryClient = useQueryClient();
  const { data, isLoading, isError, refetch } = useQuery(getConfig, {});
  const { mutateAsync: updateConfigMutate, isPending: isSaving } = useMutation(updateConfig);
  const { theme, setTheme } = useTheme();
  const { showError } = useToast();

  const [localDebugMode, setLocalDebugMode] = useState<boolean>(() => {
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

  const effectiveDebugMode =
    debugMode !== undefined
      ? debugMode
      : showItemIds !== undefined
        ? showItemIds
        : localDebugMode;

  const handleToggleDebugMode = (enabled: boolean) => {
    if (onToggleDebugMode) {
      onToggleDebugMode(enabled);
    } else if (onToggleShowItemIds) {
      onToggleShowItemIds(enabled);
    } else {
      try {
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem('octodeck_debug_mode', String(enabled));
          localStorage.setItem('octodeck_debug_show_item_ids', String(enabled));
        }
      } catch (err) {
        console.error('Failed to save debug mode preference to localStorage:', err);
      }
      setLocalDebugMode(enabled);
    }
  };

  const [pollingInterval, setPollingInterval] = useState(
    data?.config?.pollingIntervalMin || DEFAULT_POLLING_INTERVAL_MIN
  );

  const initialRepoPatterns = serializeFilterPatterns(
    data?.config?.watchedRepos,
    data?.config?.excludedRepos
  );
  const [repoPatterns, setRepoPatterns] = useState(initialRepoPatterns);
  const [repoValidationError, setRepoValidationError] = useState<string | null>(null);

  const [pinnedRepos, setPinnedRepos] = useState((data?.config?.pinnedRepos || []).join('\n'));
  const [knownBots, setKnownBots] = useState(getInitialKnownBots(data?.config?.knownBots));
  const [autoAckOwnActivity, setAutoAckOwnActivity] = useState(
    data?.config?.autoAckOwnActivity ?? DEFAULT_AUTO_ACK_OWN_ACTIVITY
  );

  const initialLabelPatterns = serializeFilterPatterns(
    data?.config?.includedLabels,
    data?.config?.excludedLabels
  );
  const [labelPatterns, setLabelPatterns] = useState(initialLabelPatterns);
  const [labelValidationError, setLabelValidationError] = useState<string | null>(null);

  const [trackedQueriesList, setTrackedQueriesList] = useState<string[]>(() =>
    getInitialTrackedQueriesList(data?.config?.trackedQueries)
  );
  const [autoSubscribeQueries, setAutoSubscribeQueries] = useState<string[]>(() =>
    getInitialTrackedQueriesList(data?.config?.autoSubscribeQueries)
  );
  const [queriesValidationError, setQueriesValidationError] = useState<string | null>(null);
  const [queryEditorModal, setQueryEditorModal] = useState<{
    mode: 'add' | 'edit';
    index?: number;
    value: string;
    autoSubscribe: boolean;
    error: string | null;
  } | null>(null);

  const queryStatsMap = useMemo(() => {
    const map = new Map<string, { avg7d: number; avg30d: number }>();
    for (const s of data?.queryStats || []) {
      if (s.query) {
        map.set(s.query.trim(), {
          avg7d: Number(s.dailyAverage7d ?? 0),
          avg30d: Number(s.dailyAverage30d ?? 0),
        });
      }
    }
    return map;
  }, [data?.queryStats]);

  const [discoveryInterval, setDiscoveryInterval] = useState<number | string>(
    data?.config?.discoveryIntervalMin || DEFAULT_DISCOVERY_INTERVAL_MIN
  );
  const [discoveryIntervalError, setDiscoveryIntervalError] = useState<string | null>(null);

  const [status, setStatus] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);
  const [showDefaultsConfirm, setShowDefaultsConfirm] = useState(false);
  const [pendingQueryWarnings, setPendingQueryWarnings] = useState<TrackedQueryWarning[]>([]);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const [prevConfig, setPrevConfig] = useState(data?.config);
  if (data?.config && data.config !== prevConfig) {
    setPrevConfig(data.config);
    const cfg = data.config;
    setPollingInterval(cfg.pollingIntervalMin || DEFAULT_POLLING_INTERVAL_MIN);

    setRepoPatterns(serializeFilterPatterns(cfg.watchedRepos, cfg.excludedRepos));
    setRepoValidationError(null);

    setPinnedRepos((cfg.pinnedRepos || []).join('\n'));
    setKnownBots(getInitialKnownBots(cfg.knownBots));
    setAutoAckOwnActivity(cfg.autoAckOwnActivity ?? DEFAULT_AUTO_ACK_OWN_ACTIVITY);

    setLabelPatterns(serializeFilterPatterns(cfg.includedLabels, cfg.excludedLabels));
    setLabelValidationError(null);

    setTrackedQueriesList(getInitialTrackedQueriesList(cfg.trackedQueries));
    setAutoSubscribeQueries(getInitialTrackedQueriesList(cfg.autoSubscribeQueries));
    setQueriesValidationError(null);

    setDiscoveryInterval(cfg.discoveryIntervalMin || DEFAULT_DISCOVERY_INTERVAL_MIN);
    setDiscoveryIntervalError(null);
  }

  const isDirty = useMemo(() => {
    const savedPolling = data?.config?.pollingIntervalMin || DEFAULT_POLLING_INTERVAL_MIN;
    const savedRepoPatterns = serializeFilterPatterns(
      data?.config?.watchedRepos,
      data?.config?.excludedRepos
    );
    const savedPinned = (data?.config?.pinnedRepos || []).join('\n');
    const savedBots = getInitialKnownBots(data?.config?.knownBots);
    const savedAutoAck = data?.config?.autoAckOwnActivity ?? DEFAULT_AUTO_ACK_OWN_ACTIVITY;
    const savedLabelPatterns = serializeFilterPatterns(
      data?.config?.includedLabels,
      data?.config?.excludedLabels
    );
    const savedTrackedQueries = getInitialTrackedQueriesList(data?.config?.trackedQueries);
    const savedAutoSubscribeQueries = new Set(
      getInitialTrackedQueriesList(data?.config?.autoSubscribeQueries)
    );
    const savedDiscoveryInterval =
      data?.config?.discoveryIntervalMin || DEFAULT_DISCOVERY_INTERVAL_MIN;

    const queriesChanged =
      trackedQueriesList.length !== savedTrackedQueries.length ||
      trackedQueriesList.some((q, i) => q !== savedTrackedQueries[i]);

    const currentAutoSubscribeList = trackedQueriesList.filter((q) =>
      autoSubscribeQueries.includes(q.trim())
    );
    const autoSubChanged =
      currentAutoSubscribeList.length !== savedAutoSubscribeQueries.size ||
      currentAutoSubscribeList.some((q) => !savedAutoSubscribeQueries.has(q.trim()));

    return (
      Number(pollingInterval) !== savedPolling ||
      repoPatterns !== savedRepoPatterns ||
      pinnedRepos !== savedPinned ||
      knownBots !== savedBots ||
      autoAckOwnActivity !== savedAutoAck ||
      labelPatterns !== savedLabelPatterns ||
      queriesChanged ||
      autoSubChanged ||
      Number(discoveryInterval) !== savedDiscoveryInterval
    );
  }, [
    data?.config,
    pollingInterval,
    repoPatterns,
    pinnedRepos,
    knownBots,
    autoAckOwnActivity,
    labelPatterns,
    trackedQueriesList,
    autoSubscribeQueries,
    discoveryInterval,
  ]);

  const handleRequestClose = useCallback(() => {
    if (isDirty) {
      setShowDiscardConfirm(true);
    } else {
      onClose?.();
    }
  }, [isDirty, onClose]);

  const handleConfirmDiscard = () => {
    setShowDiscardConfirm(false);
    onClose?.();
  };

  const handleConfirmResetDefaults = () => {
    setPollingInterval(DEFAULT_POLLING_INTERVAL_MIN);
    setRepoPatterns('');
    setRepoValidationError(null);
    setPinnedRepos('');
    setKnownBots((data?.config?.knownBots || []).join('\n'));
    setAutoAckOwnActivity(DEFAULT_AUTO_ACK_OWN_ACTIVITY);
    setLabelPatterns('');
    setLabelValidationError(null);
    setTrackedQueriesList([]);
    setAutoSubscribeQueries([]);
    setQueriesValidationError(null);
    setDiscoveryInterval(DEFAULT_DISCOVERY_INTERVAL_MIN);
    setDiscoveryIntervalError(null);
    setShowDefaultsConfirm(false);
    setStatus({ type: 'success', message: 'Default values restored. Click Save to persist.' });
  };

  const handleConfirmQueryModal = () => {
    if (!queryEditorModal) return;
    const trimmed = queryEditorModal.value.trim();
    const err = validateSingleTrackedQuery(trimmed);
    if (err) {
      setQueryEditorModal({ ...queryEditorModal, error: err });
      return;
    }
    if (queryEditorModal.mode === 'add') {
      setTrackedQueriesList((prev) => (prev.includes(trimmed) ? prev : [...prev, trimmed]));
      setAutoSubscribeQueries((prev) => {
        if (queryEditorModal.autoSubscribe) {
          return prev.includes(trimmed) ? prev : [...prev, trimmed];
        }
        return prev.filter((q) => q !== trimmed);
      });
    } else if (queryEditorModal.mode === 'edit' && queryEditorModal.index !== undefined) {
      const oldQuery = trackedQueriesList[queryEditorModal.index!]?.trim();
      setTrackedQueriesList((prev) => {
        const next = [...prev];
        next[queryEditorModal.index!] = trimmed;
        return Array.from(new Set(next));
      });
      setAutoSubscribeQueries((prev) => {
        const filtered = prev.filter((q) => q !== oldQuery && q !== trimmed);
        if (queryEditorModal.autoSubscribe) {
          return [...filtered, trimmed];
        }
        return filtered;
      });
    }
    setQueriesValidationError(null);
    setQueryEditorModal(null);
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        if (queryEditorModal) {
          setQueryEditorModal(null);
        } else if (pendingQueryWarnings.length > 0) {
          setPendingQueryWarnings([]);
        } else if (showDefaultsConfirm) {
          setShowDefaultsConfirm(false);
        } else if (showDiscardConfirm) {
          setShowDiscardConfirm(false);
        } else {
          handleRequestClose();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    queryEditorModal,
    pendingQueryWarnings.length,
    showDefaultsConfirm,
    showDiscardConfirm,
    handleRequestClose,
  ]);

  useEffect(() => {
    if (status) {
      const timer = setTimeout(() => setStatus(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [status]);

  const handleSave = async (forceSave = false) => {
    try {
      const repoValidationErr = validateRepoFilterPatterns(repoPatterns);
      if (repoValidationErr) {
        setRepoValidationError(repoValidationErr);
        setStatus({ type: 'error', message: repoValidationErr });
        return;
      }
      setRepoValidationError(null);

      const labelValidationErr = validateLabelFilterPatterns(labelPatterns);
      if (labelValidationErr) {
        setLabelValidationError(labelValidationErr);
        setStatus({ type: 'error', message: labelValidationErr });
        return;
      }
      setLabelValidationError(null);

      // Validate Tracked Queries
      const rawQueries = trackedQueriesList.map((q) => q.trim()).filter(Boolean);
      for (const q of rawQueries) {
        const qErr = validateSingleTrackedQuery(q);
        if (qErr) {
          setQueriesValidationError(qErr);
          setStatus({ type: 'error', message: qErr });
          return;
        }
      }
      setQueriesValidationError(null);

      // Validate Discovery Interval
      const parsedDiscoveryInterval = Number(discoveryInterval);
      if (isNaN(parsedDiscoveryInterval) || parsedDiscoveryInterval < MIN_DISCOVERY_INTERVAL_MIN) {
        const err = `Discovery interval must be at least ${MIN_DISCOVERY_INTERVAL_MIN} minute.`;
        setDiscoveryIntervalError(err);
        setStatus({ type: 'error', message: err });
        return;
      }
      setDiscoveryIntervalError(null);

      const parsedRepos = parseFilterPatterns(repoPatterns);
      const parsedLabels = parseFilterPatterns(labelPatterns);
      const dedupedQueries = Array.from(new Set(rawQueries));
      const dedupedAutoSubscribeQueries = dedupedQueries.filter((q) =>
        autoSubscribeQueries.includes(q)
      );

      const currentCfg = data?.config;
      const newConfig = {
        ...currentCfg,
        pollingIntervalMin: Number(pollingInterval),
        watchedRepos: parsedRepos.includes,
        excludedRepos: parsedRepos.excludes,
        pinnedRepos: pinnedRepos.split('\n').map(s => s.trim()).filter(Boolean),
        knownBots: knownBots.split('\n').map(s => s.trim()).filter(Boolean),
        autoAckOwnActivity,
        includedLabels: parsedLabels.includes,
        excludedLabels: parsedLabels.excludes,
        trackedQueries: dedupedQueries,
        autoSubscribeQueries: dedupedAutoSubscribeQueries,
        discoveryIntervalMin: Math.max(MIN_DISCOVERY_INTERVAL_MIN, Math.round(parsedDiscoveryInterval)),
      };

      const res = await updateConfigMutate({
        config: newConfig as Partial<Config> as Config,
        ...(forceSave ? { forceSave: true } : {}),
      });

      if (res?.queryWarnings && res.queryWarnings.length > 0 && !res.saved) {
        setPendingQueryWarnings(res.queryWarnings);
        return;
      }
      setPendingQueryWarnings([]);
      if (res?.config) {
        setAutoSubscribeQueries(getInitialTrackedQueriesList(res.config.autoSubscribeQueries));
      }

      if (queryClient?.invalidateQueries) {
        await queryClient.invalidateQueries();
      }
      if (queryClient?.refetchQueries) {
        await queryClient.refetchQueries({ type: 'active' });
      }
      onSave?.();
      if (onClose) {
        onClose();
      } else {
        setStatus({ type: 'success', message: 'Configuration saved!' });
      }
    } catch (err) {
      console.error(err);
      setStatus({ type: 'error', message: 'Failed to save configuration.' });
      showError(err, 'Failed to save configuration');
    }
  };

  if (isLoading) {
    return (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 bg-slate-950/50 dark:bg-slate-950/80 backdrop-blur-xs overflow-y-auto"
        onClick={(e) => {
          if (e.target === e.currentTarget) {
            onClose?.();
          }
        }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
      >
        <div className="w-full max-w-2xl my-auto bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-2xl overflow-hidden flex flex-col">
          <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between shrink-0 bg-slate-50/50 dark:bg-slate-900">
            <h2 id="settings-title" className="text-lg font-bold text-slate-900 dark:text-white flex items-center gap-2">
              <SettingsIcon size={18} className="text-blue-600 dark:text-blue-400" />
              <span>Settings</span>
            </h2>
            <button
              onClick={onClose}
              className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors p-1 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800"
              aria-label="Close settings"
            >
              <X size={18} />
            </button>
          </div>
          <div className="p-12 flex flex-col items-center justify-center text-slate-500 dark:text-slate-400">
            <RefreshCw size={24} className="animate-spin text-blue-600 dark:text-blue-400 mb-2" />
            <p className="text-xs">Loading daemon configuration...</p>
          </div>
        </div>
      </div>
    );
  }

  if (isError) {
    return (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 bg-slate-950/50 dark:bg-slate-950/80 backdrop-blur-xs overflow-y-auto"
        onClick={(e) => {
          if (e.target === e.currentTarget) {
            onClose?.();
          }
        }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
      >
        <div className="w-full max-w-2xl my-auto bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-2xl overflow-hidden flex flex-col">
          <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between shrink-0 bg-slate-50/50 dark:bg-slate-900">
            <h2 id="settings-title" className="text-lg font-bold text-slate-900 dark:text-white flex items-center gap-2">
              <SettingsIcon size={18} className="text-blue-600 dark:text-blue-400" />
              <span>Settings</span>
            </h2>
            <button
              onClick={onClose}
              className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors p-1 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800"
              aria-label="Close settings"
            >
              <X size={18} />
            </button>
          </div>
          <div className="p-8 text-center text-red-600 dark:text-red-400">
            <AlertCircle size={32} className="mx-auto mb-2" />
            <p className="font-semibold text-sm">Failed to load configuration from daemon</p>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">Make sure the OctoDeck backend is running.</p>
            <button
              type="button"
              onClick={() => refetch()}
              className="mt-4 px-4 py-1.5 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 rounded-lg text-xs font-medium transition cursor-pointer"
            >
              Retry
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 bg-slate-950/50 dark:bg-slate-950/80 backdrop-blur-xs overflow-y-auto"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          handleRequestClose();
        }
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-title"
    >
      <div className="w-full max-w-2xl my-auto bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between shrink-0 bg-slate-50/50 dark:bg-slate-900">
          <div>
            <h2 id="settings-title" className="text-lg font-bold text-slate-900 dark:text-white flex items-center gap-2">
              <SettingsIcon size={18} className="text-blue-600 dark:text-blue-400" />
              <span>Settings</span>
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              Manage your local OctoDeck daemon settings and GitHub synchronization preferences
            </p>
          </div>
          <button
            onClick={handleRequestClose}
            className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors p-1 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
            aria-label="Close settings"
          >
            <X size={18} />
          </button>
        </div>

        {/* Scrollable Content */}
        <div className="p-6 space-y-6 overflow-y-auto min-h-0 flex-1">
          {/* Appearance Section */}
          <div>
            <h3 className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-3">
              Appearance
            </h3>
            <div className="grid grid-cols-3 gap-3" role="radiogroup" aria-label="Theme selection">
              <button
                type="button"
                role="radio"
                aria-checked={theme === 'system'}
                onClick={() => setTheme('system')}
                className={`p-3 rounded-lg border text-left flex flex-col gap-2 transition-colors cursor-pointer ${
                  theme === 'system'
                    ? 'border-blue-500 bg-blue-50/60 dark:bg-blue-950/40 text-blue-950 dark:text-blue-200 ring-1 ring-blue-500/50 shadow-xs'
                    : 'border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-800/40 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300'
                }`}
              >
                <div className="flex items-center justify-between w-full">
                  <Monitor size={18} className={theme === 'system' ? 'text-blue-600 dark:text-blue-400' : 'text-slate-500 dark:text-slate-400'} />
                  {theme === 'system' && <span className="w-2 h-2 rounded-full bg-blue-600 dark:bg-blue-400"></span>}
                </div>
                <div>
                  <div className="text-sm font-semibold">System</div>
                  <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">Match OS preference</div>
                </div>
              </button>

              <button
                type="button"
                role="radio"
                aria-checked={theme === 'light'}
                onClick={() => setTheme('light')}
                className={`p-3 rounded-lg border text-left flex flex-col gap-2 transition-colors cursor-pointer ${
                  theme === 'light'
                    ? 'border-blue-500 bg-blue-50/60 dark:bg-blue-950/40 text-blue-950 dark:text-blue-200 ring-1 ring-blue-500/50 shadow-xs'
                    : 'border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-800/40 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300'
                }`}
              >
                <div className="flex items-center justify-between w-full">
                  <Sun size={18} className={theme === 'light' ? 'text-blue-600 dark:text-blue-400' : 'text-slate-500 dark:text-slate-400'} />
                  {theme === 'light' && <span className="w-2 h-2 rounded-full bg-blue-600 dark:bg-blue-400"></span>}
                </div>
                <div>
                  <div className="text-sm font-semibold">Light</div>
                  <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">GitHub Light</div>
                </div>
              </button>

              <button
                type="button"
                role="radio"
                aria-checked={theme === 'dark'}
                onClick={() => setTheme('dark')}
                className={`p-3 rounded-lg border text-left flex flex-col gap-2 transition-colors cursor-pointer ${
                  theme === 'dark'
                    ? 'border-blue-500 bg-blue-50/60 dark:bg-blue-950/40 text-blue-950 dark:text-blue-200 ring-1 ring-blue-500/50 shadow-xs'
                    : 'border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-800/40 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300'
                }`}
              >
                <div className="flex items-center justify-between w-full">
                  <Moon size={18} className={theme === 'dark' ? 'text-blue-600 dark:text-blue-400' : 'text-slate-500 dark:text-slate-400'} />
                  {theme === 'dark' && <span className="w-2 h-2 rounded-full bg-blue-600 dark:bg-blue-400"></span>}
                </div>
                <div>
                  <div className="text-sm font-semibold">Dark</div>
                  <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">GitHub Dark</div>
                </div>
              </button>
            </div>
          </div>

          {/* Repository Filters Section */}
          <div className="pt-6 border-t border-slate-200 dark:border-slate-800 space-y-4">
            {/* Repository Filters Textarea */}
            <div>
              <label htmlFor="repoPatterns" className="block text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1">
                Repository Filters
              </label>
              <textarea
                id="repoPatterns"
                className={`w-full p-2.5 bg-white dark:bg-slate-800 border rounded-lg text-slate-900 dark:text-slate-200 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition placeholder-slate-400 dark:placeholder-slate-500 font-mono text-xs ${
                  repoValidationError ? 'border-red-500 dark:border-red-500 ring-1 ring-red-500/50' : 'border-slate-300 dark:border-slate-700'
                }`}
                placeholder="kubernetes/*&#10;!kubernetes/steering&#10;golang/*"
                rows={4}
                value={repoPatterns}
                onChange={(e) => {
                  setRepoPatterns(e.target.value);
                  setRepoValidationError(null);
                }}
              />
              {repoValidationError ? (
                <p className="text-xs text-red-600 dark:text-red-400 mt-1 flex items-center gap-1">
                  <AlertCircle size={13} className="shrink-0" />
                  <span>{repoValidationError}</span>
                </p>
              ) : (
                <p className="text-xs text-slate-500 dark:text-slate-500 mt-1">
                  Enter one pattern per line. Prefix lines with <code className="font-mono bg-slate-100 dark:bg-slate-800 px-1 py-0.5 rounded text-[11px]">!</code> to exclude. Use <code className="font-mono bg-slate-100 dark:bg-slate-800 px-1 py-0.5 rounded text-[11px]">*</code> as a wildcard (e.g., <code className="font-mono bg-slate-100 dark:bg-slate-800 px-1 py-0.5 rounded text-[11px]">kubernetes/*</code>, <code className="font-mono bg-slate-100 dark:bg-slate-800 px-1 py-0.5 rounded text-[11px]">!kubernetes/steering</code>).
                </p>
              )}
            </div>

            <div>
              <label htmlFor="pinnedRepos" className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                Pinned Repositories
              </label>
              <textarea
                id="pinnedRepos"
                className="w-full p-2.5 bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-900 dark:text-slate-200 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition placeholder-slate-400 dark:placeholder-slate-500 font-mono text-xs"
                placeholder="kubernetes/community"
                rows={3}
                value={pinnedRepos}
                onChange={(e) => setPinnedRepos(e.target.value)}
              />
              <p className="text-xs text-slate-500 dark:text-slate-500 mt-1">
                Repositories always visible in the sidebar navigation.
              </p>
            </div>

            <div>
              <label htmlFor="knownBots" className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                Known Bots
              </label>
              <textarea
                id="knownBots"
                className="w-full p-2.5 bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-900 dark:text-slate-200 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition placeholder-slate-400 dark:placeholder-slate-500 font-mono text-xs"
                placeholder="k8s-ci-robot&#10;fejta-bot"
                rows={4}
                value={knownBots}
                onChange={(e) => setKnownBots(e.target.value)}
              />
              <p className="text-xs text-slate-500 dark:text-slate-500 mt-1">
                Usernames treated as automated bots. Their comments will be grouped in timelines.
              </p>
            </div>

            <div>
              <label className="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={autoAckOwnActivity}
                  onChange={(e) => setAutoAckOwnActivity(e.target.checked)}
                  className="form-checkbox mt-0.5 h-4 w-4 text-blue-600 rounded border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 focus:ring-blue-500"
                />
                <div>
                  <span className="text-sm font-medium text-slate-700 dark:text-slate-300 block">
                    Auto-Ack items when last action was by me
                  </span>
                  <span className="text-xs text-slate-500 dark:text-slate-500 block mt-0.5">
                    Automatically archive items where your own comment or action was the most recent non-bot event.
                  </span>
                </div>
              </label>
            </div>
          </div>

          {/* Label Filters Section */}
          <div className="pt-6 border-t border-slate-200 dark:border-slate-800">
            <div>
              <label htmlFor="labelPatterns" className="block text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1">
                Label Filters
              </label>
              <textarea
                id="labelPatterns"
                className={`w-full p-2.5 bg-white dark:bg-slate-800 border rounded-lg text-slate-900 dark:text-slate-200 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition placeholder-slate-400 dark:placeholder-slate-500 font-mono text-xs ${
                  labelValidationError ? 'border-red-500 dark:border-red-500 ring-1 ring-red-500/50' : 'border-slate-300 dark:border-slate-700'
                }`}
                placeholder="size/*&#10;sig/*&#10;!kind/flake"
                rows={4}
                value={labelPatterns}
                onChange={(e) => {
                  setLabelPatterns(e.target.value);
                  setLabelValidationError(null);
                }}
              />
              {labelValidationError ? (
                <p className="text-xs text-red-600 dark:text-red-400 mt-1 flex items-center gap-1">
                  <AlertCircle size={13} className="shrink-0" />
                  <span>{labelValidationError}</span>
                </p>
              ) : (
                <p className="text-xs text-slate-500 dark:text-slate-500 mt-1">
                  Enter one pattern per line. Prefix lines with <code className="font-mono bg-slate-100 dark:bg-slate-800 px-1 py-0.5 rounded text-[11px]">!</code> to exclude. Use <code className="font-mono bg-slate-100 dark:bg-slate-800 px-1 py-0.5 rounded text-[11px]">*</code> and <code className="font-mono bg-slate-100 dark:bg-slate-800 px-1 py-0.5 rounded text-[11px]">?</code> as wildcards (e.g., <code className="font-mono bg-slate-100 dark:bg-slate-800 px-1 py-0.5 rounded text-[11px]">size/*</code>, <code className="font-mono bg-slate-100 dark:bg-slate-800 px-1 py-0.5 rounded text-[11px]">!kind/flake</code>).
                </p>
              )}
            </div>
          </div>

          {/* Discovery Queries Section */}
          <div className="pt-6 border-t border-slate-200 dark:border-slate-800">
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="block text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                  Discovery Queries
                </span>
                <button
                  type="button"
                  onClick={() =>
                    setQueryEditorModal({
                      mode: 'add',
                      value: '',
                      autoSubscribe: false,
                      error: null,
                    })
                  }
                  aria-label="Add discovery query"
                  className="inline-flex items-center gap-1 px-2.5 py-1 bg-blue-50 dark:bg-blue-950/40 hover:bg-blue-100 dark:hover:bg-blue-900/50 text-blue-600 dark:text-blue-400 border border-blue-200 dark:border-blue-800/60 rounded-lg text-xs font-semibold transition-colors cursor-pointer"
                >
                  <Plus size={14} />
                  <span>Add Query</span>
                </button>
              </div>

              {trackedQueriesList.length === 0 ? (
                <div className="p-3.5 rounded-lg border border-dashed border-slate-300 dark:border-slate-700 bg-slate-50/50 dark:bg-slate-800/30 text-center text-xs text-slate-500 dark:text-slate-400">
                  No discovery queries configured. Click <span className="font-semibold">+ Add Query</span> to periodically discover candidate items.
                </div>
              ) : (
                <ul className="space-y-2" aria-label="Discovery Queries List">
                  {trackedQueriesList.map((q, idx) => {
                    const trimmedQ = q.trim();
                    const stats = queryStatsMap.get(trimmedQ) ?? { avg7d: 0, avg30d: 0 };
                    const avg7dText = `${stats.avg7d.toFixed(1)}/day`;
                    const avg30dTooltip = `30-day avg: ${stats.avg30d.toFixed(1)}/day`;
                    const isAutoSub = autoSubscribeQueries.includes(trimmedQ);
                    const autoSubTooltip = !canSubscribe
                      ? "Auto-subscribe enabled — Missing GitHub 'notifications' scope. Run 'gh auth refresh -s notifications' to enable auto-subscribe."
                      : 'Auto-subscribe on discover enabled';
                    return (
                      <li
                        key={`${idx}-${q}`}
                        className="flex items-center justify-between gap-3 p-2.5 bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700/80 rounded-lg"
                      >
                        <span className="font-mono text-xs text-slate-800 dark:text-slate-200 break-all flex-1">
                          {q}
                        </span>
                        <div className="flex items-center gap-2 shrink-0">
                          <div
                            className="relative group/qstat inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-slate-200/70 dark:bg-slate-700/70 text-slate-700 dark:text-slate-300 cursor-default select-none"
                            aria-label={`7-day average ${avg7dText} (${avg30dTooltip})`}
                          >
                            <span>{avg7dText} (7d)</span>
                            <div
                              role="tooltip"
                              className="pointer-events-none invisible opacity-0 group-hover/qstat:visible group-hover/qstat:opacity-100 transition-opacity duration-150 absolute bottom-full right-0 mb-1.5 px-2 py-1 rounded bg-slate-900 dark:bg-slate-800 text-white text-[11px] font-normal whitespace-nowrap shadow-lg border border-slate-700 z-20"
                            >
                              {avg30dTooltip}
                            </div>
                          </div>
                          {isAutoSub && (
                            <span
                              data-testid={`query-autosubscribe-${idx}`}
                              aria-label={autoSubTooltip}
                              className={`relative group/autosub inline-flex items-center p-1.5 rounded-md cursor-default ${
                                !canSubscribe
                                  ? 'text-amber-500 dark:text-amber-400 opacity-75'
                                  : 'text-blue-600 dark:text-blue-400'
                              }`}
                            >
                              <Bell size={14} />
                              <div
                                role="tooltip"
                                className={`pointer-events-none invisible opacity-0 group-hover/autosub:visible group-hover/autosub:opacity-100 transition-opacity duration-150 absolute bottom-full right-0 mb-1.5 px-2 py-1 rounded bg-slate-900 dark:bg-slate-800 text-white text-[11px] font-normal shadow-lg border border-slate-700 z-20 ${
                                  !canSubscribe ? 'w-max max-w-xs whitespace-normal text-left' : 'whitespace-nowrap'
                                }`}
                              >
                                {autoSubTooltip}
                              </div>
                            </span>
                          )}
                          <button
                            type="button"
                            onClick={() =>
                              setQueryEditorModal({
                                mode: 'edit',
                                index: idx,
                                value: q,
                                autoSubscribe: isAutoSub,
                                error: null,
                              })
                            }
                            aria-label={`Edit query ${q}`}
                            title="Edit query"
                            className="p-1.5 text-slate-500 hover:text-blue-600 dark:text-slate-400 dark:hover:text-blue-400 hover:bg-slate-200/60 dark:hover:bg-slate-700/60 rounded-md transition-colors cursor-pointer"
                          >
                            <Pencil size={14} />
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setTrackedQueriesList((prev) => prev.filter((_, i) => i !== idx));
                              setAutoSubscribeQueries((prev) => prev.filter((item) => item !== trimmedQ));
                              setQueriesValidationError(null);
                            }}
                            aria-label={`Remove query ${q}`}
                            title="Remove query"
                            className="p-1.5 text-slate-500 hover:text-red-600 dark:text-slate-400 dark:hover:text-red-400 hover:bg-slate-200/60 dark:hover:bg-slate-700/60 rounded-md transition-colors cursor-pointer"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}

              {queriesValidationError ? (
                <p className="text-xs text-red-600 dark:text-red-400 mt-1.5 flex items-center gap-1">
                  <AlertCircle size={13} className="shrink-0" />
                  <span>{queriesValidationError}</span>
                </p>
              ) : (
                <p className="text-xs text-slate-500 dark:text-slate-500 mt-1.5">
                  Periodically search GitHub to surface matching issues and pull requests outside your notification stream.
                </p>
              )}
            </div>
          </div>

          {/* Developer Tools / Debug Browser (Visible outside Advanced when onOpenDebug provided) */}
          {onOpenDebug && (
            <div className="pt-6 border-t border-slate-200 dark:border-slate-800">
              <h3 className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-4">
                Developer Tools
              </h3>
              <div className="flex items-center justify-between p-3.5 bg-slate-50 dark:bg-slate-800/40 border border-slate-200 dark:border-slate-800 rounded-lg">
                <div>
                  <div className="text-sm font-medium text-slate-700 dark:text-slate-300">Debug Data Browser</div>
                  <div className="text-xs text-slate-500 dark:text-slate-500 mt-0.5">Inspect raw cached items, sync traces, database storage, and configuration</div>
                </div>
                <button
                  type="button"
                  onClick={onOpenDebug}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-white dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 border border-slate-200 dark:border-slate-700 rounded-lg text-xs font-medium transition-colors cursor-pointer"
                >
                  <Terminal size={14} />
                  <span>Open Browser</span>
                </button>
              </div>
            </div>
          )}

          {/* Advanced Section (Collapsed by default, at the bottom) */}
          <div className="pt-6 border-t border-slate-200 dark:border-slate-800">
            <button
              type="button"
              onClick={() => setShowAdvanced(!showAdvanced)}
              aria-expanded={showAdvanced}
              className="w-full flex items-center justify-between text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider cursor-pointer hover:text-slate-700 dark:hover:text-slate-200 transition-colors select-none"
            >
              <span>Advanced</span>
              {showAdvanced ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
            </button>

            {showAdvanced && (
              <div className="mt-4 space-y-4">
                {/* Polling Interval */}
                <div>
                  <label htmlFor="pollingInterval" className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                    Polling Interval (minutes)
                  </label>
                  <input
                    id="pollingInterval"
                    type="number"
                    min="1"
                    max="120"
                    className="w-full p-2.5 bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-900 dark:text-slate-200 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition text-sm"
                    value={pollingInterval}
                    onChange={(e) => setPollingInterval(Number(e.target.value))}
                  />
                  <p className="text-xs text-slate-500 dark:text-slate-500 mt-1">
                    Interval for background polling of GitHub notifications.
                  </p>
                </div>

                {/* Discovery Interval */}
                <div>
                  <label htmlFor="discoveryInterval" className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                    Discovery Interval (minutes)
                  </label>
                  <input
                    id="discoveryInterval"
                    type="number"
                    min="1"
                    className={`w-full p-2.5 bg-white dark:bg-slate-800 border rounded-lg text-slate-900 dark:text-slate-200 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition text-sm ${
                      discoveryIntervalError ? 'border-red-500 dark:border-red-500 ring-1 ring-red-500/50' : 'border-slate-300 dark:border-slate-700'
                    }`}
                    value={discoveryInterval}
                    onChange={(e) => {
                      setDiscoveryInterval(e.target.value);
                      setDiscoveryIntervalError(null);
                    }}
                  />
                  {discoveryIntervalError ? (
                    <p className="text-xs text-red-600 dark:text-red-400 mt-1 flex items-center gap-1">
                      <AlertCircle size={13} className="shrink-0" />
                      <span>{discoveryIntervalError}</span>
                    </p>
                  ) : (
                    <p className="text-xs text-slate-500 dark:text-slate-500 mt-1">
                      Interval for periodic background discovery of candidate items matching tracked queries (default: 10 minutes, minimum: 1 minute).
                    </p>
                  )}
                </div>

                {/* Enable Debug Mode */}
                <div>
                  <label className="flex items-start gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={effectiveDebugMode}
                      onChange={(e) => handleToggleDebugMode(e.target.checked)}
                      className="form-checkbox mt-0.5 h-4 w-4 text-blue-600 rounded border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 focus:ring-blue-500"
                    />
                    <div>
                      <span className="text-sm font-medium text-slate-700 dark:text-slate-300 block">
                        Enable Debug Mode
                      </span>
                      <span className="text-xs text-slate-500 dark:text-slate-500 block mt-0.5">
                        Display internal item IDs on dashboard cards.
                      </span>
                    </div>
                  </label>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Footer with Version, Status, Defaults Link, and Action Buttons */}
        {(() => {
          const effectiveDaemonVersion = daemonVersion || (typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev');
          return (
            <div className="px-6 py-4 border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900 flex flex-col sm:flex-row sm:items-center justify-between gap-3 shrink-0">
              <div className="flex flex-wrap items-center gap-3 min-w-0">
                <button
                  type="button"
                  onClick={() => setShowDefaultsConfirm(true)}
                  className="text-xs text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 underline underline-offset-2 transition-colors cursor-pointer shrink-0"
                >
                  Restore defaults
                </button>
                <span className="text-slate-300 dark:text-slate-700 hidden sm:inline">•</span>
                <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400" data-testid="settings-versions-container">
                  <span>
                    Version: <code className="font-mono text-slate-700 dark:text-slate-300">{effectiveDaemonVersion}</code>
                  </span>
                </div>
                {status && (
                  <div
                    className={`flex items-center gap-1.5 text-xs font-medium truncate ${
                      status.type === 'success' ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'
                    }`}
                  >
                    {status.type === 'error' ? <AlertCircle size={14} className="shrink-0" /> : <CheckCircle size={14} className="shrink-0" />}
                    <span className="truncate">{status.message}</span>
                  </div>
                )}
              </div>

              <div className="flex items-center gap-3 shrink-0">
                <button
                  type="button"
                  onClick={handleRequestClose}
                  className="px-4 py-2 text-xs font-medium text-slate-600 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200 transition-colors cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void handleSave(false)}
                  disabled={isSaving}
                  className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-xs font-semibold shadow-xs transition-colors cursor-pointer disabled:opacity-50"
                >
                  {isSaving ? <RefreshCw size={14} className="animate-spin" /> : <Save size={14} />}
                  <span>{isSaving ? 'Saving...' : 'Save Settings'}</span>
                </button>
              </div>
            </div>
          );
        })()}

        {/* Add / Edit Discovery Query Modal */}
        {queryEditorModal && (
          <div
            data-testid="query-editor-modal"
            className="fixed inset-0 z-60 flex items-center justify-center p-4 bg-slate-950/60 backdrop-blur-xs"
            role="dialog"
            aria-modal="true"
            aria-labelledby="query-editor-title"
          >
            <div className="w-full max-w-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-2xl p-6">
              <div className="flex items-center justify-between mb-3">
                <h3 id="query-editor-title" className="text-base font-bold text-slate-900 dark:text-white">
                  {queryEditorModal.mode === 'add' ? 'Add Discovery Query' : 'Edit Discovery Query'}
                </h3>
                <button
                  type="button"
                  onClick={() => setQueryEditorModal(null)}
                  aria-label="Close query editor"
                  className="p-1 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 rounded-lg transition-colors cursor-pointer"
                >
                  <X size={18} />
                </button>
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400 mb-3">
                Each query must include a scope qualifier (<code className="font-mono bg-slate-100 dark:bg-slate-800 px-1 py-0.5 rounded text-[11px]">repo:owner/name</code>, <code className="font-mono bg-slate-100 dark:bg-slate-800 px-1 py-0.5 rounded text-[11px]">org:name</code>, or <code className="font-mono bg-slate-100 dark:bg-slate-800 px-1 py-0.5 rounded text-[11px]">user:name</code>).
              </p>
              <div>
                <label htmlFor="queryEditorInput" className="sr-only">
                  Discovery Query
                </label>
                <input
                  id="queryEditorInput"
                  type="text"
                  autoFocus
                  value={queryEditorModal.value}
                  onChange={(e) =>
                    setQueryEditorModal({
                      ...queryEditorModal,
                      value: e.target.value,
                      error: null,
                    })
                  }
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      handleConfirmQueryModal();
                    }
                  }}
                  placeholder="repo:kubernetes/kubernetes is:open label:sig/node"
                  className={`w-full p-2.5 bg-white dark:bg-slate-800 border rounded-lg text-slate-900 dark:text-slate-200 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition placeholder-slate-400 dark:placeholder-slate-500 font-mono text-xs ${
                    queryEditorModal.error
                      ? 'border-red-500 dark:border-red-500 ring-1 ring-red-500/50'
                      : 'border-slate-300 dark:border-slate-700'
                  }`}
                />
                {queryEditorModal.error && (
                  <p className="text-xs text-red-600 dark:text-red-400 mt-2 flex items-start gap-1.5">
                    <AlertCircle size={14} className="shrink-0 mt-0.5" />
                    <span>{queryEditorModal.error}</span>
                  </p>
                )}
              </div>
              <div className="mt-4 pt-3 border-t border-slate-200 dark:border-slate-800">
                <div className="relative group/modalautosub">
                  <label
                    htmlFor="queryEditorAutoSubscribe"
                    className={`flex items-start gap-3 ${
                      !canSubscribe && !queryEditorModal.autoSubscribe
                        ? 'opacity-60 cursor-not-allowed'
                        : 'cursor-pointer'
                    }`}
                  >
                    <input
                      id="queryEditorAutoSubscribe"
                      data-testid="query-editor-autosubscribe-checkbox"
                      type="checkbox"
                      checked={queryEditorModal.autoSubscribe}
                      disabled={!canSubscribe && !queryEditorModal.autoSubscribe}
                      onChange={(e) =>
                        setQueryEditorModal({
                          ...queryEditorModal,
                          autoSubscribe: e.target.checked,
                        })
                      }
                      className="form-checkbox mt-0.5 h-4 w-4 text-blue-600 rounded border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 focus:ring-blue-500 disabled:cursor-not-allowed"
                    />
                    <div>
                      <span className="text-sm font-medium text-slate-700 dark:text-slate-300 flex items-center gap-1.5">
                        <Bell size={13} className="text-blue-600 dark:text-blue-400 shrink-0" />
                        <span>Auto-subscribe on discover</span>
                      </span>
                      <span className="text-xs text-slate-500 dark:text-slate-400 block mt-0.5">
                        Automatically subscribe on GitHub to newly discovered items matching this query.
                      </span>
                      {!canSubscribe && (
                        <span
                          role="tooltip"
                          className="text-xs text-amber-600 dark:text-amber-400 block mt-1"
                        >
                          Missing GitHub &apos;notifications&apos; scope. Run &apos;gh auth refresh -s notifications&apos; to enable auto-subscribe.
                        </span>
                      )}
                    </div>
                  </label>
                </div>
              </div>
              <div className="flex items-center justify-end gap-3 mt-5">
                <button
                  type="button"
                  onClick={() => setQueryEditorModal(null)}
                  className="px-4 py-2 text-xs font-medium text-slate-700 dark:text-slate-300 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg transition-colors cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleConfirmQueryModal}
                  className="px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg shadow-xs transition-colors cursor-pointer"
                >
                  {queryEditorModal.mode === 'add' ? 'Add Query' : 'Save Query'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* High-Volume Discovery Query Pre-Flight Warning Modal */}
        {pendingQueryWarnings.length > 0 && (
          <div
            className="fixed inset-0 z-60 flex items-center justify-center p-4 bg-slate-950/60 backdrop-blur-xs"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="query-warning-title"
          >
            <div className="w-full max-w-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-2xl p-6">
              <div className="w-12 h-12 rounded-full bg-amber-50 dark:bg-amber-950/50 text-amber-600 dark:text-amber-400 flex items-center justify-center mx-auto mb-4 border border-amber-200 dark:border-amber-800/60">
                <AlertTriangle size={24} />
              </div>
              <h3 id="query-warning-title" className="text-base font-bold text-slate-900 dark:text-white text-center">
                High-Volume Discovery Query Detected
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-2 text-center">
                One or more discovery queries exceeded the recommended safety threshold of 50 newly created items per day (evaluated over the last 48 hours):
              </p>
              <ul className="mt-4 space-y-2 max-h-48 overflow-y-auto text-left">
                {pendingQueryWarnings.map((w) => (
                  <li
                    key={w.query}
                    className="p-2.5 rounded-lg bg-amber-50/70 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800/60 text-xs"
                  >
                    <div className="font-mono font-semibold text-slate-900 dark:text-slate-200 break-all">
                      {w.query}
                    </div>
                    <div className="text-amber-800 dark:text-amber-300 mt-1">
                      {w.matchCount48h} items created in last 48h (~{Number(w.dailyAverage).toFixed(1)}/day avg)
                    </div>
                  </li>
                ))}
              </ul>
              <div className="flex items-center justify-center gap-3 mt-6">
                <button
                  type="button"
                  onClick={() => {
                    const firstWarning = pendingQueryWarnings[0];
                    setPendingQueryWarnings([]);
                    if (firstWarning?.query) {
                      const idx = trackedQueriesList.findIndex(
                        (q) => q.trim() === firstWarning.query.trim()
                      );
                      if (idx !== -1) {
                        setQueryEditorModal({
                          mode: 'edit',
                          index: idx,
                          value: trackedQueriesList[idx],
                          autoSubscribe: autoSubscribeQueries.includes(
                            trackedQueriesList[idx].trim()
                          ),
                          error: null,
                        });
                      }
                    }
                  }}
                  className="px-4 py-2 text-xs font-medium text-slate-700 dark:text-slate-300 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg transition-colors cursor-pointer"
                >
                  Edit Query
                </button>
                <button
                  type="button"
                  disabled={isSaving}
                  onClick={() => void handleSave(true)}
                  className="px-4 py-2 text-xs font-semibold text-white bg-amber-600 hover:bg-amber-700 disabled:opacity-50 rounded-lg shadow-xs transition-colors cursor-pointer"
                >
                  Save Anyway
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Unsaved Changes Confirmation Modal */}
        {showDiscardConfirm && (
          <div
            className="fixed inset-0 z-60 flex items-center justify-center p-4 bg-slate-950/60 backdrop-blur-xs"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="discard-title"
          >
            <div className="w-full max-w-md bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-2xl p-6 text-center">
              <div className="w-12 h-12 rounded-full bg-amber-50 dark:bg-amber-950/50 text-amber-600 dark:text-amber-400 flex items-center justify-center mx-auto mb-4 border border-amber-200 dark:border-amber-800/60">
                <AlertTriangle size={24} />
              </div>
              <h3 id="discard-title" className="text-base font-bold text-slate-900 dark:text-white">
                Discard unsaved changes?
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-2">
                You have unsaved changes that will be lost if you leave this settings dialogue.
              </p>
              <div className="flex items-center justify-center gap-3 mt-6">
                <button
                  type="button"
                  onClick={() => setShowDiscardConfirm(false)}
                  className="px-4 py-2 text-xs font-medium text-slate-700 dark:text-slate-300 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg transition-colors cursor-pointer"
                >
                  Keep Editing
                </button>
                <button
                  type="button"
                  onClick={handleConfirmDiscard}
                  className="px-4 py-2 text-xs font-semibold text-white bg-red-600 hover:bg-red-700 rounded-lg shadow-xs transition-colors cursor-pointer"
                >
                  Discard Changes
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Restore Defaults Confirmation Modal */}
        {showDefaultsConfirm && (
          <div
            className="fixed inset-0 z-60 flex items-center justify-center p-4 bg-slate-950/60 backdrop-blur-xs"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="defaults-title"
          >
            <div className="w-full max-w-md bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-2xl p-6 text-center">
              <div className="w-12 h-12 rounded-full bg-blue-50 dark:bg-blue-950/50 text-blue-600 dark:text-blue-400 flex items-center justify-center mx-auto mb-4 border border-blue-200 dark:border-blue-800/60">
                <RefreshCw size={24} />
              </div>
              <h3 id="defaults-title" className="text-base font-bold text-slate-900 dark:text-white">
                Restore default settings?
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-2">
                This will reset polling interval, repository filters, label filters, known bots, and triage preferences to default values. You must click Save to persist.
              </p>
              <div className="flex items-center justify-center gap-3 mt-6">
                <button
                  type="button"
                  onClick={() => setShowDefaultsConfirm(false)}
                  className="px-4 py-2 text-xs font-medium text-slate-700 dark:text-slate-300 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg transition-colors cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleConfirmResetDefaults}
                  className="px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg shadow-xs transition-colors cursor-pointer"
                >
                  Restore Defaults
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
