import { ItemStatus } from '../api/octodeck/v1/resources_pb';

export { ItemStatus };
export type ItemStatusType = ItemStatus;

export interface NotificationFilters {
  enabled: boolean;
  filterMode: 'include' | 'exclude';
  repos: string[];
  labels: string[];
  authors: string[];
  onlyAssignedOrAuthored: boolean;
  ignoreBots: boolean;
  notifyOnNewItems: boolean;
  notifyOnNewActivity: boolean;
}

export const DEFAULT_NOTIFICATION_FILTERS: NotificationFilters = {
  enabled: true,
  filterMode: 'exclude',
  repos: [],
  labels: [],
  authors: [],
  onlyAssignedOrAuthored: true,
  ignoreBots: true,
  notifyOnNewItems: true,
  notifyOnNewActivity: true,
};

export type BadgeCountMode = 'inbox' | 'unread' | 'disabled';
export const DEFAULT_BADGE_COUNT_MODE: BadgeCountMode = 'inbox';

export type ExtensionMessage =
  | { type: 'GET_ITEM'; itemId: string }
  | { type: 'VIEW_ITEM'; itemId: string }
  | { type: 'ACK_ITEM'; itemId: string; acked?: boolean }
  | { type: 'STAR_ITEM'; itemId: string; starred: boolean }
  | { type: 'SET_NOTES'; itemId: string; notes: string }
  | { type: 'REFETCH_ITEM'; itemId: string }
  | { type: 'SYNC_ITEM'; itemId: string }
  | { type: 'GET_CONFIG' }
  | { type: 'GET_KNOWN_BOTS' }
  | { type: 'ADD_KNOWN_BOTS'; logins: string[] }
  | { type: 'GET_DAEMON_STATUS' }
  | { type: 'OPEN_DASHBOARD'; itemId?: string }
  | { type: 'GET_NOTIFICATION_FILTERS' }
  | { type: 'SAVE_NOTIFICATION_FILTERS'; filters: NotificationFilters }
  | { type: 'GET_HIDE_EVENTS' }
  | { type: 'SET_HIDE_EVENTS'; hideEvents: boolean }
  | { type: 'GET_BADGE_COUNT_MODE' }
  | { type: 'SET_BADGE_COUNT_MODE'; mode: BadgeCountMode };

export type ExtensionResponse<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: string };

export interface DaemonStatus {
  online: boolean;
  version?: string;
  ghAuthenticated?: boolean;
  error?: string;
}

export interface StoredExtensionData {
  bearer_token?: string;
  notification_filters?: NotificationFilters;
  last_notified_timestamps?: Record<string, number>;
  last_known_user_login?: string;
  hide_events?: boolean;
  badge_count_mode?: BadgeCountMode;
  known_bots?: string[];
}