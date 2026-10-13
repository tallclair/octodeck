import { describe, it, expect } from 'vitest';
import type { ControlKey, FilterControls } from '../../../types/filters';
import { projectClauses } from '../predicates';
import { parseQuery } from '../syntax';
import {
  insertClause,
  removeClause,
  replaceClause,
  setControlInText,
  setTriageTabInText,
  toggleAssignedToMeInText,
  toggleRepoInText,
} from '../textEdit';

const editControl = <K extends ControlKey>(
  text: string,
  key: K,
  value: FilterControls[K]
): string => setControlInText(text, parseQuery(text), key, value);

const editTab = (text: string, tab: FilterControls['triage']): string =>
  setTriageTabInText(text, parseQuery(text), tab);

const editToggleRepo = (text: string, repo: string): string =>
  toggleRepoInText(text, parseQuery(text), repo);

/** Deterministic mulberry32 PRNG. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('replaceClause, removeClause, and insertClause', () => {
  it('replaces a clause at start, middle, or end without disturbing neighbors', () => {
    const text = 'is:open label:"good first issue" flaky';
    const parsed = parseQuery(text);

    expect(replaceClause(text, parsed.clauses[0], 'state:closed')).toBe(
      'state:closed label:"good first issue" flaky'
    );
    expect(replaceClause(text, parsed.clauses[1], 'label:bug')).toBe(
      'is:open label:bug flaky'
    );
    expect(replaceClause(text, parsed.clauses[2], '"flaky test"')).toBe(
      'is:open label:"good first issue" "flaky test"'
    );
  });

  it('removes a clause and one adjacent whitespace run at start, middle, end, or when sole clause', () => {
    const text = 'state:open repo:a/b label:bug';
    const parsed = parseQuery(text);

    expect(removeClause(text, parsed.clauses[0])).toBe('repo:a/b label:bug');
    expect(removeClause(text, parsed.clauses[1])).toBe('state:open label:bug');
    expect(removeClause(text, parsed.clauses[2])).toBe('state:open repo:a/b');

    const single = 'state:open';
    expect(removeClause(single, parseQuery(single).clauses[0])).toBe('');
  });

  it('inserts clauses at their canonical rank before higher-ranked qualifiers and terms', () => {
    let text = '';
    text = insertClause(text, parseQuery(text), 'label:bug', 9);
    expect(text).toBe('label:bug');

    text = insertClause(text, parseQuery(text), 'triage:acked', 0);
    expect(text).toBe('triage:acked label:bug');

    text = insertClause(text, parseQuery(text), 'repo:a/b', 5);
    expect(text).toBe('triage:acked repo:a/b label:bug');

    // Free-text terms rank after every qualifier
    const withTerm = 'state:open crash';
    expect(insertClause(withTerm, parseQuery(withTerm), 'label:bug', 9)).toBe(
      'state:open label:bug crash'
    );
  });
});

describe('setControlInText', () => {
  it('rewrites only the edited control clause and leaves untouched clauses (including is:open and error clauses) byte-identical', () => {
    const initial = 'is:open label:"good first issue" lable:typo flaky';
    expect(editControl(initial, 'label', ['good first issue', 'bug'])).toBe(
      'is:open label:"good first issue",bug lable:typo flaky'
    );

    // Editing state replaces is:open in place, keeping label:"good first issue", lable:typo, and flaky untouched
    expect(editControl(initial, 'state', 'closed')).toBe(
      'state:closed label:"good first issue" lable:typo flaky'
    );

    // Clearing state removes is:open and its trailing space
    expect(editControl(initial, 'state', 'all')).toBe(
      'label:"good first issue" lable:typo flaky'
    );

    // Reformatting the edited clause itself (label:"Bug" + tick ui -> label:Bug,ui)
    expect(editControl('is:pr label:"Bug"', 'label', ['Bug', 'ui'])).toBe(
      'is:pr label:Bug,ui'
    );
  });

  it('preserves negated and extra clauses for the same field when editing or clearing a control', () => {
    const initial = '-label:wontfix label:a label:b';
    expect(editControl(initial, 'label', ['a', 'c'])).toBe(
      '-label:wontfix label:a,c label:b'
    );
    expect(editControl(initial, 'label', [])).toBe('-label:wontfix label:b');
  });

  it('enforces org/repo mutual exclusivity across multi-clause edits', () => {
    const withOrg = 'is:open org:k8s label:bug';
    expect(editControl(withOrg, 'repo', ['k8s/k8s'])).toBe(
      'is:open repo:k8s/k8s label:bug'
    );

    const withRepo = 'is:open repo:k8s/k8s label:bug';
    expect(editControl(withRepo, 'org', ['golang'])).toBe(
      'is:open org:golang label:bug'
    );

    // When both org and repo are present in hand-typed text, selecting one removes the other cleanly
    const both = 'org:k8s repo:golang/go label:bug';
    expect(setControlInText(both, parseQuery(both), 'org', ['k8s', 'cncf'])).toBe(
      'org:k8s,cncf label:bug'
    );
    expect(setControlInText(both, parseQuery(both), 'repo', ['golang/go'])).toBe(
      'repo:golang/go label:bug'
    );
  });

  it('enforces Any vs specific activity flag exclusivity', () => {
    const specific = editControl('', 'activity', ['mention', 'code']);
    expect(specific).toBe('new:mention,code');

    const withNoiseAndSpecific = editControl('', 'activity', ['mention', 'noise']);
    expect(editControl(withNoiseAndSpecific, 'activity', ['mention', 'noise', 'any'])).toBe(
      'new:noise,any'
    );

    const newTab = editControl('', 'activity', ['any']);
    expect(editControl(newTab, 'activity', ['any', 'comment'])).toBe('new:comment');
  });

  it('supports author:@me and toggleAssignedToMeInText', () => {
    expect(editControl('', 'author', ['@me', '@alice'])).toBe('author:@me,alice');

    const t1 = toggleAssignedToMeInText('assignee:alice', parseQuery('assignee:alice'));
    expect(t1).toBe('assignee:@me,alice');

    const t2 = toggleAssignedToMeInText(t1, parseQuery(t1));
    expect(t2).toBe('assignee:alice');
  });
});

describe('setTriageTabInText and toggleRepoInText', () => {
  it('removes -triage:acked and replaces new:mention,code on New tab switch', () => {
    expect(editTab('repo:a/b -triage:acked', 'activity')).toBe('new:any repo:a/b');
    expect(editTab('repo:a/b -triage:acked', 'inbox')).toBe('repo:a/b');

    expect(editTab('triage:acked new:mention,code repo:a/b', 'activity')).toBe(
      'new:any repo:a/b'
    );
    expect(editTab('repo:a/b new:mention,code label:bug', 'activity')).toBe(
      'repo:a/b new:any label:bug'
    );
  });

  it('removes new:any when switching to Inbox/Acked/All, but preserves specific new:mention flags', () => {
    expect(editTab('new:any repo:a/b', 'acked')).toBe('triage:acked repo:a/b');
    expect(editTab('new:any repo:a/b', 'inbox')).toBe('repo:a/b');
    expect(editTab('is:new repo:a/b', 'all')).toBe('triage:all repo:a/b');

    expect(editTab('new:mention repo:a/b', 'acked')).toBe(
      'triage:acked new:mention repo:a/b'
    );
    expect(editTab('triage:acked new:mention', 'inbox')).toBe('new:mention');
  });

  it('toggles a single repo and clears org via toggleRepoInText', () => {
    const selected = editToggleRepo('org:k8s label:x', 'k8s/a');
    expect(selected).toBe('repo:k8s/a label:x');
    expect(editToggleRepo(selected, 'k8s/b')).toBe('repo:k8s/b label:x');
    expect(editToggleRepo(selected, 'k8s/a')).toBe('label:x');
    expect(editToggleRepo(selected, 'K8S/A')).toBe('label:x');

    // Narrowing multi-repo selection to one repo
    expect(editToggleRepo('repo:k8s/a,k8s/b label:x', 'k8s/a')).toBe(
      'repo:k8s/a label:x'
    );
  });
});

describe('P-edit property over generated query texts (§3.7)', () => {
  const SAMPLE_CLAUSES = [
    'is:open',
    'is:pr',
    '-is:draft',
    'triage:acked',
    '-triage:inbox',
    'state:closed',
    'type:issue',
    'tracking:true',
    'repo:kubernetes/kubernetes',
    'org:golang',
    'author:alice',
    'assignee:@me',
    'milestone:"v1.32 release"',
    'label:"good first issue",bug',
    '-label:wontfix',
    'new:mention,code',
    'lable:typo',
    'label:',
    '"exact phrase"',
    '#123',
    'flaky',
  ];

  it('preserves every untouched clause raw text across 250 seeded edit operations', () => {
    const rng = mulberry32(0x99887766);

    for (let i = 0; i < 250; i++) {
      const count = 1 + Math.floor(rng() * 6);
      const clauses: string[] = [];
      for (let j = 0; j < count; j++) {
        clauses.push(SAMPLE_CLAUSES[Math.floor(rng() * SAMPLE_CLAUSES.length)]);
      }
      const text = clauses.join(' ');
      const parsed = parseQuery(text);
      const { owners } = projectClauses(parsed);

      // Pick a single-clause control edit (state, type, tracking, milestone, label, author, assignee)
      const controlPool = [
        { key: 'state' as const, value: 'merged' as const },
        { key: 'state' as const, value: 'all' as const },
        { key: 'type' as const, value: 'pr' as const },
        { key: 'tracking' as const, value: 'untracked' as const },
        { key: 'label' as const, value: ['area/api', 'kind/bug'] },
        { key: 'label' as const, value: [] },
        { key: 'milestone' as const, value: ['v2.0'] },
        { key: 'author' as const, value: ['bob'] },
        { key: 'assignee' as const, value: ['@me'] },
      ];
      const chosen = controlPool[Math.floor(rng() * controlPool.length)];
      const ownerIdx = owners[chosen.key];

      const editedText = setControlInText(
        text,
        parsed,
        chosen.key,
        chosen.value as never
      );
      const editedParsed = parseQuery(editedText);

      // Every clause from `parsed` except `ownerIdx` must appear with its exact `.raw` string in `editedParsed` in the same relative order.
      const expectedUntouched = parsed.clauses
        .filter((_, idx) => idx !== ownerIdx)
        .map((c) => c.raw);
      const actualRaws = editedParsed.clauses.map((c) => c.raw);

      let cursor = 0;
      for (const untouchedRaw of expectedUntouched) {
        const foundAt = actualRaws.indexOf(untouchedRaw, cursor);
        expect(
          foundAt,
          `untouched clause '${untouchedRaw}' missing or reordered in '${editedText}' (from '${text}')`
        ).toBeGreaterThanOrEqual(cursor);
        cursor = foundAt + 1;
      }

      // Single-space invariant holds on the result
      expect(editedText).toBe(editedParsed.clauses.map((c) => c.raw).join(' '));
    }
  });
});
