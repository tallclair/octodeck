export interface StorageData {
  settings: {
    bearer_token?: string;
    stable_ext_id?: string;
  };
  currentUser?: {
    login: string;
    avatarUrl: string;
  };
}

export type ExtensionMessage =
  | { type: 'FORCE_REFRESH' }
  | { type: 'MSG_UPDATE_VIEW'; payload: { owner: string; repo: string; number: number } };

export * from './filters';

/**
 * A timestamp as it may appear on items: a protobuf Timestamp message (dashboard), its JSON
 * form (an RFC 3339 string or a { seconds, nanos } object, e.g. after crossing the extension
 * message bridge), a Date, or epoch milliseconds.
 */
export type TimestampLike =
  | Date
  | string
  | number
  | { seconds?: number | string | bigint; nanos?: number | string }
  | null
  | undefined;

/** The acknowledgement fields of ItemLocalState, in any of the shapes TimestampLike allows. */
export interface AckStateLike {
  /** When the item was acknowledged (ack action time). Presence means acked. */
  ackedAt?: TimestampLike;
  /** Activity watermark (GitHub clock). Falls back to ackedAt when unset. */
  ackedActivityAt?: TimestampLike;
}
