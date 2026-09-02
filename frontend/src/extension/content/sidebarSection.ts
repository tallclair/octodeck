import { create } from '@bufbuild/protobuf';
import { TimestampSchema } from '@bufbuild/protobuf/wkt';
import { ItemLocalStateSchema, ItemStatus, SubscriptionState, type Item } from '../../api/octodeck/v1/resources_pb';
import type { ExtensionMessage, ExtensionResponse } from '../types';

export const SIDEBAR_SELECTORS = [
  '#partial-discussion-sidebar',
  '.discussion-sidebar',
  'div[class*="sidebarContent"]',
  'div[data-testid="sticky-sidebar"]',
  'div[data-testid="sidebar-assignees-section"]',
  'div[data-testid="issue-viewer-metadata-pane"]',
  'div[data-testid="issue-viewer-metadata-container"]',
  'div[data-testid="issue-sidebar"]',
  'div[data-testid="issue-metadata-container"]',
  'div[data-testid="sidebar-items"]',
  '.Layout-sidebar .sidebar-inner',
  '.Layout-sidebar',
  'aside[aria-label="Sidebar"]',
  'div[aria-label="Issue metadata"]',
  '.js-discussion-sidebar',
];

export const COMMENT_BUTTON_SELECTORS = [
  '#partial-new-comment-form-actions button.btn-primary[type="submit"]',
  '#partial-new-comment-form-actions button[type="submit"]',
  '.js-new-comment-form .form-actions button.btn-primary',
  '.js-new-comment-form .form-actions button[type="submit"]',
  'form.js-new-comment-form button.btn-primary',
  '.timeline-comment .form-actions button.btn-primary',
  '.form-actions button.btn-primary',
  '.form-actions button[type="submit"]',
  'button[data-testid="comment-button"]',
  'button[data-disable-with="Commenting..."]',
  '[data-testid="save-button-tooltip"] button',
  '[data-testid="issue-comment-composer"] button[data-variant="primary"]',
  '[class*="IssueCommentComposer"] button[data-variant="primary"]',
  '[class*="IssueCommentComposer"] button',
];

export function isItemAcked(item: Item | null | undefined): boolean {
  if (!item || !item.local) return false;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawStatus = (item.local as any).computedStatus;
  if (
    rawStatus === ItemStatus.ACKED ||
    rawStatus === 'ITEM_STATUS_ACKED' ||
    rawStatus === 'ACKED' ||
    rawStatus === 5 ||
    rawStatus === '5'
  ) {
    return true;
  }

  // If computedStatus is explicitly specified (and not ACKED), trust it over historical ackedAt.
  if (
    rawStatus !== undefined &&
    rawStatus !== null &&
    rawStatus !== ItemStatus.UNSPECIFIED &&
    rawStatus !== 0 &&
    rawStatus !== '0' &&
    rawStatus !== 'ITEM_STATUS_UNSPECIFIED' &&
    rawStatus !== 'UNSPECIFIED'
  ) {
    return false;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ackedAt = (item.local as any).ackedAt;
  if (ackedAt) {
    if (typeof ackedAt === 'string' && ackedAt.trim() !== '') {
      const parsed = Date.parse(ackedAt);
      if (!isNaN(parsed) && parsed > 0) return true;
    }
    if (typeof ackedAt === 'object') {
      if (ackedAt instanceof Date && ackedAt.getTime() > 0) return true;
      if (ackedAt.seconds !== undefined && Number(ackedAt.seconds) > 0) return true;
      if (ackedAt.nanos !== undefined && Number(ackedAt.nanos) > 0) return true;
    }
  }

  return false;
}

export function findSidebar(container: HTMLElement = document.body): HTMLElement | null {
  for (const selector of SIDEBAR_SELECTORS) {
    const el = container.querySelector<HTMLElement>(selector);
    if (el) {
      if (selector === 'div[data-testid="sidebar-assignees-section"]' && el.parentElement) {
        return el.parentElement;
      }
      return el;
    }
  }
  return null;
}

export function findCommentButton(container: HTMLElement = document.body): HTMLElement | null {
  for (const selector of COMMENT_BUTTON_SELECTORS) {
    const el = container.querySelector<HTMLElement>(selector);
    if (el && !el.classList.contains('octodeck-gh-comment-ack-btn')) return el;
  }
  return null;
}

export function waitForSidebar(container: HTMLElement = document.body, timeoutMs = 8000): Promise<HTMLElement | null> {
  const immediate = findSidebar(container);
  if (immediate) return Promise.resolve(immediate);

  return new Promise((resolve) => {
    let resolved = false;
    let observer: MutationObserver | null = null;
    let timeoutId: number | null = null;

    const cleanup = () => {
      if (observer) {
        observer.disconnect();
        observer = null;
      }
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
    };

    observer = new MutationObserver(() => {
      const el = findSidebar(container);
      if (el && !resolved) {
        resolved = true;
        cleanup();
        resolve(el);
      }
    });

    observer.observe(container, { childList: true, subtree: true });

    timeoutId = window.setTimeout(() => {
      if (!resolved) {
        resolved = true;
        cleanup();
        resolve(findSidebar(container));
      }
    }, timeoutMs);
  });
}

export function extractPageGraphQLId(): string | null {
  const el = document.querySelector<HTMLElement>(
    '#partial-discussion-sidebar[data-gid], .discussion-sidebar[data-gid], [data-gid^="PR_"], [data-gid^="I_"]'
  );
  if (el) {
    const gid = el.getAttribute('data-gid');
    if (gid && (gid.startsWith('PR_') || gid.startsWith('I_'))) {
      return gid;
    }
  }

  const reactEl = document.querySelector('script[data-target="react-app.embeddedData"]');
  if (reactEl && reactEl.textContent) {
    try {
      const data = JSON.parse(reactEl.textContent);
      const relayId = data?.payload?.pullRequest?.relayId || data?.payload?.issue?.relayId;
      if (relayId) return relayId;

      const preloaded = data?.payload?.preloadedSubscriptions;
      if (preloaded && typeof preloaded === 'object') {
        for (const subObj of Object.values(preloaded)) {
          if (subObj && typeof subObj === 'object') {
            for (const key of Object.keys(subObj)) {
              if (key.includes('issueId')) {
                try {
                  const parsedKey = JSON.parse(key);
                  if (parsedKey.issueId) return parsedKey.issueId;
                } catch {
                  // Ignore
                }
              }
            }
          }
        }
      }
    } catch {
      // Ignore
    }
  }

  return null;
}

export class SidebarSection {
  private sidebarEl: HTMLElement | null = null;
  private rootEl: HTMLElement | null = null;
  private commentAckEl: HTMLButtonElement | null = null;
  private itemId: string;
  private currentItem: Item | null = null;
  private isEditingNotes = false;
  private draftNotes = '';
  private isOffline = false;
  private isUntracked = false;
  private errorMessage: string | null = null;
  private hideEvents: boolean;
  private onToggleHideEvents?: (hide: boolean) => void;
  private onItemUpdated?: (item: Item | null) => void;
  private reconnectTimer: number | null = null;
  private reconnectDelay = 2000;
  private readonly minReconnectDelay = 2000;
  private readonly maxReconnectDelay = 30000;
  private readonly backoffMultiplier = 1.5;
  private domObserver: MutationObserver | null = null;

  constructor(
    itemId: string,
    hideEvents = false,
    onToggleHideEvents?: (hide: boolean) => void,
    onItemUpdated?: (item: Item | null) => void
  ) {
    this.itemId = itemId;
    this.hideEvents = hideEvents;
    this.onToggleHideEvents = onToggleHideEvents;
    this.onItemUpdated = onItemUpdated;
  }

  public async init(container: HTMLElement = document.body): Promise<void> {
    console.log(`[OctoDeck Sidebar] Initializing companion widgets for ${this.itemId}...`);
    this.sidebarEl = findSidebar(container);
    if (this.sidebarEl) {
      console.log('[OctoDeck Sidebar] Found sidebar container element immediately:', this.sidebarEl);
      this.renderInitialSkeleton();
    } else {
      waitForSidebar(container).then((el) => {
        if (el && !this.rootEl) {
          console.log('[OctoDeck Sidebar] Found sidebar container element asynchronously:', el);
          this.sidebarEl = el;
          this.renderInitialSkeleton();
        }
      });
    }

    this.renderCommentAck();

    // Observe DOM mutations so if sidebar or comment box render asynchronously (e.g. React hydration), we attach immediately
    if (typeof MutationObserver !== 'undefined') {
      this.domObserver = new MutationObserver(() => {
        if (!this.rootEl || !document.body.contains(this.rootEl)) {
          const el = findSidebar(container);
          if (el) {
            this.sidebarEl = el;
            this.renderInitialSkeleton();
          }
        }
        if (!this.commentAckEl || !document.body.contains(this.commentAckEl)) {
          this.renderCommentAck();
        }
      });
      this.domObserver.observe(container, { childList: true, subtree: true });
    }

    await this.fetchItem();
  }

  public setHideEvents(hide: boolean): void {
    this.hideEvents = hide;
    const checkbox = this.rootEl?.querySelector<HTMLInputElement>('#octodeck-hide-events-toggle');
    if (checkbox) {
      checkbox.checked = hide;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    console.log(`[OctoDeck Sidebar] Scheduling daemon reconnection attempt in ${this.reconnectDelay}ms...`);
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      if (this.isUnavailable) {
        this.reconnectDelay = Math.min(
          Math.round(this.reconnectDelay * this.backoffMultiplier),
          this.maxReconnectDelay
        );
        this.fetchItem();
      }
    }, this.reconnectDelay);
  }

  private resetReconnectBackoff(): void {
    this.reconnectDelay = this.minReconnectDelay;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      console.log('[OctoDeck Sidebar] Stopped daemon reconnection polling.');
    }
  }

  private renderInitialSkeleton(): void {
    if (!this.sidebarEl) return;

    // Check if already injected
    const existing = document.querySelector('.octodeck-gh-sidebar-section');
    if (existing) {
      existing.remove();
    }

    const section = document.createElement('div');
    section.className = 'discussion-sidebar-item sidebar-item octodeck-gh-sidebar-section';
    this.rootEl = section;

    // Optimal insertion point:
    // 1. If #partial-discussion-sidebar has a parent container (e.g. .Layout-sidebar),
    // insert BEFORE #partial-discussion-sidebar so GitHub's partial AJAX updates do not overwrite us!
    const partialSidebar = document.querySelector('#partial-discussion-sidebar');
    if (partialSidebar && partialSidebar.parentElement) {
      partialSidebar.parentElement.insertBefore(section, partialSidebar);
      console.log('[OctoDeck Sidebar] Injected sidebar widget directly above #partial-discussion-sidebar');
    } else if (this.sidebarEl.firstElementChild) {
      this.sidebarEl.insertBefore(section, this.sidebarEl.firstElementChild);
      console.log('[OctoDeck Sidebar] Injected sidebar widget before first child of sidebar container');
    }

    this.renderSidebar();
  }

  private async fetchItem(): Promise<void> {
    try {
      const pageGid = extractPageGraphQLId();
      const queryId = pageGid || this.itemId;

      const doFetch = (idToFetch: string, isFallback = false) => {
        const msg: ExtensionMessage = { type: 'GET_ITEM', itemId: idToFetch };
        chrome.runtime.sendMessage(msg, (response: ExtensionResponse<Item> | undefined) => {
          if (chrome.runtime.lastError || !response || !response.ok) {
            const errDetail =
              chrome.runtime.lastError?.message ||
              (!response?.ok ? response?.error : undefined) ||
              'unknown';
            console.debug(`[OctoDeck Sidebar] Daemon response for ${idToFetch}:`, errDetail);
            if (!isFallback && pageGid && idToFetch !== this.itemId) {
              console.log(`[OctoDeck Sidebar] Retrying with fallback itemId=${this.itemId}...`);
              doFetch(this.itemId, true);
              return;
            }
            if (errDetail.toLowerCase().includes('not found') || errDetail.includes('404')) {
              this.isOffline = false;
              this.isUntracked = true;
              this.errorMessage = null;
              this.resetReconnectBackoff();
            } else if (
              errDetail.includes('Failed to fetch') ||
              errDetail.includes('NetworkError') ||
              errDetail.toLowerCase().includes('connection refused') ||
              errDetail.includes('ERR_CONNECTION_REFUSED') ||
              errDetail.includes('ECONNREFUSED') ||
              errDetail.toLowerCase().includes('offline')
            ) {
              this.isOffline = true;
              this.isUntracked = false;
              this.errorMessage = null;
              this.scheduleReconnect();
            } else {
              this.isOffline = false;
              this.isUntracked = false;
              this.errorMessage = errDetail;
              this.scheduleReconnect();
            }
            // Do not notify onItemUpdated on failure/retry to prevent unneeded timeline rerendering
            this.render(false);
            return;
          }

          const wasUnavailable = this.isUnavailable;
          this.isOffline = false;
          this.isUntracked = false;
          this.errorMessage = null;
          this.resetReconnectBackoff();
          this.currentItem = response.data;
          this.draftNotes = this.currentItem.local?.privateNotes || '';
          if (wasUnavailable) {
            console.log('[OctoDeck Sidebar] Reconnected to daemon successfully! Updated item state.');
          }
          this.render(true);
        });
      };

      doFetch(queryId);
    } catch (err) {
      console.debug('[OctoDeck Sidebar] Error fetching item state:', err);
      const errDetail = err instanceof Error ? err.message : String(err);
      if (
        errDetail.includes('Failed to fetch') ||
        errDetail.includes('NetworkError') ||
        errDetail.toLowerCase().includes('connection refused') ||
        errDetail.includes('ERR_CONNECTION_REFUSED') ||
        errDetail.includes('ECONNREFUSED') ||
        errDetail.toLowerCase().includes('offline')
      ) {
        this.isOffline = true;
        this.errorMessage = null;
      } else {
        this.isOffline = false;
        this.errorMessage = errDetail;
      }
      this.isUntracked = false;
      this.scheduleReconnect();
      this.render(false);
    }
  }

  private get isUnavailable(): boolean {
    return this.isOffline || Boolean(this.errorMessage);
  }

  private get unavailableReason(): string {
    if (this.isOffline) return 'Octodeck is offline';
    if (this.errorMessage) return `Octodeck error: ${this.errorMessage}`;
    return '';
  }

  private getStatusBadgeInfo(): { label: string; className: string; title: string } {
    if (this.isOffline) {
      return {
        label: 'Offline',
        className: 'octodeck-gh-badge-offline',
        title: 'Unable to connect to OctoDeck daemon. Make sure octodeck serve is running.',
      };
    }
    if (this.errorMessage) {
      return {
        label: 'Error',
        className: 'octodeck-gh-badge-error',
        title: this.errorMessage,
      };
    }
    if (this.isUntracked) {
      return {
        label: 'Untracked',
        className: 'octodeck-gh-badge-untracked',
        title: 'This item is not tracked in your local OctoDeck database.',
      };
    }
    if (!this.currentItem) {
      return {
        label: 'Loading...',
        className: 'octodeck-gh-badge-tracked',
        title: 'Loading item state from OctoDeck...',
      };
    }

    const sub = this.currentItem.viewerSubscription as unknown;
    const isUnsubscribed =
      sub === SubscriptionState.UNSUBSCRIBED ||
      sub === 2 ||
      sub === 'UNSUBSCRIBED' ||
      sub === 'SUBSCRIPTION_STATE_UNSUBSCRIBED';

    if (isUnsubscribed) {
      return {
        label: 'Untracked',
        className: 'octodeck-gh-badge-untracked',
        title:
          'Not subscribed on GitHub. Live updates will not be received automatically unless you subscribe or are mentioned.',
      };
    }

    return {
      label: 'Tracked',
      className: 'octodeck-gh-badge-tracked',
      title: 'Tracked in OctoDeck',
    };
  }

  private render(notifyItemUpdated = true): void {
    this.renderSidebar();
    this.renderCommentAck();
    if (notifyItemUpdated) {
      this.onItemUpdated?.(this.currentItem);
    }
  }

  private renderCommentAck(): void {
    const isAcked = isItemAcked(this.currentItem);

    if (!this.commentAckEl || !document.body.contains(this.commentAckEl)) {
      const commentBtn = findCommentButton(document.body);
      if (!commentBtn || !commentBtn.parentElement) return;

      const existingAck = document.querySelector('.octodeck-gh-comment-ack-btn');
      if (existingAck && existingAck !== this.commentAckEl) {
        existingAck.remove();
      }

      const ackBtn = document.createElement('button');
      ackBtn.type = 'button';
      ackBtn.className = 'octodeck-gh-comment-ack-btn';
      ackBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();

        if (this.isOffline) return;

        const pageGid = extractPageGraphQLId();
        const targetId = this.currentItem?.id || pageGid || this.itemId;
        const currentAcked = isItemAcked(this.currentItem);
        const nextAcked = !currentAcked;

        console.log(`[OctoDeck] Ack button clicked -> setting acked = ${nextAcked} on ${targetId}`);

        // Optimistic UI update
        if (this.currentItem) {
          if (!this.currentItem.local) {
            this.currentItem.local = create(ItemLocalStateSchema, {
              computedStatus: nextAcked ? ItemStatus.ACKED : ItemStatus.IDLE,
              starred: false,
              privateNotes: '',
            });
          } else {
            this.currentItem.local.computedStatus = nextAcked ? ItemStatus.ACKED : ItemStatus.IDLE;
            if (nextAcked) {
              this.currentItem.local.ackedAt = create(TimestampSchema, {
                seconds: BigInt(Math.floor(Date.now() / 1000)),
                nanos: 0,
              });
            } else {
              this.currentItem.local.ackedAt = undefined;
            }
          }
        }
        this.render();

        const msg: ExtensionMessage = { type: 'ACK_ITEM', itemId: targetId, acked: nextAcked };
        chrome.runtime.sendMessage(msg, (response: ExtensionResponse<Item> | undefined) => {
          if (response && response.ok) {
            this.currentItem = response.data;
            this.render();
          } else if ((!response || !response.ok) && targetId !== this.itemId) {
            console.log(`[OctoDeck] Retrying ack with fallback itemId=${this.itemId}`);
            chrome.runtime.sendMessage({ type: 'ACK_ITEM', itemId: this.itemId, acked: nextAcked }, (fallbackResp) => {
              if (fallbackResp && fallbackResp.ok) {
                this.currentItem = fallbackResp.data;
              }
              this.render();
            });
          }
        });
      });

      // Target the cleanest outer wrapper (e.g. tooltip wrapper or ButtonGroup wrapper)
      let targetWrapper: HTMLElement = commentBtn;
      const tooltipWrapper = commentBtn.closest<HTMLElement>('[data-testid="save-button-tooltip"]');
      const groupOrSubtle = commentBtn.closest<HTMLElement>(
        '.BtnGroup, [data-component="ButtonGroup"], div.color-bg-subtle, span.color-bg-subtle'
      );

      if (tooltipWrapper) {
        targetWrapper = tooltipWrapper;
      } else if (
        groupOrSubtle &&
        !groupOrSubtle.classList.contains('form-actions') &&
        !groupOrSubtle.matches('#partial-new-comment-form-actions')
      ) {
        targetWrapper = groupOrSubtle;
      }

      if (targetWrapper.parentElement) {
        targetWrapper.parentElement.insertBefore(ackBtn, targetWrapper);
      } else {
        commentBtn.parentElement.insertBefore(ackBtn, commentBtn);
      }

      // Ensure parent container does not have color-bg-subtle background bleeding
      if (ackBtn.parentElement) {
        ackBtn.parentElement.classList.add('octodeck-gh-comment-actions-clean');
        if (ackBtn.parentElement.classList.contains('color-bg-subtle')) {
          ackBtn.parentElement.style.backgroundColor = 'transparent';
        }
      }

      this.commentAckEl = ackBtn;
    }

    if (this.isUnavailable) {
      this.commentAckEl.disabled = true;
      this.commentAckEl.className = 'octodeck-gh-comment-ack-btn octodeck-gh-disabled';
      this.commentAckEl.title = this.unavailableReason;
      this.commentAckEl.setAttribute('aria-disabled', 'true');
    } else {
      this.commentAckEl.disabled = false;
      this.commentAckEl.className = `octodeck-gh-comment-ack-btn ${isAcked ? 'octodeck-gh-btn-acked' : ''}`;
      this.commentAckEl.title = isAcked ? 'Mark as unacknowledged in Octodeck' : 'Acknowledge item in Octodeck';
      this.commentAckEl.removeAttribute('aria-disabled');
    }

    this.commentAckEl.innerHTML = `<span>${isAcked ? '✓ Acked' : '✓ Ack'}</span>`;
  }

  private renderSidebar(): void {
    if (!this.rootEl) return;

    const notes = this.currentItem?.local?.privateNotes || '';
    const isStarred = Boolean(this.currentItem?.local?.starred);
    const badge = this.getStatusBadgeInfo();

    this.rootEl.innerHTML = `
      <div class="octodeck-gh-sidebar-header">
        <button
          type="button"
          class="octodeck-gh-header-btn octodeck-gh-jump-btn ${this.isUnavailable ? 'octodeck-gh-disabled' : ''}"
          title="${this.isUnavailable ? this.escapeHtml(this.unavailableReason) : 'Open in Octodeck App'}"
          aria-label="Open in Octodeck App"
          ${this.isUnavailable ? 'disabled' : ''}
        >
          <span class="octodeck-gh-header-title">Octodeck</span>
          <svg aria-hidden="true" height="13" viewBox="0 0 16 16" width="13" fill="currentColor">
            <path d="M3.75 2h3.5a.75.75 0 0 1 0 1.5h-3.5a.25.25 0 0 0-.25.25v8.5c0 .138.112.25.25.25h8.5a.25.25 0 0 0 .25-.25v-3.5a.75.75 0 0 1 1.5 0v3.5A1.75 1.75 0 0 1 12.25 14h-8.5A1.75 1.75 0 0 1 2 12.25v-8.5C2 2.784 2.784 2 3.75 2Zm6.5 0a.75.75 0 0 1 .75-.75h3.25c.414 0 .75.336.75.75v3.25a.75.75 0 0 1-1.5 0V3.56l-4.22 4.22a.749.749 0 0 1-1.275-.326.749.749 0 0 1 .215-.734L13.44 2.5H11a.75.75 0 0 1-.75-.75Z"></path>
          </svg>
        </button>
        <div class="octodeck-gh-header-right">
          <button
            type="button"
            class="octodeck-gh-star-btn ${isStarred ? 'octodeck-gh-star-active' : ''} ${this.isUnavailable ? 'octodeck-gh-disabled' : ''}"
            title="${this.isUnavailable ? this.escapeHtml(this.unavailableReason) : isStarred ? 'Unstar in Octodeck' : 'Star in Octodeck'}"
            aria-label="${isStarred ? 'Unstar in Octodeck' : 'Star in Octodeck'}"
            ${this.isUnavailable ? 'disabled' : ''}
          >
            <svg aria-hidden="true" height="14" viewBox="0 0 16 16" width="14" fill="${isStarred && !this.isUnavailable ? '#d4a72c' : 'none'}" stroke="${isStarred && !this.isUnavailable ? '#d4a72c' : 'currentColor'}" stroke-width="1.5">
              <path d="M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.75.75 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25Z"></path>
            </svg>
          </button>
          <span class="octodeck-gh-badge ${badge.className}" title="${this.escapeHtml(badge.title || badge.label)}">${badge.label}</span>
        </div>
      </div>

      <div class="octodeck-gh-notes-section">
        ${this.renderNotesContent(notes)}
      </div>

      <div class="octodeck-gh-filter-row">
        <label class="octodeck-gh-filter-label" for="octodeck-hide-events-toggle">
          <input
            type="checkbox"
            id="octodeck-hide-events-toggle"
            class="octodeck-gh-filter-checkbox"
            ${this.hideEvents ? 'checked' : ''}
          />
          <span class="octodeck-gh-filter-text">Hide events</span>
        </label>
      </div>
    `;

    this.attachEventListeners();
  }

  private renderNotesContent(notes: string): string {
    if (this.isEditingNotes && !this.isUnavailable) {
      return `
        <div class="octodeck-gh-notes-edit-container">
          <textarea
            class="octodeck-gh-notes-textarea"
            placeholder="Private notes are only visible to you."
            rows="3"
          >${this.escapeHtml(this.draftNotes)}</textarea>
          <div class="octodeck-gh-notes-edit-actions">
            <button type="button" class="btn btn-sm octodeck-gh-btn octodeck-gh-btn-sm octodeck-gh-notes-cancel-btn">Cancel</button>
            <button type="button" class="btn btn-sm btn-primary octodeck-gh-btn octodeck-gh-btn-sm octodeck-gh-btn-primary octodeck-gh-notes-save-btn">Save</button>
          </div>
        </div>
      `;
    }

    if (notes) {
      return `
        <div class="octodeck-gh-notes-box">
          <div class="octodeck-gh-notes-header">
            <span class="octodeck-gh-notes-title">Private Notes</span>
            ${
              !this.isUnavailable
                ? `<button type="button" class="octodeck-gh-notes-edit-btn" title="Edit private notes" aria-label="Edit notes">
                    <svg aria-hidden="true" height="13" viewBox="0 0 16 16" width="13" fill="currentColor">
                      <path d="M11.013 1.427a1.75 1.75 0 0 1 2.474 0l1.086 1.086a1.75 1.75 0 0 1 0 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 0 1-.927-.928l.929-3.25c.081-.286.235-.547.445-.758l8.61-8.61Zm1.414 1.06a.25.25 0 0 0-.354 0L10.811 3.75l1.439 1.44 1.263-1.263a.25.25 0 0 0 0-.354l-1.086-1.086ZM11.189 6.25 9.75 4.81 3.242 11.318a.25.25 0 0 0-.063.108l-.57 1.993 1.993-.57a.25.25 0 0 0 .108-.063L11.189 6.25Z"></path>
                    </svg>
                  </button>`
                : ''
            }
          </div>
          <div class="octodeck-gh-notes-text">${this.escapeHtml(notes)}</div>
        </div>
      `;
    }

    return `
      <button
        type="button"
        class="octodeck-gh-notes-trigger octodeck-gh-notes-add-btn ${this.isUnavailable ? 'octodeck-gh-disabled' : ''}"
        ${this.isUnavailable ? `disabled title="${this.escapeHtml(this.unavailableReason)}"` : ''}
      >
        <svg aria-hidden="true" height="14" viewBox="0 0 16 16" width="14" fill="currentColor">
          <path d="M7.75 2a.75.75 0 0 1 .75.75V7h4.25a.75.75 0 0 1 0 1.5H8.5v4.25a.75.75 0 0 1-1.5 0V8.5H2.75a.75.75 0 0 1 0-1.5H7V2.75A.75.75 0 0 1 7.75 2Z"></path>
        </svg>
        <span>Add Private Note</span>
      </button>
    `;
  }

  private attachEventListeners(): void {
    if (!this.rootEl) return;

    // Jump to dashboard button (header link)
    this.rootEl.querySelector('.octodeck-gh-jump-btn')?.addEventListener('click', () => {
      if (this.isUnavailable) return;
      console.log(`[OctoDeck Sidebar] User clicked Octodeck header -> opening ${this.itemId} in dashboard`);
      const msg: ExtensionMessage = { type: 'OPEN_DASHBOARD', itemId: this.itemId };
      chrome.runtime.sendMessage(msg);
    });

    // Star item button
    this.rootEl.querySelector('.octodeck-gh-star-btn')?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();

      if (this.isUnavailable) return;

      const pageGid = extractPageGraphQLId();
      const targetId = this.currentItem?.id || pageGid || this.itemId;
      const currentStarred = Boolean(this.currentItem?.local?.starred);
      const nextStarred = !currentStarred;

      console.log(`[OctoDeck] Star button clicked -> toggling to ${nextStarred} on ${targetId}`);

      // Optimistic UI update
      if (this.currentItem) {
        if (!this.currentItem.local) {
          this.currentItem.local = create(ItemLocalStateSchema, {
            computedStatus: ItemStatus.UNSPECIFIED,
            starred: nextStarred,
            privateNotes: '',
          });
        } else {
          this.currentItem.local.starred = nextStarred;
        }
      }
      this.render();

      const msg: ExtensionMessage = { type: 'STAR_ITEM', itemId: targetId, starred: nextStarred };
      chrome.runtime.sendMessage(msg, (response: ExtensionResponse<Item> | undefined) => {
        if (response && response.ok) {
          this.currentItem = response.data;
          this.render();
        } else if ((!response || !response.ok) && targetId !== this.itemId) {
          console.log(`[OctoDeck] Retrying star with fallback itemId=${this.itemId}`);
          chrome.runtime.sendMessage({ type: 'STAR_ITEM', itemId: this.itemId, starred: nextStarred }, (fallbackResp) => {
            if (fallbackResp && fallbackResp.ok) {
              this.currentItem = fallbackResp.data;
            }
            this.render();
          });
        }
      });
    });

    // Notes Add / Edit button
    this.rootEl.querySelector('.octodeck-gh-notes-add-btn, .octodeck-gh-notes-edit-btn')?.addEventListener('click', () => {
      if (this.isUnavailable) return;
      this.isEditingNotes = true;
      this.draftNotes = this.currentItem?.local?.privateNotes || '';
      this.render();
      const textarea = this.rootEl?.querySelector('textarea');
      if (textarea) {
        textarea.focus();
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
      }
    });

    // Notes Cancel button
    this.rootEl.querySelector('.octodeck-gh-notes-cancel-btn')?.addEventListener('click', () => {
      this.isEditingNotes = false;
      this.render();
    });

    // Notes Save button
    this.rootEl.querySelector('.octodeck-gh-notes-save-btn')?.addEventListener('click', () => {
      if (this.isUnavailable) return;
      this.saveNotes();
    });

    // Notes Textarea shortcuts
    const textarea = this.rootEl.querySelector('textarea');
    if (textarea) {
      textarea.addEventListener('input', (e) => {
        this.draftNotes = (e.target as HTMLTextAreaElement).value;
      });

      textarea.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
          e.preventDefault();
          this.saveNotes();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          this.isEditingNotes = false;
          this.render();
        }
      });
    }

    // Hide Events Toggle
    const hideEventsCheckbox = this.rootEl.querySelector<HTMLInputElement>('#octodeck-hide-events-toggle');
    if (hideEventsCheckbox) {
      hideEventsCheckbox.addEventListener('change', (e) => {
        const checked = (e.target as HTMLInputElement).checked;
        this.hideEvents = checked;
        console.log(`[OctoDeck Sidebar] Toggled Hide Events -> ${checked}`);
        if (this.onToggleHideEvents) {
          this.onToggleHideEvents(checked);
        }
      });
    }
  }

  private saveNotes(): void {
    const pageGid = extractPageGraphQLId();
    const targetId = this.currentItem?.id || pageGid || this.itemId;
    const nextNotes = this.draftNotes;
    console.log(`[OctoDeck Sidebar] Saving private notes for ${targetId} (length: ${nextNotes.length})`);
    const msg: ExtensionMessage = { type: 'SET_NOTES', itemId: targetId, notes: nextNotes };
    chrome.runtime.sendMessage(msg, (response: ExtensionResponse<Item> | undefined) => {
      if (response && response.ok) {
        this.currentItem = response.data;
        console.log(`[OctoDeck Sidebar] Successfully updated notes for ${targetId}`);
      }
      this.isEditingNotes = false;
      this.render();
    });
  }

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  public destroy(): void {
    this.resetReconnectBackoff();
    if (this.domObserver) {
      this.domObserver.disconnect();
      this.domObserver = null;
    }
    if (this.rootEl && this.rootEl.parentNode) {
      this.rootEl.parentNode.removeChild(this.rootEl);
      this.rootEl = null;
    }
    if (this.commentAckEl && this.commentAckEl.parentNode) {
      this.commentAckEl.parentNode.removeChild(this.commentAckEl);
      this.commentAckEl = null;
    }
  }
}
