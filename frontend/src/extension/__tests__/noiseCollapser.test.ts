import {
  isBotLogin,
  isSlashCommandBody,
  extractAuthorLogin,
  extractCommentBodyElement,
  extractFirstNonBlankLine,
  extractRemainingLines,
  formatContentWithLinks,
  createRestContentElement,
  isCommentMultiLine,
  extractTimelineItemInfo,
  buildCollapseSummaryText,
  isRunCollapsible,
  isCloseOrReopenEvent,
  isReviewEvent,
  isMentionOrReferenceEvent,
  NoiseCollapser,
} from '../content/noiseCollapser';

describe('NoiseCollapser', () => {
  describe('isBotLogin', () => {
    it('detects [bot] suffixes and bot keywords for any username', () => {
      expect(isBotLogin('k8s-ci-robot[bot]')).toBe(true);
      expect(isBotLogin('dependabot[bot]')).toBe(true);
      expect(isBotLogin('some-random-unknown-app[bot]')).toBe(true);
      expect(isBotLogin('custom-tool[robot]')).toBe(true);
      expect(isBotLogin('fejta-bot')).toBe(true);
      expect(isBotLogin('k8s-bot')).toBe(true);
      expect(isBotLogin('humanDev')).toBe(false);
      expect(isBotLogin('')).toBe(false);
    });

    it('matches known bots list case-insensitively and handles suffixes in knownBots', () => {
      const known = ['k8s-ci-robot', 'kubernetes-prow', 'codecov'];
      expect(isBotLogin('k8s-ci-robot', known)).toBe(true);
      expect(isBotLogin('K8S-CI-ROBOT', known)).toBe(true);
      expect(isBotLogin('kubernetes-prow[bot]', known)).toBe(true);
      expect(isBotLogin('codecov', known)).toBe(true);
      expect(isBotLogin('otherDev', known)).toBe(false);
    });
  });

  describe('isSlashCommandBody', () => {
    it('identifies single slash commands', () => {
      expect(isSlashCommandBody('/lgtm')).toBe(true);
      expect(isSlashCommandBody('/approve')).toBe(true);
      expect(isSlashCommandBody('/assign')).toBe(true);
      expect(isSlashCommandBody('/hold cancel')).toBe(true);
      expect(isSlashCommandBody('/retest')).toBe(true);
    });

    it('identifies multiline slash commands', () => {
      const multiline = '/lgtm\n/approve\n/assign @bob';
      expect(isSlashCommandBody(multiline)).toBe(true);
    });

    it('returns false for human commentary containing slash commands', () => {
      expect(isSlashCommandBody('I will /hold this until tests pass.')).toBe(false);
      expect(isSlashCommandBody('Please run /retest on this PR.')).toBe(false);
    });
  });

  describe('extractFirstNonBlankLine, extractRemainingLines, and isCommentMultiLine', () => {
    it('extracts first non-blank line from multiline text', () => {
      expect(extractFirstNonBlankLine('\n\nBuild passed on commit 123.\nMore output below.')).toBe(
        'Build passed on commit 123.'
      );
      expect(extractFirstNonBlankLine('/lgtm\n/approve')).toBe('/lgtm');
      expect(extractFirstNonBlankLine('')).toBe('');
      expect(extractFirstNonBlankLine('   \n\t\n  ')).toBe('');
    });

    it('extracts remaining lines after the first non-blank line', () => {
      expect(extractRemainingLines('/lgtm\n/approve\n/assign @bob')).toBe('/approve\n/assign @bob');
      expect(extractRemainingLines('\n\nBuild passed.\nDetails at ci.k8s.io')).toBe('Details at ci.k8s.io');
      expect(extractRemainingLines('Single line')).toBe('');
      expect(extractRemainingLines('')).toBe('');
    });

    it('detects if comment is multiline', () => {
      expect(isCommentMultiLine('/lgtm')).toBe(false);
      expect(isCommentMultiLine('Single line message')).toBe(false);
      expect(isCommentMultiLine('Single line with trailing spaces\n\n')).toBe(false);
      expect(isCommentMultiLine('/lgtm\n/approve')).toBe(true);
      expect(isCommentMultiLine('Header\nBody text')).toBe(true);
    });
  });

  describe('createRestContentElement and formatContentWithLinks', () => {
    it('preserves real DOM anchor elements from markdown body', () => {
      const bodyEl = document.createElement('div');
      bodyEl.className = 'markdown-body';
      bodyEl.innerHTML = `
        <p>The following tests failed:</p>
        <ul>
          <li><a href="https://prow.k8s.io/view/123" class="issue-link">ci-kubernetes-e2e-gce</a></li>
          <li><a href="https://prow.k8s.io/view/456">ci-kubernetes-unit</a></li>
        </ul>
      `;

      const restEl = createRestContentElement(bodyEl, '');
      expect(restEl.className).toBe('octodeck-gh-dense-rest');
      expect(restEl.textContent).not.toContain('The following tests failed:');

      const links = restEl.querySelectorAll('a');
      expect(links.length).toBe(2);
      expect(links[0].href).toBe('https://prow.k8s.io/view/123');
      expect(links[0].textContent).toBe('ci-kubernetes-e2e-gce');
      expect(links[1].href).toBe('https://prow.k8s.io/view/456');
    });

    it('removes the first line from single paragraph with br and preserves subsequent links', () => {
      const bodyEl = document.createElement('div');
      bodyEl.className = 'markdown-body';
      bodyEl.innerHTML = `<p>Coverage +0.2%<br>Full report at <a href="https://codecov.io/gh/repo">codecov.io</a></p>`;

      const restEl = createRestContentElement(bodyEl, '');
      expect(restEl.textContent).not.toContain('Coverage +0.2%');
      expect(restEl.textContent).toContain('Full report at codecov.io');

      const link = restEl.querySelector('a');
      expect(link).not.toBeNull();
      expect(link?.href).toBe('https://codecov.io/gh/repo');
    });

    it('filters out elements with role="toolbar" and action bars', () => {
      const bodyEl = document.createElement('div');
      bodyEl.className = 'markdown-body';
      bodyEl.innerHTML = `
        <div role="toolbar" aria-label="Comment actions"><button>Quote reply</button></div>
        <p>First line</p>
        <p>Second line with content</p>
        <div class="ActionBar-module__actionBar"><button>React</button></div>
        <div role="toolbar"><button>Copy code</button></div>
      `;

      const restEl = createRestContentElement(bodyEl, '');
      expect(restEl.querySelectorAll('[role="toolbar"]').length).toBe(0);
      expect(restEl.textContent).toContain('Second line with content');
      expect(restEl.textContent).not.toContain('Quote reply');
      expect(restEl.textContent).not.toContain('React');
      expect(restEl.textContent).not.toContain('Copy code');
    });

    it('extracts markdown-body element ignoring outer action bar and reaction buttons', () => {
      const commentEl = document.createElement('div');
      commentEl.innerHTML = `
        <div class="IssueCommentViewer-module__IssueCommentBody__IXu9t">
          <div class="ActionBar-module__actionBar__123" role="toolbar">
            <button aria-label="React">React</button>
          </div>
          <div class="markdown-body">
            <p>Build failed.</p>
          </div>
          <div class="reaction-popover-container">
            <button>React</button>
          </div>
        </div>
      `;

      const bodyEl = extractCommentBodyElement(commentEl);
      expect(bodyEl?.className).toBe('markdown-body');
      expect(bodyEl?.textContent?.trim()).toBe('Build failed.');
    });

    it('formats plain text fallback without links', () => {
      const el = formatContentWithLinks('Simple multi-line\ncomment body');
      expect(el.textContent).toBe('Simple multi-line\ncomment body');
      expect(el.querySelectorAll('a').length).toBe(0);
    });

    it('converts bare URLs into clickable links in plain text fallback', () => {
      const el = formatContentWithLinks('Full report at https://codecov.io/gh/repo. Details at http://ci.k8s.io');
      const links = el.querySelectorAll('a');
      expect(links.length).toBe(2);
      expect(links[0].href).toBe('https://codecov.io/gh/repo');
      expect(links[0].textContent).toBe('https://codecov.io/gh/repo');
      expect(links[0].target).toBe('_blank');
      expect(links[0].rel).toBe('noopener noreferrer');
      expect(links[1].href).toBe('http://ci.k8s.io/');
    });

    it('converts markdown links into clickable links in plain text fallback', () => {
      const el = formatContentWithLinks('See [Coverage Report](https://codecov.io) for more details.');
      const links = el.querySelectorAll('a');
      expect(links.length).toBe(1);
      expect(links[0].href).toBe('https://codecov.io/');
      expect(links[0].textContent).toBe('Coverage Report');
      expect(links[0].target).toBe('_blank');
    });
  });

  describe('extractAuthorLogin', () => {
    it('extracts author when avatar link precedes author link', () => {
      const el = document.createElement('div');
      el.innerHTML = `
        <div class="avatar-parent-child">
          <a class="d-inline-block" data-hovercard-type="user" data-hovercard-url="/users/tallclair/hovercard" href="https://github.com/tallclair">
            <img class="avatar rounded-2" src="avatar.png" alt="@tallclair">
          </a>
        </div>
        <div class="timeline-comment-header">
          <strong>
            <a class="author Link--primary text-bold" href="https://github.com/tallclair">tallclair</a>
          </strong>
        </div>
      `;
      expect(extractAuthorLogin(el)).toBe('tallclair');
    });

    it('extracts author from GitHub apps link', () => {
      const el = document.createElement('div');
      el.innerHTML = `
        <div class="TimelineItem-body">
          <a class="d-inline-block" href="https://github.com/apps/kubernetes-prow">
            <img class="avatar" src="prow.png" alt="@kubernetes-prow">
          </a>
          <a class="author Link--primary text-bold" href="https://github.com/apps/kubernetes-prow">kubernetes-prow</a>
          <span class="Label Label--secondary">Bot</span>
        </div>
      `;
      expect(extractAuthorLogin(el)).toBe('kubernetes-prow');
    });
  });

  describe('isCloseOrReopenEvent', () => {
    it('detects close event with icon or closed text', () => {
      const el = document.createElement('div');
      el.className = 'TimelineItem';
      el.innerHTML = `
        <div class="TimelineItem-badge"><svg class="octicon octicon-circle-slash"></svg></div>
        <div class="TimelineItem-body">tallclair closed this as completed</div>
      `;
      expect(isCloseOrReopenEvent(el)).toBe(true);
    });

    it('detects reopen event in React issue structure', () => {
      const el = document.createElement('section');
      el.setAttribute('aria-label', 'Events');
      el.innerHTML = `
        <div data-wrapper-timeline-id="REE_12345">
          <div class="prc-Timeline-TimelineBadge-u0qSm">
            <svg class="octicon octicon-issue-reopened"></svg>
          </div>
          <div class="row-module__timelineBodyContent__nmY90">
            <span>reopened this</span>
          </div>
        </div>
      `;
      expect(isCloseOrReopenEvent(el)).toBe(true);
    });

    it('returns false for label events even if referenced issues are closed', () => {
      const el = document.createElement('section');
      el.setAttribute('aria-label', 'Events');
      el.innerHTML = `
        <div data-wrapper-timeline-id="LE_12345">
          <div class="prc-Timeline-TimelineBadge-u0qSm">
            <svg class="octicon octicon-tag"></svg>
          </div>
          <div class="row-module__timelineBodyContent__nmY90">
            <span>added kind/bug label</span>
          </div>
          <ul class="CrossReferencedEvent">
            <li><svg class="octicon octicon-issue-closed"></svg> #123</li>
          </ul>
        </div>
      `;
      expect(isCloseOrReopenEvent(el)).toBe(false);
    });

    it('returns false for comment elements mentioning closed issues', () => {
      const el = document.createElement('div');
      el.className = 'timeline-comment-group';
      el.id = 'issuecomment-123';
      el.innerHTML = `
        <div class="comment-body">I closed this issue earlier</div>
      `;
      expect(isCloseOrReopenEvent(el)).toBe(false);
    });
  });

  describe('buildCollapseSummaryText', () => {
    it('formats summary with both comments and other events', () => {
      expect(buildCollapseSummaryText(3, 6, ['kubernetes-prow'])).toBe(
        '3 comments and 6 other events from @kubernetes-prow'
      );
      expect(buildCollapseSummaryText(1, 4, ['kubernetes-prow', 'tallclair'])).toBe(
        '1 comment and 4 other events from @kubernetes-prow, @tallclair'
      );
      expect(buildCollapseSummaryText(1, 1, ['kubernetes-prow'])).toBe(
        '1 comment and 1 other event from @kubernetes-prow'
      );
    });

    it('formats summary with comments only', () => {
      expect(buildCollapseSummaryText(2, 0, ['ci-robot'])).toBe('2 comments from @ci-robot');
      expect(buildCollapseSummaryText(1, 0, ['tallclair'])).toBe('1 comment from @tallclair');
    });

    it('formats summary with events only', () => {
      expect(buildCollapseSummaryText(0, 5, ['kubernetes-prow'])).toBe('5 other events from @kubernetes-prow');
      expect(buildCollapseSummaryText(0, 1, ['kubernetes-prow'])).toBe('1 other event from @kubernetes-prow');
    });
  });

  describe('isReviewEvent', () => {
    it('detects review event by pullrequestreview ID', () => {
      const el = document.createElement('div');
      el.id = 'pullrequestreview-4741544059';
      el.className = 'TimelineItem';
      el.innerHTML = `
        <div class="TimelineItem-body">
          <a class="author" href="/tallclair">tallclair</a> reviewed last month
        </div>
      `;
      expect(isReviewEvent(el)).toBe(true);
    });

    it('detects review event with review anchor link and author profile link', () => {
      const el = document.createElement('div');
      el.className = 'TimelineItem';
      el.innerHTML = `
        <div class="TimelineItem-body">
          <a class="author" href="https://github.com/tallclair">tallclair</a>
          reviewed
          <a href="https://github.com/kubernetes/kubernetes/pull/140704#pullrequestreview-4741544059">last month</a>
        </div>
      `;
      expect(isReviewEvent(el)).toBe(true);
    });

    it('detects review event in React timeline by PRR wrapper ID', () => {
      const el = document.createElement('div');
      el.setAttribute('data-wrapper-timeline-id', 'PRR_kwDOA12345');
      el.innerHTML = `
        <div class="row-module__timelineBodyContent__nmY90">
          <a data-testid="actor-link" href="/tallclair">tallclair</a>
          <span>reviewed</span>
        </div>
      `;
      expect(isReviewEvent(el)).toBe(true);
    });

    it('detects review event by approved or requested changes text', () => {
      const approvedEl = document.createElement('div');
      approvedEl.className = 'TimelineItem';
      approvedEl.innerHTML = `
        <div class="TimelineItem-body">
          <a class="author" href="/reviewer">reviewer</a> approved these changes
        </div>
      `;
      expect(isReviewEvent(approvedEl)).toBe(true);

      const requestedChangesEl = document.createElement('div');
      requestedChangesEl.className = 'TimelineItem';
      requestedChangesEl.innerHTML = `
        <div class="TimelineItem-body">
          <a class="author" href="/reviewer">reviewer</a> requested changes
        </div>
      `;
      expect(isReviewEvent(requestedChangesEl)).toBe(true);
    });

    it('returns false for regular issue comments mentioning the word reviewed', () => {
      const el = document.createElement('div');
      el.id = 'issuecomment-98765';
      el.className = 'timeline-comment-group';
      el.innerHTML = `
        <div class="comment-body">I reviewed the PR and it looks good.</div>
      `;
      expect(isReviewEvent(el)).toBe(false);
    });

    it('returns false for label or force-push events', () => {
      const labelEl = document.createElement('div');
      labelEl.className = 'TimelineItem';
      labelEl.innerHTML = `<div class="TimelineItem-body">added kind/bug label</div>`;
      expect(isReviewEvent(labelEl)).toBe(false);

      const pushEl = document.createElement('div');
      pushEl.className = 'TimelineItem';
      pushEl.innerHTML = `<div class="TimelineItem-body">force-pushed branch</div>`;
      expect(isReviewEvent(pushEl)).toBe(false);
    });
  });

  describe('isMentionOrReferenceEvent', () => {
    it('detects mention event with author and "mentioned this" text and issue link', () => {
      const el = document.createElement('div');
      el.className = 'TimelineItem';
      el.id = 'event-1422795341';
      el.innerHTML = `
        <div class="TimelineItem-badge">
          <svg class="octicon octicon-bookmark"></svg>
        </div>
        <div class="TimelineItem-body">
          <a class="author" href="/bouaouda-achraf">bouaouda-achraf</a>
          mentioned this
          <a href="#event-1422795341">on Sep 2, 2024</a>
          <a href="/kubernetes/kubernetes/pull/127071">e2e: refactor FilterNonRestartablePods function #127071</a>
        </div>
      `;
      expect(isMentionOrReferenceEvent(el)).toBe(true);
    });

    it('detects cross-reference event in React timeline by CRE wrapper ID and cross-reference octicon', () => {
      const el = document.createElement('div');
      el.setAttribute('data-wrapper-timeline-id', 'CRE_kwDOA12345');
      el.innerHTML = `
        <div class="prc-Timeline-TimelineBadge-u0qSm">
          <svg class="octicon octicon-cross-reference"></svg>
        </div>
        <div class="row-module__timelineBodyContent__nmY90">
          <a data-testid="actor-link" href="/developer">developer</a>
          <span>mentioned this</span>
          <a href="...">on Aug 10, 2026</a>
        </div>
      `;
      expect(isMentionOrReferenceEvent(el)).toBe(true);
    });

    it('detects referenced event by "referenced this" text', () => {
      const el = document.createElement('div');
      el.className = 'TimelineItem discussion-item-ref';
      el.innerHTML = `
        <div class="TimelineItem-body">
          <a class="author" href="/developer">developer</a>
          referenced this pull request
        </div>
      `;
      expect(isMentionOrReferenceEvent(el)).toBe(true);
    });

    it('returns false for regular comments containing the word "mentioned"', () => {
      const el = document.createElement('div');
      el.id = 'issuecomment-12345';
      el.className = 'timeline-comment-group';
      el.innerHTML = `
        <div class="comment-body">
          <p>I mentioned this bug in yesterday's standup meeting.</p>
        </div>
      `;
      expect(isMentionOrReferenceEvent(el)).toBe(false);
    });

    it('returns false for label, milestone, or force-push events', () => {
      const labelEl = document.createElement('div');
      labelEl.className = 'TimelineItem';
      labelEl.innerHTML = `
        <div class="TimelineItem-badge"><svg class="octicon octicon-tag"></svg></div>
        <div class="TimelineItem-body">added kind/bug label</div>
      `;
      expect(isMentionOrReferenceEvent(labelEl)).toBe(false);

      const pushEl = document.createElement('div');
      pushEl.className = 'TimelineItem';
      pushEl.innerHTML = `
        <div class="TimelineItem-badge"><svg class="octicon octicon-repo-push"></svg></div>
        <div class="TimelineItem-body">force-pushed branch</div>
      `;
      expect(isMentionOrReferenceEvent(pushEl)).toBe(false);
    });
  });

  describe('isRunCollapsible', () => {
    const dummyEl = document.createElement('div');

    it('collapses runs with at least 1 comment', () => {
      const singleComment = [
        { element: dummyEl, authorLogin: 'bot', isComment: true, isBot: true, isSlashCommand: false, isNoise: true },
      ];
      expect(isRunCollapsible(singleComment)).toBe(true);

      const twoComments = [
        { element: dummyEl, authorLogin: 'bot', isComment: true, isBot: true, isSlashCommand: false, isNoise: true },
        { element: dummyEl, authorLogin: 'human', isComment: true, isBot: false, isSlashCommand: true, isNoise: true },
      ];
      expect(isRunCollapsible(twoComments)).toBe(true);
    });

    it('returns false for empty runs or runs without comments', () => {
      expect(isRunCollapsible([])).toBe(false);
      const pureEvent = [
        { element: dummyEl, authorLogin: 'bot', isComment: false, isBot: true, isSlashCommand: false, isNoise: false },
      ];
      expect(isRunCollapsible(pureEvent)).toBe(false);
    });
  });

  describe('Extra-Dense DOM Collapsing and Grouping', () => {
    let container: HTMLElement;

    beforeEach(() => {
      document.body.innerHTML = '';
      container = document.createElement('div');
      container.innerHTML = `
        <div class="js-discussion">
          <!-- Comment 1: 1-line bot comment (no expand button) -->
          <div id="issuecomment-1" class="timeline-comment-group">
            <span class="author">k8s-ci-robot[bot]</span>
            <div class="comment-body">
              <p>Build passed on commit abc.</p>
            </div>
          </div>
          <!-- Comment 2: Multi-line bot comment with links (has expand button) -->
          <div id="issuecomment-2" class="timeline-comment-group">
            <span class="author">codecov[bot]</span>
            <div class="comment-body">
              <p>Coverage increased +0.2%.</p>
              <p>Full report at <a href="https://codecov.io/report">codecov.io</a></p>
            </div>
          </div>
          <!-- Comment 3: Human discussion comment -->
          <div id="issuecomment-3" class="timeline-comment-group">
            <span class="author">alice</span>
            <div class="comment-body">
              <p>Looks great, but can you check line 42?</p>
            </div>
          </div>
          <!-- Comment 4: Single line slash command (no expand button) -->
          <div id="issuecomment-4" class="timeline-comment-group">
            <span class="author">bob</span>
            <div class="comment-body">
              <p>/lgtm</p>
            </div>
          </div>
        </div>
      `;
      document.body.appendChild(container);
    });

    it('extracts comment info accurately from DOM', () => {
      const comment1 = container.querySelector('#issuecomment-1') as HTMLElement;
      const info1 = extractTimelineItemInfo(comment1);
      expect(info1.authorLogin).toBe('k8s-ci-robot[bot]');
      expect(info1.isBot).toBe(true);
      expect(info1.isNoise).toBe(true);
      expect(info1.isComment).toBe(true);

      const comment3 = container.querySelector('#issuecomment-3') as HTMLElement;
      const info3 = extractTimelineItemInfo(comment3);
      expect(info3.authorLogin).toBe('alice');
      expect(info3.isBot).toBe(false);
      expect(info3.isSlashCommand).toBe(false);
      expect(info3.isNoise).toBe(false);
      expect(info3.isComment).toBe(true);

      const comment4 = container.querySelector('#issuecomment-4') as HTMLElement;
      const info4 = extractTimelineItemInfo(comment4);
      expect(info4.authorLogin).toBe('bob');
      expect(info4.isBot).toBe(false);
      expect(info4.isSlashCommand).toBe(true);
      expect(info4.isNoise).toBe(true);
      expect(info4.isComment).toBe(true);
    });

    it('does not classify human review comments containing words with "bot" (like both, bottom) as noise', () => {
      const humanReview = document.createElement('div');
      humanReview.className = 'timeline-comment-group';
      humanReview.innerHTML = `
        <div class="timeline-comment-header">
          <span class="author">reviewer1</span>
        </div>
        <div class="comment-body">We should both look at the bottom of this function to optimize it.</div>
      `;
      const info = extractTimelineItemInfo(humanReview);
      expect(info.isBot).toBe(false);
      expect(info.isNoise).toBe(false);
    });

    it('renders extra-dense boxes wrapped in TimelineItem with no colon between author and comment, and no expand button for single-line comments', () => {
      const collapser = new NoiseCollapser(container);
      collapser.run();

      // Original noise comments should have collapsed class
      const comment1 = container.querySelector('#issuecomment-1') as HTMLElement;
      const comment2 = container.querySelector('#issuecomment-2') as HTMLElement;
      expect(comment1.classList.contains('octodeck-gh-collapsed-comment')).toBe(true);
      expect(comment2.classList.contains('octodeck-gh-collapsed-comment')).toBe(true);

      // Human comment 3 should remain visible
      const comment3 = container.querySelector('#issuecomment-3') as HTMLElement;
      expect(comment3.classList.contains('octodeck-gh-collapsed-comment')).toBe(false);

      // Comment 4 should be collapsed (slash command)
      const comment4 = container.querySelector('#issuecomment-4') as HTMLElement;
      expect(comment4.classList.contains('octodeck-gh-collapsed-comment')).toBe(true);

      // Check dense timeline item wrappers
      const wrappers = container.querySelectorAll('.octodeck-gh-dense-timeline-item');
      expect(wrappers.length).toBe(2);
      expect(wrappers[0].querySelector('.TimelineItem-body')).not.toBeNull();

      // Check dense boxes inside wrappers
      const boxes = container.querySelectorAll('.octodeck-gh-dense-box');
      expect(boxes.length).toBe(2);
      expect(boxes[0].classList.contains('tmp-ml-n3')).toBe(true);

      // Box 1 contains 2 rows (k8s-ci-robot and codecov)
      const box1Rows = boxes[0].querySelectorAll('.octodeck-gh-dense-row');
      expect(box1Rows.length).toBe(2);

      // Row 1: Single line -> NO expand button, no colon
      expect(box1Rows[0].querySelector('.octodeck-gh-dense-author')?.textContent).toBe('@k8s-ci-robot[bot]');
      expect(box1Rows[0].querySelector('.octodeck-gh-dense-text')?.textContent).toBe('Build passed on commit abc.');
      expect(box1Rows[0].querySelector('.octodeck-gh-dense-expand-btn')).toBeNull();

      // Row 2: Multiline -> has expand button, no colon
      expect(box1Rows[1].querySelector('.octodeck-gh-dense-author')?.textContent).toBe('@codecov[bot]');
      expect(box1Rows[1].querySelector('.octodeck-gh-dense-text')?.textContent).toBe('Coverage increased +0.2%.');
      const expandBtn2 = box1Rows[1].querySelector('.octodeck-gh-dense-expand-btn') as HTMLButtonElement;
      expect(expandBtn2).not.toBeNull();
      expect(expandBtn2.textContent).toBe('[+]');

      // Box 2 contains 1 row (bob /lgtm) -> Single line -> NO expand button
      const box2Rows = boxes[1].querySelectorAll('.octodeck-gh-dense-row');
      expect(box2Rows.length).toBe(1);
      expect(box2Rows[0].querySelector('.octodeck-gh-dense-author')?.textContent).toBe('@bob');
      expect(box2Rows[0].querySelector('.octodeck-gh-dense-text')?.textContent).toBe('/lgtm');
      expect(box2Rows[0].querySelector('.octodeck-gh-dense-expand-btn')).toBeNull();
    });

    it('keeps first line in place and renders links in rest of content when expanding in-line', () => {
      const collapser = new NoiseCollapser(container);
      collapser.run();

      const boxes = container.querySelectorAll('.octodeck-gh-dense-box');
      const box1Rows = boxes[0].querySelectorAll('.octodeck-gh-dense-row');
      const row2 = box1Rows[1];
      const expandBtn2 = row2.querySelector('.octodeck-gh-dense-expand-btn') as HTMLButtonElement;
      const comment2 = container.querySelector('#issuecomment-2') as HTMLElement;

      const previewEl = row2.querySelector('.octodeck-gh-dense-preview') as HTMLElement;
      const restEl = row2.querySelector('.octodeck-gh-dense-rest') as HTMLElement;

      // Initially collapsed: first line visible, rest hidden, button says [+]
      expect(previewEl.style.display).not.toBe('none');
      expect(restEl.style.display).toBe('none');
      expect(expandBtn2.textContent).toBe('[+]');
      expect(comment2.classList.contains('octodeck-gh-collapsed-comment')).toBe(true);

      // Click Expand -> first line stays in place, button becomes [-], rest of content displays below with link
      expandBtn2.click();
      expect(previewEl.style.display).not.toBe('none');
      expect(expandBtn2.textContent).toBe('[-]');
      expect(restEl.style.display).toBe('block');
      expect(restEl.textContent).toContain('Full report at codecov.io');

      const link = restEl.querySelector('a');
      expect(link).not.toBeNull();
      expect(link?.href).toBe('https://codecov.io/report');
      expect(link?.textContent).toBe('codecov.io');

      // Original GitHub comment MUST stay hidden
      expect(comment2.classList.contains('octodeck-gh-collapsed-comment')).toBe(true);

      // Click Collapse -> toggles back
      expandBtn2.click();
      expect(previewEl.style.display).not.toBe('none');
      expect(expandBtn2.textContent).toBe('[+]');
      expect(restEl.style.display).toBe('none');
      expect(comment2.classList.contains('octodeck-gh-collapsed-comment')).toBe(true);
    });

    it('collapses React issue bot comments and slash commands properly into extra-dense box with in-line expansion', () => {
      const reactIssueContainer = document.createElement('div');
      reactIssueContainer.innerHTML = `
        <div id="issue-timeline" class="prc-Timeline-Timeline-awSoC">
          <!-- Item 0: Multiline Bot comment with link in second paragraph -->
          <div class="LayoutHelpers-module__timelineElement" data-wrapper-timeline-id="IC_1" id="react-item-0">
            <div class="react-issue-comment">
              <div id="issuecomment-1" data-testid="comment-header">
                <a data-testid="actor-link" data-hovercard-type="user" href="https://github.com/k8s-ci-robot">
                  <span>k8s-ci-robot</span>
                </a>
              </div>
              <div class="IssueCommentViewer-module__IssueCommentBody__IXu9t">
                <div class="markdown-body">
                  <p>Build failed.</p>
                  <p>Details at <a href="https://ci.k8s.io/view/123">ci-kubernetes-e2e</a></p>
                </div>
              </div>
            </div>
          </div>

          <!-- Item 1: 1-line Slash command -->
          <div class="LayoutHelpers-module__timelineElement" data-wrapper-timeline-id="IC_2" id="react-item-1">
            <div class="react-issue-comment">
              <div id="issuecomment-2" data-testid="comment-header">
                <a data-testid="actor-link" data-hovercard-type="user" href="https://github.com/tallclair">
                  <span>tallclair</span>
                </a>
              </div>
              <div class="IssueCommentViewer-module__IssueCommentBody__IXu9t">
                <div class="markdown-body">
                  <p>/retest</p>
                </div>
              </div>
            </div>
          </div>

          <!-- Item 2: Human comment -->
          <div class="LayoutHelpers-module__timelineElement" data-wrapper-timeline-id="IC_3" id="react-item-2">
            <div class="react-issue-comment">
              <div id="issuecomment-3" data-testid="comment-header">
                <a data-testid="actor-link" data-hovercard-type="user" href="https://github.com/tallclair">
                  <span>tallclair</span>
                </a>
              </div>
              <div class="IssueCommentViewer-module__IssueCommentBody__IXu9t">
                <div class="markdown-body">
                  <p>Investigating the test failure now.</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      `;

      const collapser = new NoiseCollapser(reactIssueContainer);
      collapser.run();

      const boxes = reactIssueContainer.querySelectorAll('.octodeck-gh-dense-box');
      expect(boxes.length).toBe(1);

      const rows = boxes[0].querySelectorAll('.octodeck-gh-dense-row');
      expect(rows.length).toBe(2);

      // Row 0 (multiline bot comment) has expand button
      expect(rows[0].querySelector('.octodeck-gh-dense-author')?.textContent).toBe('@k8s-ci-robot');
      expect(rows[0].querySelector('.octodeck-gh-dense-text')?.textContent).toBe('Build failed.');
      const expandBtn0 = rows[0].querySelector('.octodeck-gh-dense-expand-btn') as HTMLButtonElement;
      expect(expandBtn0).not.toBeNull();

      // Expand row 0 -> verify real <a> link from GitHub Markdown DOM is present
      expandBtn0.click();
      const restEl0 = rows[0].querySelector('.octodeck-gh-dense-rest');
      expect(restEl0).not.toBeNull();
      const link0 = restEl0?.querySelector('a');
      expect(link0?.href).toBe('https://ci.k8s.io/view/123');
      expect(link0?.textContent).toBe('ci-kubernetes-e2e');

      // Row 1 (single-line slash command) has NO expand button
      expect(rows[1].querySelector('.octodeck-gh-dense-author')?.textContent).toBe('@tallclair');
      expect(rows[1].querySelector('.octodeck-gh-dense-text')?.textContent).toBe('/retest');
      expect(rows[1].querySelector('.octodeck-gh-dense-expand-btn')).toBeNull();
    });

    it('hides all non-comment events when hideNonCommentEvents is enabled EXCEPT close & reopen events', () => {
      const prContainer = document.createElement('div');
      prContainer.innerHTML = `
        <div class="TimelineItem" id="event-label">
          <div class="TimelineItem-badge"><svg class="octicon octicon-tag"></svg></div>
          <div class="TimelineItem-body">added a label</div>
        </div>
        <div class="TimelineItem" id="issuecomment-1">
          <div class="comment-body"><p>/lgtm</p></div>
        </div>
        <div class="TimelineItem" id="event-force-push">
          <div class="TimelineItem-badge"><svg class="octicon octicon-repo-push"></svg></div>
          <div class="TimelineItem-body">force-pushed branch</div>
        </div>
        <div class="TimelineItem" id="event-close">
          <div class="TimelineItem-badge"><svg class="octicon octicon-circle-slash"></svg></div>
          <div class="TimelineItem-body">closed this as completed</div>
        </div>
        <div class="TimelineItem" id="issuecomment-2">
          <div class="comment-body"><p>Human review comment</p></div>
        </div>
        <div class="TimelineItem" id="event-reopen">
          <div class="TimelineItem-badge"><svg class="octicon octicon-issue-reopened"></svg></div>
          <div class="TimelineItem-body">reopened this</div>
        </div>
      `;

      const collapser = new NoiseCollapser(prContainer);
      collapser.setHideNonCommentEvents(true);

      const eventLabel = prContainer.querySelector('#event-label') as HTMLElement;
      const eventPush = prContainer.querySelector('#event-force-push') as HTMLElement;
      const eventClose = prContainer.querySelector('#event-close') as HTMLElement;
      const eventReopen = prContainer.querySelector('#event-reopen') as HTMLElement;
      const comment1 = prContainer.querySelector('#issuecomment-1') as HTMLElement;
      const comment2 = prContainer.querySelector('#issuecomment-2') as HTMLElement;

      // Regular non-comment events must be hidden
      expect(eventLabel.classList.contains('octodeck-gh-hidden-event')).toBe(true);
      expect(eventPush.classList.contains('octodeck-gh-hidden-event')).toBe(true);

      // Comments must remain in their dense/visible representations
      expect(comment1.classList.contains('octodeck-gh-hidden-event')).toBe(false);
      expect(comment2.classList.contains('octodeck-gh-hidden-event')).toBe(false);

      // Close and reopen events MUST remain visible
      expect(eventClose.classList.contains('octodeck-gh-hidden-event')).toBe(false);
      expect(eventReopen.classList.contains('octodeck-gh-hidden-event')).toBe(false);

      // Restore
      collapser.setHideNonCommentEvents(false);
      expect(eventLabel.classList.contains('octodeck-gh-hidden-event')).toBe(false);
      expect(eventPush.classList.contains('octodeck-gh-hidden-event')).toBe(false);
      expect(eventClose.classList.contains('octodeck-gh-hidden-event')).toBe(false);
      expect(eventReopen.classList.contains('octodeck-gh-hidden-event')).toBe(false);
    });

    it('preserves user expanded state across run() invocations', () => {
      const prContainer = document.createElement('div');
      prContainer.innerHTML = `
        <div class="TimelineItem" id="issuecomment-1">
          <div class="TimelineItem-avatar"><img alt="@k8s-ci-robot" /></div>
          <div class="comment-body"><p>/lgtm\n/approve\n/assign @developer</p></div>
        </div>
      `;

      const collapser = new NoiseCollapser(prContainer);
      collapser.run();

      const expandBtn = prContainer.querySelector('.octodeck-gh-dense-expand-btn') as HTMLButtonElement;
      expect(expandBtn).not.toBeNull();
      expect(expandBtn.textContent).toBe('[+]');

      // User expands the comment
      expandBtn.click();
      expect(expandBtn.textContent).toBe('[-]');
      const restEl = prContainer.querySelector('.octodeck-gh-dense-rest') as HTMLElement;
      expect(restEl.style.display).toBe('block');

      // Rerun collapser (e.g. dynamic load or update)
      collapser.run();

      // Should still be expanded!
      const newExpandBtn = prContainer.querySelector('.octodeck-gh-dense-expand-btn') as HTMLButtonElement;
      expect(newExpandBtn.textContent).toBe('[-]');
      const newRestEl = prContainer.querySelector('.octodeck-gh-dense-rest') as HTMLElement;
      expect(newRestEl.style.display).toBe('block');
    });

    it('never hides review events when hideNonCommentEvents is true because they serve as review headers', () => {
      const prContainer = document.createElement('div');
      prContainer.innerHTML = `
        <div class="TimelineItem" id="event-label">
          <div class="TimelineItem-badge"><svg class="octicon octicon-tag"></svg></div>
          <div class="TimelineItem-body">added a label</div>
        </div>
        <div class="TimelineItem js-review" id="pullrequestreview-4741544059">
          <div class="TimelineItem-badge"><svg class="octicon octicon-check"></svg></div>
          <div class="TimelineItem-body">
            <a class="author" href="https://github.com/tallclair">tallclair</a>
            reviewed
            <a href="https://github.com/kubernetes/kubernetes/pull/140704#pullrequestreview-4741544059">last month</a>
          </div>
        </div>
        <div class="review-comment" id="diffcomment-123">
          <div class="comment-body"><p>Looks good to me</p></div>
        </div>
      `;

      const collapser = new NoiseCollapser(prContainer);
      collapser.setHideNonCommentEvents(true);

      const eventLabel = prContainer.querySelector('#event-label') as HTMLElement;
      const reviewHeader = prContainer.querySelector('#pullrequestreview-4741544059') as HTMLElement;
      const reviewComment = prContainer.querySelector('#diffcomment-123') as HTMLElement;

      // Label event must be hidden
      expect(eventLabel.classList.contains('octodeck-gh-hidden-event')).toBe(true);

      // Review header event MUST NOT be hidden
      expect(reviewHeader.classList.contains('octodeck-gh-hidden-event')).toBe(false);

      // Review comment must remain visible
      expect(reviewComment.classList.contains('octodeck-gh-hidden-event')).toBe(false);
    });

    it('never hides mention or cross-reference events when hideNonCommentEvents is true', () => {
      const prContainer = document.createElement('div');
      prContainer.innerHTML = `
        <div class="TimelineItem" id="event-label">
          <div class="TimelineItem-badge"><svg class="octicon octicon-tag"></svg></div>
          <div class="TimelineItem-body">added kind/bug label</div>
        </div>
        <div class="TimelineItem" id="event-1422795341">
          <div class="TimelineItem-badge">
            <svg class="octicon octicon-bookmark"></svg>
          </div>
          <div class="TimelineItem-body">
            <a class="author" href="/bouaouda-achraf">bouaouda-achraf</a>
            mentioned this
            <a href="#event-1422795341">on Sep 2, 2024</a>
            <a href="/kubernetes/kubernetes/pull/127071">e2e: refactor FilterNonRestartablePods function #127071</a>
          </div>
        </div>
        <div class="TimelineItem" id="issuecomment-1">
          <div class="comment-body"><p>Discussion comment</p></div>
        </div>
      `;

      const collapser = new NoiseCollapser(prContainer);
      collapser.setHideNonCommentEvents(true);

      const eventLabel = prContainer.querySelector('#event-label') as HTMLElement;
      const mentionEvent = prContainer.querySelector('#event-1422795341') as HTMLElement;
      const comment1 = prContainer.querySelector('#issuecomment-1') as HTMLElement;

      // Label event must be hidden
      expect(eventLabel.classList.contains('octodeck-gh-hidden-event')).toBe(true);

      // Mention event MUST NOT be hidden
      expect(mentionEvent.classList.contains('octodeck-gh-hidden-event')).toBe(false);

      // Comment must remain visible
      expect(comment1.classList.contains('octodeck-gh-hidden-event')).toBe(false);
    });

    it('does not group comments together when events are shown between them, and never puts events into dense boxes', () => {
      const prContainer = document.createElement('div');
      prContainer.innerHTML = `
        <!-- Noise comment 1 -->
        <div class="TimelineItem" id="issuecomment-1">
          <span class="author">k8s-ci-robot[bot]</span>
          <div class="comment-body"><p>/lgtm</p></div>
        </div>
        <!-- Non-comment event between comments (e.g. prow bot label event) -->
        <div class="TimelineItem" id="event-label-bot">
          <span class="author">k8s-ci-robot[bot]</span>
          <div class="TimelineItem-badge"><svg class="octicon octicon-tag"></svg></div>
          <div class="TimelineItem-body">added lgtm label</div>
        </div>
        <!-- Noise comment 2 -->
        <div class="TimelineItem" id="issuecomment-2">
          <span class="author">k8s-ci-robot[bot]</span>
          <div class="comment-body"><p>/approve</p></div>
        </div>
        <!-- Contiguous noise comment 3 (no event between comment 2 and comment 3) -->
        <div class="TimelineItem" id="issuecomment-3">
          <span class="author">codecov[bot]</span>
          <div class="comment-body"><p>Coverage 85%</p></div>
        </div>
      `;

      const collapser = new NoiseCollapser(prContainer);
      collapser.setHideNonCommentEvents(false); // Events are shown

      const boxes = prContainer.querySelectorAll('.octodeck-gh-dense-box');
      // Because event-label-bot is between comment 1 and comment 2, they must NOT be grouped together!
      // Box 1 should have comment 1 only.
      // Box 2 should have comment 2 and comment 3 grouped together.
      expect(boxes.length).toBe(2);

      const box1Rows = boxes[0].querySelectorAll('.octodeck-gh-dense-row');
      expect(box1Rows.length).toBe(1);
      expect(box1Rows[0].querySelector('.octodeck-gh-dense-text')?.textContent).toBe('/lgtm');

      const box2Rows = boxes[1].querySelectorAll('.octodeck-gh-dense-row');
      expect(box2Rows.length).toBe(2);
      expect(box2Rows[0].querySelector('.octodeck-gh-dense-text')?.textContent).toBe('/approve');
      expect(box2Rows[1].querySelector('.octodeck-gh-dense-text')?.textContent).toBe('Coverage 85%');

      // The non-comment event must NOT be collapsed or hidden, and must NOT be inside any dense box
      const labelEvent = prContainer.querySelector('#event-label-bot') as HTMLElement;
      expect(labelEvent.classList.contains('octodeck-gh-collapsed-comment')).toBe(false);
      expect(labelEvent.classList.contains('octodeck-gh-hidden-event')).toBe(false);
      expect(labelEvent.closest('.octodeck-gh-dense-box')).toBeNull();
    });

    it('groups all adjacent comments together when events between them are hidden', () => {
      const prContainer = document.createElement('div');
      prContainer.innerHTML = `
        <!-- Noise comment 1 -->
        <div class="TimelineItem" id="issuecomment-1">
          <span class="author">k8s-ci-robot[bot]</span>
          <div class="comment-body"><p>/lgtm</p></div>
        </div>
        <!-- Non-comment event between comments -->
        <div class="TimelineItem" id="event-label-bot">
          <span class="author">k8s-ci-robot[bot]</span>
          <div class="TimelineItem-badge"><svg class="octicon octicon-tag"></svg></div>
          <div class="TimelineItem-body">added lgtm label</div>
        </div>
        <!-- Another non-comment event between comments -->
        <div class="TimelineItem" id="event-milestone">
          <div class="TimelineItem-body">changed milestone</div>
        </div>
        <!-- Noise comment 2 -->
        <div class="TimelineItem" id="issuecomment-2">
          <span class="author">k8s-ci-robot[bot]</span>
          <div class="comment-body"><p>/approve</p></div>
        </div>
      `;

      const collapser = new NoiseCollapser(prContainer);
      collapser.setHideNonCommentEvents(true); // Events are hidden

      const boxes = prContainer.querySelectorAll('.octodeck-gh-dense-box');
      // When events are hidden, all adjacent comments (comment 1 and comment 2) MUST be grouped into 1 box!
      expect(boxes.length).toBe(1);

      const boxRows = boxes[0].querySelectorAll('.octodeck-gh-dense-row');
      expect(boxRows.length).toBe(2);
      expect(boxRows[0].querySelector('.octodeck-gh-dense-text')?.textContent).toBe('/lgtm');
      expect(boxRows[1].querySelector('.octodeck-gh-dense-text')?.textContent).toBe('/approve');

      // The intervening events must be hidden with octodeck-gh-hidden-event
      const labelEvent = prContainer.querySelector('#event-label-bot') as HTMLElement;
      const milestoneEvent = prContainer.querySelector('#event-milestone') as HTMLElement;
      expect(labelEvent.classList.contains('octodeck-gh-hidden-event')).toBe(true);
      expect(milestoneEvent.classList.contains('octodeck-gh-hidden-event')).toBe(true);
    });

    it('does not group comments across visible review events even when hideNonCommentEvents is true', () => {
      const prContainer = document.createElement('div');
      prContainer.innerHTML = `
        <!-- Noise comment 1 -->
        <div class="TimelineItem" id="issuecomment-1">
          <span class="author">k8s-ci-robot[bot]</span>
          <div class="comment-body"><p>/lgtm</p></div>
        </div>
        <!-- Visible review event header -->
        <div class="TimelineItem js-review" id="pullrequestreview-1">
          <div class="TimelineItem-body">
            <a class="author" href="https://github.com/tallclair">tallclair</a>
            reviewed
            <a href="#pullrequestreview-1">last month</a>
          </div>
        </div>
        <!-- Noise comment 2 -->
        <div class="TimelineItem" id="issuecomment-2">
          <span class="author">k8s-ci-robot[bot]</span>
          <div class="comment-body"><p>/approve</p></div>
        </div>
      `;

      const collapser = new NoiseCollapser(prContainer);
      collapser.setHideNonCommentEvents(true);

      const boxes = prContainer.querySelectorAll('.octodeck-gh-dense-box');
      // Because review event is visible between comment 1 and comment 2, they should be in separate boxes
      expect(boxes.length).toBe(2);

      const reviewHeader = prContainer.querySelector('#pullrequestreview-1') as HTMLElement;
      expect(reviewHeader.classList.contains('octodeck-gh-hidden-event')).toBe(false);
    });

    it('collapses kubernetes-prow APPROVALNOTIFIER comments that mention "reviewed" inside comment body', () => {
      const prContainer = document.createElement('div');
      prContainer.innerHTML = `
        <div class="TimelineItem" id="item-wrap-1">
          <div class="TimelineItem-avatar">
            <img class="avatar" alt="@kubernetes-prow" src="avatar.png">
          </div>
          <div class="TimelineItem-body">
            <div id="issuecomment-5256561389" class="timeline-comment-group">
              <div class="timeline-comment-header">
                <a class="author" href="https://github.com/apps/kubernetes-prow">kubernetes-prow</a>
                <span class="Label Label--secondary">Bot</span>
              </div>
              <div class="comment-body markdown-body">
                <p>[APPROVALNOTIFIER] This PR is <strong>NOT APPROVED</strong></p>
                <p>This pull-request has been approved by: troychiu</p>
                <p>Once this PR has been reviewed and has the lgtm label, please assign thockin for approval.</p>
              </div>
            </div>
          </div>
        </div>
      `;

      const commentEl = prContainer.querySelector('#item-wrap-1') as HTMLElement;
      expect(isReviewEvent(commentEl)).toBe(false);

      const info = extractTimelineItemInfo(commentEl);
      expect(info.isComment).toBe(true);
      expect(info.isBot).toBe(true);
      expect(info.isNoise).toBe(true);

      const collapser = new NoiseCollapser(prContainer);
      collapser.run();

      const boxes = prContainer.querySelectorAll('.octodeck-gh-dense-box');
      expect(boxes.length).toBe(1);

      const rows = boxes[0].querySelectorAll('.octodeck-gh-dense-row');
      expect(rows.length).toBe(1);
      expect(rows[0].querySelector('.octodeck-gh-dense-author')?.textContent).toBe('@kubernetes-prow');
      expect(rows[0].querySelector('.octodeck-gh-dense-text')?.textContent).toContain('[APPROVALNOTIFIER]');
    });

    it('triggers onBotDiscovered when encountering an unknown bot on the page', () => {
      const prContainer = document.createElement('div');
      prContainer.innerHTML = `
        <div class="TimelineItem" id="issuecomment-1">
          <div class="timeline-comment-header">
            <a class="author" href="https://github.com/apps/some-new-bot">some-new-bot</a>
            <span class="Label Label--secondary">Bot</span>
          </div>
          <div class="comment-body"><p>Automated test report</p></div>
        </div>
      `;

      const discovered: string[] = [];
      const collapser = new NoiseCollapser(prContainer, ['existing-bot'], (login) => {
        discovered.push(login);
      });
      collapser.run();

      expect(discovered).toEqual(['some-new-bot']);
    });

    it('updates collapsing dynamically when setKnownBots is called', () => {
      const prContainer = document.createElement('div');
      prContainer.innerHTML = `
        <div class="TimelineItem" id="issuecomment-1">
          <div class="timeline-comment-header">
            <span class="author">my-custom-ci</span>
          </div>
          <div class="comment-body"><p>Test results passed</p></div>
        </div>
      `;

      const collapser = new NoiseCollapser(prContainer, []);
      collapser.run();

      // Initially not collapsed because my-custom-ci is not in knownBots and has no bot suffix/badge
      expect(prContainer.querySelectorAll('.octodeck-gh-dense-box').length).toBe(0);

      // Dynamically add to known bots
      collapser.setKnownBots(['my-custom-ci']);

      // Now it should be collapsed
      expect(prContainer.querySelectorAll('.octodeck-gh-dense-box').length).toBe(1);
    });
  });
});
