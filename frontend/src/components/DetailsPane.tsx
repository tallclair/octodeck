import { useRef, useEffect, useState, Fragment } from 'react';
import {
    GitPullRequest, GitPullRequestDraft, GitPullRequestClosed, AlertCircle,
    CheckCircle2, GitCommit, X,
    ChevronDown, ChevronRight, FileCode, XCircle, Star, CornerDownRight, ExternalLink, Milestone,
    GitMerge, CircleSlash, RotateCcw, AlertTriangle, UserCheck
} from 'lucide-react';
import type { Item } from '../api/octodeck/v1/resources_pb';
import {
    ItemType as ProtoItemType,
    ItemState as ProtoItemState,
    ItemStatus as ProtoItemStatus,
    SubscriptionState,
} from '../api/octodeck/v1/resources_pb';
import { BotSummary } from './BotSummary';
import { Markdown } from './Markdown';
import { formatFuzzyTime, formatExactDateTime } from '../utils/time';
import { getLabelStyle } from '../utils/labels';
import { stripHtmlComments } from '../utils/text';
import { buildTimeline, getProtoTimestampMs, getLatestNonNoiseActivityMs, getCiFailureSummary, formatReviewCommentSummary, getFilesViewUrl } from '../logic/timeline';

interface DetailsPaneProps {
    item: Item;
    onAck: (id: string) => Promise<void> | void;
    onUnack: (id: string) => Promise<void> | void;
    onStar?: (id: string, starred: boolean) => Promise<void> | void;
    onSetNotes?: (id: string, notes: string) => Promise<void> | void;
    knownBots?: string[];
    onClose: () => void;
    showItemId?: boolean;
    onOpenDebug?: (targetItemId?: string) => void;
}



export function DetailsPane({
    item,
    onAck,
    onUnack,
    onStar,
    onSetNotes,
    onClose,
    showItemId = false,
    onOpenDebug,
}: DetailsPaneProps) {
    const repoName = item.repo;
    const number = item.number;
    const title = item.title;
    const body = item.body || '';
    const url = item.url;
    const isPr = item.type === ProtoItemType.PR || item.url.includes('/pull/');
    const isDraft = Boolean(item.isDraft);
    const isDraftPr = isPr && isDraft;
    const isOpen = item.state === ProtoItemState.OPEN;
    const stateText = isOpen ? (isDraftPr ? 'DRAFT' : 'OPEN') : item.state === ProtoItemState.MERGED ? 'MERGED' : 'CLOSED';
    const isAcked = item.local?.computedStatus === ProtoItemStatus.ACKED;
    const isStarred = Boolean(item.local?.starred);
    const isUntracked = item.viewerSubscription === SubscriptionState.UNSUBSCRIBED || (item.viewerSubscription as number) === 2;
    const initialNotes = item.local?.privateNotes || '';
    const authorLogin = item.author?.login || 'unknown';
    const authorAvatar = item.author?.avatarUrl || 'https://github.com/ghost.png';
    const updatedAtMs = getLatestNonNoiseActivityMs(item);

    const lastViewedAtMs = getProtoTimestampMs(item.local?.lastViewedAt) || null;
    const ackedAtMs = getProtoTimestampMs(item.local?.ackedAt) || null;

    const [prevItemKey, setPrevItemKey] = useState({ id: item.id, initialNotes });
    const [notes, setNotes] = useState(initialNotes);
    const [isNotesExpanded, setIsNotesExpanded] = useState<boolean>(() => Boolean(initialNotes && initialNotes.trim().length > 0));

    if (item.id !== prevItemKey.id || initialNotes !== prevItemKey.initialNotes) {
        setPrevItemKey({ id: item.id, initialNotes });
        setNotes(initialNotes);
        setIsNotesExpanded(Boolean(initialNotes && initialNotes.trim().length > 0));
    }

    const scrollRef = useRef<HTMLDivElement>(null);
    const timeline = buildTimeline(item);
    const ciSummary = getCiFailureSummary(timeline);

    useEffect(() => {
        if (scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
    }, [item.id]);



    return (
        <div className="h-full flex flex-col bg-white dark:bg-slate-900 shadow-xl w-full">
            {/* Header */}
            <div className="p-4 border-b border-slate-200 dark:border-slate-800 flex flex-col gap-3 shrink-0 bg-slate-50/50 dark:bg-slate-900">
                <div className="flex items-center justify-between gap-4">
                    <div className="flex items-center gap-2 text-slate-500 dark:text-slate-400 text-xs font-mono flex-wrap">
                        {isPr ? (
                            isOpen && isDraft ? (
                                <GitPullRequestDraft size={14} className="text-slate-500 dark:text-slate-400" aria-label="Draft Pull Request" />
                            ) : item.state === ProtoItemState.MERGED ? (
                                <GitMerge size={14} className="text-purple-600 dark:text-purple-400" aria-label="Merged Pull Request" />
                            ) : item.state === ProtoItemState.CLOSED ? (
                                <GitPullRequestClosed size={14} className="text-red-600 dark:text-red-400" aria-label="Closed Pull Request" />
                            ) : (
                                <GitPullRequest size={14} className="text-green-600 dark:text-green-400" aria-label="Open Pull Request" />
                            )
                        ) : item.state === ProtoItemState.CLOSED ? (
                            <CircleSlash size={14} className="text-red-600 dark:text-red-400" aria-label="Closed Issue" />
                        ) : (
                            <AlertCircle size={14} className="text-green-600 dark:text-green-400" aria-label="Open Issue" />
                        )}
                        <span>{repoName} #{number}</span>
                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold border ${
                            isOpen
                                ? isDraftPr
                                    ? 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 border-slate-300 dark:border-slate-700'
                                    : 'bg-green-100 dark:bg-green-500/20 text-green-700 dark:text-green-400 border-green-200 dark:border-green-500/30'
                                : item.state === ProtoItemState.MERGED
                                    ? 'bg-purple-100 dark:bg-purple-500/20 text-purple-700 dark:text-purple-400 border-purple-200 dark:border-purple-500/30'
                                    : 'bg-red-100 dark:bg-red-500/20 text-red-700 dark:text-red-400 border-red-200 dark:border-red-500/30'
                        }`}>
                            {stateText}
                        </span>
                        {isUntracked && (
                            <span
                                className="px-1.5 py-0.5 rounded text-[10px] font-bold border bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 border-slate-300 dark:border-slate-700 font-sans"
                                title="You are unsubscribed from notifications on this item (untracked)"
                                data-testid="details-untracked-badge"
                            >
                                Untracked
                            </span>
                        )}
                        {item.milestone?.title && (
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700 font-sans">
                                <Milestone size={11} className="text-slate-400 dark:text-slate-500 shrink-0" />
                                <span>{item.milestone.title}</span>
                            </span>
                        )}
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                        {isPr && url && (
                            <a
                                href={getFilesViewUrl(url)}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 hover:text-slate-900 dark:hover:text-slate-100 text-xs font-medium transition-colors border border-slate-200 dark:border-transparent"
                                title="View Changes on GitHub"
                            >
                                <FileCode size={14} /> View Changes
                            </a>
                        )}
                        {onStar && (
                            <button
                                onClick={() => onStar(item.id, !isStarred)}
                                className={`flex items-center gap-1.5 px-3 py-1.5 rounded bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-xs font-medium transition-colors cursor-pointer border border-slate-200 dark:border-transparent ${
                                    isStarred ? 'text-amber-500 dark:text-amber-400' : 'text-slate-700 dark:text-slate-300 hover:text-amber-500 dark:hover:text-amber-300'
                                }`}
                                title={isStarred ? 'Unstar Item' : 'Star Item'}
                            >
                                <Star size={14} className={isStarred ? 'fill-amber-400 text-amber-500 dark:fill-amber-400 dark:text-amber-400' : ''} />
                                {isStarred ? 'Starred' : 'Star'}
                            </button>
                        )}
                        {isAcked ? (
                            <button
                                onClick={() => onUnack(item.id)}
                                className="flex items-center gap-2 px-3 py-1.5 rounded bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-green-600 dark:text-green-400 hover:text-green-700 dark:hover:text-green-300 text-xs font-medium transition-colors border border-slate-200 dark:border-transparent cursor-pointer"
                                title="Move back to Inbox"
                            >
                                <CheckCircle2 size={14} className="text-green-600 dark:text-green-400" /> Acked
                            </button>
                        ) : (
                            <button
                                onClick={() => onAck(item.id)}
                                className="flex items-center gap-2 px-3 py-1.5 rounded bg-slate-100 dark:bg-slate-800 hover:bg-green-100 dark:hover:bg-green-900/30 text-slate-700 dark:text-slate-300 hover:text-green-700 dark:hover:text-green-400 text-xs font-medium transition-colors border border-slate-200 dark:border-transparent cursor-pointer"
                                title="Ack: Hide until new activity"
                            >
                                <CheckCircle2 size={14} /> Ack
                            </button>
                        )}
                        <button
                            onClick={onClose}
                            aria-label="Close details pane"
                            className="p-1.5 text-slate-400 hover:text-slate-700 dark:hover:text-slate-300 cursor-pointer rounded hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
                        >
                            <X size={20} />
                        </button>
                    </div>
                </div>

                <div>
                    <a
                        href={url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-start gap-2 text-lg font-semibold text-slate-900 dark:text-slate-100 leading-snug break-words hover:text-blue-600 dark:hover:text-blue-400 hover:underline decoration-blue-500/50 decoration-2 underline-offset-2 transition-colors group"
                        title="Open on GitHub"
                    >
                        <span>{title}</span>
                        <ExternalLink size={16} className="shrink-0 text-slate-400 group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors mt-1" />
                    </a>
                </div>

                {showItemId && (
                    <div className="text-xs font-mono text-slate-400 dark:text-slate-500">
                        <span
                            className={onOpenDebug ? 'cursor-pointer hover:text-blue-600 dark:hover:text-blue-400 hover:underline' : ''}
                            onClick={() => onOpenDebug?.(item.id)}
                            title="Open in Debug Browser"
                        >
                            ID: {item.id}
                        </span>
                    </div>
                )}

                {item.labels && item.labels.length > 0 && (
                    <div className="flex items-center gap-1.5 flex-wrap" data-testid="details-pane-labels">
                        {item.labels.map((lbl) => (
                            <span
                                key={lbl.name}
                                className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border leading-tight"
                                style={getLabelStyle(lbl.color)}
                            >
                                {lbl.name}
                            </span>
                        ))}
                    </div>
                )}
            </div>

            {/* Scrollable Content */}
            <div className="flex-1 overflow-y-auto p-4 space-y-6" ref={scrollRef}>
                {item.local?.syncError && (
                    <div
                        className="p-3 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-500/30 rounded-lg flex items-center gap-2.5 text-xs text-amber-900 dark:text-amber-300"
                        data-testid="sync-error-banner"
                        title={item.local.syncError}
                    >
                        <AlertTriangle size={16} className="text-amber-600 dark:text-amber-400 shrink-0" />
                        <div className="min-w-0 flex-1">
                            <span className="font-semibold">Sync Warning: </span>
                            <span className="text-amber-800/90 dark:text-amber-300/90">{item.local.syncError}</span>
                        </div>
                    </div>
                )}

                <div className="flex items-center gap-3 p-3 bg-slate-100/70 dark:bg-slate-800/50 rounded-lg border border-slate-200 dark:border-transparent">
                    <img src={authorAvatar} alt={authorLogin} className="w-8 h-8 rounded-full" />
                    <div>
                        <div className="text-sm font-medium text-slate-800 dark:text-slate-200">{authorLogin}</div>
                        <div className="text-xs text-slate-500 dark:text-slate-500" title={formatExactDateTime(updatedAtMs)}>
                            Updated {formatFuzzyTime(updatedAtMs)}
                        </div>
                    </div>
                </div>

                {/* Description */}
                {stripHtmlComments(body).trim() && (
                    <div className="bg-slate-50 dark:bg-slate-800/40 rounded-lg p-4 border border-slate-200 dark:border-slate-700/50">
                        <Markdown content={body} />
                    </div>
                )}

                {/* Timeline */}
                <div className="space-y-4 relative">
                    <div className="absolute left-4 top-0 bottom-0 w-px bg-slate-200 dark:bg-slate-800" />
                    {(() => {
                        const newViewIndex = lastViewedAtMs
                            ? timeline.findIndex(entry => {
                                const t = new Date(entry.timestamp).getTime();
                                return t > lastViewedAtMs;
                            })
                            : -1;

                        const newAckIndex = ackedAtMs
                            ? timeline.findIndex(entry => {
                                const t = new Date(entry.timestamp).getTime();
                                return t > ackedAtMs;
                            })
                            : -1;

                        const suppressLastViewed = (ackedAtMs !== null && ackedAtMs > 0) && (
                            (newViewIndex !== -1 && newViewIndex === newAckIndex) ||
                            (newViewIndex === -1 && newAckIndex === -1)
                        );

                        const showViewDividerIndex = suppressLastViewed ? -1 : newViewIndex;
                        const showAckAtEnd = (ackedAtMs !== null && ackedAtMs > 0) && newAckIndex === -1;

                        const itemsMarkup = timeline.map((entry, idx) => {
                            const isNewView = idx === showViewDividerIndex;
                            const isNewAck = idx === newAckIndex;
                            let content;

                            if (entry.type === 'BOT_SUMMARY') {
                                content = (
                                    <div key={`entry-${idx}`} className="relative py-1">
                                        <div className="absolute left-4 -translate-x-1/2 top-[18px] -translate-y-1/2 h-2 w-2 rounded-full bg-slate-400 dark:bg-slate-700 ring-4 ring-white dark:ring-slate-900 z-10" />
                                        <BotSummary group={entry} />
                                    </div>
                                );
                            } else if (entry.type === 'COMMIT') {
                                content = (
                                    <div key={`entry-${idx}`} className="flex gap-3 text-xs relative items-center py-1">
                                        <div className="absolute left-4 -translate-x-1/2 top-1/2 -translate-y-1/2 h-2 w-2 rounded-full bg-slate-400 dark:bg-slate-500 ring-4 ring-white dark:ring-slate-900 z-10" />
                                        <div className="pl-11 pr-3 flex-1">
                                            <div className="flex justify-between items-baseline gap-2">
                                                <div className="flex items-center gap-2 min-w-0">
                                                    <GitCommit size={12} className="text-slate-400 dark:text-slate-500 shrink-0" />
                                                    <span className="text-slate-600 dark:text-slate-300 truncate">
                                                        New commit pushed by <span className="font-medium text-slate-800 dark:text-slate-200">{entry.authorLogin}</span>
                                                    </span>
                                                </div>
                                                <span className="text-[10px] text-slate-400 shrink-0" title={formatExactDateTime(entry.timestamp)}>
                                                    {formatFuzzyTime(new Date(entry.timestamp).getTime())}
                                                </span>
                                            </div>
                                        </div>
                                    </div>
                                );
                            } else if (entry.type === 'REVIEW') {
                                const isApproved = entry.state === 'APPROVED';
                                const isChangesRequested = entry.state === 'CHANGES_REQUESTED';
                                const isDismissed = entry.state === 'DISMISSED';

                                let stateLabel = 'Reviewed';
                                let stateBadgeColor = 'bg-slate-100 dark:bg-slate-500/20 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-600/30';

                                if (isApproved) {
                                    stateLabel = 'Approved';
                                    stateBadgeColor = 'bg-green-50 dark:bg-green-500/20 text-green-700 dark:text-green-400 border-green-200 dark:border-green-500/30';
                                } else if (isChangesRequested) {
                                    stateLabel = 'Requested changes';
                                    stateBadgeColor = 'bg-red-50 dark:bg-red-500/20 text-red-700 dark:text-red-400 border-red-200 dark:border-red-500/30';
                                } else if (isDismissed) {
                                    stateLabel = 'Dismissed review';
                                    stateBadgeColor = 'bg-amber-50 dark:bg-amber-500/20 text-amber-700 dark:text-amber-400 border-amber-200 dark:border-amber-500/30';
                                }

                                const commentCountSummary = formatReviewCommentSummary(entry) || null;
                                const reviewCommentsPreview = (entry.comments || []).slice(0, 3);
                                const totalReviewComments = entry.commentCount || entry.comments?.length || 0;
                                const remainingCount = totalReviewComments > 3 ? totalReviewComments - 3 : 0;
                                const hasTopBody = Boolean(stripHtmlComments(entry.body || '').trim());

                                content = (
                                    <div key={`entry-${idx}`} className="flex gap-3 text-xs relative group">
                                        <div className="absolute left-[15px] top-6 -ml-px w-px h-full" />
                                        <div className="relative z-10">
                                            <img
                                                src={entry.author.avatarUrl || 'https://github.com/ghost.png'}
                                                alt={entry.author.login}
                                                className="w-8 h-8 rounded-full border-2 border-white dark:border-slate-900 bg-slate-100 dark:bg-slate-800"
                                            />
                                        </div>

                                        <div className="flex-1 min-w-0">
                                            <div className="bg-slate-50 dark:bg-slate-800/90 p-3 rounded-lg rounded-tl-none border border-slate-200 dark:border-slate-700/60 shadow-xs">
                                                <div className={`flex justify-between items-baseline mb-2 flex-wrap gap-2 ${hasTopBody ? 'border-b border-slate-200 dark:border-slate-700/40 pb-2' : ''}`}>
                                                    <div className="flex items-center gap-2 flex-wrap">
                                                        <span className="font-bold text-slate-800 dark:text-slate-200">{entry.author.login}</span>
                                                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold border ${stateBadgeColor}`}>
                                                            {stateLabel}
                                                        </span>
                                                        {commentCountSummary && (
                                                            <span className="text-[10px] text-slate-500 dark:text-slate-400 font-normal">
                                                                • {commentCountSummary}
                                                            </span>
                                                        )}
                                                    </div>
                                                    {entry.url ? (
                                                        <a
                                                            href={entry.url}
                                                            target="_blank"
                                                            rel="noopener noreferrer"
                                                            className="text-[10px] text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:underline cursor-pointer"
                                                            title={formatExactDateTime(entry.timestamp)}
                                                        >
                                                            {formatFuzzyTime(new Date(entry.timestamp).getTime())}
                                                        </a>
                                                    ) : (
                                                        <span className="text-[10px] text-slate-400" title={formatExactDateTime(entry.timestamp)}>
                                                            {formatFuzzyTime(new Date(entry.timestamp).getTime())}
                                                        </span>
                                                    )}
                                                </div>

                                                {hasTopBody && (
                                                    <div className="mb-3 text-sm leading-relaxed">
                                                        <Markdown content={entry.body || ''} />
                                                    </div>
                                                )}

                                                {reviewCommentsPreview.length > 0 && (
                                                    <div className={`space-y-2 ${hasTopBody ? 'mt-2 pt-2 border-t border-slate-200 dark:border-slate-700/40' : 'mt-1'}`}>
                                                        {reviewCommentsPreview.map((rc, rcIdx) => {
                                                            const isReply = Boolean(rc.replyToId);
                                                            return (
                                                                <div
                                                                    key={rc.id || `rc-${rcIdx}`}
                                                                    className="bg-white dark:bg-slate-900/60 p-2.5 rounded border border-slate-200 dark:border-slate-700/50 text-xs leading-relaxed"
                                                                >
                                                                    {rc.path && (
                                                                        <div className="flex items-center gap-1.5 mb-1.5">
                                                                            <FileCode className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400 shrink-0" />
                                                                            {rc.url ? (
                                                                                <a
                                                                                    href={getFilesViewUrl(rc.url)}
                                                                                    target="_blank"
                                                                                    rel="noopener noreferrer"
                                                                                    className="font-mono text-[10px] text-blue-600 dark:text-blue-300 font-medium hover:underline hover:text-blue-700 dark:hover:text-blue-200 truncate max-w-full"
                                                                                >
                                                                                    {rc.path}
                                                                                </a>
                                                                            ) : (
                                                                                <span className="font-mono text-[10px] text-blue-600 dark:text-blue-300 font-medium truncate max-w-full">
                                                                                    {rc.path}
                                                                                </span>
                                                                            )}
                                                                        </div>
                                                                    )}

                                                                    {isReply && (
                                                                        <div className="flex items-center gap-1 text-[10px] text-slate-500 dark:text-slate-400 mb-1.5 font-medium">
                                                                            <CornerDownRight className="w-3 h-3 text-blue-600 dark:text-blue-400 shrink-0" />
                                                                            <span>Reply to comment</span>
                                                                            {rc.url && (
                                                                                <a
                                                                                    href={getFilesViewUrl(rc.url)}
                                                                                    target="_blank"
                                                                                    rel="noopener noreferrer"
                                                                                    className="text-blue-600 dark:text-blue-400 hover:underline ml-1"
                                                                                >
                                                                                    (view thread)
                                                                                </a>
                                                                            )}
                                                                        </div>
                                                                    )}

                                                                    <Markdown content={rc.body} size="compact" />
                                                                </div>
                                                            );
                                                        })}

                                                        {remainingCount > 0 && entry.url && (
                                                            <a
                                                                href={entry.url}
                                                                target="_blank"
                                                                rel="noopener noreferrer"
                                                                className="inline-block text-[11px] text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 font-medium hover:underline pt-1"
                                                            >
                                                                + {remainingCount} more {remainingCount === 1 ? 'comment' : 'comments'} on GitHub →
                                                            </a>
                                                        )}
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    </div>
                                );
                            } else if (entry.type === 'STATE_CHANGE') {
                                let icon;
                                let dotColor;
                                let text;

                                const hasActor = Boolean(entry.actor.login && entry.actor.login !== 'unknown');
                                const actorDisplay = hasActor ? (
                                    <span className="font-medium text-slate-800 dark:text-slate-200">{entry.actor.login}</span>
                                ) : null;

                                if (entry.changeType === 'MERGED') {
                                    icon = <GitMerge size={12} className="text-purple-600 dark:text-purple-400 shrink-0" />;
                                    dotColor = 'bg-purple-600 dark:bg-purple-500';
                                    text = actorDisplay ? (
                                        <>
                                            {actorDisplay} merged
                                        </>
                                    ) : (
                                        'Merged'
                                    );
                                } else if (entry.changeType === 'CLOSED') {
                                    icon = <CircleSlash size={12} className="text-red-600 dark:text-red-400 shrink-0" />;
                                    dotColor = 'bg-red-500 dark:bg-red-400';
                                    text = actorDisplay ? (
                                        <>
                                            {actorDisplay} closed
                                        </>
                                    ) : (
                                        'Closed'
                                    );
                                } else if (entry.changeType === 'ASSIGNED') {
                                    icon = <UserCheck size={12} className="text-blue-600 dark:text-blue-400 shrink-0" />;
                                    dotColor = 'bg-blue-500 dark:bg-blue-400';
                                    text = actorDisplay ? (
                                        <>
                                            {actorDisplay} assigned
                                        </>
                                    ) : (
                                        'Assigned'
                                    );
                                } else {
                                    icon = <RotateCcw size={12} className="text-green-600 dark:text-green-400 shrink-0" />;
                                    dotColor = 'bg-green-500 dark:bg-green-400';
                                    text = actorDisplay ? (
                                        <>
                                            {actorDisplay} reopened
                                        </>
                                    ) : (
                                        'Reopened'
                                    );
                                }

                                content = (
                                    <div key={`entry-${idx}`} className="flex gap-3 text-xs relative items-center py-1" data-testid={`state-change-${entry.changeType.toLowerCase()}`}>
                                        <div className={`absolute left-4 -translate-x-1/2 top-1/2 -translate-y-1/2 h-2 w-2 rounded-full ${dotColor} ring-4 ring-white dark:ring-slate-900 z-10`} />
                                        <div className="pl-11 pr-3 flex-1">
                                            <div className="flex justify-between items-baseline gap-2">
                                                <div className="flex items-center gap-2 min-w-0">
                                                    {icon}
                                                    <span className="text-slate-600 dark:text-slate-300 truncate">
                                                        {text}
                                                    </span>
                                                </div>
                                                {entry.url ? (
                                                    <a
                                                        href={entry.url}
                                                        target="_blank"
                                                        rel="noopener noreferrer"
                                                        className="text-[10px] text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:underline shrink-0"
                                                        title={formatExactDateTime(entry.timestamp)}
                                                    >
                                                        {formatFuzzyTime(new Date(entry.timestamp).getTime())}
                                                    </a>
                                                ) : (
                                                    <span className="text-[10px] text-slate-400 shrink-0" title={formatExactDateTime(entry.timestamp)}>
                                                        {formatFuzzyTime(new Date(entry.timestamp).getTime())}
                                                    </span>
                                                )}
                                            </div>
                                        </div>
                                    </div>
                                );
                            } else {
                                content = (
                                    <div key={`entry-${idx}`} className="flex gap-3 text-xs relative group">
                                        <div className="absolute left-[15px] top-6 -ml-px w-px h-full" />
                                        <div className="relative z-10">
                                            <img
                                                src={entry.data.author.avatarUrl || 'https://github.com/ghost.png'}
                                                alt={entry.data.author.login}
                                                className="w-8 h-8 rounded-full border-2 border-white dark:border-slate-900 bg-slate-100 dark:bg-slate-800"
                                            />
                                        </div>

                                        <div className="flex-1 min-w-0">
                                            <div className="bg-slate-50 dark:bg-slate-800 p-3 rounded-lg rounded-tl-none border border-slate-200 dark:border-slate-700/50">
                                                <div className="flex justify-between items-baseline mb-2">
                                                    <span className="font-bold text-slate-800 dark:text-slate-300">{entry.data.author.login}</span>
                                                    {entry.data.url ? (
                                                        <a
                                                            href={entry.data.url}
                                                            target="_blank"
                                                            rel="noopener noreferrer"
                                                            className="text-[10px] text-slate-400 hover:text-slate-700 dark:hover:text-slate-300 hover:underline cursor-pointer"
                                                            title={formatExactDateTime(entry.timestamp)}
                                                        >
                                                            {formatFuzzyTime(new Date(entry.timestamp).getTime())}
                                                        </a>
                                                    ) : (
                                                        <span className="text-[10px] text-slate-400" title={formatExactDateTime(entry.timestamp)}>
                                                            {formatFuzzyTime(new Date(entry.timestamp).getTime())}
                                                        </span>
                                                    )}
                                                </div>
                                                <Markdown content={entry.data.bodyText} />
                                            </div>
                                        </div>
                                    </div>
                                );
                            }

                            const ackDivider = isNewAck ? (
                                <div key={`ack-divider-${idx}`} className="relative py-4 flex items-center gap-4 pl-8">
                                    <div className="h-px bg-emerald-500/30 flex-1"></div>
                                    <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-600 dark:text-emerald-400">Acknowledged</span>
                                </div>
                            ) : null;

                            const viewDivider = isNewView ? (
                                <div key={`view-divider-${idx}`} className="relative py-4 flex items-center gap-4 pl-8">
                                    <div className="h-px bg-yellow-500/30 flex-1"></div>
                                    <span className="text-[10px] font-bold uppercase tracking-wider text-amber-600 dark:text-yellow-500">Last Viewed</span>
                                </div>
                            ) : null;

                            if (isNewView || isNewAck) {
                                const firstDivider = (ackedAtMs ?? 0) <= (lastViewedAtMs ?? 0) ? ackDivider : viewDivider;
                                const secondDivider = (ackedAtMs ?? 0) <= (lastViewedAtMs ?? 0) ? viewDivider : ackDivider;

                                return (
                                    <Fragment key={`fragment-${idx}`}>
                                        {firstDivider}
                                        {secondDivider}
                                        {content}
                                    </Fragment>
                                );
                            }
                            return content;
                        });

                        const ackDividerAtEnd = showAckAtEnd ? (
                            <div key="ack-divider-end" className="relative py-4 flex items-center gap-4 pl-8">
                                <div className="h-px bg-emerald-500/30 flex-1"></div>
                                <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-600 dark:text-emerald-400">Acknowledged</span>
                            </div>
                        ) : null;

                        return (
                            <Fragment key="timeline-content">
                                {itemsMarkup}
                                {ackDividerAtEnd}
                            </Fragment>
                        );
                    })()}
                </div>

                {/* Consolidated CI / Test Failure Indicator */}
                {ciSummary.hasFailure && (
                    <div className="p-3 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-500/30 rounded-lg flex items-center justify-between gap-3 text-xs">
                        <div className="flex items-center gap-2.5 min-w-0">
                            <XCircle size={16} className="text-red-600 dark:text-red-400 shrink-0" />
                            <div className="min-w-0">
                                <span className="font-semibold text-red-900 dark:text-red-300">CI / Checks Failing</span>
                                <p className="text-[11px] text-red-700/80 dark:text-red-400/80 truncate">
                                    {ciSummary.failureCount === 1
                                        ? '1 automated check or test failed.'
                                        : `${ciSummary.failureCount} automated checks or tests failed.`}
                                </p>
                            </div>
                        </div>
                        {ciSummary.failedComments.length > 0 && ciSummary.failedComments[0].url && (
                            <a
                                href={ciSummary.failedComments[0].url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-[11px] text-red-600 dark:text-red-400 hover:text-red-800 dark:hover:text-red-300 underline shrink-0 cursor-pointer"
                            >
                                View failing job
                            </a>
                        )}
                    </div>
                )}

                {/* Private Notes */}
                <div className="pt-4 border-t border-slate-200 dark:border-slate-800">
                    <button
                        type="button"
                        onClick={() => setIsNotesExpanded(!isNotesExpanded)}
                        className="flex items-center justify-between w-full text-xs font-medium text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 transition-colors py-1 focus:outline-none cursor-pointer"
                        aria-expanded={isNotesExpanded}
                    >
                        <div className="flex items-center gap-1.5">
                            {isNotesExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                            <span>Private Notes (Local Only)</span>
                            {!isNotesExpanded && notes.trim() && (
                                <span className="text-[10px] bg-slate-100 dark:bg-slate-800 text-blue-600 dark:text-blue-400 px-1.5 py-0.5 rounded font-mono border border-slate-200 dark:border-slate-700/50">
                                    has notes
                                </span>
                            )}
                        </div>
                        {!isNotesExpanded && !notes.trim() && (
                            <span className="text-[10px] text-slate-400 dark:text-slate-600">Click to add notes</span>
                        )}
                    </button>
                    {isNotesExpanded && (
                        <div className="mt-2">
                            <textarea
                                value={notes}
                                onChange={(e) => setNotes(e.target.value)}
                                onBlur={() => {
                                    if (onSetNotes && notes !== initialNotes) {
                                        onSetNotes(item.id, notes);
                                    }
                                }}
                                onKeyDown={(e) => {
                                    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                                        e.preventDefault();
                                        if (onSetNotes && notes !== initialNotes) {
                                            onSetNotes(item.id, notes);
                                        }
                                    }
                                }}
                                placeholder="Jot down context, todos, or reminders..."
                                className="w-full bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-800 rounded p-3 text-sm text-slate-800 dark:text-slate-300 placeholder-slate-400 dark:placeholder-slate-600 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-all resize-y"
                                rows={4}
                            />
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
