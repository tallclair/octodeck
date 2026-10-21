import {
  FINGERPRINT_MAX_CHARS,
  fingerprint,
  fingerprintAll,
  idsFromSelectors,
  maskValue,
  normalizeClass,
} from '../content/dom/fingerprint';
import { OWN_ATTR } from '../content/engine/constants';
import { listFixtures, loadFixture, resetFixture } from './fixtureHarness';

/** Characters the background accepts in a fingerprint. */
const ALLOWED = /^[\w\-#.*[\]=?:> \n]*$/;

describe('fingerprint helpers', () => {
  it('masks digit runs and GraphQL node ids', () => {
    expect(maskValue('issuecomment-123456')).toBe('issuecomment-#');
    expect(maskValue('discussion_r987')).toBe('discussion_r#');
    expect(maskValue('timeline-row-border-IC_kwDOAToIks7abcDEF')).toBe('timeline-row-border-IC_*');
  });

  it('collapses generated class hashes but keeps ordinary classes', () => {
    expect(normalizeClass('prc-Button-ButtonBase-c50BI')).toBe('prc-Button-ButtonBase-*');
    expect(normalizeClass('sidebarContent__Ab12c')).toBe('sidebarContent__*');
    expect(normalizeClass('PageHeader_Title_marginRight__RB_Qdt')).toBe('PageHeader_Title_marginRight__*');
    expect(normalizeClass('Box-row__title')).toBe('Box-row__title');
    expect(normalizeClass('prc-Stack-Stack-WJVsK')).toBe('prc-Stack-Stack-*');
    expect(normalizeClass('js-timeline-item')).toBe('js-timeline-item');
    expect(normalizeClass('TimelineItem-badge')).toBe('TimelineItem-badge');
    expect(normalizeClass('Button--secondary')).toBe('Button--secondary');
    expect(normalizeClass('mr-2')).toBe('mr-#');
  });
});

describe('fingerprint', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('describes structure with indentation and no text', () => {
    document.body.innerHTML = `
      <div id="partial-discussion-sidebar" class="Layout-sidebar">
        <div data-testid="sidebar-assignees-section" role="region" aria-label="Assigned to alice">
          <a href="/alice">alice</a>
        </div>
      </div>`;
    const fp = fingerprint(document.getElementById('partial-discussion-sidebar')!, {
      knownIds: new Set(['partial-discussion-sidebar']),
    });
    expect(fp).toBe(
      [
        'div#partial-discussion-sidebar.Layout-sidebar',
        '  div[data-testid=sidebar-assignees-section][role=region][aria-label?]',
        '    a[href?]',
      ].join('\n')
    );
    expect(fp).not.toContain('alice');
  });

  it('shows only ids the contract knows, masking numbered ones', () => {
    document.body.innerHTML = `<div id="awaiting-review-alice"><div id="issuecomment-123"></div><h2 id="user-content-launch-plan"></h2></div>`;
    const root = document.body.firstElementChild!;
    expect(fingerprint(root)).toBe('div[id?]\n  div[id?]\n  h2[id?]');
    expect(fingerprint(root, { knownIds: idsFromSelectors(['[id^="issuecomment-"]']) })).toBe(
      'div[id?]\n  div#issuecomment-#\n  h2[id?]'
    );
  });

  it('collects ids from selectors', () => {
    expect([...idsFromSelectors(['#partial-discussion-sidebar > .x', '[id^="discussion_r"]', '[id="issue-timeline"]'])]).toEqual([
      'partial-discussion-sidebar',
      'discussion_r',
      'issue-timeline',
    ]);
  });

  it('marks user-content subtrees without descending into them', () => {
    document.body.innerHTML = `<div class="x"><div class="comment-body markdown-body"><p id="user-content-a">hi</p></div></div>`;
    const fp = fingerprint(document.body.firstElementChild!);
    expect(fp).toBe('div.x\n  div.comment-body.markdown-body [content]');
  });

  it('skips OctoDeck-owned nodes', () => {
    document.body.innerHTML = `<div class="host"><div ${OWN_ATTR}="sidebarWidget"><span class="mine"></span></div><span class="gh"></span></div>`;
    const host = document.body.firstElementChild!;
    expect(fingerprint(host)).toBe('div.host\n  span.gh');
    expect(fingerprint(host.firstElementChild!)).toBe('');
  });

  it('respects depth, node and size limits', () => {
    document.body.innerHTML = `<div class="a"><div class="b"><div class="c"><div class="d"><div class="e"></div></div></div></div></div>`;
    expect(fingerprint(document.body.firstElementChild!, { depth: 2 }).split('\n')).toHaveLength(3);

    document.body.innerHTML = `<ul>${'<li class="item"></li>'.repeat(100)}</ul>`;
    const lines = fingerprint(document.body.firstElementChild!, { maxNodes: 10 }).split('\n');
    expect(lines).toHaveLength(11);
    expect(lines.at(-1)).toBe('...');

    document.body.innerHTML = `<ul>${`<li class="${'x'.repeat(100)}"></li>`.repeat(100)}</ul>`;
    expect(fingerprint(document.body.firstElementChild!, { maxNodes: 1000 }).length).toBeLessThanOrEqual(
      FINGERPRINT_MAX_CHARS
    );
  });

  it('lists deeper controls after the tree, skipping user content and own nodes', () => {
    document.body.innerHTML = `
      <div id="composer" class="wrap">
        <div class="a"><div class="b"><div class="c"><div class="d">
          <button class="CompactInput__Ab12c" type="button">Add a comment</button>
          <div contenteditable="true" class="editor"></div>
        </div></div></div></div>
        <div class="markdown-body"><input type="checkbox" class="task"></div>
        <div data-octodeck="ackButton"><button class="mine"></button></div>
      </div>`;
    const lines = fingerprint(document.getElementById('composer')!, { depth: 1 }).split('\n');
    expect(lines).toEqual([
      'div[id?].wrap',
      '  div.a',
      '  div.markdown-body [content]',
      '> button.CompactInput__*[type=button]',
      '> div.editor',
    ]);
  });

  it('joins multiple roots within the budget', () => {
    document.body.innerHTML = `<p class="one"></p><p class="two"></p><p class="three"></p>`;
    expect(fingerprintAll(Array.from(document.body.children))).toBe('p.one\n--\np.two');
  });
});

describe('fingerprint on captured GitHub pages', () => {
  afterEach(() => {
    resetFixture();
  });

  describe.each(listFixtures())('%s', (name) => {
    it('never leaks page text, repo names, viewer identity or numbers', async () => {
      const meta = await loadFixture(name);
      const [owner, repo] = new URL(meta.url).pathname.split('/').filter(Boolean);
      const forbidden = [owner, repo, meta.viewerPlaceholder].filter((s): s is string => Boolean(s));
      const violations: string[] = [];
      for (const el of Array.from(document.body.querySelectorAll('*'))) {
        const fp = fingerprint(el, { depth: 1, maxNodes: 20 });
        if (!ALLOWED.test(fp)) violations.push(`charset: ${fp}`);
        // Ids and attribute values never carry numbers (item, comment or user ids). Digits may
        // only appear in tag names (h1) and component class stems (prc-TooltipV2-*).
        const values = [...fp.matchAll(/#([\w-]+)|=([^\]]*)\]/g)].map((m) => m[1] ?? m[2]);
        for (const v of values) if (/\d/.test(v)) violations.push(`number: ${v}`);
        const lower = fp.toLowerCase();
        for (const word of forbidden) {
          if (lower.includes(word.toLowerCase())) {
            violations.push(`leak: ${fp.split('\n').find((line) => line.toLowerCase().includes(word.toLowerCase()))}`);
          }
        }
      }
      expect(violations).toEqual([]);
    }, 20_000);
  });

  it('shows the stable anchors around the classic sidebar', async () => {
    await loadFixture('classic-pr-141014');
    const fp = fingerprint(document.getElementById('partial-discussion-sidebar')!, {
      knownIds: idsFromSelectors(['#partial-discussion-sidebar']),
    });
    expect(fp.split('\n')[0]).toMatch(/^div#partial-discussion-sidebar/);
  });

  it('shows test ids with GraphQL ids reduced to their typename', async () => {
    await loadFixture('react-issue-142957');
    const pane = document.querySelector('[data-testid="issue-viewer-metadata-pane"]')!;
    expect(fingerprint(pane).split('\n')[0]).toContain('[data-testid=issue-viewer-metadata-pane]');
    const row = document.querySelector('[data-testid^="timeline-row-border-"]')!;
    expect(fingerprint(row, { depth: 0 })).toMatch(/\[data-testid=timeline-row-border-[A-Z]{1,5}_\*\]/);
  });
});
