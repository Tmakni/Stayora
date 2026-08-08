import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';

export function useGmailAccounts(options = {}) {
  return useQuery({
    queryKey: ['gmail-accounts'],
    queryFn: () => api.gmail.getAccounts(),
    ...options,
  });
}

export function useAirbnbAccounts(options = {}) {
  return useQuery({
    queryKey: ['airbnb-accounts'],
    queryFn: () => api.sync.getAirbnbAccounts(),
    ...options,
  });
}

export function useGmailAuthUrl() {
  return useMutation({ mutationFn: () => api.gmail.getAuthUrl() });
}

export function useRemoveGmailAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id) => api.gmail.removeAccount(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['gmail-accounts'] }),
  });
}

export function useReauthorizeGmail() {
  return useMutation({ mutationFn: (accountId) => api.gmail.reauthorize(accountId) });
}

export function useRemoveAirbnbAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id) => api.sync.removeAirbnbAccount(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['airbnb-accounts'] }),
  });
}

export function useFullSyncAirbnb() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (accountId) => api.sync.fullSync(accountId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['airbnb-accounts'] });
      qc.invalidateQueries({ queryKey: ['conversations'] });
      qc.invalidateQueries({ queryKey: ['properties'] });
    },
  });
}

// Derived, honest "is Michel active" signal: at least one connected & active channel.
export function useMichelActiveStatus() {
  const gmail = useGmailAccounts({ staleTime: 30_000 });
  const airbnb = useAirbnbAccounts({ staleTime: 30_000 });
  const gmailActive = (gmail.data?.accounts || []).some((a) => a.is_active && a.sync_status !== 'error');
  const airbnbActive = (airbnb.data?.accounts || []).some((a) => a.is_active && a.sync_status !== 'error');
  return {
    active: gmailActive || airbnbActive,
    loading: gmail.isLoading || airbnb.isLoading,
  };
}
