import { listFixtures, loadFixture, loadFixtureHtml, resetFixture } from './fixtureHarness';

// Fixtures are real pages trimmed for size; keep them small enough to load quickly in every test run.
const MAX_FIXTURE_BYTES = 400 * 1024;

describe('GitHub page fixtures', () => {
  afterEach(() => {
    resetFixture();
  });

  it('discovers the fixture corpus', () => {
    expect(listFixtures()).toEqual(expect.arrayContaining(['classic-pr-141014', 'react-issue-142957']));
  });

  describe.each(listFixtures())('%s', (name) => {
    it('loads the captured DOM and URL into jsdom', async () => {
      const meta = await loadFixture(name);
      expect(window.location.href).toBe(meta.url);
      expect(document.title).not.toBe('');
      expect(document.querySelector('meta[property="og:url"]')?.getAttribute('content')).toBe(meta.url);
    });

    it('matches the expected anchor counts recorded in its meta.json', async () => {
      const meta = await loadFixture(name);
      const actual = Object.fromEntries(
        Object.keys(meta.expectedAnchors).map((selector) => [selector, document.querySelectorAll(selector).length])
      );
      expect(actual).toEqual(meta.expectedAnchors);
    });

    it('is sanitized: no executable scripts, no viewer identity, bounded size', async () => {
      const html = await loadFixtureHtml(name);
      const meta = await loadFixture(name);
      expect(html.length).toBeLessThan(MAX_FIXTURE_BYTES);
      // Only the pruned react-app embeddedData JSON blob may remain.
      const scripts = Array.from(document.querySelectorAll('script'));
      expect(scripts.every((s) => s.getAttribute('type') === 'application/json')).toBe(true);
      expect(document.querySelectorAll('style, link[rel="stylesheet"], iframe').length).toBe(0);
      if (meta.signedIn) {
        expect(document.querySelector('meta[name="user-login"]')?.getAttribute('content')).toBe(meta.viewerPlaceholder);
      }
      expect(html).not.toMatch(/name="authenticity_token" value="(?!REDACTED)/);
    });
  });

  it('resetFixture restores an empty document', async () => {
    await loadFixture('react-issue-142957');
    resetFixture();
    expect(document.body.children.length).toBe(0);
    expect(window.location.hostname).not.toBe('github.com');
  });
});
