/**
 * page capability: URL-derived page kind and item, plus page-scope facts (viewer, deploy SHA,
 * validated node identity) read through the DOM contract (design section 6.1).
 */
import type { Diagnostic } from '../../types';
import { Resolver, detectScope, type ResolveEvent } from '../dom/resolver';
import type { ItemRef, PageFacts, PageKind, ScopeDetection } from '../dom/types';
import type { VariantModule } from '../variants/types';
import type { PageCap } from './types';

const GITHUB_HOST = 'github.com';
const PR_SUBTABS = new Set(['files', 'changes', 'commits', 'checks']);

/** Parses /:owner/:repo/(pull|issues)/:number[/subtab] on github.com. */
function parseItemPath(url: URL): { owner: string; repo: string; type: 'pull' | 'issues'; number: number; subtab: string | null } | null {
  if (url.hostname !== GITHUB_HOST) return null;
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length < 4) return null;
  const [owner, repo, type, num, subtab] = parts;
  if ((type !== 'pull' && type !== 'issues') || !/^\d+$/.test(num)) return null;
  return { owner, repo, type, number: Number(num), subtab: subtab ?? null };
}

/** Page kind from the URL: /pull/N -> pr-conversation, /pull/N/(files|changes|commits|checks) -> pr-subtab. */
export function pageKindFromUrl(url: URL): PageKind {
  const p = parseItemPath(url);
  if (!p) return 'other';
  if (p.type === 'issues') return p.subtab ? 'other' : 'issue';
  if (!p.subtab) return 'pr-conversation';
  return PR_SUBTABS.has(p.subtab) ? 'pr-subtab' : 'other';
}

/** The item a URL is about (owner/repo#number), without node id. */
export function itemFromUrl(url: URL): ItemRef | null {
  const p = parseItemPath(url);
  if (!p) return null;
  return { owner: p.owner, repo: p.repo, number: p.number, itemId: `${p.owner}/${p.repo}#${p.number}` };
}

export interface PageFactsResult {
  facts: PageFacts;
  pageDetection: ScopeDetection;
}

export interface PageFactsOptions {
  /** Resolver events (fallback / ambiguous / expected-missing) for diagnostics. */
  onEvent?: (event: ResolveEvent) => void;
  /** Capability-level diagnostics (DOM_IDENTITY_MISMATCH). */
  report?: (d: Diagnostic) => void;
}

/**
 * Computes the page facts for a session. Kind and item come from the URL; the page scope is then
 * detected, and viewer, deploy SHA and identity are resolved through its variant's locators.
 * The node id is kept only when every on-page occurrence agrees (allEqual), its typename matches the
 * URL type (PR_ / I_) AND the page's own owner/repo agrees with the URL; otherwise it is dropped and DOM_IDENTITY_MISMATCH is reported.
 */
export function computePageFacts(url: URL, doc: Document, variants: readonly VariantModule[], opts: PageFactsOptions = {}): PageFactsResult {
  const item = itemFromUrl(url);
  const base: PageFacts = {
    kind: pageKindFromUrl(url),
    item,
    viewerLogin: null,
    signedIn: false,
    locked: null,
    archived: null,
    ghRelease: null,
    variants: {},
  };
  const pageDetection = detectScope('page', doc, variants, base);
  if (pageDetection.status !== 'recognized' || !pageDetection.variant) {
    return { facts: base, pageDetection };
  }

  const module = variants.find((v) => v.id === pageDetection.variant);
  const resolver = new Resolver({ facts: base, detections: { page: pageDetection }, variants, onEvent: opts.onEvent });
  const content = (el: Element | null) => el?.getAttribute('content')?.trim() || null;

  const viewerLogin = content(resolver.first('page.viewer'));
  const ghRelease = content(resolver.first('page.release'));
  const nwo = content(resolver.first('page.repo'));

  let nodeId: string | undefined;
  const identity = resolver.resolve('page.identity');
  const valueOf = module?.anchors['page.identity']?.value;
  if ((identity.status === 'ok' || identity.status === 'fallback') && valueOf && item) {
    const candidate = valueOf(identity.els[0]);
    const urlNwo = `${item.owner}/${item.repo}`.toLowerCase();
    // The node's typename must match the URL type: PR_ on /pull/N. /issues/N accepts I_ or PR_,
    // because GitHub serves (and then redirects) PRs at /issues/N; numbers share one space.
    const allowedPrefixes = base.kind === 'issue' ? ['I_', 'PR_'] : ['PR_'];
    if (candidate && allowedPrefixes.some((p) => candidate.startsWith(p)) && nwo && nwo.toLowerCase() === urlNwo) {
      nodeId = candidate;
    } else if (candidate) {
      opts.report?.({ code: 'DOM_IDENTITY_MISMATCH', severity: 'warn', scope: 'page', anchor: 'page.repo' });
    }
  }

  const adapter = module?.adapters.page;
  const facts: PageFacts = {
    ...base,
    item: item && nodeId ? { ...item, nodeId } : item,
    viewerLogin,
    signedIn: viewerLogin !== null,
    locked: adapter ? adapter.locked(doc) : null,
    archived: adapter ? adapter.archived(doc) : null,
    ghRelease,
    variants: { page: pageDetection.variant },
  };
  return { facts, pageDetection };
}

/** The page capability: facts are fixed for the session. */
export function createPageCap(facts: PageFacts): PageCap {
  return { facts: () => facts };
}
