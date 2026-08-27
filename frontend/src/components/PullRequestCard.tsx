import {
  GitPullRequest, GitPullRequestDraft, GitPullRequestClosed, GitMerge, CheckCircle, AlertCircle, MessageSquare, GitCommit,
  ExternalLink, Star, Milestone, CircleSlash, RotateCcw, AlertTriangle, UserCheck, Check
} from 'lucide-react';
import type { Item } from '../api/octodeck/v1/resources_pb';
import {
  ItemStatus as ProtoItemStatus,
  ItemType as ProtoItemType,
  ItemState as ProtoItemState,
  SubscriptionState,
} from '../api/octodeck/v1/resources_pb';
import { formatFuzzyTime, formatExactDateTime } from '../utils/time';
import { getCommentPreview } from '../utils/text';
import { getLabelStyle } from '../utils/labels';
import { buildTimeline, getLatestRelevantActivity, getLatestNonNoiseActivityMs, formatReviewCommentSummary } from '../logic/timeline';

function getReviewPreviewText(review: { state: string; body?: string; commentCount?: number; newThreadsCount?: number; replyCount?: number }): string {
  let action = 'Submitted a review';
  switch (review.state) {
    case 'APPROVED':
      action = 'Approved changes';
      break;
    case 'CHANGES_REQUESTED':
      action = 'Requested changes';
      break;
    case 'DISMISSED':
      action = 'Dismissed review';
      break;
    case 'COMMENTED':
    default:
      action = 'Reviewed';
      break;
  }

  const summaryText = formatReviewCommentSummary(review);
  const commentSuffix = summaryText ? ` (${summaryText})` : '';
  const previewText = review.body ? getCommentPreview(review.body) : '';

  if (previewText) {
    return `${action}${commentSuffix}: ${previewText}`;
  }
  return `${action}${commentSuffix}`;
}

export interface PullRequestCardProps {
  item: Item;
  isSelected: boolean;
  isFocused?: boolean;
  onSelect: () => void;
  onAck?: (id: string) => Promise<void> | void;
  onUnack?: (id: string) => Promise<void> | void;
  showItemId?: boolean;
  onOpenDebug?: (targetItemId?: string) => void;
  grayAckedBackground?: boolean;
}

export function PullRequestCard({
  item,
  isSelected,
  isFocused = false,
  onSelect,
  onAck,
  onUnack,
  showItemId = false,
  onOpenDebug,
  grayAckedBackground = false,
}: PullRequestCardProps) {
  let statusText = 'Unknown';
  let statusColor = 'text-slate-500';
  const repoName = item.repo;
  const number = item.number;
  const title = item.title;
  const url = item.url;
  const isPr = item.type === ProtoItemType.PR || item.url.includes('/pull/');
  const isDraft = Boolean(item.isDraft);
  const isOpen = item.state === ProtoItemState.OPEN;
  const isAcked = item.local?.computedStatus === ProtoItemStatus.ACKED;
  const isStarred = Boolean(item.local?.starred);
  const isUntracked = item.viewerSubscription === SubscriptionState.UNSUBSCRIBED || (item.viewerSubscription as number) === 2;
  const syncError = item.local?.syncError;
  const activityTimeMs = getLatestNonNoiseActivityMs(item);
  const authorLogin = item.author?.login || 'unknown';

  // Determine triage status text and color
  const computedStatus = item.local?.computedStatus ?? ProtoItemStatus.UNSPECIFIED;
  switch (computedStatus) {
    case ProtoItemStatus.NEW:
      statusText = 'New';
      statusColor = 'text-blue-600 dark:text-blue-400';
      break;
    case ProtoItemStatus.NEW_ACTIVITY:
      statusText = 'New Activity';
      statusColor = 'text-amber-600 dark:text-yellow-400';
      break;
    case ProtoItemStatus.NEW_CODE:
      statusText = 'New Commit';
      statusColor = 'text-green-600 dark:text-green-400';
      break;
    case ProtoItemStatus.ACKED:
      statusText = 'Acked';
      statusColor = 'text-slate-500 dark:text-slate-400';
      break;
    case ProtoItemStatus.NOISE:
    case ProtoItemStatus.IDLE:
    case ProtoItemStatus.UNSPECIFIED:
    default:
      statusText = '';
      statusColor = '';
      break;
  }

  const timeline = buildTimeline(item);
  const latestActivity = getLatestRelevantActivity(timeline);

  return (
    <div
      onClick={onSelect}
      className={`group relative border-b border-slate-200 dark:border-slate-800 p-4 transition-colors cursor-pointer ${
        isSelected
          ? 'border-l-4 border-l-blue-600 dark:border-l-blue-500 pl-3 hover:bg-slate-50 dark:hover:bg-slate-800/30'
          : isFocused
            ? 'border-l-4 border-l-blue-400 dark:border-l-blue-400 pl-3 hover:bg-slate-50 dark:hover:bg-slate-800/30'
            : isAcked && grayAckedBackground
              ? 'bg-slate-100/70 dark:bg-slate-900/70 hover:bg-slate-200/60 dark:hover:bg-slate-800/50 border-l-4 border-l-transparent pl-3'
              : 'hover:bg-slate-50 dark:hover:bg-slate-800/30 border-l-4 border-l-transparent pl-3'
      }`}
    >
      <div className="flex items-start gap-3">
        <div className="mt-1 shrink-0">
          {isOpen ? (
            isPr ? (
              isDraft ? (
                <GitPullRequestDraft className="text-slate-500 dark:text-slate-400" size={18} aria-label="Draft Pull Request" />
              ) : (
                <GitPullRequest className="text-green-600 dark:text-green-500" size={18} />
              )
            ) : (
              <AlertCircle className="text-green-600 dark:text-green-500" size={18} />
            )
          ) : isPr ? (
            item.state === ProtoItemState.MERGED ? (
              <GitMerge className="text-purple-600 dark:text-purple-500" size={18} />
            ) : (
              <GitPullRequestClosed className="text-red-600 dark:text-red-500" size={18} />
            )
          ) : (
            <CheckCircle className="text-purple-600 dark:text-purple-500" size={18} />
          )}
        </div>

        <div className="flex-1 min-w-0">
          {/* Header Row */}
          <div className="flex justify-between items-start gap-2">
            <div className="flex-1 min-w-0 flex items-start gap-2">
              <h3 className="text-sm font-medium truncate text-slate-800 dark:text-slate-200 group-hover:text-blue-600 dark:group-hover:text-white">
                <a
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => {
                    if (e.button === 0 && !e.ctrlKey && !e.metaKey) {
                      e.preventDefault();
                    } else {
                      e.stopPropagation();
                    }
                  }}
                  onAuxClick={(e) => {
                    if (e.button === 1) {
                      e.stopPropagation();
                    }
                  }}
                  className="hover:underline focus:outline-hidden"
                >
                  {title}
                </a>
              </h3>
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="text-slate-400 hover:text-blue-600 dark:text-slate-500 dark:hover:text-blue-400 mt-0.5 shrink-0"
                title="Open on GitHub (o)"
              >
                <ExternalLink size={14} />
              </a>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              {syncError && (
                <span
                  className="text-amber-500 dark:text-amber-400 flex items-center shrink-0 cursor-help"
                  title={`Sync warning: ${syncError}`}
                  data-testid="sync-error-badge"
                  aria-label="Sync warning"
                >
                  <AlertTriangle size={14} />
                </span>
              )}
              {isUntracked && (
                <span
                  className="px-1.5 py-0.5 rounded text-[10px] font-medium border bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 border-slate-300 dark:border-slate-700 shrink-0"
                  title="You are not subscribed to updates on this item (untracked)"
                  data-testid="untracked-badge"
                >
                  Untracked
                </span>
              )}
              {isPr && isDraft && (
                <span
                  className="px-1.5 py-0.5 rounded text-[10px] font-medium border bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border-slate-300 dark:border-slate-700 shrink-0 flex items-center gap-1"
                  title="This pull request is in a draft state"
                  data-testid="draft-badge"
                >
                  <GitPullRequestDraft size={11} className="text-slate-500 dark:text-slate-400 shrink-0" />
                  Draft
                </span>
              )}
              <div className="flex items-center shrink-0">
                {statusText && (
                  <span
                    className={`text-[10px] whitespace-nowrap font-bold flex items-center gap-1 shrink-0 ${statusColor}`}
                  >
                    {statusText === 'New Code' && <div className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse"></div>}
                    {statusText}
                  </span>
                )}
                {onAck && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (isAcked) {
                        if (onUnack) {
                          onUnack(item.id);
                        } else {
                          onAck(item.id);
                        }
                      } else {
                        onAck(item.id);
                      }
                    }}
                    className={`overflow-hidden max-w-0 opacity-0 group-hover:max-w-6 group-hover:opacity-100 group-hover:ml-1.5 focus:max-w-6 focus:opacity-100 focus:ml-1.5 flex items-center justify-center p-0 group-hover:p-0.5 focus:p-0.5 rounded transition-all duration-150 ease-out cursor-pointer shrink-0 ${
                      isAcked
                        ? 'text-green-600/70 dark:text-green-500/70 hover:text-green-700 dark:hover:text-green-400 hover:bg-slate-200/60 dark:hover:bg-slate-800'
                        : 'text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-200/60 dark:hover:bg-slate-800'
                    }`}
                    title={isAcked ? 'Unack item (move back to Inbox)' : 'Ack item (x)'}
                    aria-label={isAcked ? 'Unack item' : 'Ack item'}
                    data-testid="card-ack-btn"
                  >
                    <Check size={14} strokeWidth={2.5} className="shrink-0" />
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Metadata Row */}
          <div className="text-[11px] text-slate-500 dark:text-slate-500 mt-1 flex items-center gap-2 flex-wrap">
            {isStarred && (
              <Star
                size={12}
                className="fill-amber-400 text-amber-500 dark:fill-amber-400 dark:text-amber-400 shrink-0"
                aria-label="Starred item"
              />
            )}
            <span>{authorLogin}</span>
            <span>•</span>
            <span className="font-mono">{repoName} #{number}</span>
            <span>•</span>
            <span title={formatExactDateTime(activityTimeMs)}>{formatFuzzyTime(activityTimeMs)}</span>
            {item.milestone?.title && (
              <>
                <span>•</span>
                <span className="inline-flex items-center gap-1 text-slate-600 dark:text-slate-400">
                  <Milestone size={11} className="text-slate-400 dark:text-slate-500 shrink-0" />
                  <span>{item.milestone.title}</span>
                </span>
              </>
            )}
            {showItemId && (
              <>
                <span>•</span>
                <span
                  className={`font-mono text-slate-400 dark:text-slate-600 ${
                    onOpenDebug ? 'cursor-pointer hover:text-blue-600 dark:hover:text-blue-400 hover:underline' : ''
                  }`}
                  onClick={(e) => {
                    if (onOpenDebug) {
                      e.stopPropagation();
                      onOpenDebug(item.id);
                    }
                  }}
                  title="Open in Debug Browser"
                >
                  ID: {item.id}
                </span>
              </>
            )}
          </div>

          {/* Labels Row */}
          {item.labels && item.labels.length > 0 && (
            <div className="flex items-center gap-1 flex-wrap mt-1.5" data-testid="pr-card-labels">
              {item.labels.map((lbl) => (
                <span
                  key={lbl.name}
                  className="inline-flex items-center px-1.5 py-0.2 rounded-full text-[10px] font-medium border leading-tight"
                  style={getLabelStyle(lbl.color)}
                >
                  {lbl.name}
                </span>
              ))}
            </div>
          )}

          {/* Preview Row (Latest Activity) */}
          {latestActivity && (
            <div className="mt-2 text-[10px] font-mono bg-slate-100/70 dark:bg-slate-900/50 p-2 rounded border border-slate-200 dark:border-slate-800/50 flex items-start gap-1.5">
              <span className="mt-0.5 shrink-0 opacity-70 text-slate-500 dark:text-slate-400">
                {latestActivity.type === 'COMMIT' ? (
                  <GitCommit size={10} />
                ) : latestActivity.type === 'REVIEW' ? (
                  latestActivity.state === 'APPROVED' ? (
                    <CheckCircle size={10} className="text-green-600 dark:text-green-400" />
                  ) : latestActivity.state === 'CHANGES_REQUESTED' ? (
                    <AlertCircle size={10} className="text-red-600 dark:text-red-400" />
                  ) : (
                    <MessageSquare size={10} />
                  )
                ) : latestActivity.type === 'STATE_CHANGE' ? (
                  latestActivity.changeType === 'MERGED' ? (
                    <GitMerge size={10} className="text-purple-600 dark:text-purple-400" />
                  ) : latestActivity.changeType === 'CLOSED' ? (
                    <CircleSlash size={10} className="text-red-600 dark:text-red-400" />
                  ) : latestActivity.changeType === 'ASSIGNED' ? (
                    <UserCheck size={10} className="text-blue-600 dark:text-blue-400" />
                  ) : (
                    <RotateCcw size={10} className="text-green-600 dark:text-green-400" />
                  )
                ) : (
                  <MessageSquare size={10} />
                )}
              </span>
              <div className="line-clamp-2 text-slate-600 dark:text-slate-300 min-w-0">
                <span className="font-semibold text-slate-800 dark:text-slate-200 mr-1">
                  {latestActivity.type === 'COMMIT'
                    ? latestActivity.authorLogin || authorLogin
                    : latestActivity.type === 'REVIEW'
                    ? latestActivity.author.login
                    : latestActivity.type === 'STATE_CHANGE'
                    ? latestActivity.actor.login || 'GitHub'
                    : latestActivity.data.author.login}:
                </span>
                <span>
                  {latestActivity.type === 'COMMIT'
                    ? 'Pushed new code'
                    : latestActivity.type === 'REVIEW'
                    ? getReviewPreviewText(latestActivity)
                    : latestActivity.type === 'STATE_CHANGE'
                    ? latestActivity.changeType === 'MERGED'
                      ? 'Merged'
                      : latestActivity.changeType === 'CLOSED'
                      ? 'Closed'
                      : latestActivity.changeType === 'ASSIGNED'
                      ? 'Assigned'
                      : 'Reopened'
                    : getCommentPreview(latestActivity.data.bodyText)}
                </span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
