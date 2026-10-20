/**
 * OctoDeck sidebar widget (mutator; requires the sidebar scope).
 *
 * Shows the item's OctoDeck state (tracked badge, star, private notes), the Hide events switch,
 * and a "Limited" chip when other OctoDeck features are paused on this page (decision 6).
 * The Expand all control lives inline in the timeline (owned by expandAll), not here.
 *
 * It owns the daemon fetch for the current item and publishes it as 'item:updated'.
 */
import type { FeatureId, ItemRef } from '../dom/types';
import type { BusEvents, Feature, FeatureContext, FeatureRegistration, FeatureStatus } from '../engine/types';
import {
  candidateIds,
  isUnavailable,
  sendItemMessage,
  startItemSync,
  toItemUpdated,
  unavailableReason,
  withLocal,
  type ItemSnapshot,
} from './daemonItem';
import { button, h, ICON_LINK_EXTERNAL, ICON_PENCIL, ICON_PLUS, ICON_STAR, svgIcon } from './ui';

const STAR_COLOR = '#d4a72c';

/** User-facing names for the "Limited" chip tooltip. */
export const FEATURE_LABELS: Record<FeatureId, string> = {
  viewTracker: 'View tracking',
  actionTracker: 'Action tracking',
  sidebarWidget: 'Sidebar widget',
  ackButton: 'Ack button',
  noiseCollapser: 'Bot comment collapsing and Hide events',
  timelineMarkers: 'Timeline markers',
  expandAll: 'Expand all',
  anchorNav: 'Comment link repair',
};

/** Health values that mean "paused because the page wasn't recognized or the feature broke". */
const PAUSED_HEALTH = new Set<FeatureStatus['health']>(['unrecognized', 'disabled']);

export function pausedFeatures(health: BusEvents['host:health'] | undefined, self: FeatureId): FeatureId[] {
  if (!health) return [];
  return (Object.keys(health) as FeatureId[]).filter((id) => id !== self && PAUSED_HEALTH.has(health[id]!.health));
}

interface BadgeInfo {
  label: string;
  className: string;
  title: string;
}

export function badgeFor(snapshot: ItemSnapshot | null): BadgeInfo {
  if (snapshot?.daemon === 'offline') {
    return {
      label: 'Offline',
      className: 'octodeck-gh-badge-offline',
      title: 'Unable to connect to OctoDeck daemon. Make sure octodeck serve is running.',
    };
  }
  if (snapshot?.daemon === 'error') {
    return { label: 'Error', className: 'octodeck-gh-badge-error', title: snapshot.error ?? 'unknown' };
  }
  if (snapshot?.daemon === 'notFound') {
    return {
      label: 'Untracked',
      className: 'octodeck-gh-badge-untracked',
      title: 'This item is not tracked in your local OctoDeck database.',
    };
  }
  if (!snapshot?.item) {
    return { label: 'Loading...', className: 'octodeck-gh-badge-tracked', title: 'Loading item state from OctoDeck...' };
  }
  const sub = snapshot.item.viewerSubscription as unknown;
  const isUnsubscribed =
    sub === 2 || sub === 'UNSUBSCRIBED' || sub === 'SUBSCRIPTION_STATE_UNSUBSCRIBED';
  if (isUnsubscribed) {
    return {
      label: 'Untracked',
      className: 'octodeck-gh-badge-untracked',
      title:
        'Not subscribed on GitHub. Live updates will not be received automatically unless you subscribe or are mentioned.',
    };
  }
  return { label: 'Tracked', className: 'octodeck-gh-badge-tracked', title: 'Tracked in OctoDeck' };
}

class SidebarWidget implements Feature {
  readonly id = 'sidebarWidget' as const;
  readonly kind = 'mutator' as const;
  readonly pages = ['issue', 'pr-conversation'] as const;
  readonly requires = ['sidebar'] as const;

  private ctx!: FeatureContext;
  private ref!: ItemRef;
  private root!: HTMLDivElement;
  private headerEl!: HTMLDivElement;
  private notesEl!: HTMLDivElement;
  private hideEventsBox!: HTMLInputElement;

  /** Last snapshot from the daemon; item survives offline periods. */
  private snapshot: ItemSnapshot | null = null;
  private isEditingNotes = false;
  private draftNotes = '';
  /** Set while this feature emits 'item:updated', so its own listener ignores the echo. */
  private emitting = false;

  mount(ctx: FeatureContext): void {
    this.ctx = ctx;
    const ref = ctx.caps.page.facts().item;
    if (!ref || !ctx.caps.sidebar) {
      ctx.setStatus({ health: 'notApplicable', detail: ref ? 'scope:sidebar' : 'no-item' });
      return;
    }
    this.ref = ref;
    this.build();
    if (!this.place()) {
      ctx.setStatus({ health: 'unrecognized', detail: 'sidebar-insertion-point' });
    }

    // Re-insert when GitHub/React re-renders the sidebar and drops our node. The ledger counts
    // re-inserts, so a fight with React reconciliation trips the circuit breaker.
    ctx.onScopeChange('sidebar', () => {
      if (!this.root.isConnected) this.place();
    });

    ctx.prefs.onChange((p) => {
      this.hideEventsBox.checked = p.hideEvents;
    }, ctx.signal);

    ctx.bus.on('item:updated', (v) => {
      if (this.emitting) return;
      // Another feature (the Ack button) changed the item; adopt it.
      this.snapshot = { item: v.item ?? this.snapshot?.item ?? null, daemon: v.daemon, error: v.error };
      this.renderHeader();
      if (!this.isEditingNotes) this.renderNotes();
    });
    ctx.bus.on('host:health', () => this.renderHeader());

    startItemSync(ctx, ref, () => this.snapshot?.item ?? null, (s) => this.applySnapshot(s));
  }

  /** Inserts the widget at the sidebar's insertion point; returns false when there is none. */
  private place(): boolean {
    const point = this.ctx.caps.sidebar?.insertionPoint();
    if (!point) return false;
    this.ctx.ledger.insert(this.root, point);
    return true;
  }

  private build(): void {
    const { ledger } = this.ctx;
    this.root = ledger.create('div', 'sidebar-widget');
    this.root.className = 'octodeck-gh-sidebar-section';
    this.headerEl = h('div', 'octodeck-gh-sidebar-header');
    this.notesEl = h('div', 'octodeck-gh-notes-section');

    const filterRow = h('div', 'octodeck-gh-filter-row');
    const label = h('label', 'octodeck-gh-filter-label');
    this.hideEventsBox = h('input', 'octodeck-gh-filter-checkbox');
    this.hideEventsBox.type = 'checkbox';
    this.hideEventsBox.checked = this.ctx.prefs.current().hideEvents;
    this.hideEventsBox.addEventListener(
      'change',
      this.ctx.guard(() => this.ctx.prefs.setHideEvents(this.hideEventsBox.checked))
    );
    label.append(this.hideEventsBox, h('span', 'octodeck-gh-filter-text', 'Hide events'));
    filterRow.appendChild(label);

    this.root.append(this.headerEl, this.notesEl, filterRow);
    this.renderHeader();
    this.renderNotes();
  }

  private applySnapshot(s: ItemSnapshot): void {
    this.snapshot = s;
    if (s.daemon === 'ok' && !this.isEditingNotes) {
      this.draftNotes = s.item?.local?.privateNotes || '';
    }
    this.renderHeader();
    if (!this.isEditingNotes) this.renderNotes();
    this.publish();
  }

  private publish(): void {
    if (!this.snapshot) return;
    this.emitting = true;
    try {
      this.ctx.bus.emit('item:updated', toItemUpdated(this.snapshot));
    } finally {
      this.emitting = false;
    }
  }

  private get unavailable(): boolean {
    return this.snapshot ? isUnavailable(this.snapshot.daemon) : false;
  }

  private get unavailableText(): string {
    return this.snapshot ? unavailableReason(this.snapshot) : '';
  }

  private renderHeader(): void {
    const item = this.snapshot?.item ?? null;
    const isStarred = Boolean(item?.local?.starred);
    const off = this.unavailable;
    const badge = badgeFor(this.snapshot);

    const jump = button('octodeck-gh-header-btn octodeck-gh-jump-btn', {
      label: 'Open in Octodeck App',
      title: off ? this.unavailableText : 'Open in Octodeck App',
      disabled: off,
    });
    jump.append(h('span', 'octodeck-gh-header-title', 'Octodeck'), svgIcon(ICON_LINK_EXTERNAL, 13));
    jump.addEventListener(
      'click',
      this.ctx.guard(() => {
        if (this.unavailable) return;
        void this.ctx.send({ type: 'OPEN_DASHBOARD', itemId: this.ref.itemId });
      })
    );

    const right = h('div', 'octodeck-gh-header-right');
    const paused = pausedFeatures(this.ctx.bus.last('host:health'), this.id);
    if (paused.length > 0) {
      const chip = h('span', 'octodeck-gh-limited-chip', 'Limited');
      chip.title = `GitHub's page layout wasn't fully recognized, so some OctoDeck features are paused here: ${paused
        .map((id) => FEATURE_LABELS[id])
        .join(', ')}.`;
      chip.setAttribute('role', 'status');
      right.appendChild(chip);
    }

    const starLabel = isStarred ? 'Unstar in Octodeck' : 'Star in Octodeck';
    const star = button(`octodeck-gh-star-btn${isStarred ? ' octodeck-gh-star-active' : ''}`, {
      label: starLabel,
      title: off ? this.unavailableText : starLabel,
      disabled: off,
    });
    const lit = isStarred && !off;
    star.appendChild(
      svgIcon(ICON_STAR, 14, { fill: lit ? STAR_COLOR : 'none', stroke: lit ? STAR_COLOR : 'currentColor', strokeWidth: '1.5' })
    );
    star.addEventListener(
      'click',
      this.ctx.guard(async (e: Event) => {
        e.preventDefault();
        e.stopPropagation();
        await this.toggleStar();
      })
    );

    const badgeEl = h('span', `octodeck-gh-badge ${badge.className}`, badge.label);
    badgeEl.title = badge.title || badge.label;
    right.append(star, badgeEl);
    this.headerEl.replaceChildren(jump, right);
  }

  private renderNotes(): void {
    const off = this.unavailable;
    const notes = this.snapshot?.item?.local?.privateNotes || '';

    if (this.isEditingNotes && !off) {
      const container = h('div', 'octodeck-gh-notes-edit-container');
      const textarea = h('textarea', 'octodeck-gh-notes-textarea');
      textarea.placeholder = 'Private notes are only visible to you.';
      textarea.rows = 3;
      textarea.value = this.draftNotes;
      textarea.addEventListener(
        'input',
        this.ctx.guard(() => {
          this.draftNotes = textarea.value;
        })
      );
      textarea.addEventListener(
        'keydown',
        this.ctx.guard(async (e: KeyboardEvent) => {
          if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault();
            await this.saveNotes();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            this.isEditingNotes = false;
            this.renderNotes();
          }
        })
      );
      const actions = h('div', 'octodeck-gh-notes-edit-actions');
      const cancel = button('octodeck-gh-btn octodeck-gh-btn-sm octodeck-gh-notes-cancel-btn');
      cancel.textContent = 'Cancel';
      cancel.addEventListener(
        'click',
        this.ctx.guard(() => {
          this.isEditingNotes = false;
          this.renderNotes();
        })
      );
      const save = button('octodeck-gh-btn octodeck-gh-btn-sm octodeck-gh-btn-primary octodeck-gh-notes-save-btn');
      save.textContent = 'Save';
      save.addEventListener('click', this.ctx.guard(() => this.saveNotes()));
      actions.append(cancel, save);
      container.append(textarea, actions);
      this.notesEl.replaceChildren(container);
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
      return;
    }

    const startEditing = this.ctx.guard(() => {
      if (this.unavailable) return;
      this.isEditingNotes = true;
      this.draftNotes = this.snapshot?.item?.local?.privateNotes || '';
      this.renderNotes();
    });

    if (notes) {
      const box = h('div', 'octodeck-gh-notes-box');
      const header = h('div', 'octodeck-gh-notes-header');
      header.appendChild(h('span', 'octodeck-gh-notes-title', 'Private Notes'));
      if (!off) {
        const edit = button('octodeck-gh-notes-edit-btn', { label: 'Edit notes', title: 'Edit private notes' });
        edit.appendChild(svgIcon(ICON_PENCIL, 13));
        edit.addEventListener('click', startEditing);
        header.appendChild(edit);
      }
      box.append(header, h('div', 'octodeck-gh-notes-text', notes));
      this.notesEl.replaceChildren(box);
      return;
    }

    const add = button('octodeck-gh-notes-trigger octodeck-gh-notes-add-btn', {
      title: off ? this.unavailableText : undefined,
      disabled: off,
    });
    add.append(svgIcon(ICON_PLUS, 14), h('span', undefined, 'Add Private Note'));
    add.addEventListener('click', startEditing);
    this.notesEl.replaceChildren(add);
  }

  private async toggleStar(): Promise<void> {
    if (this.unavailable) return;
    const previous = this.snapshot?.item ?? null;
    const next = !previous?.local?.starred;
    // Optimistic update on a copy: the item object is shared with other features via the bus.
    if (previous) {
      this.applySnapshot({ item: withLocal(previous, { starred: next }), daemon: 'ok' });
    }
    const res = await sendItemMessage(this.ctx, this.ref, candidateIds(this.ref, previous), (itemId) => ({
      type: 'STAR_ITEM',
      itemId,
      starred: next,
    }));
    if (res.ok) {
      this.applySnapshot({ item: res.item, daemon: 'ok' });
    } else if (previous) {
      this.applySnapshot({ item: previous, daemon: 'ok' });
    }
  }

  private async saveNotes(): Promise<void> {
    if (this.unavailable) return;
    const item = this.snapshot?.item ?? null;
    const notes = this.draftNotes;
    const res = await sendItemMessage(this.ctx, this.ref, candidateIds(this.ref, item), (itemId) => ({
      type: 'SET_NOTES',
      itemId,
      notes,
    }));
    this.isEditingNotes = false;
    if (res.ok) {
      this.applySnapshot({ item: res.item, daemon: 'ok' });
    } else {
      this.renderNotes();
    }
  }
}

export const sidebarWidget: FeatureRegistration = {
  id: 'sidebarWidget',
  create: () => new SidebarWidget(),
};
