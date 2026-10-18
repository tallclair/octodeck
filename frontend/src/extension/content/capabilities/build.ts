/**
 * Builds the session's Capabilities from scope detection and the registered variant modules
 * (design section 6). Capabilities for scopes that are not 'recognized' are null, so mutators that
 * require them never mount (section 7).
 */
import type { Diagnostic } from '../../types';
import type { Resolver } from '../dom/resolver';
import type { ScopeId } from '../dom/types';
import type { EventBus, FeatureLedger, ScopeChange } from '../engine/types';
import type { VariantModule } from '../variants/types';
import { createActionsCap } from './actions';
import { createComposerCap } from './composer';
import { createLoadUntil } from './loadUntil';
import { createNavigationCap } from './navigation';
import { createPageCap } from './page';
import { createSidebarCap } from './sidebar';
import { createTimelineCap, type LoadUntilFactory } from './timeline';
import type { Capabilities } from './types';

export interface CapabilityDeps {
  resolver: Resolver;
  variants: readonly VariantModule[];
  doc: Document;
  win: Window;
  bus: EventBus;
  /** Engine-provided ledger bound to anchorNav for the session (toast and highlight nodes). */
  navLedger: FeatureLedger;
  onHash: (cb: (hash: string) => void, signal: AbortSignal) => void;
  onScopeChange: (scope: ScopeId, cb: (change: ScopeChange) => void, signal: AbortSignal) => void;
  /** Session-level sink for capability diagnostics (unknown kinds, identity mismatch, load failures). */
  report?: (d: Diagnostic) => void;
  /** Bounded loader factory; defaults to capabilities/loadUntil.ts (overridable in tests). */
  createLoadUntil?: LoadUntilFactory;
}

export function buildCapabilities(deps: CapabilityDeps): Capabilities {
  const { resolver } = deps;
  const timelineModule = resolver.variantFor('timeline');
  const composerModule = resolver.variantFor('composer');
  const sidebarModule = resolver.variantFor('sidebar');

  return {
    page: createPageCap(resolver.facts),
    timeline: timelineModule
      ? createTimelineCap({
          resolver,
          module: timelineModule,
          doc: deps.doc,
          bus: deps.bus,
          onScopeChange: deps.onScopeChange,
          report: deps.report,
          createLoadUntil: deps.createLoadUntil ?? createLoadUntil,
        })
      : null,
    composer: composerModule ? createComposerCap(resolver, composerModule) : null,
    sidebar: sidebarModule ? createSidebarCap(resolver, sidebarModule) : null,
    navigation: createNavigationCap({ doc: deps.doc, win: deps.win, navLedger: deps.navLedger, onHash: deps.onHash }),
    // Actions span the whole page; the page variant's adapter classifies them.
    actions: createActionsCap(resolver.variantFor('page')),
  };
}
