import { useCallback, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery } from '@connectrpc/connect-query';
import { useQueryClient } from '@tanstack/react-query';
import {
  createSavedSearch,
  deleteSavedSearch,
  getConfig,
  reorderSavedSearches,
  updateSavedSearch,
} from '../api/octodeck/v1/service-OctoDeckService_connectquery';
import type {
  GetConfigResponse,
  SavedSearch,
} from '../api/octodeck/v1/service_pb';
import type { SortOption, SortOrder } from '../types/filters';
import { toSort, type ExprInit } from '../logic/query/expr';
import { parseQuery } from '../logic/query/syntax';
import {
  buildCountRequest,
  toView,
  type BadgeScope,
  type SavedSearchView,
} from '../logic/savedSearches';

export type { BadgeScope, SavedSearchView };

const NO_SAVED_SEARCHES: readonly SavedSearch[] = [];

function isGetConfigQuery(query: { queryKey: readonly unknown[] }): boolean {
  const meta = query.queryKey[1] as { methodName?: string } | undefined;
  return !meta?.methodName || meta.methodName === 'GetConfig';
}

function writeSavedSearchesToCache(
  queryClient: ReturnType<typeof useQueryClient> | undefined,
  savedSearches: readonly SavedSearch[]
): void {
  if (!queryClient?.setQueriesData) return;
  queryClient.setQueriesData(
    { queryKey: ['connect-query'], predicate: isGetConfigQuery },
    (oldData: unknown) => {
      const dataObj = oldData as GetConfigResponse | undefined;
      if (!dataObj || typeof dataObj !== 'object' || !dataObj.config) return oldData;
      return {
        ...dataObj,
        config: {
          ...dataObj.config,
          savedSearches: savedSearches as SavedSearch[],
        },
      };
    }
  );
}

async function invalidateConfigCache(
  queryClient: ReturnType<typeof useQueryClient> | undefined,
  refetchActive: boolean
): Promise<void> {
  if (!queryClient?.invalidateQueries) return;
  await queryClient.invalidateQueries({
    queryKey: ['connect-query'],
    refetchType: refetchActive ? 'active' : 'none',
    predicate: isGetConfigQuery,
  });
}

export interface CreateSavedSearchInput {
  name: string;
  text: string;
  sort: SortOption;
  order: SortOrder;
}

export interface UpdateSavedSearchPatch {
  name?: string;
  text?: string;
  sort?: SortOption;
  order?: SortOrder;
}

export interface UseSavedSearchesResult {
  searches: SavedSearchView[];
  countRequest: { queries: ExprInit[]; rowIndex: number[] };
  isLoading: boolean;
  create(input: CreateSavedSearchInput): Promise<SavedSearchView>;
  update(id: string, patch: UpdateSavedSearchPatch): Promise<void>;
  remove(id: string): Promise<void>;
  reorder(ids: string[]): Promise<void>;
}

export function useSavedSearches(): UseSavedSearchesResult {
  const configQ = useQuery(getConfig, {});
  const queryClient = useQueryClient();

  const { mutateAsync: createMutate } = useMutation(createSavedSearch);
  const { mutateAsync: updateMutate } = useMutation(updateSavedSearch);
  const { mutateAsync: deleteMutate } = useMutation(deleteSavedSearch);
  const { mutateAsync: reorderMutate } = useMutation(reorderSavedSearches);

  const configSearches = configQ.data?.config?.savedSearches;
  const [override, setOverride] = useState<{
    base: readonly SavedSearch[] | undefined;
    list: readonly SavedSearch[];
  } | null>(null);
  const reorderSeqRef = useRef(0);

  const rawSearches: readonly SavedSearch[] =
    override && override.base === configSearches
      ? override.list
      : (configSearches ?? NO_SAVED_SEARCHES);

  const searches = useMemo(() => rawSearches.map((s) => toView(s)), [rawSearches]);
  const countRequest = useMemo(() => buildCountRequest(searches), [searches]);

  const applySavedSearches = useCallback(
    async (nextList: readonly SavedSearch[], refetchActive = false) => {
      const cloned = [...nextList];
      setOverride({ base: configSearches, list: cloned });
      writeSavedSearchesToCache(queryClient, cloned);
      await invalidateConfigCache(queryClient, refetchActive);
    },
    [configSearches, queryClient]
  );

  const createSearch = useCallback(
    async (input: CreateSavedSearchInput): Promise<SavedSearchView> => {
      const parsed = parseQuery(input.text);
      if (parsed.issues.length > 0) {
        throw new Error(parsed.issues[0].message);
      }
      const sortProto = toSort(input.sort, input.order);
      const prevIds = new Set(rawSearches.map((s) => s.id));
      const res = await createMutate({
        savedSearch: {
          name: input.name,
          query: input.text,
          sort: sortProto,
        },
      });
      const returnedList =
        res?.savedSearches && res.savedSearches.length > 0
          ? res.savedSearches
          : res?.savedSearch
            ? [...rawSearches, res.savedSearch]
            : rawSearches;
      await applySavedSearches(returnedList, false);
      const created =
        res?.savedSearch ??
        returnedList.find((s) => !prevIds.has(s.id)) ??
        returnedList[returnedList.length - 1];
      return toView(
        created ?? {
          id: '',
          name: input.name,
          query: input.text,
          sort: sortProto,
        }
      );
    },
    [rawSearches, createMutate, applySavedSearches]
  );

  const updateSearch = useCallback(
    async (id: string, patch: UpdateSavedSearchPatch): Promise<void> => {
      const paths: string[] = [];
      const existing = searches.find((s) => s.id === id);
      const savedSearchInit: {
        id: string;
        name?: string;
        query?: string;
        sort?: ReturnType<typeof toSort>;
      } = { id };

      if (patch.name !== undefined) {
        paths.push('name');
        savedSearchInit.name = patch.name;
      }
      if (patch.text !== undefined) {
        const parsed = parseQuery(patch.text);
        if (parsed.issues.length > 0) {
          throw new Error(parsed.issues[0].message);
        }
        paths.push('query');
        savedSearchInit.query = patch.text;
      }
      if (patch.sort !== undefined || patch.order !== undefined) {
        paths.push('sort');
        const nextSort = patch.sort ?? existing?.sort ?? 'updated';
        const nextOrder = patch.order ?? existing?.order ?? 'desc';
        savedSearchInit.sort = toSort(nextSort, nextOrder);
      }

      const res = await updateMutate({
        savedSearch: savedSearchInit,
        updateMask: { paths },
      });

      await applySavedSearches(res?.savedSearches ?? rawSearches, false);
    },
    [searches, rawSearches, updateMutate, applySavedSearches]
  );

  const removeSearch = useCallback(
    async (id: string): Promise<void> => {
      const res = await deleteMutate({ id });
      await applySavedSearches(res?.savedSearches ?? [], false);
    },
    [deleteMutate, applySavedSearches]
  );

  const reorderSearches = useCallback(
    async (ids: string[]): Promise<void> => {
      const seq = ++reorderSeqRef.current;
      const previous = [...rawSearches];
      const byId = new Map(previous.map((s) => [s.id, s]));
      const optimistic: SavedSearch[] = [];
      for (const id of ids) {
        const found = byId.get(id);
        if (found) optimistic.push(found);
      }
      for (const item of previous) {
        if (!ids.includes(item.id)) optimistic.push(item);
      }

      setOverride({ base: configSearches, list: optimistic });
      writeSavedSearchesToCache(queryClient, optimistic);

      try {
        const res = await reorderMutate({ ids });
        if (seq === reorderSeqRef.current) {
          const returnedList = res?.savedSearches;
          if (returnedList && returnedList.length > 0) {
            await applySavedSearches(returnedList, false);
          } else {
            await invalidateConfigCache(queryClient, false);
          }
        }
      } catch (err) {
        if (seq === reorderSeqRef.current) {
          setOverride({ base: configSearches, list: previous });
          writeSavedSearchesToCache(queryClient, previous);
          await invalidateConfigCache(queryClient, true);
        }
        throw err;
      }
    },
    [rawSearches, configSearches, reorderMutate, queryClient, applySavedSearches]
  );

  const isLoading = Boolean(configQ.isLoading) && !configQ.data && !configQ.isError;

  return {
    searches,
    countRequest,
    isLoading,
    create: createSearch,
    update: updateSearch,
    remove: removeSearch,
    reorder: reorderSearches,
  };
}
