/**
 * Test helper (WP1): builds a real page session (facts, scope detection, resolver, capabilities)
 * on the current jsdom document, as the engine's session code does.
 */
import { buildCapabilities, type CapabilityDeps } from '../content/capabilities/build';
import { computePageFacts } from '../content/capabilities/page';
import type { Capabilities } from '../content/capabilities/types';
import { Resolver, detectScopes, type ResolveEvent } from '../content/dom/resolver';
import type { ScopeDetection, ScopeId } from '../content/dom/types';
import type { ScopeChange } from '../content/engine/types';
import { VARIANTS } from '../content/variants';
import type { VariantModule } from '../content/variants/types';
import type { Diagnostic } from '../types';
import { createFakeBus, createFakeLedger, type FakeLedger } from './fakes/context';

export interface CapabilitySession {
  detections: Partial<Record<ScopeId, ScopeDetection>>;
  resolver: Resolver;
  caps: Capabilities;
  events: ResolveEvent[];
  reports: Diagnostic[];
  navLedger: FakeLedger;
  /** Delivers a scope change to every onScopeChange subscriber of that scope. */
  fireScopeChange(change: ScopeChange): void;
}

export function openCapabilitySession(
  url: string = window.location.href,
  overrides: Partial<CapabilityDeps> & { variants?: readonly VariantModule[] } = {}
): CapabilitySession {
  const variants = overrides.variants ?? VARIANTS;
  const events: ResolveEvent[] = [];
  const reports: Diagnostic[] = [];
  const { facts, pageDetection } = computePageFacts(new URL(url), document, variants, {
    onEvent: (e) => events.push(e),
    report: (d) => reports.push(d),
  });
  const detections: Partial<Record<ScopeId, ScopeDetection>> = {
    page: pageDetection,
    ...detectScopes(document, variants, facts, ['timeline', 'sidebar', 'composer']),
  };
  const resolver = new Resolver({ facts, detections, variants, onEvent: (e) => events.push(e) });
  const subscribers: Array<{ scope: ScopeId; cb: (c: ScopeChange) => void; signal: AbortSignal }> = [];
  const navLedger = createFakeLedger('anchorNav');
  const caps = buildCapabilities({
    resolver,
    variants,
    doc: document,
    win: window,
    bus: createFakeBus().forSignal(new AbortController().signal),
    navLedger,
    onHash: () => {},
    onScopeChange: (scope, cb, signal) => subscribers.push({ scope, cb, signal }),
    report: (d) => reports.push(d),
    ...overrides,
  });
  return {
    detections,
    resolver,
    caps,
    events,
    reports,
    navLedger,
    fireScopeChange: (change) => {
      for (const s of subscribers) if (s.scope === change.scope && !s.signal.aborted) s.cb(change);
    },
  };
}
