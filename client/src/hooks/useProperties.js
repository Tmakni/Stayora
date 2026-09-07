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

// ── Centre de vérification ──────────────────────────────────────────────────
//
// Confirmer un fait écrit dans la fiche : il faut donc invalider AUSSI le
// logement lui-même, sans quoi le formulaire continuerait d'afficher le champ
// vide alors qu'il vient d'être rempli.

export function usePropertyFacts(id, options = {}) {
  return useQuery({
    queryKey: ['properties', id, 'facts'],
    queryFn: () => api.properties.getFacts(id),
    enabled: !!id,
    ...options,
  });
}

export function usePendingFacts(options = {}) {
  return useQuery({
    queryKey: ['property-facts', 'pending'],
    queryFn: () => api.properties.getPendingFacts(),
    ...options,
  });
}

function invalidateFacts(qc, id) {
  qc.invalidateQueries({ queryKey: ['properties', id, 'facts'] });
  qc.invalidateQueries({ queryKey: ['properties', id] });
  qc.invalidateQueries({ queryKey: ['property-facts', 'pending'] });
  qc.invalidateQueries({ queryKey: ['properties'], exact: true });
}

export function useConfirmFact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, factId, value }) => api.properties.confirmFact(id, factId, value),
    onSuccess: (_data, vars) => invalidateFacts(qc, vars.id),
  });
}

export function useRejectFact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, factId }) => api.properties.rejectFact(id, factId),
    onSuccess: (_data, vars) => invalidateFacts(qc, vars.id),
  });
}

export function useConfirmAllFacts() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id) => api.properties.confirmAllFacts(id),
    onSuccess: (_data, id) => invalidateFacts(qc, id),
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
