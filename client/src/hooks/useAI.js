import { useMutation } from '@tanstack/react-query';
import { api } from '../lib/api';

export function useGenerateDraft() {
  return useMutation({ mutationFn: (payload) => api.ai.generateDraft(payload) });
}
