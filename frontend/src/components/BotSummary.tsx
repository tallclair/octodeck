import { Bot } from 'lucide-react';
import type { BotSummaryGroup } from '../logic/noiseFilter';
import { useState } from 'react';
import { smartTruncate, stripHtmlComments } from '../utils/text';
import { formatFuzzyTime, formatExactDateTime } from '../utils/time';

interface BotSummaryProps {
  group: BotSummaryGroup;
}

function BotComment({ comment }: { comment: BotSummaryGroup['comments'][number] }) {
  const [expanded, setExpanded] = useState(false);
  const maxLength = 200;
  
  const cleanBody = stripHtmlComments(comment.bodyText);
  const { text, truncated } = smartTruncate(cleanBody, maxLength);
  const shouldShowButton = truncated || (expanded && cleanBody.length > maxLength);

  const formattedTime = comment.createdAt 
    ? formatFuzzyTime(new Date(comment.createdAt).getTime()) 
    : '';

  return (
    <div className="text-xs bg-slate-50 dark:bg-slate-900/50 p-2 rounded border border-slate-200 dark:border-slate-800">
        <div className="flex justify-between text-slate-500 mb-1 text-[10px] font-mono">
            <span>{comment.author.login}</span>
            {comment.url ? (
              <a 
                href={comment.url} 
                target="_blank" 
                rel="noopener noreferrer"
                className="hover:underline cursor-pointer hover:text-slate-800 dark:hover:text-slate-300"
                title={formatExactDateTime(comment.createdAt ? new Date(comment.createdAt).getTime() : null)}
              >
                {formattedTime}
              </a>
            ) : (
              <span title={formatExactDateTime(comment.createdAt ? new Date(comment.createdAt).getTime() : null)}>{formattedTime}</span>
            )}
        </div>
        <div className="text-slate-700 dark:text-slate-400 font-mono whitespace-pre-wrap break-words">
            {expanded ? cleanBody : (truncated ? `${text}...` : text)}
        </div>
        {shouldShowButton && (
          <button 
            onClick={() => setExpanded(!expanded)}
            className="text-[10px] text-slate-500 hover:text-slate-800 dark:hover:text-slate-300 mt-1 focus:outline-none cursor-pointer"
          >
            {expanded ? 'Show less' : 'Show more'}
          </button>
        )}
    </div>
  );
}

export function BotSummary({ group }: BotSummaryProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="ml-11 relative z-10">
      <div 
        className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-400 bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 px-2.5 py-1.5 rounded-md w-fit cursor-pointer hover:bg-slate-200/60 dark:hover:bg-slate-800/60 hover:text-slate-900 dark:hover:text-slate-200 hover:border-slate-300 dark:hover:border-slate-700/60 transition-colors group/summary shadow-xs"
        onClick={() => setExpanded(!expanded)}
        title={`${group.count} bot interactions hidden`}
      >
        <Bot size={14} className="text-slate-500 dark:text-slate-400 shrink-0" />
        <span>{group.count} bot interactions hidden {expanded ? '(Click to collapse)' : '(Click to expand)'}</span>
      </div>
      
      {expanded && (
        <div className="mt-2 space-y-2 border-l border-slate-300 dark:border-slate-700 pl-2">
          <div className="space-y-2">
            {group.comments.map((comment, idx) => (
              <BotComment key={idx} comment={comment} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
