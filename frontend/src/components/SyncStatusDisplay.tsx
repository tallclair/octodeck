import { useState, useRef } from 'react';
import { RefreshCw, AlertTriangle, CheckCircle, Clock, RotateCw } from 'lucide-react';
import type { SyncStatus } from '../api/octodeck/v1/service_pb';
import { getProtoTimestampMs } from '../logic/timeline';
import { formatFuzzyTime, formatCompactTime } from '../utils/time';

function formatRate(rate?: number): string {
  if (rate === undefined || rate === null) return '0.0/hr';
  if (rate === 0) return '0.0/hr';
  if (rate < 0.1) return '< 0.1/hr';
  return `${rate.toFixed(1)}/hr`;
}

interface SyncStatusDisplayProps {
  status?: SyncStatus | null;
  isSyncing?: boolean;
  onManualSync: () => Promise<void> | void;
  isDisconnected?: boolean;
}

export function SyncStatusDisplay({ status, isSyncing = false, onManualSync, isDisconnected = false }: SyncStatusDisplayProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [syncingManual, setSyncingManual] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const lastSuccessfulMs = getProtoTimestampMs(status?.lastSuccessfulSyncAt);
  const lastUpdateMs = getProtoTimestampMs(status?.lastUpdateReceivedAt);
  const isFailed = Boolean(status?.lastSyncFailed);
  const currentlySyncing = isSyncing || Boolean(status?.isSyncing) || syncingManual;
  const syncDurationMs = status?.lastSyncDurationMs !== undefined ? Number(status.lastSyncDurationMs) : 0;
  const formattedDuration =
    syncDurationMs > 0
      ? syncDurationMs < 1000
        ? `${syncDurationMs}ms`
        : `${(syncDurationMs / 1000).toFixed(1)}s`
      : null;

  const handleMouseEnter = () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    setIsOpen(true);
  };

  const handleMouseLeave = () => {
    timeoutRef.current = setTimeout(() => {
      setIsOpen(false);
    }, 200);
  };

  const handleSyncClick = async () => {
    try {
      setSyncingManual(true);
      await onManualSync();
    } finally {
      setSyncingManual(false);
    }
  };

  let statusText = 'Not Synced';
  let badgeColor = 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200';

  if (isDisconnected) {
    statusText = 'Offline';
    badgeColor = 'text-red-600 dark:text-red-400 font-semibold';
  } else if (currentlySyncing) {
    statusText = 'Syncing...';
    badgeColor = 'text-blue-600 dark:text-blue-400 font-medium';
  } else if (isFailed) {
    statusText = 'Sync Failed';
    badgeColor = 'text-red-600 dark:text-red-400 font-medium';
  } else if (lastSuccessfulMs > 0) {
    statusText = `Synced ${formatFuzzyTime(lastSuccessfulMs)}`;
    badgeColor = 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200';
  }

  return (
    <div
      className="relative flex items-center"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className={`text-xs font-mono flex items-center gap-1.5 cursor-pointer py-1 px-2.5 rounded-full bg-slate-100 dark:bg-slate-900/60 border border-slate-200 dark:border-slate-800/80 transition-colors ${badgeColor}`}
        aria-label="Sync Status"
      >
        {isDisconnected ? (
          <AlertTriangle size={12} className="text-red-600 dark:text-red-400" />
        ) : currentlySyncing ? (
          <RefreshCw size={12} className="animate-spin text-blue-600 dark:text-blue-400" />
        ) : isFailed ? (
          <AlertTriangle size={12} className="text-red-600 dark:text-red-400" />
        ) : (
          <CheckCircle size={12} className="text-emerald-600 dark:text-emerald-400" />
        )}
        <span>{statusText}</span>
      </button>

      {isOpen && (
        <div
          className="absolute right-0 top-full mt-2 w-80 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-2xl p-4 z-50 text-xs text-slate-700 dark:text-slate-300 font-sans backdrop-blur-md"
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
        >
          <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800/80 pb-2.5 mb-3">
            <div className="flex items-center gap-2">
              <Clock size={14} className="text-blue-600 dark:text-blue-400" />
              <span className="font-semibold text-slate-900 dark:text-slate-200">Synchronization Status</span>
            </div>
            <span
              className={`px-2 py-0.5 rounded-full text-[10px] font-medium tracking-wide ${
                isDisconnected
                  ? 'bg-red-50 dark:bg-red-500/20 text-red-700 dark:text-red-300 border border-red-200 dark:border-red-500/30'
                  : currentlySyncing
                  ? 'bg-blue-50 dark:bg-blue-500/20 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-500/30'
                  : isFailed
                  ? 'bg-red-50 dark:bg-red-500/20 text-red-700 dark:text-red-300 border border-red-200 dark:border-red-500/30'
                  : 'bg-emerald-50 dark:bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-500/30'
              }`}
            >
              {isDisconnected ? 'Offline' : currentlySyncing ? 'Syncing' : isFailed ? 'Failed' : 'Healthy'}
            </span>
          </div>

          <div className="space-y-2 mb-3">
            <div className="flex justify-between items-center text-slate-500 dark:text-slate-400">
              <span>Last successful sync:</span>
              <div className="flex items-center gap-1.5 font-mono text-slate-900 dark:text-slate-200">
                <span>{lastSuccessfulMs > 0 ? formatCompactTime(lastSuccessfulMs) : 'Never'}</span>
                {lastSuccessfulMs > 0 && formattedDuration && (
                  <span className="text-[10px] text-slate-400 dark:text-slate-500 font-sans">
                    ({formattedDuration})
                  </span>
                )}
              </div>
            </div>
            <div className="flex justify-between items-center text-slate-500 dark:text-slate-400">
              <span>Last update received:</span>
              <span className="font-mono text-slate-900 dark:text-slate-200">
                {lastUpdateMs > 0 ? formatCompactTime(lastUpdateMs) : 'Never'}
              </span>
            </div>
          </div>

          <div className="pt-2.5 border-t border-slate-200 dark:border-slate-800/80 mb-3">
            <div className="text-[11px] font-semibold text-slate-900 dark:text-slate-200 mb-1.5">
              Notification Rate
            </div>
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="bg-slate-50 dark:bg-slate-800/50 p-1.5 rounded border border-slate-200/60 dark:border-slate-700/50">
                <div className="text-[10px] text-slate-500 dark:text-slate-400">24 Hours</div>
                <div className="font-mono font-medium text-slate-900 dark:text-slate-200 mt-0.5">
                  {formatRate(status?.notificationRate24h)}
                </div>
              </div>
              <div className="bg-slate-50 dark:bg-slate-800/50 p-1.5 rounded border border-slate-200/60 dark:border-slate-700/50">
                <div className="text-[10px] text-slate-500 dark:text-slate-400">7 Days</div>
                <div className="font-mono font-medium text-slate-900 dark:text-slate-200 mt-0.5">
                  {formatRate(status?.notificationRate7d)}
                </div>
              </div>
              <div className="bg-slate-50 dark:bg-slate-800/50 p-1.5 rounded border border-slate-200/60 dark:border-slate-700/50">
                <div className="text-[10px] text-slate-500 dark:text-slate-400">30 Days</div>
                <div className="font-mono font-medium text-slate-900 dark:text-slate-200 mt-0.5">
                  {formatRate(status?.notificationRate30d)}
                </div>
              </div>
            </div>
          </div>

          {isDisconnected && (
            <div className="mt-3 pt-2.5 border-t border-slate-200 dark:border-slate-800/80 space-y-2">
              <div className="bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900/60 text-red-800 dark:text-red-300 rounded-lg p-2.5 text-[11px] leading-relaxed">
                Could not connect to the local OctoDeck daemon. Make sure <code className="font-mono bg-red-100 dark:bg-red-900/60 px-1 py-0.5 rounded text-red-950 dark:text-red-200">octodeck serve</code> is running.
              </div>
            </div>
          )}

          {!isDisconnected && (isFailed || (status?.failedAttemptsCount ?? 0) > 0) && (
            <div className="mt-3 pt-2.5 border-t border-slate-200 dark:border-slate-800/80 space-y-2">
              <div className="flex justify-between items-center text-red-600 dark:text-red-400 font-medium">
                <span>Failed Attempts:</span>
                <span className="font-mono">{status?.failedAttemptsCount ?? 1}</span>
              </div>
              {status?.lastErrorMessage && (
                <div className="bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900/60 text-red-800 dark:text-red-300 rounded-lg p-2.5 font-mono text-[11px] break-words">
                  {status.lastErrorMessage}
                </div>
              )}
            </div>
          )}

          <div className="mt-3 pt-2.5 border-t border-slate-200 dark:border-slate-800/80 flex justify-end">
            <button
              type="button"
              onClick={handleSyncClick}
              disabled={currentlySyncing}
              className="flex items-center gap-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-medium px-3 py-1.5 rounded-lg transition-colors cursor-pointer text-xs shadow-xs"
            >
              <RotateCw size={12} className={currentlySyncing ? 'animate-spin' : ''} />
              <span>{currentlySyncing ? 'Syncing...' : 'Sync Now'}</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
