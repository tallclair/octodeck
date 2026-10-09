import type { JsonObject } from '@bufbuild/protobuf';
import { ItemStatus } from '../api/octodeck/v1/resources_pb';

/** octodeck.v1.NotificationSettings in its proto JSON form. */
export type NotificationSettingsJson = JsonObject;

export { ItemStatus };
export type ItemStatusType = ItemStatus;

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
  // Notification settings live in the daemon config; they cross the message channel in their
  // proto JSON form.
  | { type: 'GET_NOTIFICATION_SETTINGS' }
  | { type: 'SAVE_NOTIFICATION_SETTINGS'; settings: NotificationSettingsJson }
  | { type: 'GET_HIDE_EVENTS' }
  | { type: 'SET_HIDE_EVENTS'; hideEvents: boolean };

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
  hide_events?: boolean;
  known_bots?: string[];
  /** Resume cursor of the notification stream (proto JSON Timestamp). */
  last_received_at?: string;
}

/** Keys written by earlier extension versions that are removed on install/update. */
export const OBSOLETE_STORAGE_KEYS = [
  'notification_filters',
  'last_notified_timestamps',
  'last_known_user_login',
  'badge_count_mode',
] as const;

/**
 * Session storage (cleared when the browser exits): shown notification IDs mapped to the URL a
 * click opens, and the freshest copy of the stream's resume cursor.
 */
export interface SessionExtensionData {
  notification_urls?: Record<string, string>;
  /** Resume cursor updated on every stream message (proto JSON Timestamp). */
  last_received_at?: string;
}