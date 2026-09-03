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

/**
 * Mise a jour PARTIELLE, employee par la sauvegarde automatique.
 *
 * Deux differences volontaires avec useUpdateProperty :
 *  - le corps ne porte que les champs modifies, jamais le logement entier ;
 *  - l'invalidation est EXACTE sur ['properties']. Une invalidation par prefixe
 *    toucherait aussi ['properties', id], donc referait la requete de la fiche
 *    a chaque frappe enregistree — c'est ce refetch qui, combine a l'ancien
 *    effet d'hydratation, ecrasait la saisie en cours.
 */
export function usePatchProperty() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, payload }) => api.properties.patch(id, payload),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['properties'], exact: true }),
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

/**
 * Previsualisation d'une archive Airbnb : rien n'est ecrit en base a ce stade.
 * L'utilisateur voit ce qui a ete detecte avant de decider.
 */
export function usePreviewAirbnbArchive() {
  return useMutation({ mutationFn: (file) => api.properties.previewArchive(file) });
}

/** Import en masse de la selection issue de la previsualisation. */
export function useImportAirbnbArchive() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (listings) => api.properties.importArchive(listings),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['properties'], exact: true }),
  });
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
