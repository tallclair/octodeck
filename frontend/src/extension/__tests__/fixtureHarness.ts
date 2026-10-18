/**
 * Test harness for the sanitized GitHub page fixtures in src/extension/__fixtures__.
 *
 * Each fixture is a pair of files produced by scripts/sanitize-github-fixture.mjs:
 *   <name>.html       the sanitized, post-render DOM of a real GitHub page
 *   <name>.meta.json  page URL, page kind, markup variant(s) and expected anchor counts
 *
 * Usage in a vitest (jsdom) test:
 *   const meta = await loadFixture('react-issue-142957');
 *   // document and window.location now reflect the captured page
 *   afterEach(() => resetFixture());
 */

/** Markup variant of each page area, as detected by the sanitizer. */
export interface FixtureAreas {
  /** Outer application shell: GitHub's React "voltron" app or a plain Rails page. */
  shell: 'react-app' | 'rails';
  timeline: 'classic' | 'react' | 'unknown';
  sidebar: 'classic' | 'react' | 'unknown';
  composer: 'classic' | 'react' | 'none';
}

export interface FixtureMeta {
  name: string;
  /** URL the page was captured from; loadFixture() navigates jsdom to it. */
  url: string;
  /** e.g. 'issue', 'pr-conversation', 'pr-files'. */
  pageKind: string;
  /** Short variant label, `${areas.timeline}-${kind}` (e.g. 'classic-pr', 'react-issue'). */
  variant: string;
  areas: FixtureAreas;
  /** Capture date (YYYY-MM-DD). */
  capturedAt: string;
  signedIn: boolean;
  /** Placeholder login substituted for the signed-in viewer, or null when signed out. */
  viewerPlaceholder: string | null;
  /** Options the sanitizer ran with (trimming limits, etc.). */
  sanitizer: Record<string, unknown>;
  notes: string;
  /** Selector -> number of matches in the sanitized fixture (regression baseline). */
  expectedAnchors: Record<string, number>;
  /** Hand-curated DOM-contract expectations (design section 11.1), read by contract tests. */
  expect?: FixtureExpectations;
}

export interface FixtureExpectations {
  /** Scope -> expected recognized variant id. */
  scopes: Record<string, string>;
  /** Expected validated node id of the page's item. */
  identity: string | null;
  /** Anchor id -> expected resolution status and match count (scope-root resolution). */
  anchors: Record<string, { status: 'ok' | 'fallback' | 'missing' | 'ambiguous'; count?: number }>;
  /** Kinds of timeline.items() in document order. */
  items: string[];
  /** Node-id prefix of a grouped item (e.g. 'RFRE_') -> expected row kinds. */
  groupRows: Record<string, string[]>;
  /** Comment anchors written by humans (must never be hidden). */
  humanCommentIds: string[];
  /** Comment anchors written by bots/apps (detected via author signals). */
  botCommentIds: string[];
  /** Hidden-content segments per kind (timeline.hidden()). */
  hidden: Record<'range' | 'collapsedThread' | 'hiddenComments', number>;
  /** Whether the variant's load-more is verified (fail closed otherwise). */
  supportsLoadMore: boolean;
}

const FIXTURE_DIR = '../__fixtures__/';

// Lazily imported so that tests which don't use fixtures don't pay for parsing them.
const htmlLoaders = import.meta.glob<string>('../__fixtures__/*.html', { query: '?raw', import: 'default' });
const metaLoaders = import.meta.glob<FixtureMeta>('../__fixtures__/*.meta.json', { import: 'default' });

/** jsdom instance that vitest's jsdom environment exposes as a global. */
interface JsdomGlobal {
  reconfigure(options: { url?: string }): void;
}

const initialUrl = typeof window !== 'undefined' ? window.location.href : '';

function nameFromPath(path: string, suffix: string): string {
  return path.slice(FIXTURE_DIR.length, -suffix.length);
}

/** Names of all available fixtures (those with both an .html and a .meta.json file), sorted. */
export function listFixtures(): string[] {
  const metas = new Set(Object.keys(metaLoaders).map((p) => nameFromPath(p, '.meta.json')));
  return Object.keys(htmlLoaders)
    .map((p) => nameFromPath(p, '.html'))
    .filter((n) => metas.has(n))
    .sort();
}

export async function loadFixtureMeta(name: string): Promise<FixtureMeta> {
  const load = metaLoaders[`${FIXTURE_DIR}${name}.meta.json`];
  if (!load) throw new Error(`Unknown fixture "${name}". Available: ${listFixtures().join(', ')}`);
  return load();
}

/** Returns the raw sanitized HTML of a fixture without touching the document. */
export async function loadFixtureHtml(name: string): Promise<string> {
  const load = htmlLoaders[`${FIXTURE_DIR}${name}.html`];
  if (!load) throw new Error(`Unknown fixture "${name}". Available: ${listFixtures().join(', ')}`);
  return load();
}

function setLocation(url: string): void {
  const jsdom = (globalThis as { jsdom?: JsdomGlobal }).jsdom;
  if (!jsdom) {
    throw new Error('loadFixture() requires the vitest jsdom environment (globalThis.jsdom is missing)');
  }
  jsdom.reconfigure({ url });
}

function replaceDocument(html: string): void {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  document.replaceChild(document.importNode(parsed.documentElement, true), document.documentElement);
}

/**
 * Replaces the test document with the fixture's DOM and navigates window.location to the
 * captured URL. Scripts in the fixture are never executed. Returns the fixture's metadata.
 */
export async function loadFixture(name: string): Promise<FixtureMeta> {
  const [meta, html] = await Promise.all([loadFixtureMeta(name), loadFixtureHtml(name)]);
  setLocation(meta.url);
  replaceDocument(html);
  return meta;
}

/** Restores an empty document and the location the test environment started with. */
export function resetFixture(): void {
  replaceDocument('<!DOCTYPE html><html><head></head><body></body></html>');
  if (initialUrl) setLocation(initialUrl);
}
