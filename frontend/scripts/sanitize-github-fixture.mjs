#!/usr/bin/env node
/**
 * Sanitizes a GitHub page saved from the browser ("Save page as… > Webpage, Complete", taken with
 * the OctoDeck extension DISABLED) into a compact, privacy-safe HTML fixture for the extension's
 * DOM tests, plus a sidecar <name>.meta.json describing the page and its expected anchor counts.
 *
 * What it does:
 *   - removes scripts (except a pruned react-app embeddedData blob holding identity fields only),
 *     styles, stylesheets/preloads, <template>s, iframes, noscript, comments and SVG path data
 *     (the <svg> element and its octicon classes are kept because timeline classification uses
 *     them);
 *   - strips image sources, inline styles, analytics/telemetry attributes, CSP nonces, SRI hashes
 *     and redacts CSRF tokens, signed socket channels and other secret-named attributes/fields;
 *   - removes the site-wide header (viewer menus) and footer unless --keep-global-chrome is given;
 *   - replaces the signed-in viewer's login (and display name, when known) with a placeholder
 *     everywhere, so "viewer is the author" semantics are preserved without identifying anyone;
 *   - truncates long diff tables in review threads and normalizes insignificant whitespace;
 *   - optionally (--max-per-kind N) keeps at most N top-level timeline entries of each kind, where
 *     kind = node-ID typename prefix (IC_, LE_, PRR_, …) + bot actor + review thread. Load-more and
 *     composer elements are always kept; --max-thread-entries N caps review-thread entries separately;
 *   - optionally (--max-thread-comments N) keeps the first N comments of each review thread;
 *   - optionally (--slim-chrome) drops <tool-tip> bodies and all but one emoji reaction button.
 *
 * Usage (from frontend/):
 *   node scripts/sanitize-github-fixture.mjs <saved.html> [--name <fixture-name>] [--url <page-url>]
 *       [--captured <YYYY-MM-DD>] [--out-dir src/extension/__fixtures__] [--max-diff-rows 6]
 *       [--max-per-kind 0] [--max-thread-entries 0] [--max-thread-comments 0] [--slim-chrome]
 *       [--keep-global-chrome] [--viewer-placeholder octodeck-viewer] [--notes "free text"]
 *
 * The script is deterministic: running it twice on the same input produces identical output.
 */
import { readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT_DIR = resolve(SCRIPT_DIR, '../src/extension/__fixtures__');

/** Meta tags worth keeping: page identity, routing and variant signals. Everything else is dropped. */
const KEEP_META_NAMES = new Set([
  'user-login',
  'route-pattern',
  'route-controller',
  'route-action',
  'current-catalog-service',
  'expected-hostname',
  'octolytics-dimension-repository_nwo',
  'octolytics-dimension-repository_id',
  'octolytics-dimension-repository_is_fork',
  'octolytics-dimension-repository_network_root_nwo',
  'turbo-cache-control',
  'turbo-body-classes',
  'github-keyboard-shortcuts',
  'release',
  'ui-target',
]);
const KEEP_META_PROPERTIES = new Set(['og:url', 'og:title', 'og:type']);

/** Attributes removed outright (analytics, telemetry, resource loading, CSP/SRI). */
const DROP_ATTRIBUTES = new Set([
  'style',
  'nonce',
  'integrity',
  'crossorigin',
  'srcset',
  'octo-click',
  'octo-dimensions',
  'data-csrf',
]);
const DROP_ATTRIBUTE_PREFIXES = ['data-hydro-', 'data-octo-', 'data-ga-', 'data-analytics-'];

/** Values of secret-bearing attributes / form fields are replaced with this. */
const REDACTED = 'REDACTED';
/** Attribute names that carry secrets or signed values (CSRF tokens, signed socket channels, HMACs). */
const SECRET_ATTRIBUTE = /(?:^|[-_])(?:token|csrf|nonce|hmac|signature|secret|auth)(?:[-_]|$)|channel/i;
/** Hidden form fields whose value is a secret (authenticity_token, timestamp_secret, …). */
const SECRET_FIELD_NAME = /token|csrf|secret|nonce|signature|hmac/i;

/** True for opaque, high-entropy values such as CSRF tokens (base64-ish, mixed case and digits). */
function looksLikeSecret(value) {
  return value.length >= 32 && /^[A-Za-z0-9_\-+/=.]+$/.test(value) && /[a-z]/.test(value) && /[A-Z]/.test(value) && /\d/.test(value);
}

/** Leaf keys kept from the react-app embeddedData blob. Identity only; no viewer data. */
const EMBEDDED_KEEP_LEAVES = new Set([
  'relayId',
  'id',
  'number',
  'state',
  'title',
  'createdTime',
  'createdAt',
  'name',
  'ownerLogin',
  'nameWithOwner',
  '__typename',
  'locked',
  'issueId',
]);
// Keys dropped from embeddedData: viewer/user data, signed channels, asset manifests, feature flags.
// Matched per key (e.g. "viewerLogin", "safeViewer", "current_user"), so route names such as
// "issueViewerRoute" are kept.
const EMBEDDED_DROP_KEYS = /^(?:viewer|safeViewer|user|author|current_user\w*|js|css|enabled_features|notices|bannersData|transactionalMessageBanner)$|^viewer|channel|avatar|token|nonce|hmac|csrf/i;

/**
 * Anchors recorded in meta.json as the expected match counts for this fixture. These are the
 * selectors the current content scripts depend on (plus stable variant signals), so the counts
 * double as a regression baseline and as seed data for the DOM contract.
 */
export const ANCHOR_SELECTORS = [
  // Identity / variant signals
  'meta[name="user-login"]',
  'react-app',
  'script[data-target="react-app.embeddedData"]',
  '[data-gid^="PR_"]',
  '[data-gid^="I_"]',
  // Sidebar
  '#partial-discussion-sidebar',
  '[data-testid="issue-viewer-metadata-pane"]',
  '[data-testid="sidebar-assignees-section"]',
  '[data-testid="sticky-sidebar"]',
  'div[class*="sidebarContent"]',
  '.Layout-sidebar',
  // Composer
  '#issuecomment-new',
  'form.js-new-comment-form',
  '#partial-new-comment-form-actions button[type="submit"]',
  '[data-testid="comment-composer"]',
  '[data-testid="comment-composer"] button[data-variant="primary"]',
  '.form-actions button[type="submit"]',
  // Timeline containers and items
  '.js-discussion',
  '.js-timeline-item',
  '#issue-timeline',
  '[data-testid="issue-timeline-container"] > li',
  '[data-wrapper-timeline-id]',
  '.TimelineItem',
  '.timeline-comment-group',
  '[id^="issuecomment-"]',
  '[id^="event-"]',
  '[id^="pullrequestreview-"]',
  '[id^="discussion_r"]',
  '.review-comment',
  'div.react-issue-comment',
  // Description
  '.js-command-palette-pull-body',
  '[data-testid="issue-body"]',
  // Comment internals
  '.comment-body',
  '.markdown-body',
  '[class*="IssueCommentBody"]',
  'a.author',
  '[data-testid="actor-link"]',
  '[data-testid="avatar-link"]',
  'relative-time',
  '[datetime]',
  // Progressive loading
  '.ajax-pagination-form',
  '.ajax-pagination-btn',
  '[data-testid*="load-more"]',
];

function parseArgs(argv) {
  const args = { input: null, name: null, url: null, captured: null, outDir: DEFAULT_OUT_DIR, maxDiffRows: 6, maxPerKind: 0, maxThreadComments: 0, maxThreadEntries: 0, slimChrome: false, keepGlobalChrome: false, viewerPlaceholder: 'octodeck-viewer', notes: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`Missing value for ${a}`);
      return v;
    };
    if (a === '--name') args.name = next();
    else if (a === '--url') args.url = next();
    else if (a === '--captured') args.captured = next();
    else if (a === '--out-dir') args.outDir = resolve(next());
    else if (a === '--max-diff-rows') args.maxDiffRows = Number(next());
    else if (a === '--max-per-kind') args.maxPerKind = Number(next());
    else if (a === '--max-thread-comments') args.maxThreadComments = Number(next());
    else if (a === '--max-thread-entries') args.maxThreadEntries = Number(next());
    else if (a === '--slim-chrome') args.slimChrome = true;
    else if (a === '--keep-global-chrome') args.keepGlobalChrome = true;
    else if (a === '--viewer-placeholder') args.viewerPlaceholder = next();
    else if (a === '--notes') args.notes = next();
    else if (a === '-h' || a === '--help') {
      console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]);
      process.exit(0);
    } else if (!args.input) args.input = a;
    else throw new Error(`Unexpected argument: ${a}`);
  }
  if (!args.input) throw new Error('Usage: sanitize-github-fixture.mjs <saved.html> [options] (see --help)');
  return args;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Reads the "saved from url=(NNNN)https://…" comment Chrome adds to saved pages. */
function savedFromUrl(html) {
  const m = html.match(/<!-- saved from url=\(\d+\)(\S+?) -->/);
  return m ? m[1] : null;
}

function pruneEmbedded(value, depth = 0) {
  if (depth > 8 || value === null || typeof value !== 'object') return undefined;
  if (Array.isArray(value)) return undefined; // identity never lives in arrays; drop timeline/comment lists
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (EMBEDDED_DROP_KEYS.test(k)) continue;
    if (v !== null && typeof v === 'object') {
      // preloadedSubscriptions keys are JSON strings like '{"issueId":"I_…"}'; keep those keys only.
      if (k === 'preloadedSubscriptions') {
        const subs = {};
        for (const [sk, sv] of Object.entries(v)) {
          if (sv && typeof sv === 'object') {
            const kept = Object.keys(sv).filter((key) => key.includes('issueId'));
            if (kept.length) subs[sk] = Object.fromEntries(kept.map((key) => [key, {}]));
          }
        }
        if (Object.keys(subs).length) out[k] = subs;
        continue;
      }
      const pruned = pruneEmbedded(v, depth + 1);
      if (pruned && Object.keys(pruned).length) out[k] = pruned;
    } else if (EMBEDDED_KEEP_LEAVES.has(k)) {
      out[k] = v;
    }
  }
  return out;
}

function detectAreas(doc) {
  const has = (sel) => doc.querySelector(sel) !== null;
  const timeline = has('[data-testid="issue-timeline-container"]') ? 'react' : has('.js-discussion .js-timeline-item') ? 'classic' : 'unknown';
  const sidebar = has('[data-testid="issue-viewer-metadata-pane"]') ? 'react' : has('#partial-discussion-sidebar') ? 'classic' : 'unknown';
  const composer = has('[data-testid="comment-composer"]') ? 'react' : has('#issuecomment-new, form.js-new-comment-form') ? 'classic' : 'none';
  const shell = has('react-app') ? 'react-app' : 'rails';
  return { shell, timeline, sidebar, composer };
}

function pageKindFromUrl(url) {
  const parts = new URL(url).pathname.split('/').filter(Boolean);
  const type = parts[2];
  const sub = parts[4];
  if (type === 'pull') return sub ? `pr-${sub}` : 'pr-conversation';
  if (type === 'issues') return 'issue';
  return 'other';
}

/** Selectors for top-level timeline entries, per markup variant. */
const TIMELINE_ENTRY_SELECTORS = ['.js-discussion .js-timeline-item', '[data-testid="issue-timeline-container"] > li'];
const PRESERVE_ENTRY_SELECTOR = '.ajax-pagination-form, .ajax-pagination-btn, [data-testid*="load-more"], #issuecomment-new, form.js-new-comment-form, [data-testid="comment-composer"]';

/**
 * Classifies a timeline entry by its GitHub node-ID typename prefix (IC_, LE_, PRR_, CRE_, …),
 * whether its actor is a bot, and whether it contains a review thread. Used only for trimming.
 */
function entryKind(el) {
  const gid =
    el.getAttribute('data-gid') ||
    el.getAttribute('data-wrapper-timeline-id') ||
    el.querySelector('[data-gid], [data-wrapper-timeline-id]')?.getAttribute('data-gid') ||
    el.querySelector('[data-wrapper-timeline-id]')?.getAttribute('data-wrapper-timeline-id') ||
    '';
  const prefix = (gid.match(/^([A-Z]+)_/) || [, el.id ? el.id.replace(/[-_]?\d.*$/, '') : 'unknown'])[1];
  const isBot =
    Boolean(el.querySelector('a[href*="/apps/"]')) ||
    Array.from(el.querySelectorAll('.Label, [data-component="Label"]')).some((l) => l.textContent.trim().toLowerCase() === 'bot');
  const hasThread = Boolean(el.querySelector('.js-comments-holder, [id^="discussion_r"]'));
  return `${prefix}${isBot ? ':bot' : ''}${hasThread ? ':thread' : ''}`;
}

/** Keeps at most opts.maxPerKind timeline entries of each kind (always keeping load-more/composer). */
function trimTimeline(doc, opts) {
  const entries = Array.from(doc.querySelectorAll(TIMELINE_ENTRY_SELECTORS.join(', ')));
  const kept = {};
  let removed = 0;
  for (const el of entries) {
    if (!el.isConnected || el.querySelector(PRESERVE_ENTRY_SELECTOR) || el.matches(PRESERVE_ENTRY_SELECTOR)) continue;
    const kind = entryKind(el);
    // Review-thread entries are by far the largest; they can be capped separately.
    const limit = kind.endsWith(':thread') && opts.maxThreadEntries > 0 ? opts.maxThreadEntries : opts.maxPerKind;
    kept[kind] = (kept[kind] || 0) + 1;
    if (kept[kind] > limit) {
      el.remove();
      removed++;
      kept[kind] = limit;
    }
  }
  return { removed, kept };
}

export function sanitize(html, opts) {
  const url = opts.url || savedFromUrl(html);
  if (!url) throw new Error('Could not determine the page URL; pass --url');

  // No scripts are executed: JSDOM only runs scripts with runScripts set.
  const dom = new JSDOM(html, { url });
  const doc = dom.window.document;
  const NodeFilter = dom.window.NodeFilter;

  // --- Capture identity before stripping -----------------------------------------------------
  const viewerLogin = doc.querySelector('meta[name="user-login"]')?.getAttribute('content')?.trim() || '';
  let viewerName = '';
  let viewerNodeId = '';
  const embeddedEl = doc.querySelector('script[data-target="react-app.embeddedData"]');
  let embeddedPruned = null;
  if (embeddedEl?.textContent) {
    try {
      const data = JSON.parse(embeddedEl.textContent);
      viewerName = data?.payload?.issuesLayoutRoute?.current_user?.name || '';
      viewerNodeId = data?.payload?.issuesLayoutRoute?.current_user?.id || '';
      embeddedPruned = pruneEmbedded(data) || {};
    } catch {
      embeddedPruned = null;
    }
  }

  // --- Remove non-structural elements ----------------------------------------------------------
  for (const el of Array.from(doc.querySelectorAll('script'))) {
    if (el === embeddedEl && embeddedPruned) {
      el.textContent = JSON.stringify(embeddedPruned);
      for (const attr of Array.from(el.attributes)) {
        if (!['type', 'data-target'].includes(attr.name)) el.removeAttribute(attr.name);
      }
    } else {
      el.remove();
    }
  }
  for (const el of Array.from(doc.querySelectorAll('style, link, noscript, iframe, template, base'))) el.remove();
  // Site-wide chrome (global header with the viewer's menus, footer) is unrelated to item pages and
  // carries most of the viewer's identity. Repository and item headers are kept.
  if (!opts.keepGlobalChrome) {
    for (const el of Array.from(doc.querySelectorAll('.js-header-wrapper, header.AppHeader, body > .footer, footer.footer, [data-testid="footer"]'))) el.remove();
  }
  for (const el of Array.from(doc.querySelectorAll('meta'))) {
    const name = el.getAttribute('name');
    const prop = el.getAttribute('property');
    if (!(name && KEEP_META_NAMES.has(name)) && !(prop && KEEP_META_PROPERTIES.has(prop))) el.remove();
  }
  // SVG internals are large and irrelevant; keep the <svg> element (octicon classes classify events).
  for (const svg of Array.from(doc.querySelectorAll('svg'))) {
    while (svg.firstChild) svg.removeChild(svg.firstChild);
  }
  // Long diff hunks in review threads: keep the first rows only.
  if (opts.maxDiffRows >= 0) {
    for (const table of Array.from(doc.querySelectorAll('table'))) {
      const rows = Array.from(table.querySelectorAll('tr'));
      if (rows.length > opts.maxDiffRows && table.closest('.js-comment-container, .review-thread-component, [data-testid*="diff"], .blob-wrapper, .js-file-content')) {
        for (const row of rows.slice(opts.maxDiffRows)) row.remove();
      }
    }
  }
  const trimmed = opts.maxPerKind > 0 ? trimTimeline(doc, opts) : { removed: 0, kept: {} };
  // Long review threads: keep the first N comments of each thread (the reply form is kept).
  if (opts.maxThreadComments > 0) {
    for (const holder of Array.from(doc.querySelectorAll('.js-comments-holder'))) {
      const comments = Array.from(holder.children).filter((c) => c.matches('.review-comment, .timeline-comment-group, [id^="discussion_r"]'));
      for (const c of comments.slice(opts.maxThreadComments)) c.remove();
    }
  }
  // Repeated per-comment chrome that no extension feature reads: tooltip bodies and the emoji
  // reaction picker (one button is kept so the picker structure stays recognizable).
  if (opts.slimChrome) {
    for (const el of Array.from(doc.querySelectorAll('tool-tip'))) el.remove();
    for (const form of Array.from(doc.querySelectorAll('form.js-pick-reaction'))) {
      for (const btn of Array.from(form.querySelectorAll('button')).slice(1)) btn.remove();
    }
  }

  // --- Scrub attributes ------------------------------------------------------------------------
  for (const el of Array.from(doc.querySelectorAll('*'))) {
    for (const attr of Array.from(el.attributes)) {
      const n = attr.name;
      if (DROP_ATTRIBUTES.has(n) || DROP_ATTRIBUTE_PREFIXES.some((p) => n.startsWith(p))) {
        el.removeAttribute(n);
        continue;
      }
      // Resource URLs (saved pages point into a local *_files dir) are not needed for structure.
      if ((n === 'src' || n === 'poster') && ['IMG', 'VIDEO', 'SOURCE', 'AUDIO', 'INPUT'].includes(el.tagName)) {
        el.removeAttribute(n);
        continue;
      }
      if (
        n === 'value' &&
        el.tagName === 'INPUT' &&
        (SECRET_FIELD_NAME.test(`${el.getAttribute('name') || ''} ${el.getAttribute('class') || ''} ${el.id}`) ||
          (el.getAttribute('type') === 'hidden' && looksLikeSecret(attr.value)))
      ) {
        el.setAttribute(n, REDACTED);
        continue;
      }
      if (SECRET_ATTRIBUTE.test(n)) {
        el.setAttribute(n, REDACTED);
      }
    }
  }

  // --- Remove comments and normalize whitespace -------------------------------------------------
  const preserveWs = (node) => node.parentElement?.closest('pre, textarea, code, script') != null;
  const comments = [];
  const walker = doc.createTreeWalker(doc, NodeFilter.SHOW_COMMENT | NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeType === 8) comments.push(n);
    else if (!preserveWs(n)) {
      // Keep line breaks (slash-command detection reads comment bodies line by line).
      n.nodeValue = n.nodeValue.replace(/[ \t\f\r]+/g, ' ').replace(/ ?\n[\s]*/g, '\n');
    }
  }
  for (const c of comments) c.remove();

  // --- Replace viewer identity everywhere --------------------------------------------------------
  let out = '<!DOCTYPE html>\n' + doc.documentElement.outerHTML + '\n';
  if (viewerLogin) {
    // Case-insensitive, not inside a longer alphanumeric run: covers text, hrefs (/login), hovercard
    // URLs, alt="@login" and ids GitHub derives from logins (e.g. "awaiting-review-<login>"). A
    // trailing hyphen is excluded because "<login>-foo" would be a different account.
    out = out.replace(new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(viewerLogin)}(?![A-Za-z0-9-])`, 'gi'), opts.viewerPlaceholder);
  }
  if (viewerName && viewerName.length >= 3) {
    out = out.replace(new RegExp(escapeRegExp(viewerName), 'g'), 'OctoDeck Viewer');
  }
  if (viewerNodeId) {
    // The viewer's GraphQL node ID (and the numeric account id it encodes) also identify them.
    out = out.replaceAll(viewerNodeId, 'U_octodeck_viewer');
    const numericId = Buffer.from(viewerNodeId, 'base64').toString('latin1').match(/User(\d+)$/)?.[1];
    if (numericId) out = out.replace(new RegExp(`(?<!\\d)${numericId}(?!\\d)`, 'g'), '0');
  }

  // --- Meta ------------------------------------------------------------------------------------
  const outDom = new JSDOM(out, { url });
  const outDoc = outDom.window.document;
  const areas = detectAreas(outDoc);
  const pageKind = pageKindFromUrl(url);
  const kindShort = pageKind.startsWith('pr') ? 'pr' : pageKind;
  const anchors = {};
  for (const sel of ANCHOR_SELECTORS) anchors[sel] = outDoc.querySelectorAll(sel).length;

  const meta = {
    name: opts.name,
    url,
    pageKind,
    variant: `${areas.timeline}-${kindShort}`,
    areas,
    capturedAt: opts.captured,
    signedIn: Boolean(viewerLogin),
    viewerPlaceholder: viewerLogin ? opts.viewerPlaceholder : null,
    sanitizer: { version: 1, maxDiffRows: opts.maxDiffRows, maxPerKind: opts.maxPerKind, maxThreadComments: opts.maxThreadComments, maxThreadEntries: opts.maxThreadEntries, slimChrome: Boolean(opts.slimChrome), keepGlobalChrome: Boolean(opts.keepGlobalChrome), trimmedEntries: trimmed.removed },
    notes: opts.notes,
    expectedAnchors: anchors,
  };
  return { html: out, meta };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const html = readFileSync(args.input, 'utf8');
  const name = args.name || basename(args.input).replace(/\.html?$/i, '');
  const captured = args.captured || statSync(args.input).mtime.toISOString().slice(0, 10);
  const { html: out, meta } = sanitize(html, { ...args, name, captured });
  mkdirSync(args.outDir, { recursive: true });
  const htmlPath = join(args.outDir, `${name}.html`);
  const metaPath = join(args.outDir, `${name}.meta.json`);
  writeFileSync(htmlPath, out);
  writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n');
  console.log(`Wrote ${htmlPath} (${(out.length / 1024).toFixed(1)} KB, variant ${meta.variant}) and ${metaPath}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
