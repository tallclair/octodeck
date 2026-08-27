const BOT_SUFFIX_REGEX = /(?:\[bot\]|\[robot\]|-bot|_bot|-robot|_robot|\bbot\b|\brobot\b)/i;
const SLASH_CMD_REGEX = /^\/[a-z0-9_-]+(?:\s|:|$)/i;

export interface TimelineItemInfo {
  element: HTMLElement;
  authorLogin: string;
  isComment: boolean;
  isBot: boolean;
  isSlashCommand: boolean;
  isNoise: boolean;
}

export type CommentInfo = TimelineItemInfo;

export function isBotLogin(login: string, knownBots: string[] = []): boolean {
  if (!login) return false;
  const l = login.trim().toLowerCase();
  if (BOT_SUFFIX_REGEX.test(l)) return true;
  if (l.endsWith('[bot]') || l.endsWith('[robot]')) return true;
  const clean = l.replace(/\[(?:bot|robot)\]$/i, '').trim();
  if (
    knownBots.some((b) => {
      const cleanB = b
        .trim()
        .toLowerCase()
        .replace(/\[(?:bot|robot)\]$/i, '')
        .trim();
      return clean === cleanB || l === cleanB;
    })
  ) {
    return true;
  }
  return false;
}

export function isSlashCommandBody(body: string): boolean {
  if (!body) return false;
  const lines = body.split('\n');
  let hasCommand = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (!SLASH_CMD_REGEX.test(trimmed)) {
      return false;
    }
    hasCommand = true;
  }
  return hasCommand;
}

export function extractAuthorLogin(el: HTMLElement): string {
  // First, check explicit author links with text
  const authorEl = el.querySelector<HTMLElement>(
    'a.author, .author, [data-testid="comment-header-author"], [data-testid="actor-link"], .timeline-comment-header .author, .TimelineItem-body .author, a[data-test-selector="pr-timeline-events-actor-profile-link"], [class*="eventActorLink"]'
  );
  if (authorEl && authorEl.textContent?.trim()) {
    return authorEl.textContent.trim().replace(/^@/, '');
  }

  // Next, check user hovercard links with non-empty text or extract from hovercard url
  const userLinks = Array.from(
    el.querySelectorAll<HTMLAnchorElement>('a[data-hovercard-type="user"], a[data-hovercard-url*="/users/"]')
  );
  for (const link of userLinks) {
    const text = link.textContent?.trim().replace(/^@/, '');
    if (text) return text;
    const hoverUrl = link.getAttribute('data-hovercard-url') || '';
    const match = hoverUrl.match(/\/users\/([^/?#]+)/);
    if (match && match[1]) return match[1];
  }

  // Next, check avatar images
  const avatarImg = el.querySelector<HTMLImageElement>(
    'img.avatar, img.avatar-user, .TimelineItem-avatar img, img[data-testid="github-avatar"]'
  );
  if (avatarImg) {
    const alt = avatarImg.getAttribute('alt') || '';
    if (alt.startsWith('@') && alt.length > 1) {
      return alt.slice(1).trim();
    }
  }

  // Next, check GitHub Apps links
  const appEl = el.querySelector<HTMLElement>('a[href^="https://github.com/apps/"], a[href^="/apps/"]');
  if (appEl) {
    const text = appEl.textContent?.trim().replace(/^@/, '');
    if (text) return text;
    const href = appEl.getAttribute('href') || '';
    const parts = href.split('/apps/');
    if (parts.length > 1) {
      return parts[1].split('/')[0].split('?')[0];
    }
  }

  return '';
}

export function extractCommentBodyElement(commentEl: HTMLElement): HTMLElement | null {
  // 1. Look for dedicated markdown body element first (avoids outer action bars / reaction containers)
  const markdownBody = commentEl.querySelector<HTMLElement>(
    '.markdown-body, .comment-body, .js-comment-body, [data-testid="comment-body"]'
  );
  if (markdownBody) {
    return markdownBody;
  }

  // 2. Fall back to issue comment body container
  return commentEl.querySelector<HTMLElement>(
    '[class*="IssueCommentBody"], [class*="commentBody"]'
  );
}

export function extractCommentBody(commentEl: HTMLElement): string {
  const bodyEl = extractCommentBodyElement(commentEl);
  return bodyEl ? bodyEl.textContent?.trim() || '' : '';
}

export function extractFirstNonBlankLine(body: string): string {
  if (!body) return '';
  const lines = body.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return '';
}

export function extractRemainingLines(body: string): string {
  if (!body) return '';
  const lines = body.split('\n');
  let firstNonBlankFound = false;
  const remainingLines: string[] = [];
  for (const line of lines) {
    if (!firstNonBlankFound) {
      if (line.trim()) {
        firstNonBlankFound = true;
      }
    } else {
      remainingLines.push(line);
    }
  }
  return remainingLines.join('\n').trimEnd();
}

export function formatContentWithLinks(text: string): HTMLElement {
  const container = document.createElement('div');
  container.className = 'octodeck-gh-dense-rest';

  // Matches markdown links [label](url) and bare URLs (https?://...)
  const urlRegex = /(\[([^\]]+)\]\((https?:\/\/[^\s)]+)\))|(https?:\/\/[^\s<>"')]+)/g;

  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = urlRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      container.appendChild(document.createTextNode(text.substring(lastIndex, match.index)));
    }

    if (match[1]) {
      // Markdown link: [text](url)
      const linkText = match[2];
      const linkUrl = match[3];
      const a = document.createElement('a');
      a.href = linkUrl;
      a.textContent = linkText;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.className = 'Link--primary octodeck-gh-dense-link';
      container.appendChild(a);
    } else if (match[4]) {
      // Bare URL: https://...
      let url = match[4];
      let trailing = '';
      const punctMatch = url.match(/[.,:;!?)]+$/);
      if (punctMatch) {
        trailing = punctMatch[0];
        url = url.slice(0, -trailing.length);
      }
      const a = document.createElement('a');
      a.href = url;
      a.textContent = url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.className = 'Link--primary octodeck-gh-dense-link';
      container.appendChild(a);
      if (trailing) {
        container.appendChild(document.createTextNode(trailing));
      }
    }

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    container.appendChild(document.createTextNode(text.substring(lastIndex)));
  }

  return container;
}

export function createRestContentElement(bodyEl: HTMLElement | null, fallbackText: string): HTMLElement {
  const container = document.createElement('div');
  container.className = 'octodeck-gh-dense-rest';

  if (!bodyEl) {
    const restText = extractRemainingLines(fallbackText);
    if (!restText) return container;
    return formatContentWithLinks(restText);
  }

  const clone = bodyEl.cloneNode(true) as HTMLElement;

  // Filter out any toolbars, action bars, reaction buttons, and action items
  const nonContentElements = clone.querySelectorAll(
    '[role="toolbar"], [class*="actionBar"], [class*="ActionBar"], [class*="actionItem"], [class*="ActionItem"], [class*="reaction"], [class*="Reaction"], [data-testid*="reaction"], [data-testid*="action-bar"], .timeline-comment-actions, .reaction-popover-container'
  );
  for (const el of Array.from(nonContentElements)) {
    el.parentNode?.removeChild(el);
  }

  let removedFirst = false;

  function removeFirstTextLine(node: Node): void {
    if (removedFirst) return;

    if (node.nodeType === 3) {
      // Text node
      const text = node.nodeValue || '';
      const lines = text.split('\n');
      let foundIdx = -1;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim()) {
          foundIdx = i;
          break;
        }
      }

      if (foundIdx !== -1) {
        const remainingLines = lines.slice(foundIdx + 1);
        const newText = remainingLines.join('\n').replace(/^\n+/, '');
        if (newText) {
          node.nodeValue = newText;
        } else {
          const next = node.nextSibling;
          if (next && next.nodeName === 'BR') {
            next.parentNode?.removeChild(next);
          }
          node.parentNode?.removeChild(node);
        }
        removedFirst = true;
        return;
      }
    }

    const children = Array.from(node.childNodes);
    for (const child of children) {
      removeFirstTextLine(child);
      if (removedFirst) break;
    }
  }

  removeFirstTextLine(clone);

  // Recursively clean up any empty wrapper elements
  function cleanEmptyElements(node: HTMLElement): void {
    const children = Array.from(node.children) as HTMLElement[];
    for (const child of children) {
      cleanEmptyElements(child);
    }
    if (
      node !== clone &&
      (!node.textContent || !node.textContent.trim()) &&
      !node.querySelector('img, svg, iframe, canvas')
    ) {
      node.parentNode?.removeChild(node);
    }
  }
  cleanEmptyElements(clone);

  // Move all children of clone into container
  while (clone.firstChild) {
    container.appendChild(clone.firstChild);
  }

  return container;
}

export function isCommentMultiLine(body: string): boolean {
  if (!body) return false;
  const nonBlankLines = body
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  return nonBlankLines.length > 1;
}

export function isReviewEvent(el: HTMLElement): boolean {
  // If explicitly an issue comment, it's not a review event
  const wrapperId = el.getAttribute('data-wrapper-timeline-id') || '';
  const eventId = el.getAttribute('data-timeline-event-id') || '';
  if (el.id && el.id.startsWith('issuecomment-')) {
    return false;
  }
  if (el.querySelector('[id^="issuecomment-"]')) {
    return false;
  }
  if (wrapperId.startsWith('IC_') || eventId.startsWith('IC_')) {
    return false;
  }
  if (
    el.querySelector(
      '[data-wrapper-timeline-id^="IC_"], [data-timeline-event-id^="IC_"]'
    )
  ) {
    return false;
  }
  if (
    el.querySelector(
      '.comment-body, .js-comment-body, [data-testid="comment-body"], .react-issue-comment, [class*="IssueCommentBody"], [class*="IssueCommentContent"]'
    )
  ) {
    // If it contains a comment body and has no explicit review identifiers, it's not a review event
    const hasReviewId =
      (el.id && (el.id.startsWith('pullrequestreview-') || el.id.startsWith('review-'))) ||
      Boolean(el.querySelector('[id^="pullrequestreview-"], [id^="review-"]'));
    const hasReviewWrapper =
      wrapperId.startsWith('PRR_') ||
      eventId.startsWith('PRR_') ||
      Boolean(
        el.querySelector(
          '[data-wrapper-timeline-id^="PRR_"], [data-timeline-event-id^="PRR_"]'
        )
      );
    const hasReviewLink = Boolean(
      el.querySelector(
        'a[href*="#pullrequestreview-"], a[href*="/pullrequestreview-"], a[href*="#review-"]'
      )
    );
    const hasReviewClass =
      el.classList.contains('discussion-item-review') ||
      el.classList.contains('js-review') ||
      el.classList.contains('pull-request-review-header') ||
      el.classList.contains('pull-request-review') ||
      Boolean(
        el.querySelector(
          '.discussion-item-review, .js-review, .pull-request-review-header, .pull-request-review'
        )
      );

    if (!hasReviewId && !hasReviewWrapper && !hasReviewLink && !hasReviewClass) {
      return false;
    }
  }

  // 1. Check ID directly on el or in wrapper
  if (
    el.id &&
    (el.id.startsWith('pullrequestreview-') ||
      el.id.startsWith('review-') ||
      el.id.startsWith('event-pullrequestreview-'))
  ) {
    return true;
  }
  if (
    el.querySelector(
      '[id^="pullrequestreview-"], [id^="review-"], [id^="event-pullrequestreview-"]'
    )
  ) {
    return true;
  }

  // 2. Check wrapper timeline ID or timeline event ID (PRR_ = PullRequestReview)
  if (wrapperId.startsWith('PRR_') || eventId.startsWith('PRR_')) {
    return true;
  }
  if (
    el.querySelector(
      '[data-wrapper-timeline-id^="PRR_"], [data-timeline-event-id^="PRR_"]'
    )
  ) {
    return true;
  }

  // 3. Check review anchor link (e.g. href="#pullrequestreview-4741544059" or href="...#pullrequestreview-...")
  if (
    el.querySelector(
      'a[href*="#pullrequestreview-"], a[href*="/pullrequestreview-"], a[href*="#review-"], [id^="pullrequestreview-"]'
    )
  ) {
    return true;
  }

  // 4. Check review classes
  if (
    el.classList.contains('discussion-item-review') ||
    el.classList.contains('js-review') ||
    el.classList.contains('pull-request-review-header') ||
    el.classList.contains('pull-request-review')
  ) {
    return true;
  }
  if (
    el.querySelector(
      '.discussion-item-review, .js-review, .pull-request-review-header, .pull-request-review'
    )
  ) {
    return true;
  }

  // 5. Check review text patterns in timeline body content or header (excluding markdown-body / comment-body)
  const headerSelector =
    '.row-module__timelineBodyContent__nmY90, .timeline-comment-header, [data-testid="comment-header"], h3, h4, .TimelineItem-body';
  const contentHeaders = Array.from(el.querySelectorAll<HTMLElement>(headerSelector));
  for (const header of contentHeaders) {
    const clone = header.cloneNode(true) as HTMLElement;
    const bodies = clone.querySelectorAll(
      '.markdown-body, .comment-body, .js-comment-body, [data-testid="comment-body"], [class*="IssueCommentBody"], [class*="IssueCommentContent"]'
    );
    for (const b of Array.from(bodies)) {
      b.parentNode?.removeChild(b);
    }
    const text = clone.textContent?.toLowerCase() || '';
    if (
      /\b(?:reviewed|approved these changes|requested changes|dismissed.*?review|submitted a review|left review comments)\b/i.test(
        text
      )
    ) {
      if (
        clone.querySelector(
          'a.author, .author, [data-testid="actor-link"], a[data-test-selector*="actor"], .TimelineItem-badge, [class*="TimelineBadge"]'
        ) ||
        el.querySelector(
          'a.author, .author, [data-testid="actor-link"], a[data-test-selector*="actor"], .TimelineItem-badge, [class*="TimelineBadge"]'
        )
      ) {
        return true;
      }
    }
  }

  return false;
}

export function isCommentElement(el: HTMLElement): boolean {
  if (isReviewEvent(el)) return false;
  if (el.id && el.id.startsWith('issuecomment-')) return true;
  if (el.classList.contains('timeline-comment-group') && !el.id.startsWith('event-')) return true;
  if (el.classList.contains('review-comment')) return true;
  if (el.classList.contains('react-issue-comment')) return true;
  const wrapperId = el.getAttribute('data-wrapper-timeline-id') || '';
  if (wrapperId.startsWith('IC_')) return true;
  if (
    el.querySelector(
      '.comment-body, .js-comment-body, [data-testid="comment-body"], [id^="issuecomment-"], .react-issue-comment, [class*="IssueCommentBody"], [class*="IssueCommentContent"]'
    )
  ) {
    return true;
  }
  return false;
}

export function isCloseOrReopenEvent(el: HTMLElement): boolean {
  if (isCommentElement(el)) return false;

  // 1. Check primary event badge icon
  const badge = el.querySelector<HTMLElement>(
    '.prc-Timeline-TimelineBadge-u0qSm, .TimelineItem-badge, [class*="TimelineBadge"]'
  );
  if (badge) {
    if (
      badge.querySelector(
        '.octicon-issue-closed, .octicon-issue-reopened, .octicon-circle-slash, .octicon-git-merge, .octicon-git-pull-request-closed'
      )
    ) {
      return true;
    }
  }

  // 2. Check wrapper timeline ID or event ID (CE_ = ClosedEvent, REE_ = ReopenedEvent)
  const wrapperId = el.getAttribute('data-wrapper-timeline-id') || '';
  const eventId = el.getAttribute('data-timeline-event-id') || '';
  if (wrapperId.startsWith('CE_') || wrapperId.startsWith('REE_') || eventId.startsWith('CE_') || eventId.startsWith('REE_')) {
    return true;
  }
  if (
    el.querySelector(
      '[data-wrapper-timeline-id^="CE_"], [data-wrapper-timeline-id^="REE_"], [data-timeline-event-id^="CE_"], [data-timeline-event-id^="REE_"]'
    )
  ) {
    return true;
  }

  // 3. Check event content header specifically (excluding cross-referenced child lists)
  const contentHeader = el.querySelector<HTMLElement>(
    '.row-module__timelineBodyContent__nmY90, .TimelineItem-body, [class*="timelineBodyContent"]'
  );
  if (contentHeader) {
    const headerText = contentHeader.textContent?.toLowerCase() || '';
    if (
      headerText.includes('closed this') ||
      headerText.includes('reopened this') ||
      headerText.includes('closed as completed') ||
      headerText.includes('closed as not planned') ||
      headerText.includes('merged commit') ||
      headerText.includes('merged this into')
    ) {
      return true;
    }
  }

  return false;
}

export function isMentionOrReferenceEvent(el: HTMLElement): boolean {
  if (isCommentElement(el)) return false;

  // 1. Check primary event badge icon
  const badge = el.querySelector<HTMLElement>(
    '.prc-Timeline-TimelineBadge-u0qSm, .TimelineItem-badge, [class*="TimelineBadge"], [class*="timelineBadge"]'
  );
  if (badge) {
    if (
      badge.querySelector(
        '.octicon-bookmark, .octicon-cross-reference, .octicon-link-external'
      )
    ) {
      return true;
    }
  }

  // 2. Check wrapper timeline ID or event ID (CRE_ = CrossReferencedEvent, REF_ = ReferencedEvent)
  const wrapperId = el.getAttribute('data-wrapper-timeline-id') || '';
  const eventId = el.getAttribute('data-timeline-event-id') || '';
  if (
    wrapperId.startsWith('CRE_') ||
    eventId.startsWith('CRE_') ||
    wrapperId.startsWith('REF_') ||
    eventId.startsWith('REF_')
  ) {
    return true;
  }
  if (
    el.querySelector(
      '[data-wrapper-timeline-id^="CRE_"], [data-timeline-event-id^="CRE_"], [data-wrapper-timeline-id^="REF_"], [data-timeline-event-id^="REF_"]'
    )
  ) {
    return true;
  }

  // 3. Check classes
  if (
    el.classList.contains('discussion-item-ref') ||
    el.classList.contains('js-discussion-item-ref') ||
    el.classList.contains('discussion-item-cross-reference') ||
    el.classList.contains('CrossReferencedEvent')
  ) {
    return true;
  }
  if (
    el.querySelector(
      '.discussion-item-ref, .js-discussion-item-ref, .discussion-item-cross-reference, .CrossReferencedEvent, [class*="CrossReference"], [class*="crossReference"]'
    )
  ) {
    return true;
  }

  // 4. Check testid or data-event-type
  const testId = el.getAttribute('data-testid') || '';
  const eventType = el.getAttribute('data-timeline-event-type') || el.getAttribute('data-event-type') || '';
  if (
    testId.includes('cross-reference') ||
    testId.includes('referenced-event') ||
    testId.includes('mention') ||
    eventType.includes('CrossReferenced') ||
    eventType.includes('Referenced') ||
    eventType.includes('cross-reference')
  ) {
    return true;
  }
  if (
    el.querySelector(
      '[data-testid*="cross-reference"], [data-testid*="referenced-event"], [data-testid*="mention"], [data-timeline-event-type*="CrossReferenced"], [data-timeline-event-type*="Referenced"]'
    )
  ) {
    return true;
  }

  // 5. Check event content header / timeline body text
  const headerSelector =
    '.row-module__timelineBodyContent__nmY90, .TimelineItem-body, [class*="timelineBodyContent"], [class*="TimelineBody"], .discussion-item-header, h3, h4';
  const contentHeaders = Array.from(el.querySelectorAll<HTMLElement>(headerSelector));
  if (el.matches(headerSelector)) {
    contentHeaders.unshift(el);
  }

  for (const header of contentHeaders) {
    const clone = header.cloneNode(true) as HTMLElement;
    const bodies = clone.querySelectorAll(
      '.markdown-body, .comment-body, .js-comment-body, [data-testid="comment-body"], [class*="IssueCommentBody"], [class*="IssueCommentContent"]'
    );
    for (const b of Array.from(bodies)) {
      b.parentNode?.removeChild(b);
    }
    const text = clone.textContent?.toLowerCase() || '';
    if (
      /\b(?:mentioned this|referenced this|cross-referenced this)\b/i.test(
        text
      )
    ) {
      return true;
    }
  }

  return false;
}

export function queryTimelineElements(container: HTMLElement): HTMLElement[] {
  const rawElements = Array.from(
    container.querySelectorAll<HTMLElement>(
      '#issue-timeline > *, [data-testid="issue-timeline-container"] > *, section[aria-label="Events"], div[data-wrapper-timeline-id], .TimelineItem, .timeline-comment-group, [id^="issuecomment-"], [id^="event-"], .review-comment, div[data-testid="timeline-comment"], div[data-testid="issue-comment"], div[data-testid="timeline-event"], div.react-issue-comment'
    )
  ).filter((el) => {
    // Don't classify the PR / issue description itself (first main comment) or sidebar elements
    if (
      el.closest(
        '[data-partial-name*="Body"], .js-command-palette-pull-body, .js-issue-body, [id^="pullrequest-"], div[data-testid="issue-viewer-metadata-container"], .octodeck-gh-sidebar-section'
      ) ||
      (el.matches('.timeline-comment-group:first-of-type') && document.querySelector('.js-issue-body')?.contains(el))
    ) {
      return false;
    }
    // Filter out pagination, non-timeline items, and our own injected dense boxes/wrappers
    if (
      el.getAttribute('data-wrapper-timeline-id') === 'load-top' ||
      el.id === 'timeline-crawler-pagination' ||
      el.matches('h2.sr-only') ||
      el.classList.contains('octodeck-gh-timeline-marker') ||
      el.classList.contains('octodeck-gh-dense-timeline-item') ||
      el.classList.contains('octodeck-gh-dense-box') ||
      el.classList.contains('octodeck-gh-bot-summary')
    ) {
      return false;
    }
    return true;
  });

  // Deduplicate nested matches: keep only the outermost candidate elements
  return rawElements.filter(
    (el) => !rawElements.some((parent) => parent !== el && parent.contains(el))
  );
}

export function extractTimelineItemInfo(
  commentEl: HTMLElement,
  knownBots: string[] = [],
  onBotDiscovered?: (login: string) => void
): TimelineItemInfo {
  const authorLogin = extractAuthorLogin(commentEl);
  const isComment = isCommentElement(commentEl);

  // Check specific bot badge element inside comment header or timeline item body (avoid matching comment body text)
  const headerOrItemEl = commentEl.querySelector<HTMLElement>(
    '.timeline-comment-header, .TimelineItem-body, [data-testid="comment-header"], .review-comment-header, .js-comment-header, h3'
  );
  const badgeEl = (headerOrItemEl || commentEl).querySelector<HTMLElement>(
    '.Label--secondary, .Label, [class*="Label"]'
  );
  const hasBotBadge = Boolean(
    badgeEl && (
      badgeEl.textContent?.trim().toLowerCase() === 'bot' ||
      badgeEl.getAttribute('aria-label')?.toLowerCase().includes('bot') ||
      badgeEl.getAttribute('title')?.toLowerCase().includes('bot')
    )
  );

  const authorEl = commentEl.querySelector<HTMLElement>(
    'a.author, .author, a[data-test-selector="pr-timeline-events-actor-profile-link"], [data-testid="actor-link"]'
  );
  const isApp = Boolean(authorEl?.getAttribute('href')?.includes('/apps/'));

  const isBot = isBotLogin(authorLogin, knownBots) || hasBotBadge || isApp;

  // If detected as bot, notify discovery callback if not already in knownBots
  if (isBot && authorLogin && onBotDiscovered) {
    const cleanLogin = authorLogin
      .trim()
      .toLowerCase()
      .replace(/\[(?:bot|robot)\]$/i, '')
      .trim();
    if (cleanLogin) {
      const isAlreadyKnown = knownBots.some((b) => {
        const cleanB = b
          .trim()
          .toLowerCase()
          .replace(/\[(?:bot|robot)\]$/i, '')
          .trim();
        return cleanB === cleanLogin;
      });
      if (!isAlreadyKnown) {
        onBotDiscovered(cleanLogin);
      }
    }
  }

  const bodyText = extractCommentBody(commentEl);
  const isSlashCmd = Boolean(bodyText && isSlashCommandBody(bodyText));

  // Determine isNoise:
  // - ONLY comments can be noise! Bot comments or slash commands.
  // - Non-comment events are never noise (they are events, handled separately).
  const isNoise = isComment && (isBot || isSlashCmd);

  return {
    element: commentEl,
    authorLogin,
    isComment,
    isBot,
    isSlashCommand: isSlashCmd,
    isNoise,
  };
}

export const extractCommentInfo = extractTimelineItemInfo;

export function buildCollapseSummaryText(commentsCount: number, eventsCount: number, authors: string[]): string {
  let itemSummary = '';
  if (commentsCount > 0 && eventsCount > 0) {
    const cStr = commentsCount === 1 ? '1 comment' : `${commentsCount} comments`;
    const eStr = eventsCount === 1 ? '1 other event' : `${eventsCount} other events`;
    itemSummary = `${cStr} and ${eStr}`;
  } else if (commentsCount > 0) {
    itemSummary = commentsCount === 1 ? '1 comment' : `${commentsCount} comments`;
  } else if (eventsCount > 0) {
    itemSummary = eventsCount === 1 ? '1 other event' : `${eventsCount} other events`;
  } else {
    itemSummary = 'activity';
  }

  const authorText = authors.length > 0 ? ` from ${authors.map((a) => `@${a}`).join(', ')}` : '';
  return `${itemSummary}${authorText}`;
}

export function isRunCollapsible(run: TimelineItemInfo[]): boolean {
  const commentsCount = run.filter((r) => r.isComment).length;
  return commentsCount > 0;
}

export interface DenseRowInfo {
  item: TimelineItemInfo;
  rowEl: HTMLElement;
  previewEl: HTMLElement;
  restEl: HTMLElement | null;
  expandBtn: HTMLButtonElement | null;
  isMultiLine: boolean;
  expanded: boolean;
}

export interface NoiseGroup {
  wrapperEl: HTMLElement;
  boxEl: HTMLElement;
  rows: DenseRowInfo[];
}

export class NoiseCollapser {
  private container: HTMLElement;
  private knownBots: string[];
  private onBotDiscovered?: (login: string) => void;
  private groups: NoiseGroup[] = [];
  private hideNonCommentEvents = false;
  private domObserver: MutationObserver | null = null;
  private debounceTimer: number | null = null;
  private expandedCommentKeys = new Set<string>();

  constructor(
    container: HTMLElement = document.body,
    knownBots: string[] = [],
    onBotDiscovered?: (login: string) => void
  ) {
    this.container = container;
    this.knownBots = knownBots;
    this.onBotDiscovered = onBotDiscovered;
  }

  public setKnownBots(knownBots: string[]): void {
    this.knownBots = knownBots;
    this.run();
  }

  private getCommentKey(item: TimelineItemInfo, bodyText: string): string {
    if (item.element.id) return item.element.id;
    const wrapperId =
      item.element.getAttribute('data-wrapper-timeline-id') ||
      item.element.getAttribute('data-timeline-event-id');
    if (wrapperId) return wrapperId;
    return `${item.authorLogin}:${extractFirstNonBlankLine(bodyText).slice(0, 60)}`;
  }

  public setHideNonCommentEvents(hide: boolean): void {
    this.hideNonCommentEvents = hide;
    this.run(hide);
  }

  public run(hideNonCommentEvents = this.hideNonCommentEvents): void {
    this.hideNonCommentEvents = hideNonCommentEvents;

    // Clear previous injections if re-running
    this.cleanupGroups();

    const timelineElements = queryTimelineElements(this.container);

    if (timelineElements.length === 0) {
      console.debug('[OctoDeck Noise] No timeline items detected on page');
      this.ensureObserver();
      return;
    }

    // Build items info
    const itemsInfo = timelineElements.map((el) =>
      extractTimelineItemInfo(el, this.knownBots, this.onBotDiscovered)
    );

    if (this.hideNonCommentEvents) {
      // Hide all non-comment events completely, EXCEPT for close & reopen events, review events, and mention / reference events
      for (const info of itemsInfo) {
        if (!info.isComment) {
          if (
            isCloseOrReopenEvent(info.element) ||
            isReviewEvent(info.element) ||
            isMentionOrReferenceEvent(info.element)
          ) {
            info.element.classList.remove('octodeck-gh-hidden-event');
          } else {
            info.element.classList.add('octodeck-gh-hidden-event');
          }
        } else {
          info.element.classList.remove('octodeck-gh-hidden-event');
        }
      }

      // Group and collapse adjacent noise comments into dense box.
      // If events are hidden, all adjacent comments should be grouped (even if there are hidden events between them).
      // Visible non-noise comments or visible events (close/reopen, review, mention) break the grouping.
      const runs: TimelineItemInfo[][] = [];
      let currentRun: TimelineItemInfo[] = [];

      for (const info of itemsInfo) {
        if (info.isComment) {
          if (info.isNoise) {
            currentRun.push(info);
          } else {
            // Human / non-noise comment breaks the run
            if (currentRun.length > 0) {
              runs.push(currentRun);
              currentRun = [];
            }
          }
        } else {
          // Non-comment event:
          // If this event is visible (close/reopen, review, or mention event), it breaks the run
          if (
            isCloseOrReopenEvent(info.element) ||
            isReviewEvent(info.element) ||
            isMentionOrReferenceEvent(info.element)
          ) {
            if (currentRun.length > 0) {
              runs.push(currentRun);
              currentRun = [];
            }
          }
          // If the event is hidden, it does NOT break the run (hidden events between comments allow grouping)
        }
      }
      if (currentRun.length > 0) {
        runs.push(currentRun);
      }

      let totalNoiseCount = 0;
      for (const run of runs) {
        totalNoiseCount += run.length;
        this.collapseRun(run);
      }

      console.log(
        `[OctoDeck Noise] Hidden non-comment events (excluding close/reopen/review/mention). Rendered ${totalNoiseCount} noise comments across ${runs.length} dense box(es)`
      );
      this.ensureObserver();
      return;
    }

    // Default mode (events are shown): ensure no elements remain hidden by event filter
    for (const info of itemsInfo) {
      info.element.classList.remove('octodeck-gh-hidden-event');
    }

    // When events are shown, ONLY contiguous noise comments (with no events or non-noise comments between them) are grouped.
    // If there are events between the comments, and events are shown, the box comments should not be grouped.
    const runs: TimelineItemInfo[][] = [];
    let currentRun: TimelineItemInfo[] = [];

    for (const info of itemsInfo) {
      if (info.isComment && info.isNoise) {
        currentRun.push(info);
      } else {
        // Any non-noise comment OR any event breaks the run
        if (currentRun.length > 0) {
          runs.push(currentRun);
          currentRun = [];
        }
      }
    }
    if (currentRun.length > 0) {
      runs.push(currentRun);
    }

    let totalNoiseCount = 0;
    for (const run of runs) {
      totalNoiseCount += run.length;
      this.collapseRun(run);
    }

    console.log(
      `[OctoDeck Noise] Scanned ${timelineElements.length} timeline items -> rendered ${totalNoiseCount} noise comments across ${runs.length} dense box(es)`
    );
    this.ensureObserver();
  }

  private ensureObserver(): void {
    if (this.domObserver || typeof MutationObserver === 'undefined') return;

    this.domObserver = new MutationObserver((mutations) => {
      // Check if mutations added non-OctoDeck elements
      let hasRelevantAdditions = false;
      for (const m of mutations) {
        if (m.addedNodes.length > 0) {
          for (let i = 0; i < m.addedNodes.length; i++) {
            const node = m.addedNodes[i];
            if (
              node instanceof HTMLElement &&
              !node.classList.contains('octodeck-gh-dense-timeline-item') &&
              !node.classList.contains('octodeck-gh-dense-box') &&
              !node.classList.contains('octodeck-gh-bot-summary')
            ) {
              hasRelevantAdditions = true;
              break;
            }
          }
        }
        if (hasRelevantAdditions) break;
      }

      if (hasRelevantAdditions) {
        if (this.debounceTimer !== null) {
          clearTimeout(this.debounceTimer);
        }
        this.debounceTimer = window.setTimeout(() => {
          this.run();
        }, 150);
      }
    });

    this.domObserver.observe(this.container, { childList: true, subtree: true });
  }

  private collapseRun(run: TimelineItemInfo[]): void {
    const firstEl = run[0].element;

    const wrapperEl = document.createElement('div');
    wrapperEl.className = 'TimelineItem TimelineItem--condensed octodeck-gh-dense-timeline-item';

    const bodyEl = document.createElement('div');
    bodyEl.className = 'TimelineItem-body';
    wrapperEl.appendChild(bodyEl);

    const boxEl = document.createElement('div');
    boxEl.className = 'octodeck-gh-dense-box tmp-ml-n3';
    boxEl.setAttribute('role', 'region');
    boxEl.setAttribute('aria-label', 'Collapsed activity');
    bodyEl.appendChild(boxEl);

    const listEl = document.createElement('div');
    listEl.className = 'octodeck-gh-dense-list';
    boxEl.appendChild(listEl);

    const rows: DenseRowInfo[] = [];

    for (const item of run) {
      // Hide original comment / event by default
      item.element.classList.add('octodeck-gh-collapsed-comment');

      const author = item.authorLogin ? `@${item.authorLogin}` : '@ghost';
      const bodyEl = extractCommentBodyElement(item.element);
      const bodyText = bodyEl ? bodyEl.textContent?.trim() || '' : extractCommentBody(item.element);
      const isMultiLine = isCommentMultiLine(bodyText);
      const firstLine =
        extractFirstNonBlankLine(bodyText) ||
        (item.isComment ? '(empty comment)' : item.element.textContent?.trim().slice(0, 100) || 'activity');

      const rowEl = document.createElement('div');
      rowEl.className = 'octodeck-gh-dense-row';

      // 1. First line preview (always stays in place)
      const previewEl = document.createElement('div');
      previewEl.className = 'octodeck-gh-dense-preview';

      const contentEl = document.createElement('div');
      contentEl.className = 'octodeck-gh-dense-content';

      const authorEl = document.createElement('span');
      authorEl.className = 'octodeck-gh-dense-author';
      authorEl.textContent = author;

      const textEl = document.createElement('span');
      textEl.className = 'octodeck-gh-dense-text';
      textEl.textContent = firstLine;

      contentEl.appendChild(authorEl);
      contentEl.appendChild(textEl);
      previewEl.appendChild(contentEl);

      let expandBtn: HTMLButtonElement | null = null;
      let restEl: HTMLElement | null = null;

      const key = this.getCommentKey(item, bodyText);
      const isExpanded = this.expandedCommentKeys.has(key);

      if (isMultiLine) {
        expandBtn = document.createElement('button');
        expandBtn.type = 'button';
        expandBtn.className = 'octodeck-gh-dense-expand-btn';
        expandBtn.textContent = isExpanded ? '[-]' : '[+]';
        expandBtn.setAttribute(
          'aria-label',
          `${isExpanded ? 'Collapse' : 'Expand'} comment from ${author}`
        );
        previewEl.appendChild(expandBtn);

        // 2. Rest of the content directly below using real cloned DOM (preserving <a> tags and elements)
        restEl = createRestContentElement(bodyEl, bodyText);
        restEl.style.display = isExpanded ? 'block' : 'none';
      }

      rowEl.appendChild(previewEl);
      if (restEl) {
        rowEl.appendChild(restEl);
      }
      listEl.appendChild(rowEl);

      const rowInfo: DenseRowInfo = {
        item,
        rowEl,
        previewEl,
        restEl,
        expandBtn,
        isMultiLine,
        expanded: isExpanded,
      };

      if (expandBtn) {
        expandBtn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.toggleRow(rowInfo);
        });
      }

      rows.push(rowInfo);
    }

    if (firstEl.parentNode) {
      firstEl.parentNode.insertBefore(wrapperEl, firstEl);
    }

    this.groups.push({
      wrapperEl,
      boxEl,
      rows,
    });
  }

  public toggleRow(rowInfo: DenseRowInfo, forceState?: boolean): void {
    if (!rowInfo.isMultiLine || !rowInfo.restEl || !rowInfo.expandBtn) return;
    const nextState = forceState !== undefined ? forceState : !rowInfo.expanded;
    rowInfo.expanded = nextState;

    const bodyEl = extractCommentBodyElement(rowInfo.item.element);
    const bodyText = bodyEl ? bodyEl.textContent?.trim() || '' : extractCommentBody(rowInfo.item.element);
    const key = this.getCommentKey(rowInfo.item, bodyText);

    if (nextState) {
      this.expandedCommentKeys.add(key);
      rowInfo.restEl.style.display = 'block';
      rowInfo.expandBtn.textContent = '[-]';
      rowInfo.expandBtn.setAttribute(
        'aria-label',
        `Collapse comment from ${rowInfo.item.authorLogin ? `@${rowInfo.item.authorLogin}` : '@ghost'}`
      );
    } else {
      this.expandedCommentKeys.delete(key);
      rowInfo.restEl.style.display = 'none';
      rowInfo.expandBtn.textContent = '[+]';
      rowInfo.expandBtn.setAttribute(
        'aria-label',
        `Expand comment from ${rowInfo.item.authorLogin ? `@${rowInfo.item.authorLogin}` : '@ghost'}`
      );
    }
  }

  private cleanupGroups(): void {
    for (const group of this.groups) {
      const parent = group.wrapperEl || group.boxEl;
      if (parent.parentNode) {
        parent.parentNode.removeChild(parent);
      }
      for (const row of group.rows) {
        row.item.element.classList.remove('octodeck-gh-collapsed-comment');
      }
    }
    this.groups = [];
  }

  public cleanup(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.domObserver) {
      this.domObserver.disconnect();
      this.domObserver = null;
    }
    this.cleanupGroups();

    // Remove any hidden-event classes from container
    const hiddenEvents = this.container.querySelectorAll('.octodeck-gh-hidden-event');
    for (const el of Array.from(hiddenEvents)) {
      el.classList.remove('octodeck-gh-hidden-event');
    }
  }
}
