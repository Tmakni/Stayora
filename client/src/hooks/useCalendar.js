import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';

export function usePropertyCalendar(propertyId, from, to, options = {}) {
  return useQuery({
    queryKey: ['calendar', propertyId, from, to],
    queryFn: () => api.properties.getCalendar(propertyId, { from, to }),
    enabled: !!propertyId,
    ...options,
  });
}

export function useICalInfo(propertyId, from, to, options = {}) {
  return useQuery({
    queryKey: ['ical', propertyId, from, to],
    queryFn: () => api.calendarApi.get(propertyId, { from, to }),
    enabled: !!propertyId,
    ...options,
  });
}

export function useConnectICal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ propertyId, icalUrl }) => api.calendarApi.connect(propertyId, icalUrl),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['ical', vars.propertyId] });
      qc.invalidateQueries({ queryKey: ['calendar', vars.propertyId] });
      qc.invalidateQueries({ queryKey: ['properties'] });
    },
  });
}

export function useDisconnectICal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (propertyId) => api.calendarApi.disconnect(propertyId),
    onSuccess: (_data, propertyId) => {
      qc.invalidateQueries({ queryKey: ['ical', propertyId] });
      qc.invalidateQueries({ queryKey: ['calendar', propertyId] });
    },
  });
}

export function useSyncICal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (propertyId) => api.calendarApi.sync(propertyId),
    onSuccess: (_data, propertyId) => {
      qc.invalidateQueries({ queryKey: ['ical', propertyId] });
      qc.invalidateQueries({ queryKey: ['calendar', propertyId] });
    },
  });
}
