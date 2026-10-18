/**
 * Ack button next to the new-comment composer's submit button (mutator; requires the composer
 * scope). Split from the sidebar widget so each fails independently.
 *
 * Item state normally comes from the sidebar widget via 'item:updated'. If none arrives (sidebar
 * not recognized on this page), the button fetches the item itself.
 */
import { create } from '@bufbuild/protobuf';
import { TimestampSchema } from '@bufbuild/protobuf/wkt';
import { ItemStatus } from '../../../api/octodeck/v1/resources_pb';
import type { ItemRef } from '../dom/types';
import { isOwnNode } from '../engine/constants';
import type { BusEvents, Feature, FeatureContext, FeatureRegistration } from '../engine/types';
import {
  candidateIds,
  isItemAcked,
  isUnavailable,
  sendItemMessage,
  startItemSync,
  toItemUpdated,
  unavailableReason,
  withLocal,
  type ItemSnapshot,
} from './daemonItem';
import { h } from './ui';

/** How long to wait for the sidebar widget's 'item:updated' before fetching the item ourselves. */
export const ACK_FALLBACK_FETCH_MS = 3000;

class AckButton implements Feature {
  readonly id = 'ackButton' as const;
  readonly kind = 'mutator' as const;
  readonly pages = ['issue', 'pr-conversation'] as const;
  readonly requires = ['composer'] as const;

  private ctx!: FeatureContext;
  private ref!: ItemRef;
  private btn!: HTMLButtonElement;
  private snapshot: ItemSnapshot | null = null;
  private emitting = false;
  private ownSyncStarted = false;

  mount(ctx: FeatureContext): void {
    this.ctx = ctx;
    const ref = ctx.caps.page.facts().item;
    if (!ref || !ctx.caps.composer) {
      ctx.setStatus({ health: 'notApplicable', detail: ref ? 'scope:composer' : 'no-item' });
      return;
    }
    this.ref = ref;

    this.btn = ctx.ledger.create('button', 'ack-button');
    this.btn.type = 'button';
    // Variant hint for per-layout spacing in features.css (our own attribute on our own node).
    const variant = ctx.session.facts.variants.composer;
    if (variant) this.btn.setAttribute('data-octodeck-variant', variant);
    this.btn.addEventListener(
      'click',
      ctx.guard(async (e: Event) => {
        e.preventDefault();
        e.stopPropagation();
        await this.toggleAck();
      })
    );
    this.render();
    if (!this.place()) {
      ctx.setStatus({ health: 'unrecognized', detail: 'composer-insertion-point' });
    }

    ctx.onScopeChange('composer', () => {
      if (!this.btn.isConnected) this.place();
    });

    const last = ctx.bus.last('item:updated');
    if (last) this.adopt(last);
    ctx.bus.on('item:updated', (v) => {
      if (!this.emitting) this.adopt(v);
    });
    if (!last) {
      ctx.setTimer(() => {
        if (!this.snapshot) this.startOwnSync();
      }, ACK_FALLBACK_FETCH_MS);
    }
  }

  private place(): boolean {
    const point = this.ctx.caps.composer?.insertionPoint();
    if (!point) return false;
    this.ctx.ledger.insert(this.btn, point);
    // GitHub's composer footer can paint a subtle background behind our button; neutralize it
    // through an OctoDeck class (reverted with the ledger) instead of an inline style.
    const parent = this.btn.parentElement;
    if (parent && !isOwnNode(parent)) this.ctx.ledger.addClass(parent, 'octodeck-gh-comment-actions-clean');
    return true;
  }

  private adopt(v: BusEvents['item:updated']): void {
    this.snapshot = { item: v.item ?? this.snapshot?.item ?? null, daemon: v.daemon, error: v.error };
    this.render();
  }

  private startOwnSync(): void {
    if (this.ownSyncStarted) return;
    this.ownSyncStarted = true;
    startItemSync(this.ctx, this.ref, () => this.snapshot?.item ?? null, (s) => this.apply(s));
  }

  private apply(s: ItemSnapshot): void {
    this.snapshot = s;
    this.render();
    this.emitting = true;
    try {
      this.ctx.bus.emit('item:updated', toItemUpdated(s));
    } finally {
      this.emitting = false;
    }
  }

  private render(): void {
    const item = this.snapshot?.item ?? null;
    const acked = isItemAcked(item);
    const off = this.snapshot ? isUnavailable(this.snapshot.daemon) : false;
    this.btn.className = 'octodeck-gh-comment-ack-btn';
    if (off) {
      this.btn.disabled = true;
      this.btn.classList.add('octodeck-gh-disabled');
      this.btn.title = unavailableReason(this.snapshot!);
      this.btn.setAttribute('aria-disabled', 'true');
    } else {
      this.btn.disabled = false;
      if (acked) this.btn.classList.add('octodeck-gh-btn-acked');
      this.btn.title = acked ? 'Mark as unacknowledged in Octodeck' : 'Acknowledge item in Octodeck';
      this.btn.removeAttribute('aria-disabled');
    }
    this.btn.replaceChildren(h('span', undefined, acked ? '✓ Acked' : '✓ Ack'));
  }

  private async toggleAck(): Promise<void> {
    if (this.snapshot && isUnavailable(this.snapshot.daemon)) return;
    const previous = this.snapshot?.item ?? null;
    const next = !isItemAcked(previous);

    if (previous) {
      // Optimistic update on a copy. Only the daemon knows the synced activity watermark; leaving
      // it unset makes readers fall back to ackedAt (now), placing the marker at the end until the
      // daemon's response replaces the item.
      this.apply({
        item: withLocal(previous, {
          computedStatus: next ? ItemStatus.ACKED : ItemStatus.IDLE,
          ackedAt: next
            ? create(TimestampSchema, { seconds: BigInt(Math.floor(Date.now() / 1000)), nanos: 0 })
            : undefined,
          ackedActivityAt: undefined,
        }),
        daemon: 'ok',
      });
    }

    const res = await sendItemMessage(this.ctx, this.ref, candidateIds(this.ref, previous), (itemId) => ({
      type: 'ACK_ITEM',
      itemId,
      acked: next,
    }));
    if (res.ok) {
      this.apply({ item: res.item, daemon: 'ok' });
    } else if (previous) {
      // Roll the optimistic change back so the button and markers reflect the daemon's state.
      this.apply({ item: previous, daemon: 'ok' });
    }
  }
}

export const ackButton: FeatureRegistration = {
  id: 'ackButton',
  create: () => new AckButton(),
};
