import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';

export function useConversations(options = {}) {
  return useQuery({
    queryKey: ['conversations'],
    queryFn: () => api.conversations.list(),
    refetchInterval: 20_000,
    ...options,
  });
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
