/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { SidebarSection, isItemAcked } from '../content/sidebarSection';
import { ItemStatus } from '../../api/octodeck/v1/resources_pb';

describe('SidebarSection', () => {
  let container: HTMLElement;
  let mockSendMessage: any;

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '';
    container = document.createElement('div');
    container.innerHTML = `
      <div id="partial-discussion-sidebar">
        <div class="discussion-sidebar-item">Reviewers section</div>
        <div class="discussion-sidebar-item">Assignees section</div>
      </div>
      <div id="partial-new-comment-form-actions" class="form-actions">
        <div class="BtnGroup">
          <button type="submit" class="btn btn-primary">Comment</button>
        </div>
      </div>
    `;
    document.body.appendChild(container);

    mockSendMessage = vi.fn((msg, callback) => {
      if (msg.type === 'GET_ITEM') {
        callback({
          ok: true,
          data: {
            id: 'kubernetes/kubernetes#12345',
            local: {
              computedStatus: ItemStatus.NEW_ACTIVITY,
              starred: true,
              privateNotes: 'Review PR thoroughly',
            },
          },
        });
      } else if (msg.type === 'STAR_ITEM') {
        callback({
          ok: true,
          data: {
            id: 'kubernetes/kubernetes#12345',
            local: {
              computedStatus: ItemStatus.NEW_ACTIVITY,
              starred: msg.starred,
              privateNotes: 'Review PR thoroughly',
            },
          },
        });
      } else if (msg.type === 'ACK_ITEM') {
        callback({
          ok: true,
          data: {
            id: 'kubernetes/kubernetes#12345',
            local: {
              computedStatus: msg.acked ? ItemStatus.ACKED : ItemStatus.UNSPECIFIED,
              starred: true,
              privateNotes: 'Review PR thoroughly',
            },
          },
        });
      } else if (msg.type === 'SET_NOTES') {
        callback({
          ok: true,
          data: {
            id: 'kubernetes/kubernetes#12345',
            local: {
              computedStatus: ItemStatus.NEW_ACTIVITY,
              starred: true,
              privateNotes: msg.notes,
            },
          },
        });
      }
    });

    globalThis.chrome = {
      runtime: {
        sendMessage: mockSendMessage,
        lastError: null,
      },
    } as any;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('isItemAcked', () => {
    it('recognizes numeric ACKED enum status', () => {
      expect(isItemAcked({ local: { computedStatus: ItemStatus.ACKED } } as any)).toBe(true);
      expect(isItemAcked({ local: { computedStatus: 5 } } as any)).toBe(true);
    });

    it('recognizes string enum status from Connect-RPC JSON', () => {
      expect(isItemAcked({ local: { computedStatus: 'ITEM_STATUS_ACKED' } } as any)).toBe(true);
      expect(isItemAcked({ local: { computedStatus: 'ACKED' } } as any)).toBe(true);
      expect(isItemAcked({ local: { computedStatus: 'ITEM_STATUS_NEW' } } as any)).toBe(false);
    });

    it('recognizes ISO string timestamps from Connect-RPC JSON', () => {
      expect(isItemAcked({ local: { ackedAt: '2026-08-12T17:40:00Z' } } as any)).toBe(true);
      expect(isItemAcked({ local: { ackedAt: '' } } as any)).toBe(false);
    });

    it('recognizes protobuf Timestamp objects', () => {
      expect(isItemAcked({ local: { ackedAt: { seconds: 1770800000n, nanos: 0 } } } as any)).toBe(true);
      expect(isItemAcked({ local: { ackedAt: { seconds: 0n, nanos: 0 } } } as any)).toBe(false);
    });
  });

  it('injects at the top of the sidebar with header button, star button, and Tracked badge', async () => {
    const sidebarSection = new SidebarSection('kubernetes/kubernetes#12345');
    await sidebarSection.init(container);

    const section = container.querySelector('.octodeck-gh-sidebar-section') as HTMLElement;
    expect(section).not.toBeNull();
    expect(section.textContent).toContain('Octodeck');
    expect(section.textContent).toContain('Tracked');
    expect(section.nextElementSibling?.id).toBe('partial-discussion-sidebar');

    const jumpBtn = container.querySelector('.octodeck-gh-jump-btn') as HTMLElement;
    expect(jumpBtn).not.toBeNull();
    expect(jumpBtn.textContent).toContain('Octodeck');
    jumpBtn.click();
    expect(mockSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'OPEN_DASHBOARD', itemId: 'kubernetes/kubernetes#12345' })
    );

    const starBtn = container.querySelector('.octodeck-gh-star-btn') as HTMLButtonElement;
    expect(starBtn).not.toBeNull();
    expect(starBtn.classList.contains('octodeck-gh-star-active')).toBe(true);

    const badge = container.querySelector('.octodeck-gh-badge') as HTMLElement;
    expect(starBtn.nextElementSibling).toBe(badge);

    // Click star to toggle
    starBtn.click();
    expect(mockSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'STAR_ITEM', itemId: 'kubernetes/kubernetes#12345', starred: false }),
      expect.any(Function)
    );

    sidebarSection.destroy();
  });

  it('supports GitHub React issue sidebar and comment composer layouts', async () => {
    container.innerHTML = `
      <div data-testid="issue-viewer-metadata-container">
        <div data-testid="sticky-sidebar">
          <div class="IssueSidebar-module__sidebarContent__HKaGK">
            <div data-testid="sidebar-assignees-section">Assignees content</div>
            <div data-testid="sidebar-labels-section">Labels content</div>
          </div>
        </div>
      </div>
      <div class="IssueCommentComposer-module__container__ABC">
        <div class="Footer-module__childrenStyling__XjmP5">
          <div data-component="ButtonGroup">
            <div><button type="button">Close issue</button></div>
          </div>
          <span role="tooltip" data-testid="save-button-tooltip">
            <button data-component="Button" type="button" data-variant="primary">
              <span>Comment</span>
            </button>
          </span>
        </div>
      </div>
    `;

    const sidebarSection = new SidebarSection('kubernetes/kubernetes#97076');
    await sidebarSection.init(container);

    // Sidebar injected at top of sidebarContent before assignees
    const section = container.querySelector('.octodeck-gh-sidebar-section') as HTMLElement;
    expect(section).not.toBeNull();
    const assigneesSection = container.querySelector('[data-testid="sidebar-assignees-section"]') as HTMLElement;
    expect(section.nextElementSibling).toBe(assigneesSection);

    // Comment Ack button injected before comment button tooltip
    const ackBtn = container.querySelector('.octodeck-gh-comment-ack-btn') as HTMLButtonElement;
    expect(ackBtn).not.toBeNull();
    const tooltip = container.querySelector('[data-testid="save-button-tooltip"]') as HTMLElement;
    expect(ackBtn.nextElementSibling).toBe(tooltip);

    sidebarSection.destroy();
  });

  it('renders comment ack button before comment button group and toggles acked status with JSON responses', async () => {
    // Simulate Connect-RPC JSON responses
    mockSendMessage.mockImplementation((msg: any, callback: any) => {
      if (msg.type === 'GET_ITEM') {
        callback({
          ok: true,
          data: {
            id: 'kubernetes/kubernetes#12345',
            local: {
              computedStatus: 'ITEM_STATUS_NEW_ACTIVITY',
              starred: true,
              privateNotes: 'Review PR thoroughly',
            },
          },
        });
      } else if (msg.type === 'ACK_ITEM') {
        callback({
          ok: true,
          data: {
            id: 'kubernetes/kubernetes#12345',
            local: {
              computedStatus: msg.acked ? 'ITEM_STATUS_ACKED' : 'ITEM_STATUS_IDLE',
              ackedAt: msg.acked ? '2026-08-12T17:40:00Z' : undefined,
              starred: true,
              privateNotes: 'Review PR thoroughly',
            },
          },
        });
      }
    });

    const sidebarSection = new SidebarSection('kubernetes/kubernetes#12345');
    await sidebarSection.init(container);

    const ackBtn = container.querySelector('.octodeck-gh-comment-ack-btn') as HTMLButtonElement;
    expect(ackBtn).not.toBeNull();
    expect(ackBtn.textContent).toContain('Ack');
    expect(ackBtn.classList.contains('octodeck-gh-btn-acked')).toBe(false);

    const btnGroup = container.querySelector('.BtnGroup') as HTMLElement;
    expect(ackBtn.nextElementSibling).toBe(btnGroup);

    // Click Ack -> should toggle and remain Acked with Connect-RPC JSON response
    ackBtn.click();
    expect(mockSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'ACK_ITEM', itemId: 'kubernetes/kubernetes#12345', acked: true }),
      expect.any(Function)
    );
    expect(ackBtn.textContent).toContain('Acked');
    expect(ackBtn.classList.contains('octodeck-gh-btn-acked')).toBe(true);

    sidebarSection.destroy();
  });

  it('renders existing private notes in a styled box and supports editing and saving with updated placeholder', async () => {
    const sidebarSection = new SidebarSection('kubernetes/kubernetes#12345');
    await sidebarSection.init(container);

    const notesBox = container.querySelector('.octodeck-gh-notes-box') as HTMLElement;
    expect(notesBox).not.toBeNull();
    expect(notesBox.textContent).toContain('Private Notes');
    expect(notesBox.textContent).toContain('Review PR thoroughly');

    const editBtn = container.querySelector('.octodeck-gh-notes-edit-btn') as HTMLElement;
    expect(editBtn).not.toBeNull();
    editBtn.click();

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    expect(textarea).not.toBeNull();
    expect(textarea.value).toBe('Review PR thoroughly');
    expect(textarea.placeholder).toBe('Private notes are only visible to you.');

    // Update text and save
    textarea.value = 'Updated maintainer notes';
    textarea.dispatchEvent(new Event('input'));

    const saveBtn = container.querySelector('.octodeck-gh-notes-save-btn') as HTMLElement;
    saveBtn.click();

    expect(mockSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'SET_NOTES', notes: 'Updated maintainer notes' }),
      expect.any(Function)
    );
    expect(container.textContent).toContain('Updated maintainer notes');

    sidebarSection.destroy();
  });

  it('hides Private Notes header when there are no notes, showing only the add button', async () => {
    mockSendMessage.mockImplementation((msg: any, callback: any) => {
      if (msg.type === 'GET_ITEM') {
        callback({
          ok: true,
          data: {
            id: 'kubernetes/kubernetes#12345',
            local: {
              computedStatus: ItemStatus.UNSPECIFIED,
              starred: false,
              privateNotes: '',
            },
          },
        });
      }
    });

    const sidebarSection = new SidebarSection('kubernetes/kubernetes#12345');
    await sidebarSection.init(container);

    expect(container.querySelector('.octodeck-gh-notes-box')).toBeNull();
    expect(container.querySelector('.octodeck-gh-notes-header')).toBeNull();
    const addBtn = container.querySelector('.octodeck-gh-notes-add-btn') as HTMLElement;
    expect(addBtn).not.toBeNull();
    expect(addBtn.textContent).toContain('Add Private Note');

    sidebarSection.destroy();
  });

  it('renders Untracked badge with tooltip when item is in DB but viewerSubscription is UNSUBSCRIBED', async () => {
    mockSendMessage.mockImplementation((msg: any, callback: any) => {
      if (msg.type === 'GET_ITEM') {
        callback({
          ok: true,
          data: {
            id: 'MDU6SXNzdWUyOTE3NzYyNDQ=',
            viewerSubscription: 2, // SubscriptionState.UNSUBSCRIBED
            local: {
              computedStatus: ItemStatus.UNSPECIFIED,
            },
          },
        });
      }
    });

    const sidebarSection = new SidebarSection('MDU6SXNzdWUyOTE3NzYyNDQ=');
    await sidebarSection.init(container);

    const badge = container.querySelector('.octodeck-gh-badge') as HTMLElement;
    expect(badge.textContent).toBe('Untracked');
    expect(badge.classList.contains('octodeck-gh-badge-untracked')).toBe(true);
    expect(badge.title).toContain('Not subscribed on GitHub');

    sidebarSection.destroy();
  });

  it('renders Untracked badge and keeps controls enabled when item is not found in DB', async () => {
    mockSendMessage.mockImplementation((msg: any, callback: any) => {
      if (msg.type === 'GET_ITEM') {
        callback({
          ok: false,
          error: 'item not found: sql: no rows in result set',
        });
      } else if (msg.type === 'STAR_ITEM') {
        callback({
          ok: true,
          data: {
            id: 'untracked/repo#42',
            local: {
              starred: msg.starred,
            },
          },
        });
      }
    });

    const sidebarSection = new SidebarSection('untracked/repo#42');
    await sidebarSection.init(container);

    const badge = container.querySelector('.octodeck-gh-badge') as HTMLElement;
    expect(badge.textContent).toBe('Untracked');
    expect(badge.classList.contains('octodeck-gh-badge-untracked')).toBe(true);
    expect(badge.title).toBe('This item is not tracked in your local OctoDeck database.');

    const starBtn = container.querySelector('.octodeck-gh-star-btn') as HTMLButtonElement;
    expect(starBtn.disabled).toBe(false);

    const notesAddBtn = container.querySelector('.octodeck-gh-notes-add-btn') as HTMLButtonElement;
    expect(notesAddBtn.disabled).toBe(false);

    const ackBtn = container.querySelector('.octodeck-gh-comment-ack-btn') as HTMLButtonElement;
    expect(ackBtn.disabled).toBe(false);

    // Star interaction works on untracked item
    starBtn.click();
    expect(mockSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'STAR_ITEM', itemId: 'untracked/repo#42', starred: true }),
      expect.any(Function)
    );

    sidebarSection.destroy();
  });

  it('renders Tracked badge when item has viewerSubscription SUBSCRIBED', async () => {
    mockSendMessage.mockImplementation((msg: any, callback: any) => {
      if (msg.type === 'GET_ITEM') {
        callback({
          ok: true,
          data: {
            id: 'kubernetes/kubernetes#12345',
            viewerSubscription: 1, // SubscriptionState.SUBSCRIBED
            local: {
              computedStatus: ItemStatus.NEW,
            },
          },
        });
      }
    });

    const sidebarSection = new SidebarSection('kubernetes/kubernetes#12345');
    await sidebarSection.init(container);

    const badge = container.querySelector('.octodeck-gh-badge') as HTMLElement;
    expect(badge.textContent).toBe('Tracked');
    expect(badge.classList.contains('octodeck-gh-badge-tracked')).toBe(true);
    expect(badge.title).toBe('Tracked in OctoDeck');

    sidebarSection.destroy();
  });

  it('renders "Hide events" toggle without border line and with unbolded label, invoking callback on change', async () => {
    const onToggle = vi.fn();
    const sidebarSection = new SidebarSection('kubernetes/kubernetes#12345', false, onToggle);
    await sidebarSection.init(container);

    const toggle = container.querySelector('#octodeck-hide-events-toggle') as HTMLInputElement;
    expect(toggle).not.toBeNull();
    expect(toggle.checked).toBe(false);
    expect(container.querySelector('.octodeck-gh-filter-label')?.textContent).toContain('Hide events');

    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));

    expect(onToggle).toHaveBeenCalledWith(true);

    sidebarSection.destroy();
  });

  it('applies exponential backoff on retries and suppresses onItemUpdated callback on retry failures', async () => {
    let callCount = 0;
    let isDaemonOnline = false;
    const onItemUpdated = vi.fn();

    mockSendMessage.mockImplementation((msg: any, callback: any) => {
      if (msg.type === 'GET_ITEM') {
        callCount++;
        if (!isDaemonOnline) {
          callback({
            ok: false,
            error: 'Failed to fetch daemon',
          });
        } else {
          callback({
            ok: true,
            data: {
              id: 'kubernetes/kubernetes#12345',
              local: {
                computedStatus: ItemStatus.ACKED,
                starred: true,
                privateNotes: 'Reconnected note',
              },
            },
          });
        }
      }
    });

    const sidebarSection = new SidebarSection(
      'kubernetes/kubernetes#12345',
      false,
      undefined,
      onItemUpdated
    );
    await sidebarSection.init(container);

    // Initial fetch failed
    expect(callCount).toBe(1);
    expect(onItemUpdated).not.toHaveBeenCalled();

    // 1st backoff attempt happens after 2000ms
    vi.advanceTimersByTime(1999);
    expect(callCount).toBe(1);
    vi.advanceTimersByTime(1);
    expect(callCount).toBe(2);
    expect(onItemUpdated).not.toHaveBeenCalled();

    // 2nd backoff attempt happens after 3000ms (2000 * 1.5)
    vi.advanceTimersByTime(2999);
    expect(callCount).toBe(2);
    vi.advanceTimersByTime(1);
    expect(callCount).toBe(3);
    expect(onItemUpdated).not.toHaveBeenCalled();

    // Daemon comes back online before 3rd attempt (3000 * 1.5 = 4500ms)
    isDaemonOnline = true;
    vi.advanceTimersByTime(4500);
    expect(callCount).toBe(4);
    expect(onItemUpdated).toHaveBeenCalledTimes(1);
    expect(onItemUpdated).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'kubernetes/kubernetes#12345' })
    );

    sidebarSection.destroy();
  });

  it('displays Error badge with tooltip when daemon returns an error response (e.g. 403 Forbidden)', async () => {
    mockSendMessage.mockImplementation((msg: any, callback: any) => {
      if (msg.type === 'GET_ITEM') {
        callback({
          ok: false,
          error: 'Daemon RPC GetItem failed (403): Forbidden',
        });
      }
    });

    const sidebarSection = new SidebarSection('kubernetes/kubernetes#12345');
    await sidebarSection.init(container);

    const badge = container.querySelector('.octodeck-gh-badge') as HTMLElement;
    expect(badge.textContent).toBe('Error');
    expect(badge.classList.contains('octodeck-gh-badge-error')).toBe(true);
    expect(badge.title).toContain('403');
    expect(badge.title).toContain('Forbidden');

    const starBtn = container.querySelector('.octodeck-gh-star-btn') as HTMLButtonElement;
    expect(starBtn.disabled).toBe(true);
    expect(starBtn.title).toContain('Forbidden');

    sidebarSection.destroy();
  });

  it('cleans up injected elements on destroy', async () => {
    const sidebarSection = new SidebarSection('kubernetes/kubernetes#12345');
    await sidebarSection.init(container);

    expect(container.querySelector('.octodeck-gh-sidebar-section')).not.toBeNull();
    expect(container.querySelector('.octodeck-gh-comment-ack-btn')).not.toBeNull();

    sidebarSection.destroy();

    expect(container.querySelector('.octodeck-gh-sidebar-section')).toBeNull();
    expect(container.querySelector('.octodeck-gh-comment-ack-btn')).toBeNull();
  });
});
