import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { api } from '../lib/api';

export const CONVERSATIONS_PAGE_SIZE = 50;

/**
 * Paginated conversation list.
 *
 * The endpoint has always capped a page at 50 rows, but the client never sent
 * limit/offset and flattened the response to `d.conversations` — so a host with
 * more than 50 conversations simply could not see the rest of them. This now
 * pages through with useInfiniteQuery while still exposing a flat `data` array,
 * which is what ConversationList consumes.
 *
 * A polling refetch re-requests EVERY page currently loaded, so the interval is
 * backed off once the user has scrolled deep into the list: new activity always
 * lands on page 1 (the list is ordered by updated_at DESC), and reloading ten
 * pages every 20s is pure waste. SSE (lib/useSSE.js) already pushes new-message
 * events, so polling is only a safety net here.
 */
export function useConversations(options = {}) {
  const query = useInfiniteQuery({
    queryKey: ['conversations'],
    queryFn: ({ pageParam = 0 }) =>
      api.conversations.list({ limit: CONVERSATIONS_PAGE_SIZE, offset: pageParam }),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) =>
      lastPage?.has_more ? allPages.length * CONVERSATIONS_PAGE_SIZE : undefined,
    refetchInterval: (query) => ((query.state.data?.pages?.length ?? 1) > 1 ? 60_000 : 20_000),
    staleTime: 10_000,
    ...options,
  });

  const data = useMemo(
    () => (query.data?.pages || []).flatMap((page) => page?.conversations || []),
    [query.data]
  );

  return { ...query, data };
}

export function useConversation(id, options = {}) {
  return useQuery({
    queryKey: ['conversations', id],
    queryFn: () => api.conversations.get(id),
    enabled: !!id,
    refetchInterval: 15_000,
    ...options,
  });
}

export function useCreateConversation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload) => api.conversations.create(payload),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['conversations'] }),
  });
}

export function useUpdateConversation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, payload }) => api.conversations.update(id, payload),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['conversations'] });
      qc.invalidateQueries({ queryKey: ['conversations', String(vars.id)] });
    },
  });
}

export function useAddMessage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, payload }) => api.conversations.addMessage(id, payload),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['conversations'] });
      qc.invalidateQueries({ queryKey: ['conversations', String(vars.id)] });
    },
  });
}

export function useSendAirbnb() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, message }) => api.conversations.sendAirbnb(id, message),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['conversations'] });
      qc.invalidateQueries({ queryKey: ['conversations', String(vars.id)] });
    },
  });
}

/**
 * Delivery state of the latest queued reply for a conversation.
 *
 * Polls only while something is actually in flight — a settled `sent`/`failed`
 * state does not change on its own, so continuing to poll it would be pure
 * noise on a phone connection.
 */
export function useReplyStatus(id, options = {}) {
  return useQuery({
    queryKey: ['reply-status', id],
    queryFn: () => api.conversations.replyStatus(id),
    enabled: !!id,
    refetchInterval: (query) => {
      const status = query.state.data?.latest?.status;
      return status === 'pending' || status === 'sending' ? 3_000 : false;
    },
    ...options,
  });
}

export function useSendReply() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, message }) => api.conversations.reply(id, message),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['conversations'] });
      qc.invalidateQueries({ queryKey: ['conversations', String(vars.id)] });
      qc.invalidateQueries({ queryKey: ['reply-status', String(vars.id)] });
    },
  });
}

export function useRetryReply() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, queueId }) => api.conversations.retryReply(id, queueId),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['reply-status', String(vars.id)] });
    },
  });
}

export function useAutoReplySettings(options = {}) {
  return useQuery({
    queryKey: ['auto-reply-settings'],
    queryFn: () => api.settings.getAutoReply(),
    staleTime: 30_000,
    ...options,
  });
}

export function useUpdateAutoReplySettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload) => api.settings.updateAutoReply(payload),
    onSuccess: (data) => {
      // The endpoint returns the full settings, so seed the cache with them
      // rather than triggering another round trip.
      qc.setQueryData(['auto-reply-settings'], data);
    },
  });
}
