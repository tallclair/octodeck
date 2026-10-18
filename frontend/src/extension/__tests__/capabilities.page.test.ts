import { itemFromUrl, pageKindFromUrl } from '../content/capabilities/page';
import { gidPrefix, kindFromGid } from '../content/capabilities/timelineKinds';
import { openCapabilitySession } from './capabilitySession';
import { loadFixture, resetFixture } from './fixtureHarness';

describe('capabilities: page', () => {
  afterEach(() => resetFixture());

  it.each([
    ['https://github.com/o/r/pull/12', 'pr-conversation'],
    ['https://github.com/o/r/pull/12/files', 'pr-subtab'],
    ['https://github.com/o/r/pull/12/changes', 'pr-subtab'],
    ['https://github.com/o/r/pull/12/commits', 'pr-subtab'],
    ['https://github.com/o/r/pull/12/checks', 'pr-subtab'],
    ['https://github.com/o/r/issues/7', 'issue'],
    ['https://github.com/o/r/issues', 'other'],
    ['https://github.com/o/r/pull/abc', 'other'],
    ['https://example.com/o/r/pull/12', 'other'],
  ])('page kind of %s is %s', (url, kind) => {
    expect(pageKindFromUrl(new URL(url))).toBe(kind);
  });

  it('derives the item from the URL', () => {
    expect(itemFromUrl(new URL('https://github.com/kubernetes/kubernetes/pull/141014#issuecomment-1'))).toEqual({
      owner: 'kubernetes',
      repo: 'kubernetes',
      number: 141014,
      itemId: 'kubernetes/kubernetes#141014',
    });
    expect(itemFromUrl(new URL('https://github.com/kubernetes/kubernetes'))).toBeNull();
  });

  it('drops the node id and reports when the page repo disagrees with the URL', async () => {
    const meta = await loadFixture('react-issue-142957');
    document.querySelector('meta[name="octolytics-dimension-repository_nwo"]')!.setAttribute('content', 'someone/else');
    const s = openCapabilitySession(meta.url);
    expect(s.caps.page.facts().item?.nodeId).toBeUndefined();
    expect(s.caps.page.facts().item?.itemId).toBe('kubernetes/kubernetes#142957');
    expect(s.reports.map((d) => d.code)).toContain('DOM_IDENTITY_MISMATCH');
  });

  it('drops the node id when on-page identities disagree (foreign data-gid)', async () => {
    const meta = await loadFixture('classic-pr-141014');
    const foreign = document.createElement('div');
    foreign.setAttribute('data-gid', 'I_kwDOforeign');
    document.body.appendChild(foreign);
    const s = openCapabilitySession(meta.url);
    expect(s.caps.page.facts().item?.nodeId).toBeUndefined();
    expect(s.events.some((e) => e.anchor === 'page.identity' && e.resolution.status === 'ambiguous')).toBe(true);
  });

  it('drops a node id whose typename does not match the URL type', async () => {
    const meta = await loadFixture('classic-pr-141014');
    document.querySelectorAll('[data-gid^="PR_"]').forEach((el) => el.setAttribute('data-gid', 'I_kwDOsameforall'));
    const s = openCapabilitySession(meta.url);
    expect(s.caps.page.facts().item?.nodeId).toBeUndefined();
    expect(s.reports.map((d) => d.code)).toContain('DOM_IDENTITY_MISMATCH');
  });

  it('treats a page without a viewer meta tag as signed out', async () => {
    const meta = await loadFixture('react-issue-142957');
    document.querySelector('meta[name="user-login"]')!.setAttribute('content', '');
    const facts = openCapabilitySession(meta.url).caps.page.facts();
    expect(facts.signedIn).toBe(false);
    expect(facts.viewerLogin).toBeNull();
  });
});

describe('capabilities: timelineKinds', () => {
  it('extracts typename prefixes', () => {
    expect(gidPrefix('IC_kwDOAToIks8AAAABMJtrUg')).toBe('IC');
    expect(gidPrefix('PRR_kwDO')).toBe('PRR');
    expect(gidPrefix('issuecomment-5')).toBeNull();
    expect(gidPrefix(null)).toBeNull();
  });

  it('maps known prefixes and flags unknown ones', () => {
    expect(kindFromGid('IC_x')).toBe('comment');
    expect(kindFromGid('PRR_x')).toBe('review');
    expect(kindFromGid('CE_x')).toBe('closeReopen');
    expect(kindFromGid('CRE_x')).toBe('reference');
    expect(kindFromGid('LE_x')).toBe('event');
    expect(kindFromGid('RFRE_x')).toBe('event');
    expect(kindFromGid('C_x')).toBe('commit');
    expect(kindFromGid('ZZZ_x')).toBe('unknown');
    expect(kindFromGid('')).toBeNull();
  });
});
