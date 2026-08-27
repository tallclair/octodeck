import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { SyncStatusDisplay } from '../SyncStatusDisplay';
import type { SyncStatus } from '../../api/octodeck/v1/service_pb';

const createTimestamp = (seconds: bigint) => ({
  $typeName: 'google.protobuf.Timestamp' as const,
  seconds,
  nanos: 0,
});

describe('SyncStatusDisplay Component', () => {
  it('renders healthy synced status text', () => {
    const status: SyncStatus = {
      $typeName: 'octodeck.v1.SyncStatus',
      lastSuccessfulSyncAt: createTimestamp(BigInt(Math.floor((Date.now() - 120000) / 1000))),
      lastSyncAttemptAt: createTimestamp(BigInt(Math.floor((Date.now() - 120000) / 1000))),
      lastUpdateReceivedAt: createTimestamp(BigInt(Math.floor((Date.now() - 120000) / 1000))),
      lastSyncFailed: false,
      lastErrorMessage: '',
      failedAttemptsCount: 0,
      isSyncing: false,
      notificationRate24h: 0,
      notificationRate7d: 0,
      notificationRate30d: 0,
      lastSyncDurationMs: 0n,
    };

    render(<SyncStatusDisplay status={status} onManualSync={vi.fn()} />);

    expect(screen.getByText(/Synced 2 minutes ago/i)).toBeDefined();
  });

  it('renders red error status when sync fails', () => {
    const status: SyncStatus = {
      $typeName: 'octodeck.v1.SyncStatus',
      lastSuccessfulSyncAt: undefined,
      lastSyncAttemptAt: createTimestamp(BigInt(1700000000)),
      lastUpdateReceivedAt: undefined,
      lastSyncFailed: true,
      lastErrorMessage: 'GitHub API Rate limit exceeded',
      failedAttemptsCount: 3,
      isSyncing: false,
      notificationRate24h: 0,
      notificationRate7d: 0,
      notificationRate30d: 0,
      lastSyncDurationMs: 0n,
    };

    render(<SyncStatusDisplay status={status} onManualSync={vi.fn()} />);

    expect(screen.getByText('Sync Failed')).toBeDefined();

    // Hover over button to open hovercard
    const trigger = screen.getByRole('button', { name: 'Sync Status' });
    fireEvent.mouseEnter(trigger.parentElement!);

    expect(screen.getByText('GitHub API Rate limit exceeded')).toBeDefined();
    expect(screen.getByText('3')).toBeDefined();
  });

  it('renders syncing state and triggers manual sync', async () => {
    const onSync = vi.fn();
    render(<SyncStatusDisplay isSyncing={true} onManualSync={onSync} />);

    expect(screen.getByText('Syncing...')).toBeDefined();

    // Open hovercard
    const trigger = screen.getByRole('button', { name: 'Sync Status' });
    fireEvent.mouseEnter(trigger.parentElement!);

    const syncBtn = screen.getByRole('button', { name: /Syncing.../i });
    expect(syncBtn).toBeDefined();
  });

  it('renders notification update rates and sync duration in popup', () => {
    const status: SyncStatus = {
      $typeName: 'octodeck.v1.SyncStatus',
      lastSuccessfulSyncAt: createTimestamp(BigInt(Math.floor((Date.now() - 60000) / 1000))),
      lastSyncAttemptAt: createTimestamp(BigInt(Math.floor((Date.now() - 60000) / 1000))),
      lastUpdateReceivedAt: createTimestamp(BigInt(Math.floor((Date.now() - 60000) / 1000))),
      lastSyncFailed: false,
      lastErrorMessage: '',
      failedAttemptsCount: 0,
      isSyncing: false,
      notificationRate24h: 12.5,
      notificationRate7d: 8.2,
      notificationRate30d: 5.0,
      lastSyncDurationMs: BigInt(350),
    };

    render(<SyncStatusDisplay status={status} onManualSync={vi.fn()} />);

    // Open hovercard
    const trigger = screen.getByRole('button', { name: 'Sync Status' });
    fireEvent.mouseEnter(trigger.parentElement!);

    expect(screen.getByText('Notification Rate')).toBeDefined();
    expect(screen.getByText('12.5/hr')).toBeDefined();
    expect(screen.getByText('8.2/hr')).toBeDefined();
    expect(screen.getByText('5.0/hr')).toBeDefined();
    expect(screen.getByText('(350ms)')).toBeDefined();
    expect(screen.queryByText('Sync duration:')).toBeNull();
    expect(screen.getAllByText('1m ago').length).toBe(2);
  });
});
