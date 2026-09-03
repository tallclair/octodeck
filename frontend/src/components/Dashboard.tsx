import { useState, useEffect, useMemo, useRef } from 'react';
import {
  Settings as SettingsIcon,
  Search,
  Filter,
  CircleDot,
  GitPullRequest,
  Disc,
  FolderGit,
  User as UserIcon,
  Zap,
  CheckCircle,
  Pin,
  UserCheck,
  X,
  ChevronDown,
  ChevronUp,
  Check,
  Layers,
  Milestone as MilestoneIcon,
  Tag as LabelIcon,
  AlertTriangle,
  RefreshCw,
  Keyboard,
} from 'lucide-react';
import { useQuery, useMutation } from '@connectrpc/connect-query';
import {
  getItems,
  ackItem,
  starItem,
  setNotes,
  getConfig,
  viewItem,
  getSyncStatus,
} from '../api/octodeck/v1/service-OctoDeckService_connectquery';
import {
  ItemStatus as ProtoItemStatus,
  type Item,
  type Label,
} from '../api/octodeck/v1/resources_pb';
import { client, checkStatus } from '../api/client';
import { PullRequestCard } from './PullRequestCard';
import { DetailsPane } from './DetailsPane';
import { SyncStatusDisplay } from './SyncStatusDisplay';
import { KeyboardShortcutsModal } from './KeyboardShortcutsModal';
import { Settings } from '../Settings';
import { useDashboardFilters } from '../hooks/useDashboardFilters';
import { useScrollAnchoring } from '../hooks/useScrollAnchoring';
import { useKeyboardNavigation } from '../hooks/useKeyboardNavigation';
import {
  applyFilters,
  extractUniqueOrgsAndRepos,
  extractUniqueAuthors,
  extractUniqueMilestones,
  extractUniqueLabels,
} from '../logic/filterEngine';

interface DashboardProps {
  onOpenDebug?: (targetItemId?: string) => void;
}

export function Dashboard({ onOpenDebug }: DashboardProps) {
  const { data: itemsData, isLoading: itemsLoading, isError: isItemsError, refetch: refetchItems } = useQuery(
    getItems,
    {},
    {
      refetchInterval: 3000,
      staleTime: 1000,
    }
  );
  const { data: configData, isError: isConfigError, refetch: refetchConfig } = useQuery(getConfig, {});
  const { data: syncStatusData, isError: isSyncStatusError, refetch: refetchSyncStatus } = useQuery(
    getSyncStatus,
    {},
    {
      refetchInterval: 2000,
      staleTime: 1000,
    }
  );

  const isDisconnected = isItemsError || isConfigError || isSyncStatusError;
  const { mutateAsync: ackItemMutate } = useMutation(ackItem);
  const { mutateAsync: starItemMutate } = useMutation(starItem);
  const { mutateAsync: setNotesMutate } = useMutation(setNotes);
  const { mutateAsync: viewItemMutate } = useMutation(viewItem);

  const [isSyncing, setIsSyncing] = useState(false);

  // Daemon version state for Settings
  const [daemonVersion, setDaemonVersion] = useState<string>(() => {
    return typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev';
  });

  // Fetch daemon version for Settings
  useEffect(() => {
    checkStatus()
      .then((status) => {
        if (status.version) {
          setDaemonVersion(status.version);
        }
      })
      .catch(() => {
        // Retain fallback version if status query fails
      });
  }, []);
  const [showSettings, setShowSettings] = useState(false);
  const [statusMenuOpen, setStatusMenuOpen] = useState(false);
  const [stateMenuOpen, setStateMenuOpen] = useState(false);
  const [repoMenuOpen, setRepoMenuOpen] = useState(false);
  const [authorMenuOpen, setAuthorMenuOpen] = useState(false);
  const [milestoneMenuOpen, setMilestoneMenuOpen] = useState(false);
  const [labelMenuOpen, setLabelMenuOpen] = useState(false);
  const [sortMenuOpen, setSortMenuOpen] = useState(false);

  const [showAllRepos, setShowAllRepos] = useState(false);
  const [showAllAuthors, setShowAllAuthors] = useState(false);
  const [showAllMilestones, setShowAllMilestones] = useState(false);
  const [showAllLabels, setShowAllLabels] = useState(false);

  const statusMenuRef = useRef<HTMLDivElement>(null);
  const stateMenuRef = useRef<HTMLDivElement>(null);
  const repoMenuRef = useRef<HTMLDivElement>(null);
  const authorMenuRef = useRef<HTMLDivElement>(null);
  const milestoneMenuRef = useRef<HTMLDivElement>(null);
  const labelMenuRef = useRef<HTMLDivElement>(null);
  const sortMenuRef = useRef<HTMLDivElement>(null);

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
    filters,
    setFilter,
    setFilters,
    applyWorkflowShortcut,
    toggleRepo,
  } = useDashboardFilters();

  const selectedItemId = filters.item;
  const [showHiddenRepos, setShowHiddenRepos] = useState(false);
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

  const items: Item[] = useMemo(() => itemsData?.items || [], [itemsData?.items]);
  const configPinnedRepos = configData?.config?.pinnedRepos;
  const pinnedRepos = useMemo(() => configPinnedRepos || [], [configPinnedRepos]);
  const currentUser = configData?.currentUserLogin || null;

  const { pinnedList, otherList, activeOtherList, hiddenOtherList } = useMemo(
    () => extractUniqueOrgsAndRepos(items, pinnedRepos),
    [items, pinnedRepos]
  );

  const hasActiveChips = useMemo(() => {
    return (
      filters.state !== 'all' ||
      Boolean(filters.repo) ||
      Boolean(filters.org) ||
      Boolean(filters.author) ||
      Boolean(filters.milestone) ||
      Boolean(filters.label) ||
      filters.assigned === 'me'
    );
  }, [filters.state, filters.repo, filters.org, filters.author, filters.milestone, filters.label, filters.assigned]);

  const clearSecondaryFilters = () => {
    setFilters({
      state: 'all',
      repo: null,
      org: null,
      author: null,
      milestone: null,
      label: null,
      assigned: 'all',
    });
  };

  const filteredItems = useMemo(
    () => applyFilters(items, filters, currentUser),
    [items, filters, currentUser]
  );

  const filteredItemIds = useMemo(() => filteredItems.map(i => i.id), [filteredItems]);
  const filterKey = `${filters.triage}|${filters.state}|${filters.type}|${filters.repo || ''}|${filters.org || ''}|${filters.author || ''}|${filters.milestone || ''}|${filters.label || ''}|${filters.assigned}|${filters.q}|${filters.sort}|${filters.order}`;

  const { scrollContainerRef } = useScrollAnchoring({
    itemIds: filteredItemIds,
    filterKey,
    animationDurationMs: 400,
  });

  const lastUpdateKey = syncStatusData?.status?.lastUpdateReceivedAt
    ? `${syncStatusData.status.lastUpdateReceivedAt.seconds}_${syncStatusData.status.lastUpdateReceivedAt.nanos || 0}`
    : '';
  const lastSyncKey = syncStatusData?.status?.lastSuccessfulSyncAt
    ? `${syncStatusData.status.lastSuccessfulSyncAt.seconds}_${syncStatusData.status.lastSuccessfulSyncAt.nanos || 0}`
    : '';
  const daemonIsSyncing = Boolean(syncStatusData?.status?.isSyncing);

  const prevSyncingRef = useRef(daemonIsSyncing);
  useEffect(() => {
    if (prevSyncingRef.current && !daemonIsSyncing) {
      // Daemon just finished syncing, immediately refresh items
      refetchItems();
    }
    prevSyncingRef.current = daemonIsSyncing;
  }, [daemonIsSyncing, refetchItems]);

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
      refetchItems();
    }
  }, [lastUpdateKey, lastSyncKey, refetchItems]);

  // Author filter options (filtered to displayed items by default, with show-all toggle)
  const displayedAuthors = useMemo(() => {
    const authors = new Set(extractUniqueAuthors(filteredItems));
    if (filters.author) {
      authors.add(filters.author);
    }
    return Array.from(authors).sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: 'base' })
    );
  }, [filteredItems, filters.author]);

  const allAuthors = useMemo(() => {
    const authors = new Set(extractUniqueAuthors(items));
    if (filters.author) {
      authors.add(filters.author);
    }
    return Array.from(authors).sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: 'base' })
    );
  }, [items, filters.author]);

  const hasMoreAuthors = useMemo(() => {
    return allAuthors.length > displayedAuthors.length || allAuthors.some(a => !displayedAuthors.includes(a));
  }, [allAuthors, displayedAuthors]);

  const currentAuthorsList = showAllAuthors ? allAuthors : displayedAuthors;

  const authorDropdownList = useMemo(() => {
    const hasCurrentUser = currentUser && currentAuthorsList.includes(currentUser);
    const otherAuthors = currentAuthorsList.filter(a => a !== currentUser);
    return {
      currentUser: hasCurrentUser ? currentUser : null,
      otherAuthors,
    };
  }, [currentAuthorsList, currentUser]);

  // Milestone filter options (filtered to displayed items by default, with show-all toggle)
  const displayedMilestones = useMemo(() => {
    const milestones = new Set(extractUniqueMilestones(filteredItems));
    if (filters.milestone) {
      milestones.add(filters.milestone);
    }
    return Array.from(milestones).sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: 'base' })
    );
  }, [filteredItems, filters.milestone]);

  const allMilestones = useMemo(() => {
    const milestones = new Set(extractUniqueMilestones(items));
    if (filters.milestone) {
      milestones.add(filters.milestone);
    }
    return Array.from(milestones).sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: 'base' })
    );
  }, [items, filters.milestone]);

  const hasMoreMilestones = useMemo(() => {
    return allMilestones.length > displayedMilestones.length || allMilestones.some(m => !displayedMilestones.includes(m));
  }, [allMilestones, displayedMilestones]);

  const currentMilestonesList = showAllMilestones ? allMilestones : displayedMilestones;

  // Label filter options (filtered to displayed items by default, with show-all toggle)
  const displayedLabels = useMemo(() => {
    const labels = extractUniqueLabels(filteredItems);
    if (filters.label && !labels.some(l => l.name?.toLowerCase() === filters.label?.toLowerCase())) {
      labels.push({ name: filters.label, color: '', description: '' } as Label);
      labels.sort((a, b) => (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' }));
    }
    return labels;
  }, [filteredItems, filters.label]);

  const allLabels = useMemo(() => {
    const labels = extractUniqueLabels(items);
    if (filters.label && !labels.some(l => l.name?.toLowerCase() === filters.label?.toLowerCase())) {
      labels.push({ name: filters.label, color: '', description: '' } as Label);
      labels.sort((a, b) => (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' }));
    }
    return labels;
  }, [items, filters.label]);

  const hasMoreLabels = useMemo(() => {
    return allLabels.length > displayedLabels.length || allLabels.some(l => !displayedLabels.some(d => d.name === l.name));
  }, [allLabels, displayedLabels]);

  const currentLabelsList = showAllLabels ? allLabels : displayedLabels;

  // Repository & Org filter options (filtered to displayed items by default, with show-all toggle)
  const displayedOrgsAndRepos = useMemo(() => {
    const { orgs, reposByOrg } = extractUniqueOrgsAndRepos(filteredItems);
    if (filters.repo && filters.repo.includes('/')) {
      const [org] = filters.repo.split('/');
      if (!orgs.includes(org)) {
        orgs.push(org);
        orgs.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
      }
      if (!reposByOrg[org]) {
        reposByOrg[org] = [];
      }
      if (!reposByOrg[org].includes(filters.repo)) {
        reposByOrg[org].push(filters.repo);
        reposByOrg[org].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
      }
    } else if (filters.org) {
      if (!orgs.includes(filters.org)) {
        orgs.push(filters.org);
        orgs.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
        if (!reposByOrg[filters.org]) {
          reposByOrg[filters.org] = [];
        }
      }
    }
    return { orgs, reposByOrg };
  }, [filteredItems, filters.repo, filters.org]);

  const allDropdownOrgsAndRepos = useMemo(
    () => extractUniqueOrgsAndRepos(items, pinnedRepos),
    [items, pinnedRepos]
  );

  const hasMoreRepos = useMemo(() => {
    const displayedRepoCount = Object.values(displayedOrgsAndRepos.reposByOrg).reduce(
      (acc, repos) => acc + repos.length,
      0
    );
    const allRepoCount = Object.values(allDropdownOrgsAndRepos.reposByOrg).reduce(
      (acc, repos) => acc + repos.length,
      0
    );
    if (allRepoCount > displayedRepoCount) return true;
    if (allDropdownOrgsAndRepos.orgs.some(org => !displayedOrgsAndRepos.orgs.includes(org))) return true;
    for (const org of allDropdownOrgsAndRepos.orgs) {
      const allR = allDropdownOrgsAndRepos.reposByOrg[org] || [];
      const dispR = displayedOrgsAndRepos.reposByOrg[org] || [];
      if (allR.some(r => !dispR.includes(r))) return true;
    }
    return false;
  }, [displayedOrgsAndRepos, allDropdownOrgsAndRepos]);

  const dropdownOrgs = showAllRepos ? allDropdownOrgsAndRepos.orgs : displayedOrgsAndRepos.orgs;
  const dropdownReposByOrg = showAllRepos ? allDropdownOrgsAndRepos.reposByOrg : displayedOrgsAndRepos.reposByOrg;

  const handleManualSync = async () => {
    setIsSyncing(true);
    try {
      for await (const res of client.sync({})) {
        if (res.message) {
          console.debug('Sync progress:', res.message);
        }
      }
      await refetchItems();
      await refetchSyncStatus();
    } catch (err) {
      console.error('Failed to trigger manual sync from GitHub:', err);
    } finally {
      setIsSyncing(false);
    }
  };

  const handleAck = async (id: string) => {
    try {
      const willDisappear = filters.triage !== 'all' && filters.triage !== 'acked';
      if (willDisappear) {
        setDismissingIds(prev => new Set(prev).add(id));
      }
      setFilter('item', null);

      const mutationPromise = ackItemMutate({ itemId: id, acked: true });
      if (willDisappear) {
        await Promise.all([
          mutationPromise,
          new Promise(resolve => setTimeout(resolve, 280)),
        ]);
      } else {
        await mutationPromise;
      }
      await refetchItems();
    } catch (err) {
      console.error('Failed to ack item:', err);
    } finally {
      setDismissingIds(prev => {
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
      await refetchItems();
    } catch (err) {
      console.error('Failed to unack item:', err);
    }
  };

  const handleStar = async (id: string, starred: boolean) => {
    try {
      await starItemMutate({ itemId: id, starred });
      await refetchItems();
    } catch (err) {
      console.error('Failed to star item:', err);
    }
  };

  const handleSetNotes = async (id: string, notes: string) => {
    try {
      await setNotesMutate({ itemId: id, notes });
      await refetchItems();
    } catch (err) {
      console.error('Failed to set notes for item:', id, err);
    }
  };



  const selectedItem = useMemo(
    () =>
      items.find(
        i =>
          i.id === selectedItemId ||
          (selectedItemId && `${i.repo}#${i.number}` === selectedItemId)
      ) || null,
    [items, selectedItemId]
  );

  const [prevSelectedItem, setPrevSelectedItem] = useState<Item | null>(null);
  const [recentItem, setRecentItem] = useState<Item | null>(selectedItem);
  if (selectedItem && selectedItem !== prevSelectedItem) {
    setPrevSelectedItem(selectedItem);
    setRecentItem(selectedItem);
  }

  useEffect(() => {
    if (selectedItemId) {
      viewItemMutate({ itemId: selectedItemId })
        .then(() => refetchItems())
        .catch(err => console.error('Failed to record view for item:', selectedItemId, err));
    }
  }, [selectedItemId, viewItemMutate, refetchItems]);

  const anyMenuOpen =
    statusMenuOpen ||
    stateMenuOpen ||
    repoMenuOpen ||
    authorMenuOpen ||
    milestoneMenuOpen ||
    labelMenuOpen ||
    sortMenuOpen;

  const {
    focusedItemId,
    showShortcutsModal,
    setShowShortcutsModal,
  } = useKeyboardNavigation({
    items: filteredItems,
    selectedItemId,
    onSelectItem: (id) => setFilter('item', id),
    onAckItem: handleAck,
    onStarItem: handleStar,
    isDetailsOpen: Boolean(selectedItemId),
    disabled: showSettings || anyMenuOpen,
  });

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (anyMenuOpen) {
          setStatusMenuOpen(false);
          setStateMenuOpen(false);
          setRepoMenuOpen(false);
          setShowAllRepos(false);
          setAuthorMenuOpen(false);
          setShowAllAuthors(false);
          setMilestoneMenuOpen(false);
          setShowAllMilestones(false);
          setLabelMenuOpen(false);
          setShowAllLabels(false);
          setSortMenuOpen(false);
          return;
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [anyMenuOpen]);

  // Click outside listener for custom dropdowns
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (statusMenuRef.current && !statusMenuRef.current.contains(e.target as Node)) {
        setStatusMenuOpen(false);
      }
      if (stateMenuRef.current && !stateMenuRef.current.contains(e.target as Node)) {
        setStateMenuOpen(false);
      }
      if (repoMenuRef.current && !repoMenuRef.current.contains(e.target as Node)) {
        setRepoMenuOpen(false);
        setShowAllRepos(false);
      }
      if (authorMenuRef.current && !authorMenuRef.current.contains(e.target as Node)) {
        setAuthorMenuOpen(false);
        setShowAllAuthors(false);
      }
      if (milestoneMenuRef.current && !milestoneMenuRef.current.contains(e.target as Node)) {
        setMilestoneMenuOpen(false);
        setShowAllMilestones(false);
      }
      if (labelMenuRef.current && !labelMenuRef.current.contains(e.target as Node)) {
        setLabelMenuOpen(false);
        setShowAllLabels(false);
      }
      if (sortMenuRef.current && !sortMenuRef.current.contains(e.target as Node)) {
        setSortMenuOpen(false);
      }
    };
    if (statusMenuOpen || stateMenuOpen || repoMenuOpen || authorMenuOpen || milestoneMenuOpen || labelMenuOpen || sortMenuOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [statusMenuOpen, stateMenuOpen, repoMenuOpen, authorMenuOpen, milestoneMenuOpen, labelMenuOpen, sortMenuOpen]);

  // Activity & inbox counts for sidebar badges
  const { repoInboxCounts, repoHasUnread } = useMemo(() => {
    const inboxCounts: Record<string, number> = {};
    const hasUnread: Record<string, boolean> = {};

    items.forEach(item => {
      if (!item.repo) return;
      const status = item.local?.computedStatus;
      if (status !== ProtoItemStatus.ACKED) {
        inboxCounts[item.repo] = (inboxCounts[item.repo] || 0) + 1;
        if (status !== ProtoItemStatus.IDLE && status !== ProtoItemStatus.NOISE) {
          hasUnread[item.repo] = true;
        }
      }
    });

    return { repoInboxCounts: inboxCounts, repoHasUnread: hasUnread };
  }, [items]);

  // Determine active workflow shortcut
  const isInboxActive =
    filters.triage === 'inbox' &&
    !filters.repo &&
    !filters.org &&
    !filters.author &&
    filters.state === 'all' &&
    filters.type === 'all' &&
    filters.assigned === 'all' &&
    !filters.q;
  const isActivityActive =
    filters.triage === 'activity' &&
    !filters.repo &&
    !filters.org &&
    !filters.author &&
    filters.state === 'all' &&
    filters.type === 'all' &&
    filters.assigned === 'all' &&
    !filters.q;
  const isAckedActive =
    filters.triage === 'acked' &&
    !filters.repo &&
    !filters.org &&
    !filters.author &&
    filters.state === 'all' &&
    filters.type === 'all' &&
    filters.assigned === 'all' &&
    !filters.q;

  const handleOrgRepoChange = (value: string) => {
    if (!value) {
      setFilters({ org: null, repo: null });
    } else if (value.startsWith('org:')) {
      setFilters({ org: value.slice(4), repo: null });
    } else if (value.startsWith('repo:')) {
      setFilters({ repo: value.slice(5), org: null });
    }
  };

  const titleText =
    filters.triage === 'inbox'
      ? 'Inbox'
      : filters.triage === 'activity'
      ? 'New'
      : filters.triage === 'acked'
      ? 'Acked'
      : 'All Items';

  const titleIcon =
    filters.triage === 'inbox' ? (
      <Filter size={18} className="text-blue-400" />
    ) : filters.triage === 'activity' ? (
      <Zap size={18} className="text-orange-400" />
    ) : filters.triage === 'acked' ? (
      <CheckCircle size={18} className="text-emerald-400" />
    ) : (
      <Layers size={18} className="text-slate-400" />
    );

  if (itemsLoading && !isDisconnected) {
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
              Disconnected from OctoDeck daemon. Make sure the local server is running (<code className="bg-red-800/80 dark:bg-red-900/80 px-1.5 py-0.5 rounded font-mono text-xs text-white">octodeck serve</code>).
            </span>
          </div>
          <button
            type="button"
            onClick={async () => {
              await Promise.allSettled([refetchItems(), refetchConfig(), refetchSyncStatus()]);
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
            placeholder="Search items, repo, author..."
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
            refetchItems();
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
        {/* Sidebar (Navigation / Shortcuts) */}
        <aside className="w-64 border-r border-slate-200 dark:border-slate-800 p-4 flex flex-col gap-1 overflow-y-auto hidden md:flex shrink-0 bg-slate-50/50 dark:bg-slate-950">
          <div className="text-xs font-bold text-slate-500 dark:text-slate-500 uppercase tracking-wider mb-2 px-2">Workflows</div>

          <button
            type="button"
            onClick={() => applyWorkflowShortcut('inbox')}
            className={`flex items-center justify-between px-3 py-2 rounded-md text-sm transition-colors cursor-pointer ${
              isInboxActive
                ? 'bg-blue-600 text-white font-medium shadow-xs'
                : 'text-slate-600 dark:text-slate-400 hover:bg-slate-200/60 dark:hover:bg-slate-900 hover:text-slate-900 dark:hover:text-slate-200'
            }`}
          >
            <div className="flex items-center gap-3">
              <Filter size={16} />
              <span>Inbox</span>
            </div>
            <span className={`px-1.5 rounded text-xs font-mono ${isInboxActive ? 'bg-blue-700 text-white' : 'bg-slate-200 dark:bg-slate-800/50 text-slate-700 dark:text-slate-300'}`}>
              {items.filter(i => i.local?.computedStatus !== ProtoItemStatus.ACKED).length}
            </span>
          </button>

          <button
            type="button"
            onClick={() => applyWorkflowShortcut('activity')}
            className={`flex items-center justify-between px-3 py-2 rounded-md text-sm transition-colors cursor-pointer ${
              isActivityActive
                ? 'bg-blue-600 text-white font-medium shadow-xs'
                : 'text-slate-600 dark:text-slate-400 hover:bg-slate-200/60 dark:hover:bg-slate-900 hover:text-slate-900 dark:hover:text-slate-200'
            }`}
          >
            <div className="flex items-center gap-3">
              <Zap size={16} />
              <span>New</span>
            </div>
            <span className={`px-1.5 rounded text-xs font-mono ${isActivityActive ? 'bg-blue-700 text-white' : 'bg-orange-100 dark:bg-orange-500/20 text-orange-700 dark:text-orange-300'}`}>
              {items.filter(i => i.local?.computedStatus !== ProtoItemStatus.ACKED && i.local?.computedStatus !== ProtoItemStatus.IDLE && i.local?.computedStatus !== ProtoItemStatus.NOISE).length}
            </span>
          </button>

          <button
            type="button"
            onClick={() => applyWorkflowShortcut('acked')}
            className={`flex items-center justify-between px-3 py-2 rounded-md text-sm transition-colors cursor-pointer ${
              isAckedActive
                ? 'bg-blue-600 text-white font-medium shadow-xs'
                : 'text-slate-600 dark:text-slate-400 hover:bg-slate-200/60 dark:hover:bg-slate-900 hover:text-slate-900 dark:hover:text-slate-200'
            }`}
          >
            <div className="flex items-center gap-3">
              <CheckCircle size={16} />
              <span>Acked</span>
            </div>
            <span className={`px-1.5 rounded text-xs font-mono ${isAckedActive ? 'bg-blue-700 text-white' : 'bg-slate-200 dark:bg-slate-800/50 text-slate-700 dark:text-slate-300'}`}>
              {items.filter(i => i.local?.computedStatus === ProtoItemStatus.ACKED).length}
            </span>
          </button>

          {/* Pinned Repositories */}
          {pinnedList.length > 0 && (
            <div className="mt-6 mb-2">
              <div className="text-xs font-bold text-slate-500 dark:text-slate-500 uppercase tracking-wider px-2 mb-2 flex items-center gap-1.5">
                <Pin size={12} className="text-blue-600 dark:text-blue-400 rotate-45" />
                <span>Pinned</span>
              </div>
              <div className="space-y-0.5">
                {pinnedList.map(repo => {
                  const inboxCount = repoInboxCounts[repo] || 0;
                  const hasUnread = Boolean(repoHasUnread[repo]);
                  return (
                    <button
                      key={repo}
                      type="button"
                      onClick={() => toggleRepo(repo)}
                      className={`w-full group px-3 py-1.5 text-sm flex items-center justify-between rounded cursor-pointer transition-colors ${
                        filters.repo === repo
                          ? 'bg-slate-200 dark:bg-slate-800 text-slate-900 dark:text-slate-200 font-medium'
                          : 'text-slate-600 dark:text-slate-300 hover:bg-slate-200/60 dark:hover:bg-slate-900 hover:text-slate-900 dark:hover:text-slate-100'
                      }`}
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="truncate">{repo}</span>
                      </div>
                      {inboxCount > 0 && (
                        <span
                          data-testid={`repo-count-${repo}`}
                          className={`text-[10px] px-1.5 rounded-full font-mono shrink-0 ${
                            hasUnread
                              ? 'bg-orange-100 dark:bg-orange-500/20 text-orange-700 dark:text-orange-300'
                              : 'bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-300'
                          }`}
                        >
                          {inboxCount}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Other / All Repositories */}
          <div className={pinnedList.length > 0 ? 'mt-4 mb-2' : 'mt-6 mb-2'}>
            <div className="text-xs font-bold text-slate-500 dark:text-slate-500 uppercase tracking-wider px-2 mb-2">
              {pinnedList.length > 0 ? 'Other Repositories' : 'Repositories'}
            </div>
            <div className="space-y-0.5">
              {activeOtherList.map(repo => {
                const inboxCount = repoInboxCounts[repo] || 0;
                const hasUnread = Boolean(repoHasUnread[repo]);
                return (
                  <button
                    key={repo}
                    type="button"
                    onClick={() => toggleRepo(repo)}
                    className={`w-full group px-3 py-1.5 text-sm flex items-center justify-between rounded cursor-pointer transition-colors ${
                      filters.repo === repo
                        ? 'bg-slate-200 dark:bg-slate-800 text-slate-900 dark:text-slate-200 font-medium'
                        : 'text-slate-600 dark:text-slate-400 hover:bg-slate-200/60 dark:hover:bg-slate-900 hover:text-slate-900 dark:hover:text-slate-200'
                    }`}
                  >
                    <span className="truncate">{repo}</span>
                    {inboxCount > 0 && (
                      <span
                        data-testid={`repo-count-${repo}`}
                        className={`text-[10px] px-1.5 rounded-full font-mono shrink-0 ${
                          hasUnread
                            ? 'bg-orange-100 dark:bg-orange-500/20 text-orange-700 dark:text-orange-300'
                            : 'bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-300'
                        }`}
                      >
                        {inboxCount}
                      </span>
                    )}
                  </button>
                );
              })}

              {hiddenOtherList.length > 0 && (
                <div className="pt-1">
                  <button
                    type="button"
                    data-testid="toggle-hidden-repos"
                    onClick={() => setShowHiddenRepos(!showHiddenRepos)}
                    className="w-full px-3 py-1.5 text-xs flex items-center gap-1.5 text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 cursor-pointer transition-colors"
                  >
                    {showHiddenRepos ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                    <span>{showHiddenRepos ? 'Less' : 'More'}</span>
                  </button>
                  {showHiddenRepos && (
                    <div className="space-y-0.5 mt-0.5" data-testid="hidden-repos-list">
                      {hiddenOtherList.map(repo => {
                        const inboxCount = repoInboxCounts[repo] || 0;
                        const hasUnread = Boolean(repoHasUnread[repo]);
                        return (
                          <button
                            key={repo}
                            type="button"
                            onClick={() => toggleRepo(repo)}
                            className={`w-full group px-3 py-1.5 text-sm flex items-center justify-between rounded cursor-pointer transition-colors ${
                              filters.repo === repo
                                ? 'bg-slate-200 dark:bg-slate-800 text-slate-900 dark:text-slate-200 font-medium'
                                : 'text-slate-600 dark:text-slate-400 hover:bg-slate-200/60 dark:hover:bg-slate-900 hover:text-slate-900 dark:hover:text-slate-200'
                            }`}
                          >
                            <span className="truncate">{repo}</span>
                            {inboxCount > 0 && (
                              <span
                                data-testid={`repo-count-${repo}`}
                                className={`text-[10px] px-1.5 rounded-full font-mono shrink-0 ${
                                  hasUnread
                                    ? 'bg-orange-100 dark:bg-orange-500/20 text-orange-700 dark:text-orange-300'
                                    : 'bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-300'
                                }`}
                              >
                                {inboxCount}
                              </span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              {pinnedList.length === 0 && otherList.length === 0 && (
                <div className="px-3 py-2 text-xs text-slate-400 dark:text-slate-600 italic">No repositories</div>
              )}
            </div>
          </div>

          {/* Lower Left Shortcuts & Settings Buttons */}
          <div className="mt-auto pt-3 border-t border-slate-200 dark:border-slate-800 space-y-1">
            <button
              type="button"
              onClick={() => setShowShortcutsModal(true)}
              className="w-full flex items-center justify-between px-3 py-2 rounded-md text-sm text-slate-600 dark:text-slate-400 hover:bg-slate-200/60 dark:hover:bg-slate-900 hover:text-slate-900 dark:hover:text-white transition-colors cursor-pointer"
              aria-label="Keyboard Shortcuts"
            >
              <div className="flex items-center gap-2.5">
                <Keyboard size={16} />
                <span>Shortcuts</span>
              </div>
              <kbd className="text-[10px] font-mono px-1.5 py-0.5 rounded border border-slate-300 dark:border-slate-700 bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400">?</kbd>
            </button>
            <button
              type="button"
              onClick={() => setShowSettings(!showSettings)}
              className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-sm transition-colors cursor-pointer ${
                showSettings
                  ? 'bg-blue-100 dark:bg-blue-950/60 text-blue-700 dark:text-blue-400 font-medium'
                  : 'text-slate-600 dark:text-slate-400 hover:bg-slate-200/60 dark:hover:bg-slate-900 hover:text-slate-900 dark:hover:text-white'
              }`}
              aria-label="Settings"
            >
              <SettingsIcon size={16} />
              <span>Settings</span>
            </button>
          </div>
        </aside>

        {/* List Pane */}
        <div className="flex-1 min-w-0 flex flex-col border-r border-slate-200 dark:border-slate-800 relative bg-slate-50 dark:bg-slate-950 overflow-hidden">
          <div className="flex flex-col h-full">
            {/* List Header */}
            <header className="px-6 py-3.5 border-b border-slate-200 dark:border-slate-800 shrink-0 bg-white/80 dark:bg-slate-950/80 backdrop-blur z-10 sticky top-0">
              <div className="flex w-full items-center transition-all duration-300 ease-in-out">
                <div className={`transition-all duration-300 ease-in-out ${selectedItem ? 'w-6 flex-none' : 'flex-1'}`} />

                <div className="max-w-4xl w-full shrink-0 space-y-3">
                  {/* Row 1: Title with Status Dropdown Arrow + Item Count */}
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3 relative" ref={statusMenuRef}>
                      <button
                        type="button"
                        onClick={() => setStatusMenuOpen(!statusMenuOpen)}
                        aria-haspopup="true"
                        aria-expanded={statusMenuOpen}
                        aria-label="Select triage status"
                        className="flex items-center gap-2 text-lg font-bold text-slate-900 dark:text-white tracking-tight hover:text-blue-600 dark:hover:text-blue-300 transition-colors group cursor-pointer select-none"
                      >
                        {titleIcon}
                        <span>{titleText}</span>
                        <ChevronDown
                          size={18}
                          className={`text-slate-400 group-hover:text-blue-600 dark:group-hover:text-blue-300 transition-transform duration-200 ${
                            statusMenuOpen ? 'rotate-180 text-blue-600 dark:text-blue-400' : ''
                          }`}
                        />
                      </button>

                      {/* Status Dropdown Menu */}
                      {statusMenuOpen && (
                        <div className="absolute top-full left-0 mt-1.5 w-48 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg shadow-xl py-1 z-30 animate-in fade-in zoom-in-95 duration-100">
                          <button
                            type="button"
                            onClick={() => {
                              setFilter('triage', 'inbox');
                              setStatusMenuOpen(false);
                            }}
                            className={`w-full px-3 py-2 text-xs flex items-center justify-between transition-colors cursor-pointer ${
                              filters.triage === 'inbox'
                                ? 'bg-blue-50 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300 font-medium'
                                : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-white'
                            }`}
                          >
                            <div className="flex items-center gap-2">
                              <Filter size={14} className="text-blue-600 dark:text-blue-400" />
                              <span>Inbox</span>
                            </div>
                            {filters.triage === 'inbox' && <Check size={14} className="text-blue-600 dark:text-blue-400" />}
                          </button>

                          <button
                            type="button"
                            onClick={() => {
                              setFilter('triage', 'activity');
                              setStatusMenuOpen(false);
                            }}
                            className={`w-full px-3 py-2 text-xs flex items-center justify-between transition-colors cursor-pointer ${
                              filters.triage === 'activity'
                                ? 'bg-blue-50 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300 font-medium'
                                : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-white'
                            }`}
                          >
                            <div className="flex items-center gap-2">
                              <Zap size={14} className="text-orange-500 dark:text-orange-400" />
                              <span>New</span>
                            </div>
                            {filters.triage === 'activity' && <Check size={14} className="text-blue-600 dark:text-blue-400" />}
                          </button>

                          <button
                            type="button"
                            onClick={() => {
                              setFilter('triage', 'acked');
                              setStatusMenuOpen(false);
                            }}
                            className={`w-full px-3 py-2 text-xs flex items-center justify-between transition-colors cursor-pointer ${
                              filters.triage === 'acked'
                                ? 'bg-blue-50 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300 font-medium'
                                : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-white'
                            }`}
                          >
                            <div className="flex items-center gap-2">
                              <CheckCircle size={14} className="text-emerald-600 dark:text-emerald-400" />
                              <span>Acked</span>
                            </div>
                            {filters.triage === 'acked' && <Check size={14} className="text-blue-600 dark:text-blue-400" />}
                          </button>

                          <div className="border-t border-slate-200 dark:border-slate-800 my-1" />

                          <button
                            type="button"
                            onClick={() => {
                              setFilter('triage', 'all');
                              setStatusMenuOpen(false);
                            }}
                            className={`w-full px-3 py-2 text-xs flex items-center justify-between transition-colors cursor-pointer ${
                              filters.triage === 'all'
                                ? 'bg-blue-50 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300 font-medium'
                                : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-white'
                            }`}
                          >
                            <div className="flex items-center gap-2">
                              <Layers size={14} className="text-slate-500 dark:text-slate-400" />
                              <span>All Items</span>
                            </div>
                            {filters.triage === 'all' && <Check size={14} className="text-blue-600 dark:text-blue-400" />}
                          </button>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Row 2: Filter Toolbar (PRs/Issues slider left-aligned, Custom Dropdowns right-aligned) */}
                  <div className="flex items-center justify-between gap-4 text-xs">
                    {/* Left-aligned: PRs / Issues Type Slider (Segmented Control) */}
                    <div
                      className="flex bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md p-0.5 shadow-xs"
                      role="group"
                      aria-label="Filter item type"
                    >
                      <button
                        type="button"
                        onClick={() => setFilter('type', 'all')}
                        className={`px-2.5 py-0.5 text-xs font-medium rounded transition-colors cursor-pointer flex items-center ${
                          filters.type === 'all'
                            ? 'bg-white dark:bg-blue-600 text-slate-900 dark:text-white shadow-xs font-semibold'
                            : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                        }`}
                      >
                        All
                      </button>
                      <button
                        type="button"
                        onClick={() => setFilter('type', 'pr')}
                        className={`px-2.5 py-0.5 text-xs font-medium rounded transition-colors cursor-pointer flex items-center gap-1.5 ${
                          filters.type === 'pr'
                            ? 'bg-white dark:bg-blue-600 text-slate-900 dark:text-white shadow-xs font-semibold'
                            : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                        }`}
                      >
                        <GitPullRequest size={12} />
                        <span>PRs</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setFilter('type', 'issue')}
                        className={`px-2.5 py-0.5 text-xs font-medium rounded transition-colors cursor-pointer flex items-center gap-1.5 ${
                          filters.type === 'issue'
                            ? 'bg-white dark:bg-blue-600 text-slate-900 dark:text-white shadow-xs font-semibold'
                            : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                        }`}
                      >
                        <Disc size={12} />
                        <span>Issues</span>
                      </button>
                    </div>

                    {/* Right-aligned: Custom Dropdown Menus for State, Repo, Author, and Assigned-to-me */}
                    <div className="flex items-center gap-2">
                      {/* Custom State Dropdown */}
                      <div className="relative" ref={stateMenuRef}>
                        <button
                          type="button"
                          onClick={() => setStateMenuOpen(!stateMenuOpen)}
                          aria-label="Filter by state"
                          aria-haspopup="true"
                          aria-expanded={stateMenuOpen}
                          className="flex items-center gap-1.5 rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 text-slate-700 dark:text-slate-300 hover:border-slate-300 dark:hover:border-slate-700 hover:text-slate-900 dark:hover:text-white py-1 px-2.5 transition-colors text-xs cursor-pointer select-none shadow-xs"
                        >
                          <CircleDot size={13} className="text-slate-400 dark:text-slate-500" />
                          <span>State</span>
                          <ChevronDown
                            size={12}
                            className={`text-slate-400 dark:text-slate-500 transition-transform duration-150 ${
                              stateMenuOpen ? 'rotate-180 text-blue-600 dark:text-blue-400' : ''
                            }`}
                          />
                        </button>

                        {stateMenuOpen && (
                          <div className="absolute right-0 top-full mt-1.5 w-36 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg shadow-xl py-1 z-30 animate-in fade-in zoom-in-95 duration-100">
                            <button
                              type="button"
                              onClick={() => {
                                setFilter('state', 'open');
                                setStateMenuOpen(false);
                              }}
                              className={`w-full px-3 py-1.5 text-xs flex items-center justify-between transition-colors cursor-pointer ${
                                filters.state === 'open'
                                  ? 'bg-blue-50 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300 font-medium'
                                  : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-white'
                              }`}
                            >
                              <span>Open</span>
                              {filters.state === 'open' && <Check size={13} className="text-blue-600 dark:text-blue-400" />}
                            </button>

                            <button
                              type="button"
                              onClick={() => {
                                setFilter('state', 'closed');
                                setStateMenuOpen(false);
                              }}
                              className={`w-full px-3 py-1.5 text-xs flex items-center justify-between transition-colors cursor-pointer ${
                                filters.state === 'closed'
                                  ? 'bg-blue-50 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300 font-medium'
                                  : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-white'
                              }`}
                            >
                              <span>Closed</span>
                              {filters.state === 'closed' && <Check size={13} className="text-blue-600 dark:text-blue-400" />}
                            </button>
                          </div>
                        )}
                      </div>

                      {/* Custom Repository Dropdown */}
                      <div className="relative" ref={repoMenuRef}>
                        <button
                          type="button"
                          onClick={() => {
                            if (repoMenuOpen) setShowAllRepos(false);
                            setRepoMenuOpen(!repoMenuOpen);
                          }}
                          aria-label="Filter by repository"
                          aria-haspopup="true"
                          aria-expanded={repoMenuOpen}
                          className="flex items-center gap-1.5 rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 text-slate-700 dark:text-slate-300 hover:border-slate-300 dark:hover:border-slate-700 hover:text-slate-900 dark:hover:text-white py-1 px-2.5 transition-colors text-xs cursor-pointer select-none shadow-xs"
                        >
                          <FolderGit size={13} className="text-slate-400 dark:text-slate-500" />
                          <span>Repository</span>
                          <ChevronDown
                            size={12}
                            className={`text-slate-400 dark:text-slate-500 transition-transform duration-150 ${
                              repoMenuOpen ? 'rotate-180 text-blue-600 dark:text-blue-400' : ''
                            }`}
                          />
                        </button>

                        {repoMenuOpen && (
                          <div className="absolute right-0 top-full mt-1.5 w-56 max-h-60 overflow-y-auto bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg shadow-xl py-1 z-30 animate-in fade-in zoom-in-95 duration-100">
                            {dropdownOrgs.map(org => (
                              <div key={org} className="py-1">
                                <button
                                  type="button"
                                  onClick={() => {
                                    handleOrgRepoChange(`org:${org}`);
                                    setRepoMenuOpen(false);
                                    setShowAllRepos(false);
                                  }}
                                  className={`w-full px-3 py-1.5 text-xs text-left font-bold uppercase tracking-wider flex items-center justify-between transition-colors cursor-pointer ${
                                    filters.org === org && !filters.repo
                                      ? 'bg-blue-50 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300'
                                      : 'text-slate-500 dark:text-slate-400 bg-slate-100/50 dark:bg-slate-950/40 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-white'
                                  }`}
                                >
                                  <span className="truncate">{org}</span>
                                  {filters.org === org && !filters.repo && (
                                    <Check size={13} className="text-blue-600 dark:text-blue-400" />
                                  )}
                                </button>
                                {(dropdownReposByOrg[org] || []).map(r => (
                                  <button
                                    key={r}
                                    type="button"
                                    onClick={() => {
                                      handleOrgRepoChange(`repo:${r}`);
                                      setRepoMenuOpen(false);
                                      setShowAllRepos(false);
                                    }}
                                    className={`w-full pl-6 pr-3 py-1.5 text-xs flex items-center justify-between transition-colors cursor-pointer ${
                                      filters.repo === r
                                        ? 'bg-blue-50 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300 font-medium'
                                        : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-white'
                                    }`}
                                  >
                                    <span className="truncate">{r}</span>
                                    {filters.repo === r && <Check size={13} className="text-blue-600 dark:text-blue-400" />}
                                  </button>
                                ))}
                              </div>
                            ))}
                            {dropdownOrgs.length === 0 && (
                              <div className="px-3 py-2 text-xs text-slate-500 italic">No repositories found</div>
                            )}
                            {!showAllRepos && hasMoreRepos && (
                              <>
                                <div className="border-t border-slate-200 dark:border-slate-800 my-1" />
                                <button
                                  type="button"
                                  onClick={() => setShowAllRepos(true)}
                                  className="w-full px-3 py-1.5 text-xs flex items-center justify-center text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/50 transition-colors cursor-pointer font-medium"
                                >
                                  Show all
                                </button>
                              </>
                            )}
                          </div>
                        )}
                      </div>

                      {/* Custom Author Dropdown */}
                      <div className="relative" ref={authorMenuRef}>
                        <button
                          type="button"
                          onClick={() => {
                            if (authorMenuOpen) setShowAllAuthors(false);
                            setAuthorMenuOpen(!authorMenuOpen);
                          }}
                          aria-label="Filter by author"
                          aria-haspopup="true"
                          aria-expanded={authorMenuOpen}
                          className="flex items-center gap-1.5 rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 text-slate-700 dark:text-slate-300 hover:border-slate-300 dark:hover:border-slate-700 hover:text-slate-900 dark:hover:text-white py-1 px-2.5 transition-colors text-xs cursor-pointer select-none shadow-xs"
                        >
                          <UserIcon size={13} className="text-slate-400 dark:text-slate-500" />
                          <span>Author</span>
                          <ChevronDown
                            size={12}
                            className={`text-slate-400 dark:text-slate-500 transition-transform duration-150 ${
                              authorMenuOpen ? 'rotate-180 text-blue-600 dark:text-blue-400' : ''
                            }`}
                          />
                        </button>

                        {authorMenuOpen && (
                          <div className="absolute right-0 top-full mt-1.5 w-48 max-h-60 overflow-y-auto bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg shadow-xl py-1 z-30 animate-in fade-in zoom-in-95 duration-100">
                            {authorDropdownList.currentUser && (
                              <>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setFilter('author', authorDropdownList.currentUser);
                                    setAuthorMenuOpen(false);
                                    setShowAllAuthors(false);
                                  }}
                                  className={`w-full px-3 py-1.5 text-xs flex items-center justify-between transition-colors cursor-pointer ${
                                    filters.author === authorDropdownList.currentUser
                                      ? 'bg-blue-50 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300 font-medium'
                                      : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-white'
                                  }`}
                                >
                                  <span className="truncate font-medium">@{authorDropdownList.currentUser} (you)</span>
                                  {filters.author === authorDropdownList.currentUser && (
                                    <Check size={13} className="text-blue-600 dark:text-blue-400" />
                                  )}
                                </button>
                                {authorDropdownList.otherAuthors.length > 0 && (
                                  <div className="border-t border-slate-200 dark:border-slate-800 my-1" />
                                )}
                              </>
                            )}
                            {authorDropdownList.otherAuthors.map(author => (
                              <button
                                key={author}
                                type="button"
                                onClick={() => {
                                  setFilter('author', author);
                                  setAuthorMenuOpen(false);
                                  setShowAllAuthors(false);
                                }}
                                className={`w-full px-3 py-1.5 text-xs flex items-center justify-between transition-colors cursor-pointer ${
                                  filters.author === author
                                    ? 'bg-blue-50 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300 font-medium'
                                    : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-white'
                                }`}
                              >
                                <span className="truncate">@{author}</span>
                                {filters.author === author && <Check size={13} className="text-blue-600 dark:text-blue-400" />}
                              </button>
                            ))}
                            {!authorDropdownList.currentUser && authorDropdownList.otherAuthors.length === 0 && (
                              <div className="px-3 py-2 text-xs text-slate-400 dark:text-slate-500 italic">No authors found</div>
                            )}
                            {!showAllAuthors && hasMoreAuthors && (
                              <>
                                <div className="border-t border-slate-200 dark:border-slate-800 my-1" />
                                <button
                                  type="button"
                                  onClick={() => setShowAllAuthors(true)}
                                  className="w-full px-3 py-1.5 text-xs flex items-center justify-center text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/50 transition-colors cursor-pointer font-medium"
                                >
                                  Show all
                                </button>
                              </>
                            )}
                          </div>
                        )}
                      </div>

                      {/* Custom Milestone Dropdown */}
                      <div className="relative" ref={milestoneMenuRef}>
                        <button
                          type="button"
                          onClick={() => {
                            if (milestoneMenuOpen) setShowAllMilestones(false);
                            setMilestoneMenuOpen(!milestoneMenuOpen);
                          }}
                          aria-label="Filter by milestone"
                          aria-haspopup="true"
                          aria-expanded={milestoneMenuOpen}
                          className="flex items-center gap-1.5 rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 text-slate-700 dark:text-slate-300 hover:border-slate-300 dark:hover:border-slate-700 hover:text-slate-900 dark:hover:text-white py-1 px-2.5 transition-colors text-xs cursor-pointer select-none shadow-xs"
                        >
                          <MilestoneIcon size={13} className="text-slate-400 dark:text-slate-500" />
                          <span>Milestone</span>
                          <ChevronDown
                            size={12}
                            className={`text-slate-400 dark:text-slate-500 transition-transform duration-150 ${
                              milestoneMenuOpen ? 'rotate-180 text-blue-600 dark:text-blue-400' : ''
                            }`}
                          />
                        </button>

                        {milestoneMenuOpen && (
                          <div className="absolute right-0 top-full mt-1.5 w-48 max-h-60 overflow-y-auto bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg shadow-xl py-1 z-30 animate-in fade-in zoom-in-95 duration-100">
                            {currentMilestonesList.map(milestone => (
                              <button
                                key={milestone}
                                type="button"
                                onClick={() => {
                                  setFilter('milestone', milestone);
                                  setMilestoneMenuOpen(false);
                                  setShowAllMilestones(false);
                                }}
                                className={`w-full px-3 py-1.5 text-xs flex items-center justify-between transition-colors cursor-pointer ${
                                  filters.milestone === milestone
                                    ? 'bg-blue-50 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300 font-medium'
                                    : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-white'
                                }`}
                              >
                                <span className="truncate">{milestone}</span>
                                {filters.milestone === milestone && <Check size={13} className="text-blue-600 dark:text-blue-400" />}
                              </button>
                            ))}
                            {currentMilestonesList.length === 0 && (
                              <div className="px-3 py-2 text-xs text-slate-400 dark:text-slate-500 italic">No milestones found</div>
                            )}
                            {!showAllMilestones && hasMoreMilestones && (
                              <>
                                <div className="border-t border-slate-200 dark:border-slate-800 my-1" />
                                <button
                                  type="button"
                                  onClick={() => setShowAllMilestones(true)}
                                  className="w-full px-3 py-1.5 text-xs flex items-center justify-center text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/50 transition-colors cursor-pointer font-medium"
                                >
                                  Show all
                                </button>
                              </>
                            )}
                          </div>
                        )}
                      </div>

                      {/* Custom Label Dropdown */}
                      <div className="relative" ref={labelMenuRef}>
                        <button
                          type="button"
                          onClick={() => {
                            if (labelMenuOpen) setShowAllLabels(false);
                            setLabelMenuOpen(!labelMenuOpen);
                          }}
                          aria-label="Filter by label"
                          aria-haspopup="true"
                          aria-expanded={labelMenuOpen}
                          className="flex items-center gap-1.5 rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 text-slate-700 dark:text-slate-300 hover:border-slate-300 dark:hover:border-slate-700 hover:text-slate-900 dark:hover:text-white py-1 px-2.5 transition-colors text-xs cursor-pointer select-none shadow-xs"
                        >
                          <LabelIcon size={13} className="text-slate-400 dark:text-slate-500" />
                          <span>Label</span>
                          <ChevronDown
                            size={12}
                            className={`text-slate-400 dark:text-slate-500 transition-transform duration-150 ${
                              labelMenuOpen ? 'rotate-180 text-blue-600 dark:text-blue-400' : ''
                            }`}
                          />
                        </button>

                        {labelMenuOpen && (
                          <div className="absolute right-0 top-full mt-1.5 w-52 max-h-60 overflow-y-auto bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg shadow-xl py-1 z-30 animate-in fade-in zoom-in-95 duration-100">
                            {currentLabelsList.map(lbl => (
                              <button
                                key={lbl.name}
                                type="button"
                                onClick={() => {
                                  setFilter('label', lbl.name || null);
                                  setLabelMenuOpen(false);
                                  setShowAllLabels(false);
                                }}
                                className={`w-full px-3 py-1.5 text-xs flex items-center justify-between transition-colors cursor-pointer ${
                                  filters.label?.toLowerCase() === lbl.name?.toLowerCase()
                                    ? 'bg-blue-50 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300 font-medium'
                                    : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-white'
                                }`}
                              >
                                <span className="flex items-center gap-1.5 truncate">
                                  <span
                                    className="w-2 h-2 rounded-full shrink-0 border border-slate-300 dark:border-slate-700"
                                    style={{ backgroundColor: lbl.color ? `#${lbl.color.replace(/^#/, '')}` : '#888' }}
                                  />
                                  <span className="truncate">{lbl.name}</span>
                                </span>
                                {filters.label?.toLowerCase() === lbl.name?.toLowerCase() && (
                                  <Check size={13} className="text-blue-600 dark:text-blue-400 shrink-0 ml-1" />
                                )}
                              </button>
                            ))}
                            {currentLabelsList.length === 0 && (
                              <div className="px-3 py-2 text-xs text-slate-400 dark:text-slate-500 italic">No labels found</div>
                            )}
                            {!showAllLabels && hasMoreLabels && (
                              <>
                                <div className="border-t border-slate-200 dark:border-slate-800 my-1" />
                                <button
                                  type="button"
                                  onClick={() => setShowAllLabels(true)}
                                  className="w-full px-3 py-1.5 text-xs flex items-center justify-center text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/50 transition-colors cursor-pointer font-medium"
                                >
                                  Show all
                                </button>
                              </>
                            )}
                          </div>
                        )}
                      </div>

                      {/* Assigned to me toggle */}
                      <button
                        type="button"
                        onClick={() => setFilter('assigned', filters.assigned === 'me' ? 'all' : 'me')}
                        className={`inline-flex items-center gap-1.5 py-1 px-2.5 rounded-md border text-xs font-medium transition-colors cursor-pointer shadow-xs ${
                          filters.assigned === 'me'
                            ? 'bg-blue-50 dark:bg-blue-950/80 border-blue-300 dark:border-blue-500/80 text-blue-700 dark:text-blue-200'
                            : 'bg-white dark:bg-slate-900/80 border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400 hover:border-slate-300 dark:hover:border-slate-700 hover:text-slate-900 dark:hover:text-slate-200'
                        }`}
                        title={currentUser ? `Assigned to @${currentUser}` : 'Assigned to me'}
                      >
                        <UserCheck
                          size={13}
                          className={filters.assigned === 'me' ? 'text-blue-600 dark:text-blue-400' : 'text-slate-400 dark:text-slate-500'}
                        />
                        <span>Assigned to me</span>
                      </button>
                    </div>
                  </div>

                  {/* Row 3: Active Chips & Clear Filters Row */}
                  {hasActiveChips && (
                    <div className="flex items-center justify-between gap-4 pt-1">
                      {/* Active Filter Chips */}
                      <div className="flex flex-wrap items-center gap-1.5 text-xs">
                        {filters.state !== 'all' && (
                          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 bg-blue-50 dark:bg-blue-950/60 border border-blue-200 dark:border-blue-700/50 text-blue-800 dark:text-blue-300 rounded text-xs font-medium">
                            <span className="text-blue-600 dark:text-blue-400/80">State:</span>
                            <span className="font-semibold capitalize">
                              {filters.state === 'open' ? 'Open' : 'Closed'}
                            </span>
                            <button
                              type="button"
                              onClick={() => setFilter('state', 'all')}
                              className="hover:bg-blue-200/60 dark:hover:bg-blue-900/80 p-0.5 rounded text-blue-600 dark:text-blue-300 hover:text-blue-900 dark:hover:text-white transition-colors cursor-pointer"
                              title="Remove state filter"
                              aria-label="Remove state filter"
                            >
                              <X size={12} />
                            </button>
                          </span>
                        )}

                        {filters.repo && (
                          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 bg-blue-50 dark:bg-blue-950/60 border border-blue-200 dark:border-blue-700/50 text-blue-800 dark:text-blue-300 rounded text-xs font-medium">
                            <span className="text-blue-600 dark:text-blue-400/80">Repo:</span>
                            <span className="font-semibold">{filters.repo}</span>
                            <button
                              type="button"
                              onClick={() => setFilter('repo', null)}
                              className="hover:bg-blue-200/60 dark:hover:bg-blue-900/80 p-0.5 rounded text-blue-600 dark:text-blue-300 hover:text-blue-900 dark:hover:text-white transition-colors cursor-pointer"
                              title="Remove repository filter"
                              aria-label="Remove repository filter"
                            >
                              <X size={12} />
                            </button>
                          </span>
                        )}

                        {filters.org && !filters.repo && (
                          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 bg-blue-50 dark:bg-blue-950/60 border border-blue-200 dark:border-blue-700/50 text-blue-800 dark:text-blue-300 rounded text-xs font-medium">
                            <span className="text-blue-600 dark:text-blue-400/80">Org:</span>
                            <span className="font-semibold">{filters.org}</span>
                            <button
                              type="button"
                              onClick={() => setFilter('org', null)}
                              className="hover:bg-blue-200/60 dark:hover:bg-blue-900/80 p-0.5 rounded text-blue-600 dark:text-blue-300 hover:text-blue-900 dark:hover:text-white transition-colors cursor-pointer"
                              title="Remove organization filter"
                              aria-label="Remove organization filter"
                            >
                              <X size={12} />
                            </button>
                          </span>
                        )}

                        {filters.author && (
                          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 bg-blue-50 dark:bg-blue-950/60 border border-blue-200 dark:border-blue-700/50 text-blue-800 dark:text-blue-300 rounded text-xs font-medium">
                            <span className="text-blue-600 dark:text-blue-400/80">Author:</span>
                            <span className="font-semibold">@{filters.author}</span>
                            <button
                              type="button"
                              onClick={() => setFilter('author', null)}
                              className="hover:bg-blue-200/60 dark:hover:bg-blue-900/80 p-0.5 rounded text-blue-600 dark:text-blue-300 hover:text-blue-900 dark:hover:text-white transition-colors cursor-pointer"
                              title="Remove author filter"
                              aria-label="Remove author filter"
                            >
                              <X size={12} />
                            </button>
                          </span>
                        )}

                        {filters.milestone && (
                          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 bg-blue-50 dark:bg-blue-950/60 border border-blue-200 dark:border-blue-700/50 text-blue-800 dark:text-blue-300 rounded text-xs font-medium">
                            <span className="text-blue-600 dark:text-blue-400/80">Milestone:</span>
                            <span className="font-semibold">{filters.milestone}</span>
                            <button
                              type="button"
                              onClick={() => setFilter('milestone', null)}
                              className="hover:bg-blue-200/60 dark:hover:bg-blue-900/80 p-0.5 rounded text-blue-600 dark:text-blue-300 hover:text-blue-900 dark:hover:text-white transition-colors cursor-pointer"
                              title="Remove milestone filter"
                              aria-label="Remove milestone filter"
                            >
                              <X size={12} />
                            </button>
                          </span>
                        )}

                        {filters.label && (
                          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 bg-blue-50 dark:bg-blue-950/60 border border-blue-200 dark:border-blue-700/50 text-blue-800 dark:text-blue-300 rounded text-xs font-medium">
                            <span className="text-blue-600 dark:text-blue-400/80">Label:</span>
                            <span className="font-semibold">{filters.label}</span>
                            <button
                              type="button"
                              onClick={() => setFilter('label', null)}
                              className="hover:bg-blue-200/60 dark:hover:bg-blue-900/80 p-0.5 rounded text-blue-600 dark:text-blue-300 hover:text-blue-900 dark:hover:text-white transition-colors cursor-pointer"
                              title="Remove label filter"
                              aria-label="Remove label filter"
                            >
                              <X size={12} />
                            </button>
                          </span>
                        )}

                        {filters.assigned === 'me' && (
                          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 bg-blue-50 dark:bg-blue-950/60 border border-blue-200 dark:border-blue-700/50 text-blue-800 dark:text-blue-300 rounded text-xs font-medium">
                            <span className="text-blue-600 dark:text-blue-400/80">Assigned:</span>
                            <span className="font-semibold">Me</span>
                            <button
                              type="button"
                              onClick={() => setFilter('assigned', 'all')}
                              className="hover:bg-blue-200/60 dark:hover:bg-blue-900/80 p-0.5 rounded text-blue-600 dark:text-blue-300 hover:text-blue-900 dark:hover:text-white transition-colors cursor-pointer"
                              title="Remove assigned filter"
                              aria-label="Remove assigned filter"
                            >
                              <X size={12} />
                            </button>
                          </span>
                        )}
                      </div>

                      {/* Right-aligned Clear filters button */}
                      <button
                        type="button"
                        onClick={clearSecondaryFilters}
                        aria-label="Reset filters"
                        className="inline-flex items-center gap-1 text-xs text-slate-500 dark:text-slate-400 hover:text-blue-600 dark:hover:text-blue-300 cursor-pointer transition-colors shrink-0"
                      >
                        <X size={13} />
                        <span>Clear filters</span>
                      </button>
                    </div>
                  )}
                </div>

                <div className="flex-1" />
              </div>
            </header>

            <div className="flex-1 overflow-y-auto" ref={scrollContainerRef}>
              <div className="flex min-h-full w-full">
                <div className={`transition-all duration-300 ease-in-out ${selectedItem ? 'w-6 flex-none' : 'flex-1'}`} />

                <div className="max-w-4xl w-full shrink-0 border-x border-slate-200/70 dark:border-slate-800/50 min-h-full bg-white dark:bg-slate-950">
                  {/* Top of list row: Item count left-aligned, subtle borderless sort control right-aligned */}
                  <div className="flex items-center justify-between px-4 py-2 border-b border-slate-200/70 dark:border-slate-800/40 text-xs select-none">
                    <span className="text-xs text-slate-500 dark:text-slate-400 font-mono">
                      {filteredItems.length} {filteredItems.length === 1 ? 'item' : 'items'}
                    </span>

                    <div className="relative" ref={sortMenuRef}>
                      <button
                        type="button"
                        onClick={() => setSortMenuOpen(!sortMenuOpen)}
                        aria-label="Sort options"
                        aria-haspopup="true"
                        aria-expanded={sortMenuOpen}
                        className="flex items-center gap-1 text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200 px-1 py-0.5 rounded transition-colors cursor-pointer text-xs"
                      >
                        <span>
                          {filters.sort === 'updated'
                            ? 'Latest Activity'
                            : filters.sort === 'acked'
                            ? 'Last Acked'
                            : 'Creation Date'}
                        </span>
                        <ChevronDown
                          size={12}
                          className={`text-slate-400 dark:text-slate-500 transition-transform duration-150 ${
                            sortMenuOpen ? 'rotate-180 text-blue-600 dark:text-blue-400' : ''
                          }`}
                        />
                      </button>

                      {sortMenuOpen && (
                        <div className="absolute right-0 top-full mt-1 w-36 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg shadow-xl py-1 z-30 animate-in fade-in zoom-in-95 duration-100">
                          <button
                            type="button"
                            onClick={() => {
                              setFilter('sort', 'updated');
                              setSortMenuOpen(false);
                            }}
                            className={`w-full px-3 py-1.5 text-xs flex items-center justify-between transition-colors cursor-pointer ${
                              filters.sort === 'updated'
                                ? 'bg-blue-50 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300 font-medium'
                                : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-white'
                            }`}
                          >
                            <span>Latest Activity</span>
                            {filters.sort === 'updated' && <Check size={12} className="text-blue-600 dark:text-blue-400" />}
                          </button>

                          <button
                            type="button"
                            onClick={() => {
                              setFilter('sort', 'acked');
                              setSortMenuOpen(false);
                            }}
                            className={`w-full px-3 py-1.5 text-xs flex items-center justify-between transition-colors cursor-pointer ${
                              filters.sort === 'acked'
                                ? 'bg-blue-50 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300 font-medium'
                                : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-white'
                            }`}
                          >
                            <span>Last Acked</span>
                            {filters.sort === 'acked' && <Check size={12} className="text-blue-600 dark:text-blue-400" />}
                          </button>

                          <button
                            type="button"
                            onClick={() => {
                              setFilter('sort', 'created');
                              setSortMenuOpen(false);
                            }}
                            className={`w-full px-3 py-1.5 text-xs flex items-center justify-between transition-colors cursor-pointer ${
                              filters.sort === 'created'
                                ? 'bg-blue-50 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300 font-medium'
                                : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-white'
                            }`}
                          >
                            <span>Creation Date</span>
                            {filters.sort === 'created' && <Check size={12} className="text-blue-600 dark:text-blue-400" />}
                          </button>

                          <div className="border-t border-slate-200 dark:border-slate-800 my-1" />

                          <button
                            type="button"
                            onClick={() => {
                              setFilter('order', 'asc');
                              setSortMenuOpen(false);
                            }}
                            className={`w-full px-3 py-1.5 text-xs flex items-center justify-between transition-colors cursor-pointer ${
                              filters.order === 'asc'
                                ? 'bg-blue-50 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300 font-medium'
                                : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-white'
                            }`}
                          >
                            <span>Ascending</span>
                            {filters.order === 'asc' && <Check size={12} className="text-blue-600 dark:text-blue-400" />}
                          </button>

                          <button
                            type="button"
                            onClick={() => {
                              setFilter('order', 'desc');
                              setSortMenuOpen(false);
                            }}
                            className={`w-full px-3 py-1.5 text-xs flex items-center justify-between transition-colors cursor-pointer ${
                              filters.order === 'desc'
                                ? 'bg-blue-50 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300 font-medium'
                                : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-white'
                            }`}
                          >
                            <span>Descending</span>
                            {filters.order === 'desc' && <Check size={12} className="text-blue-600 dark:text-blue-400" />}
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                  {filteredItems.map(item => (
                    <div
                      key={item.id}
                      data-item-id={item.id}
                      className={dismissingIds.has(item.id) ? 'animate-item-ack' : ''}
                    >
                      <PullRequestCard
                        item={item}
                        isSelected={selectedItemId === item.id}
                        isFocused={focusedItemId === item.id}
                        onSelect={() => setFilter('item', selectedItemId === item.id ? null : item.id)}
                        onAck={handleAck}
                        onUnack={handleUnack}
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
                        OctoDeck daemon is currently unreachable. Please run <code className="bg-red-100 dark:bg-red-900/60 px-1 py-0.5 rounded font-mono text-xs">octodeck serve</code> to start the backend server.
                      </p>
                    </div>
                  ) : filteredItems.length === 0 ? (
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
              selectedItem ? 'translate-x-0 pointer-events-auto' : 'translate-x-full pointer-events-none'
            }`}
          >
            {(selectedItem || recentItem) && (
              <DetailsPane
                item={selectedItem || recentItem!}
                onAck={handleAck}
                onUnack={handleUnack}
                onStar={handleStar}
                onSetNotes={handleSetNotes}
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
