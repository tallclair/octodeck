/**
 * DOM contract resolver: variant detection per scope and anchor resolution with cardinality
 * (docs/internal/extension_dom_engine_design.md sections 4.2-4.3).
 *
 * Rules:
 * - Only searches inside the scope root (or the `within` anchor's element).
 * - Never returns OctoDeck-owned nodes.
 * - More than one match for a `one`/`zeroOrOne` anchor is `ambiguous`; the first match is never
 *   silently used. `allEqual` matches must agree on their extracted value.
 * - A hit on a selector other than index 0 is `fallback` (drift), still usable.
 */
import type { VariantModule } from '../variants/types';
import { isOwnNode } from '../engine/constants';
import { ANCHORS } from './anchors';
import type {
  AnchorId,
  Locator,
  PageFacts,
  Resolution,
  ScopeDetection,
  ScopeId,
  VariantDetector,
  VariantId,
} from './types';

/** Runs one selector against a base element, including the base itself, minus OctoDeck nodes. */
function queryAll(base: ParentNode, selector: string): Element[] {
  let found: Element[];
  try {
    found = Array.from(base.querySelectorAll(selector));
    if (base instanceof Element && base.matches(selector)) found.unshift(base);
  } catch {
    // An invalid selector is a contract bug (caught by contract tests); at runtime it matches nothing.
    return [];
  }
  return found.filter((el) => !isOwnNode(el));
}

/** Applies validate and map, de-duplicating mapped results. */
function refine(candidates: Element[], locator: Locator): Element[] {
  const out: Element[] = [];
  for (const el of candidates) {
    if (locator.validate && !locator.validate(el)) continue;
    const mapped = locator.map ? locator.map(el) : el;
    if (mapped && !isOwnNode(mapped) && !out.includes(mapped)) out.push(mapped);
  }
  return out;
}

/** Whether an anchor must exist on this page (required for the page kind and not declared absent). */
export function isAnchorExpected(id: AnchorId, facts: PageFacts): boolean {
  const def = ANCHORS[id];
  if (def.presence[facts.kind] !== 'required') return false;
  return !(def.absentWhen?.(facts) ?? false);
}

/** A scope is expected when at least one of its anchors is expected on this page. */
export function isScopeExpected(scope: ScopeId, facts: PageFacts): boolean {
  return (Object.keys(ANCHORS) as AnchorId[]).some((id) => ANCHORS[id].scope === scope && isAnchorExpected(id, facts));
}

/** Resolves one locator inside a base element. Pure; no reporting or memoization. */
export function resolveLocator(
  id: AnchorId,
  locator: Locator,
  base: ParentNode,
  variant: VariantId,
  facts: PageFacts
): Resolution {
  const { cardinality } = ANCHORS[id];
  for (let i = 0; i < locator.selectors.length; i++) {
    const els = refine(queryAll(base, locator.selectors[i]), locator);
    if (els.length === 0) continue;

    if ((cardinality === 'one' || cardinality === 'zeroOrOne') && els.length > 1) {
      return { status: 'ambiguous', count: els.length, selectorIndex: i, variant };
    }
    if (cardinality === 'allEqual') {
      const values = new Set(els.map((el) => (locator.value ? locator.value(el) : null)));
      if (values.size > 1 || values.has(null)) {
        return { status: 'ambiguous', count: els.length, selectorIndex: i, variant };
      }
    }
    return i === 0 ? { status: 'ok', els, selectorIndex: 0, variant } : { status: 'fallback', els, selectorIndex: i, variant };
  }
  // 'many' means zero-or-more: no match is a valid, empty result. Capabilities detect anomalies
  // such as a non-empty timeline root yielding zero items.
  if (cardinality === 'many') return { status: 'ok', els: [], selectorIndex: 0, variant };
  return { status: 'missing', variant, expected: isAnchorExpected(id, facts) };
}

/** Finds a detector's root in the document. Ambiguous roots within one variant count as no match. */
function matchDetector(detector: VariantDetector, doc: ParentNode): { root: Element; selectorIndex: number } | null {
  const { root: locator, confirm } = detector;
  for (let i = 0; i < locator.selectors.length; i++) {
    const roots = refine(queryAll(doc, locator.selectors[i]), locator);
    if (roots.length !== 1) {
      if (roots.length > 1) return null;
      continue;
    }
    const root = roots[0];
    if (confirm && !confirm.every((sel) => queryAll(root, sel).length > 0)) continue;
    return { root, selectorIndex: i };
  }
  return null;
}

/** Detects which variant (if any) owns a scope on this page. */
export function detectScope(
  scope: ScopeId,
  doc: ParentNode,
  variants: readonly VariantModule[],
  facts: PageFacts
): ScopeDetection {
  const matches: Array<{ variant: VariantId; root: Element; selectorIndex: number }> = [];
  for (const module of variants) {
    const detector = module.detectors[scope];
    if (!detector) continue;
    const m = matchDetector(detector, doc);
    if (m) matches.push({ variant: module.id, ...m });
  }
  const candidates = matches.map((m) => m.variant);
  if (matches.length === 0) {
    return { scope, status: isScopeExpected(scope, facts) ? 'unrecognized' : 'absent', candidates };
  }
  if (matches.length > 1) {
    return { scope, status: 'ambiguous', candidates };
  }
  const [m] = matches;
  return { scope, status: 'recognized', variant: m.variant, root: m.root, selectorIndex: m.selectorIndex, candidates };
}

export function detectScopes(
  doc: ParentNode,
  variants: readonly VariantModule[],
  facts: PageFacts,
  scopes: readonly ScopeId[]
): Partial<Record<ScopeId, ScopeDetection>> {
  const out: Partial<Record<ScopeId, ScopeDetection>> = {};
  for (const scope of scopes) out[scope] = detectScope(scope, doc, variants, facts);
  return out;
}

/** Everything the resolver tells its owner about a non-ok resolution (for diagnostics). */
export interface ResolveEvent {
  anchor: AnchorId;
  scope: ScopeId;
  resolution: Resolution;
  /** Element searched from (scope root or `within` element); fingerprints start here. */
  base: Element | null;
}

export interface ResolverOptions {
  facts: PageFacts;
  detections: Partial<Record<ScopeId, ScopeDetection>>;
  variants: readonly VariantModule[];
  /** Called for fallback, ambiguous and expected-missing results. */
  onEvent?: (event: ResolveEvent) => void;
}

/**
 * Session-scoped resolver with memoization. Results without an explicit `within` element are
 * memoized until invalidate(scope); memo hits are re-checked with isConnected.
 */
export class Resolver {
  private readonly byId: ReadonlyMap<VariantId, VariantModule>;
  private readonly memo = new Map<AnchorId, Resolution>();

  constructor(private readonly opts: ResolverOptions) {
    this.byId = new Map(opts.variants.map((v) => [v.id, v]));
  }

  get facts(): PageFacts {
    return this.opts.facts;
  }

  detection(scope: ScopeId): ScopeDetection | undefined {
    return this.opts.detections[scope];
  }

  /** The variant module recognized for a scope, if any. */
  variantFor(scope: ScopeId): VariantModule | undefined {
    const det = this.opts.detections[scope];
    return det?.status === 'recognized' && det.variant ? this.byId.get(det.variant) : undefined;
  }

  /** Replaces a scope's detection (e.g. after its root was replaced) and drops its memoized anchors. */
  setDetection(detection: ScopeDetection): void {
    this.opts.detections[detection.scope] = detection;
    this.invalidate(detection.scope);
  }

  invalidate(scope?: ScopeId): void {
    if (!scope) {
      this.memo.clear();
      return;
    }
    for (const id of Array.from(this.memo.keys())) if (ANCHORS[id].scope === scope) this.memo.delete(id);
  }

  resolve(id: AnchorId, within?: Element): Resolution {
    if (!within) {
      const hit = this.memo.get(id);
      if (hit && (!('els' in hit) || hit.els.every((el) => el.isConnected))) return hit;
    }
    const res = this.compute(id, within);
    if (!within) this.memo.set(id, res);
    return res;
  }

  /** Convenience: the first element of an ok/fallback resolution, else null. */
  first(id: AnchorId, within?: Element): Element | null {
    const res = this.resolve(id, within);
    return res.status === 'ok' || res.status === 'fallback' ? (res.els[0] ?? null) : null;
  }

  /** Convenience: all elements of an ok/fallback resolution, else []. */
  all(id: AnchorId, within?: Element): Element[] {
    const res = this.resolve(id, within);
    return res.status === 'ok' || res.status === 'fallback' ? res.els : [];
  }

  private compute(id: AnchorId, within?: Element): Resolution {
    const { scope } = ANCHORS[id];
    const det = this.opts.detections[scope];
    const module = this.variantFor(scope);
    const variant = det?.variant ?? 'unknown';
    if (!det || det.status !== 'recognized' || !module || !det.root) {
      return { status: 'missing', variant, expected: false };
    }
    if (!det.root.isConnected) {
      // The scope root was replaced; the engine re-detects the scope. Transient, so not reported.
      return { status: 'missing', variant, expected: isAnchorExpected(id, this.opts.facts) };
    }
    const locator = module.anchors[id];
    if (!locator) {
      // The variant doesn't provide this anchor. Contract tests flag required anchors without locators.
      const res: Resolution = { status: 'missing', variant, expected: isAnchorExpected(id, this.opts.facts) };
      this.emit(id, scope, res, det.root);
      return res;
    }
    let base: Element | null = within ?? det.root;
    if (!within && locator.within) {
      base = this.first(locator.within);
      if (!base) {
        return { status: 'missing', variant, expected: isAnchorExpected(id, this.opts.facts) };
      }
    }
    const res = resolveLocator(id, locator, base, variant, this.opts.facts);
    this.emit(id, scope, res, base);
    return res;
  }

  private emit(anchor: AnchorId, scope: ScopeId, resolution: Resolution, base: Element | null): void {
    const notable =
      resolution.status === 'fallback' ||
      resolution.status === 'ambiguous' ||
      (resolution.status === 'missing' && resolution.expected);
    if (notable) this.opts.onEvent?.({ anchor, scope, resolution, base });
  }
}
