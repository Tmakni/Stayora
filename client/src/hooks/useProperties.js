import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';

export function useProperties(options = {}) {
  return useQuery({
    queryKey: ['properties'],
    queryFn: () => api.properties.list(),
    ...options,
  });
}

export function useProperty(id, options = {}) {
  return useQuery({
    queryKey: ['properties', id],
    queryFn: () => api.properties.get(id),
    enabled: !!id,
    ...options,
  });
}

export function useCreateProperty() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload) => api.properties.create(payload),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['properties'] }),
  });
}

export function useUpdateProperty() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, payload }) => api.properties.update(id, payload),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['properties'] });
      qc.invalidateQueries({ queryKey: ['properties', vars.id] });
    },
  });
}

export function useDeleteProperty() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id) => api.properties.remove(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['properties'] }),
  });
}

export function useImportAirbnbListing() {
  return useMutation({ mutationFn: (url) => api.properties.importAirbnb(url) });
}

export function useScanAirbnbProfile() {
  return useMutation({ mutationFn: (profileUrl) => api.properties.scanAirbnbProfile(profileUrl) });
}

export function useUpdateFromAirbnb() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id) => api.properties.updateFromAirbnb(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['properties'] }),
  });
}

export function usePropertyPhotos(id, options = {}) {
  return useQuery({
    queryKey: ['properties', id, 'photos'],
    queryFn: () => api.properties.getPhotos(id),
    enabled: !!id,
    ...options,
  });
}
