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