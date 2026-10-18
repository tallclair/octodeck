import { describe, expect, it } from 'vitest';
import { idMatchesAnchor, parseAnchor } from '../content/capabilities/anchorKinds';

describe('parseAnchor', () => {
  it.each([
    ['issuecomment-5110459218', 'issueComment', '5110459218', 'issuecomment-5110459218', true],
    ['#issuecomment-1', 'issueComment', '1', 'issuecomment-1', true],
    ['discussion_r4147796761', 'reviewComment', '4147796761', 'discussion_r4147796761', true],
    ['pullrequestreview-5370149243', 'review', '5370149243', 'pullrequestreview-5370149243', false],
    ['event-28626999763', 'event', '28626999763', 'event-28626999763', false],
    ['issue-5003592504', 'description', '5003592504', 'issue-5003592504', false],
    ['pullrequest-4155657935', 'description', '4155657935', 'pullrequest-4155657935', false],
    ['ref-pullrequest-5154263617', 'crossReference', '5154263617', 'ref-pullrequest-5154263617', false],
    ['commits-pushed-f05c330', 'commitsPushed', 'f05c330', 'commits-pushed-f05c330', false],
  ])('parses %s', (hash, kind, id, canonicalId, isComment) => {
    expect(parseAnchor(hash)).toMatchObject({ kind, id, canonicalId, isComment });
  });

  it('accepts variant-prefixed comment ids (React commentAnchorPrefix)', () => {
    expect(parseAnchor('pr-issuecomment-42')).toMatchObject({ kind: 'issueComment', id: '42', canonicalId: 'issuecomment-42' });
  });

  it('decodes URL-encoded hashes', () => {
    expect(parseAnchor('%23issuecomment-7'.replace('%23', '#'))).toMatchObject({ id: '7' });
    expect(parseAnchor('issuecomment%2D7')).toMatchObject({ id: '7' });
  });

  it.each(['', '#', 'diff-abc123', 'user-content-heading', 'issuecomment-', 'issuecomment-12x', 'event-1-2', `issuecomment-${'1'.repeat(300)}`])(
    'ignores %s',
    (hash) => {
      expect(parseAnchor(hash)).toBeNull();
    }
  );
});

describe('idMatchesAnchor', () => {
  const anchor = parseAnchor('issuecomment-42')!;
  it('matches exact, canonical and prefixed ids only', () => {
    expect(idMatchesAnchor('issuecomment-42', anchor)).toBe(true);
    expect(idMatchesAnchor('pr-issuecomment-42', anchor)).toBe(true);
    expect(idMatchesAnchor('issuecomment-420', anchor)).toBe(false);
    expect(idMatchesAnchor('xissuecomment-42', anchor)).toBe(false);
    expect(idMatchesAnchor('issuecomment-42-permalink', anchor)).toBe(false);
  });
});
