/* eslint-disable @typescript-eslint/no-explicit-any */
import { render, screen, fireEvent, act, waitFor, within } from '@testing-library/react';
import { Settings } from '../../Settings';
import { ThemeProvider } from '../../context/ThemeContext';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as connectQuery from '@connectrpc/connect-query';

const invalidateQueriesMock = vi.fn().mockResolvedValue(undefined);
const refetchQueriesMock = vi.fn().mockResolvedValue(undefined);

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({
    invalidateQueries: invalidateQueriesMock,
    refetchQueries: refetchQueriesMock,
  }),
}));

vi.mock('@connectrpc/connect-query', () => ({
  useQuery: vi.fn(),
  useMutation: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false })),
}));

const mockConfig = {
  pollingIntervalMin: 30,
  watchedRepos: ['kubernetes/kubernetes', 'kubernetes/enhancements'],
  pinnedRepos: ['kubernetes/community'],
  excludedRepos: ['kubernetes/test-infra'],
  knownBots: ['k8s-ci-robot', 'fejta-bot'],
  autoAckOwnActivity: true,
  includedLabels: ['size/*'],
  excludedLabels: ['kind/flake'],
};

describe('Settings Component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders settings modal with header, inputs, and action buttons', () => {
    vi.mocked(connectQuery.useQuery).mockReturnValue({
      data: { config: mockConfig },
      isLoading: false,
      isError: false,
      isFetching: false,
      refetch: vi.fn(),
    } as any);

    const onClose = vi.fn();
    const onOpenDebug = vi.fn();

    render(
      <Settings
        onClose={onClose}
        onOpenDebug={onOpenDebug}
        showItemIds={false}
      />
    );

    expect(screen.getByRole('heading', { name: /Settings/i })).toBeDefined();
    expect(screen.getByRole('radiogroup', { name: /Theme selection/i })).toBeDefined();
    expect(screen.getByRole('radio', { name: /System/i })).toBeDefined();
    expect(screen.getByRole('radio', { name: /Light/i })).toBeDefined();
    expect(screen.getByRole('radio', { name: /Dark/i })).toBeDefined();
    expect((screen.getByLabelText(/Repository Filters/i) as HTMLTextAreaElement).value).toBe(
      'kubernetes/kubernetes\nkubernetes/enhancements\n!kubernetes/test-infra'
    );
    expect((screen.getByLabelText(/Label Filters/i) as HTMLTextAreaElement).value).toBe(
      'size/*\n!kind/flake'
    );
    expect((screen.getByLabelText(/Pinned Repositories/i) as HTMLTextAreaElement).value).toBe(
      'kubernetes/community'
    );
    expect((screen.getByLabelText(/Known Bots/i) as HTMLTextAreaElement).value).toBe(
      'k8s-ci-robot\nfejta-bot'
    );
    expect((screen.getByLabelText(/Auto-Ack items when last action was by me/i) as HTMLInputElement).checked).toBe(true);

    // Advanced section is collapsed by default
    expect(screen.queryByLabelText(/Polling Interval/i)).toBeNull();
    const advancedBtn = screen.getByRole('button', { name: /Advanced/i });
    expect(advancedBtn).toBeDefined();
    fireEvent.click(advancedBtn);
    expect(screen.getByLabelText(/Polling Interval/i)).toBeDefined();
    expect((screen.getByLabelText(/Polling Interval/i) as HTMLInputElement).value).toBe('30');

    // Close and Save buttons exist
    expect(screen.getByRole('button', { name: /Close settings/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /^Cancel$/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /Save Settings/i })).toBeDefined();
  });

  it('switches themes when clicking Appearance radio buttons in Settings', () => {
    vi.mocked(connectQuery.useQuery).mockReturnValue({
      data: { config: mockConfig },
      isLoading: false,
      isError: false,
      isFetching: false,
      refetch: vi.fn(),
    } as any);

    render(
      <ThemeProvider>
        <Settings />
      </ThemeProvider>
    );

    const lightRadio = screen.getByRole('radio', { name: /Light/i });
    fireEvent.click(lightRadio);
    expect(lightRadio.getAttribute('aria-checked')).toBe('true');

    const darkRadio = screen.getByRole('radio', { name: /Dark/i });
    fireEvent.click(darkRadio);
    expect(darkRadio.getAttribute('aria-checked')).toBe('true');

    const systemRadio = screen.getByRole('radio', { name: /System/i });
    fireEvent.click(systemRadio);
    expect(systemRadio.getAttribute('aria-checked')).toBe('true');
  });

  it('calls onClose when close button in header or cancel in footer is clicked', () => {
    vi.mocked(connectQuery.useQuery).mockReturnValue({
      data: { config: mockConfig },
      isLoading: false,
      isError: false,
      isFetching: false,
      refetch: vi.fn(),
    } as any);

    const onClose = vi.fn();
    render(<Settings onClose={onClose} />);

    // Header close button
    const headerCloseBtn = screen.getByRole('button', { name: /Close settings/i });
    fireEvent.click(headerCloseBtn);
    expect(onClose).toHaveBeenCalledTimes(1);

    // Footer cancel button
    const footerCancelBtn = screen.getByRole('button', { name: /^Cancel$/i });
    fireEvent.click(footerCancelBtn);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('calls updateConfig mutation, invalidates queries, invokes onSave, and closes modal when saving', async () => {
    const updateConfigMutate = vi.fn().mockResolvedValue({});
    const onClose = vi.fn();
    const onSave = vi.fn();

    vi.mocked(connectQuery.useMutation).mockReturnValue({
      mutateAsync: updateConfigMutate,
      isPending: false,
    } as any);

    vi.mocked(connectQuery.useQuery).mockReturnValue({
      data: { config: mockConfig },
      isLoading: false,
      isError: false,
      isFetching: false,
      refetch: vi.fn(),
    } as any);

    render(<Settings onClose={onClose} onSave={onSave} />);

    fireEvent.click(screen.getByRole('button', { name: /Advanced/i }));
    const intervalInput = screen.getByLabelText(/Polling Interval/i);
    fireEvent.change(intervalInput, { target: { value: '45' } });

    const repoPatternsInput = screen.getByLabelText(/Repository Filters/i);
    fireEvent.change(repoPatternsInput, { target: { value: 'golang/go\n!golang/proposal\nrust-lang/rust' } });

    const autoAckCheckbox = screen.getByLabelText(/Auto-Ack items when last action was by me/i);
    fireEvent.click(autoAckCheckbox);

    const saveButton = screen.getByRole('button', { name: /Save Settings/i });
    await act(async () => {
      fireEvent.click(saveButton);
    });

    expect(updateConfigMutate).toHaveBeenCalledWith({
      config: expect.objectContaining({
        pollingIntervalMin: 45,
        watchedRepos: ['golang/go', 'rust-lang/rust'],
        excludedRepos: ['golang/proposal'],
        autoAckOwnActivity: false,
      }),
    });
    expect(invalidateQueriesMock).toHaveBeenCalled();
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('handles save error properly and displays error alert without closing', async () => {
    const updateConfigMutate = vi.fn().mockRejectedValue(new Error('Network error'));
    const onClose = vi.fn();

    vi.mocked(connectQuery.useMutation).mockReturnValue({
      mutateAsync: updateConfigMutate,
      isPending: false,
    } as any);

    vi.mocked(connectQuery.useQuery).mockReturnValue({
      data: { config: mockConfig },
      isLoading: false,
      isError: false,
      isFetching: false,
      refetch: vi.fn(),
    } as any);

    render(<Settings onClose={onClose} />);

    const saveButton = screen.getByRole('button', { name: /Save Settings/i });
    await act(async () => {
      fireEvent.click(saveButton);
    });

    await waitFor(() => {
      expect(screen.getByText('Failed to save configuration.')).toBeDefined();
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('renders loading state with close button available', () => {
    vi.mocked(connectQuery.useQuery).mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
      isFetching: true,
      refetch: vi.fn(),
    } as any);

    const onClose = vi.fn();
    render(<Settings onClose={onClose} />);

    expect(screen.getByText('Loading daemon configuration...')).toBeDefined();
    const closeBtn = screen.getByRole('button', { name: /Close settings/i });
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders error state with retry and close button', () => {
    const refetchMock = vi.fn();
    vi.mocked(connectQuery.useQuery).mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      isFetching: false,
      refetch: refetchMock,
    } as any);

    const onClose = vi.fn();
    render(<Settings onClose={onClose} />);

    expect(screen.getByText('Failed to load configuration from daemon')).toBeDefined();
    const retryBtn = screen.getByRole('button', { name: /Retry/i });
    fireEvent.click(retryBtn);
    expect(refetchMock).toHaveBeenCalledTimes(1);

    const closeBtn = screen.getByRole('button', { name: /Close settings/i });
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('toggles debugMode and triggers onToggleDebugMode callback', () => {
    vi.mocked(connectQuery.useQuery).mockReturnValue({
      data: { config: mockConfig },
      isLoading: false,
      isError: false,
      isFetching: false,
      refetch: vi.fn(),
    } as any);

    const onToggleDebugMode = vi.fn();
    render(<Settings debugMode={false} onToggleDebugMode={onToggleDebugMode} />);

    // Expand Advanced section where Enable Debug Mode lives
    fireEvent.click(screen.getByRole('button', { name: /Advanced/i }));

    const debugModeCheckbox = screen.getByLabelText(/Enable Debug Mode/i);
    expect((debugModeCheckbox as HTMLInputElement).checked).toBe(false);

    fireEvent.click(debugModeCheckbox);
    expect(onToggleDebugMode).toHaveBeenCalledWith(true);
  });

  it('shows debug browser button outside the advanced section when onOpenDebug is provided', () => {
    vi.mocked(connectQuery.useQuery).mockReturnValue({
      data: { config: mockConfig },
      isLoading: false,
      isError: false,
      isFetching: false,
      refetch: vi.fn(),
    } as any);

    const onOpenDebug = vi.fn();
    render(<Settings debugMode={false} onOpenDebug={onOpenDebug} />);

    // Debug Data Browser is visible even while Advanced is collapsed
    expect(screen.getByText('Debug Data Browser')).toBeDefined();
    const openBrowserBtn = screen.getByRole('button', { name: /Open Browser/i });
    expect(openBrowserBtn).toBeDefined();

    // Advanced is collapsed
    expect(screen.queryByLabelText(/Polling Interval/i)).toBeNull();

    fireEvent.click(openBrowserBtn);
    expect(onOpenDebug).toHaveBeenCalledTimes(1);
  });

  it('renders Advanced section collapsed by default and toggles open/close on click', () => {
    vi.mocked(connectQuery.useQuery).mockReturnValue({
      data: { config: mockConfig },
      isLoading: false,
      isError: false,
      isFetching: false,
      refetch: vi.fn(),
    } as any);

    render(<Settings debugMode={true} onOpenDebug={vi.fn()} />);

    const advancedBtn = screen.getByRole('button', { name: /Advanced/i });
    expect(advancedBtn.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByLabelText(/Polling Interval/i)).toBeNull();
    expect(screen.queryByLabelText(/Enable Debug Mode/i)).toBeNull();

    // Expand
    fireEvent.click(advancedBtn);
    expect(advancedBtn.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByLabelText(/Polling Interval/i)).toBeDefined();
    expect(screen.getByLabelText(/Enable Debug Mode/i)).toBeDefined();

    // Collapse again
    fireEvent.click(advancedBtn);
    expect(advancedBtn.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByLabelText(/Polling Interval/i)).toBeNull();
    expect(screen.queryByLabelText(/Enable Debug Mode/i)).toBeNull();
  });

  it('auto-populates with default configuration when config has no values set', () => {
    vi.mocked(connectQuery.useQuery).mockReturnValue({
      data: { config: {} },
      isLoading: false,
      isError: false,
      isFetching: false,
      refetch: vi.fn(),
    } as any);

    render(<Settings />);

    fireEvent.click(screen.getByRole('button', { name: /Advanced/i }));
    expect((screen.getByLabelText(/Polling Interval/i) as HTMLInputElement).value).toBe('1');
    expect((screen.getByLabelText(/Auto-Ack items when last action was by me/i) as HTMLInputElement).checked).toBe(true);
    const botsText = (screen.getByLabelText(/Known Bots/i) as HTMLTextAreaElement).value;
    expect(botsText).toBe('');
  });

  it('shows confirmation prompt when clicking Restore defaults link and restores values upon confirmation', () => {
    vi.mocked(connectQuery.useQuery).mockReturnValue({
      data: { config: mockConfig },
      isLoading: false,
      isError: false,
      isFetching: false,
      refetch: vi.fn(),
    } as any);

    render(<Settings />);

    fireEvent.click(screen.getByRole('button', { name: /Advanced/i }));
    const intervalInput = screen.getByLabelText(/Polling Interval/i);
    expect((intervalInput as HTMLInputElement).value).toBe('30');

    const defaultsLink = screen.getByRole('button', { name: /Restore defaults/i });
    fireEvent.click(defaultsLink);

    // Warning prompt appears
    const dialog = screen.getByRole('alertdialog');
    expect(screen.getByText('Restore default settings?')).toBeDefined();
    expect((intervalInput as HTMLInputElement).value).toBe('30'); // Not yet changed

    // Cancel does not reset
    const cancelBtn = within(dialog).getByRole('button', { name: /^Cancel$/i });
    fireEvent.click(cancelBtn);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect((intervalInput as HTMLInputElement).value).toBe('30');

    // Click link again and confirm
    fireEvent.click(defaultsLink);
    const dialog2 = screen.getByRole('alertdialog');
    expect(screen.getByText('Restore default settings?')).toBeDefined();
    const confirmBtn = within(dialog2).getByRole('button', { name: /^Restore Defaults$/i });
    fireEvent.click(confirmBtn);

    expect((intervalInput as HTMLInputElement).value).toBe('1');
    const botsText = (screen.getByLabelText(/Known Bots/i) as HTMLTextAreaElement).value;
    expect(botsText).toContain('k8s-ci-robot');
    expect(botsText).toContain('fejta-bot');
    expect((screen.getByLabelText(/Repository Filters/i) as HTMLTextAreaElement).value).toBe('');
    expect((screen.getByLabelText(/Label Filters/i) as HTMLTextAreaElement).value).toBe('');
    expect(screen.getByText(/Default values restored/i)).toBeDefined();
  });

  it('shows discard confirmation prompt when closing with unsaved changes', () => {
    vi.mocked(connectQuery.useQuery).mockReturnValue({
      data: { config: mockConfig },
      isLoading: false,
      isError: false,
      isFetching: false,
      refetch: vi.fn(),
    } as any);

    const onClose = vi.fn();
    render(<Settings onClose={onClose} />);

    // Modify a field to make form dirty
    fireEvent.click(screen.getByRole('button', { name: /Advanced/i }));
    const intervalInput = screen.getByLabelText(/Polling Interval/i);
    fireEvent.change(intervalInput, { target: { value: '99' } });

    // Click close button
    const closeBtn = screen.getByRole('button', { name: /Close settings/i });
    fireEvent.click(closeBtn);

    // Prompt appears and onClose is not called yet
    const dialog = screen.getByRole('alertdialog');
    expect(screen.getByText('Discard unsaved changes?')).toBeDefined();
    expect(onClose).not.toHaveBeenCalled();

    // Click Keep Editing
    const keepEditingBtn = within(dialog).getByRole('button', { name: /Keep Editing/i });
    fireEvent.click(keepEditingBtn);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();

    // Click close again and confirm discard
    fireEvent.click(closeBtn);
    const dialog2 = screen.getByRole('alertdialog');
    expect(screen.getByText('Discard unsaved changes?')).toBeDefined();
    const discardBtn = within(dialog2).getByRole('button', { name: /Discard Changes/i });
    fireEvent.click(discardBtn);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('handles Escape key and backdrop click with discard warning when dirty', () => {
    vi.mocked(connectQuery.useQuery).mockReturnValue({
      data: { config: mockConfig },
      isLoading: false,
      isError: false,
      isFetching: false,
      refetch: vi.fn(),
    } as any);

    const onClose = vi.fn();
    const { container } = render(<Settings onClose={onClose} />);

    // Clean Escape closes immediately
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);

    // Modify a field to make form dirty
    fireEvent.click(screen.getByRole('button', { name: /Advanced/i }));
    const intervalInput = screen.getByLabelText(/Polling Interval/i);
    fireEvent.change(intervalInput, { target: { value: '99' } });

    // Dirty Escape triggers confirmation prompt
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByText('Discard unsaved changes?')).toBeDefined();
    expect(onClose).toHaveBeenCalledTimes(1);

    // Escape while confirmation is open dismisses the prompt
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('alertdialog')).toBeNull();

    // Click backdrop overlay while dirty
    const backdrop = container.firstElementChild as HTMLElement;
    fireEvent.click(backdrop);
    const dialog = screen.getByRole('alertdialog');
    expect(screen.getByText('Discard unsaved changes?')).toBeDefined();

    // Confirm discard
    const discardBtn = within(dialog).getByRole('button', { name: /Discard Changes/i });
    fireEvent.click(discardBtn);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('renders repo filter settings with single textarea supporting includes and excludes', () => {
    vi.mocked(connectQuery.useQuery).mockReturnValue({
      data: {
        config: {
          ...mockConfig,
          watchedRepos: ['kubernetes/*', 'kubernetes/website'],
          excludedRepos: ['kubernetes/steering'],
        },
      },
      isLoading: false,
      isError: false,
      isFetching: false,
      refetch: vi.fn(),
    } as any);

    render(<Settings />);

    const textarea = screen.getByLabelText(/Repository Filters/i) as HTMLTextAreaElement;
    expect(textarea.value).toBe('kubernetes/*\nkubernetes/website\n!kubernetes/steering');
  });

  it('validates repo patterns including ! prefixes before saving and prevents save if invalid', async () => {
    const updateConfigMock = vi.fn().mockResolvedValue({});
    vi.mocked(connectQuery.useMutation).mockReturnValue({
      mutateAsync: updateConfigMock,
      isPending: false,
    } as any);

    vi.mocked(connectQuery.useQuery).mockReturnValue({
      data: { config: mockConfig },
      isLoading: false,
      isError: false,
      isFetching: false,
      refetch: vi.fn(),
    } as any);

    render(<Settings />);

    const textarea = screen.getByLabelText(/Repository Filters/i);
    // Enter invalid repo pattern without slash
    fireEvent.change(textarea, { target: { value: 'invalid-repo-without-slash' } });

    const saveBtn = screen.getByRole('button', { name: /Save Settings/i });
    fireEvent.click(saveBtn);

    expect(updateConfigMock).not.toHaveBeenCalled();
    expect(screen.getAllByText(/must be in "owner\/repo" format/i).length).toBeGreaterThanOrEqual(1);
  });

  it('saves combined includes and excludes repo patterns properly', async () => {
    const updateConfigMock = vi.fn().mockResolvedValue({});
    vi.mocked(connectQuery.useMutation).mockReturnValue({
      mutateAsync: updateConfigMock,
      isPending: false,
    } as any);

    vi.mocked(connectQuery.useQuery).mockReturnValue({
      data: { config: mockConfig },
      isLoading: false,
      isError: false,
      isFetching: false,
      refetch: vi.fn(),
    } as any);

    render(<Settings />);

    const textarea = screen.getByLabelText(/Repository Filters/i);
    fireEvent.change(textarea, { target: { value: 'kubernetes/*\n!kubernetes/steering\ngolang/*' } });

    const saveBtn = screen.getByRole('button', { name: /Save Settings/i });
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(updateConfigMock).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            watchedRepos: ['kubernetes/*', 'golang/*'],
            excludedRepos: ['kubernetes/steering'],
          }),
        })
      );
    });
  });

  it('renders label filter settings with single textarea supporting includes and excludes', () => {
    vi.mocked(connectQuery.useQuery).mockReturnValue({
      data: {
        config: {
          ...mockConfig,
          includedLabels: ['size/*', 'sig/*'],
          excludedLabels: ['kind/flake'],
        },
      },
      isLoading: false,
      isError: false,
      isFetching: false,
      refetch: vi.fn(),
    } as any);

    render(<Settings />);

    const textarea = screen.getByLabelText(/Label Filters/i) as HTMLTextAreaElement;
    expect(textarea.value).toBe('size/*\nsig/*\n!kind/flake');
  });

  it('validates label patterns before saving and prevents save if invalid', async () => {
    const updateConfigMock = vi.fn().mockResolvedValue({});
    vi.mocked(connectQuery.useMutation).mockReturnValue({
      mutateAsync: updateConfigMock,
      isPending: false,
    } as any);

    vi.mocked(connectQuery.useQuery).mockReturnValue({
      data: { config: mockConfig },
      isLoading: false,
      isError: false,
      isFetching: false,
      refetch: vi.fn(),
    } as any);

    render(<Settings />);

    const textarea = screen.getByLabelText(/Label Filters/i);
    // Enter pattern that exceeds max length
    fireEvent.change(textarea, { target: { value: 'a'.repeat(200) } });

    const saveBtn = screen.getByRole('button', { name: /Save Settings/i });
    fireEvent.click(saveBtn);

    expect(updateConfigMock).not.toHaveBeenCalled();
    expect(screen.getAllByText(/exceeds maximum length/i).length).toBeGreaterThanOrEqual(1);
  });

  it('saves combined include and exclude label patterns properly', async () => {
    const updateConfigMock = vi.fn().mockResolvedValue({});
    vi.mocked(connectQuery.useMutation).mockReturnValue({
      mutateAsync: updateConfigMock,
      isPending: false,
    } as any);

    vi.mocked(connectQuery.useQuery).mockReturnValue({
      data: { config: mockConfig },
      isLoading: false,
      isError: false,
      isFetching: false,
      refetch: vi.fn(),
    } as any);

    render(<Settings />);

    const textarea = screen.getByLabelText(/Label Filters/i);
    fireEvent.change(textarea, { target: { value: 'size/*\nkind/bug\n!kind/flake' } });

    const saveBtn = screen.getByRole('button', { name: /Save Settings/i });
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(updateConfigMock).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            includedLabels: ['size/*', 'kind/bug'],
            excludedLabels: ['kind/flake'],
          }),
        })
      );
    });
  });
});
