import { useCallback, useEffect, useRef, useState } from 'react';
import { createAutosaveEngine, AUTOSAVE_DEBOUNCE_MS, AUTOSAVE_STATUS } from '../lib/autosaveEngine';

/**
 * Enveloppe React du moteur de sauvegarde automatique.
 *
 * Toute la logique — différentiel, sérialisation des envois, comportement en cas
 * d'échec — vit dans lib/autosaveEngine.js, sans React, pour être testable
 * directement. Ce hook ne fait que : garder le moteur en vie, remonter le statut
 * dans un état React, et brancher la fermeture de l'onglet.
 *
 * Le hook n'écrit JAMAIS dans les valeurs du formulaire : c'est l'inverse de ce
 * mécanisme (un refetch réinjectant l'état serveur) qui faisait disparaître la
 * saisie en cours.
 *
 * @param {object}   opts
 * @param {boolean}  opts.enabled   false = inerte (création, dialogue fermé)
 * @param {object}   opts.values    état courant complet du formulaire
 * @param {Function} opts.save      (patch) => Promise — doit rejeter en cas d'échec
 * @param {number}   [opts.debounceMs=800]
 */
export function useAutosave({ enabled, values, save, debounceMs = AUTOSAVE_DEBOUNCE_MS }) {
  const [status, setStatus] = useState(AUTOSAVE_STATUS.IDLE);
  const [error, setError] = useState(null);

  const saveRef = useRef(save);
  saveRef.current = save;

  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  // Un seul moteur pour toute la vie du composant.
  const engineRef = useRef(null);
  if (engineRef.current === null) {
    engineRef.current = createAutosaveEngine({
      save: (patch) => saveRef.current(patch),
      debounceMs,
      onStatus: (next, err) => {
        setStatus(next);
        setError(err || null);
      },
    });
  }
  const engine = engineRef.current;

  useEffect(() => () => engine.dispose(), [engine]);

  // Toute modification des valeurs relance le compte à rebours.
  useEffect(() => {
    if (!enabled) return;
    engine.update(values);
  }, [values, enabled, engine]);

  const flush = useCallback(() => {
    if (!enabledRef.current) return Promise.resolve();
    return engine.flush();
  }, [engine]);

  const setBaseline = useCallback((baseline) => engine.setBaseline(baseline), [engine]);
  const hasPendingChanges = useCallback(() => engine.hasPendingChanges(), [engine]);

  // Fermeture / rechargement de l'onglet : on tente l'envoi et on prévient
  // l'utilisateur tant qu'il reste quelque chose à écrire.
  useEffect(() => {
    if (!enabled) return undefined;
    const onBeforeUnload = (event) => {
      if (!engine.hasPendingChanges()) return undefined;
      engine.flush().catch(() => {});
      event.preventDefault();
      event.returnValue = '';
      return '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [enabled, engine]);

  return { status, error, flush, setBaseline, hasPendingChanges };
}
