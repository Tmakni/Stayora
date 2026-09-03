/**
 * Moteur de sauvegarde automatique — sans React, donc testable directement.
 *
 * Toute la logique risquée vit ici : calcul du différentiel, sérialisation des
 * envois, gestion d'un échec réseau, statut. Le hook `useAutosave` n'en est
 * qu'une enveloppe qui reporte le statut dans un état React.
 *
 * TROIS INVARIANTS, dans l'ordre d'importance :
 *
 *  1. LE MOTEUR N'ÉCRIT JAMAIS DANS LE FORMULAIRE. Aucune réponse du serveur ne
 *     revient dans les valeurs affichées. C'est précisément le mécanisme inverse
 *     qui faisait disparaître les champs : un refetch de React Query réinjectait
 *     l'état serveur par-dessus la saisie en cours.
 *
 *  2. DIFFÉRENTIEL. Seuls les champs modifiés depuis la dernière confirmation
 *     serveur sont envoyés. Un champ absent du corps veut dire « ne pas
 *     modifier » (voir propertyController.updateProperty), donc remplir un
 *     onglet ne peut pas effacer les autres.
 *
 *  3. SÉRIALISATION. Une seule requête en vol ; les suivantes s'enchaînent
 *     derrière. Le désordre des réponses est rendu IMPOSSIBLE, au lieu d'être
 *     détecté après coup — une réponse ancienne ne peut donc pas écraser une
 *     modification plus récente.
 *
 * En cas d'échec, la référence n'avance pas : les champs concernés repartent
 * tels quels à la tentative suivante, et les valeurs restent dans le formulaire.
 */

export const AUTOSAVE_DEBOUNCE_MS = 800;

export const AUTOSAVE_STATUS = {
  IDLE: 'idle',
  SAVING: 'saving',
  SAVED: 'saved',
  ERROR: 'error',
};

/**
 * @param {object}   opts
 * @param {Function} opts.save         (patch) => Promise ; doit rejeter en cas d'échec
 * @param {Function} [opts.onStatus]   (status, error) => void
 * @param {number}   [opts.debounceMs]
 * @param {Function} [opts.setTimeoutFn] injectable pour les tests
 * @param {Function} [opts.clearTimeoutFn]
 */
export function createAutosaveEngine({
  save,
  onStatus = () => {},
  debounceMs = AUTOSAVE_DEBOUNCE_MS,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
}) {
  // Dernier état CONFIRMÉ par le serveur. N'avance que sur un succès.
  let baseline = null;
  let values = {};
  let timer = null;
  let chain = Promise.resolve();
  let inFlight = 0;
  let disposed = false;
  let status = AUTOSAVE_STATUS.IDLE;

  function emit(next, error = null) {
    status = next;
    onStatus(next, error);
  }

  function clearTimer() {
    if (timer !== null) {
      clearTimeoutFn(timer);
      timer = null;
    }
  }

  /** Différentiel courant, ou null s'il n'y a rien à envoyer. */
  function buildPatch() {
    if (!baseline) return null;
    const patch = {};
    for (const key of Object.keys(values)) {
      if (!Object.is(values[key], baseline[key])) patch[key] = values[key];
    }
    return Object.keys(patch).length > 0 ? patch : null;
  }

  function hasPendingChanges() {
    return buildPatch() !== null;
  }

  async function runSave() {
    if (disposed || !baseline) return;
    const patch = buildPatch();
    if (!patch) return;

    // Photographier l'état ENVOYÉ : c'est lui qui devient la référence, et non
    // l'état au moment de la réponse — qui peut déjà avoir changé.
    const sent = { ...values };

    inFlight += 1;
    emit(AUTOSAVE_STATUS.SAVING);
    try {
      await save(patch);
      baseline = { ...baseline, ...sent };
      // Ne rien annoncer si une autre sauvegarde attend déjà derrière :
      // « Enregistré » doit décrire l'état réel, pas une étape intermédiaire.
      if (inFlight === 1 && !disposed) {
        emit(hasPendingChanges() ? AUTOSAVE_STATUS.IDLE : AUTOSAVE_STATUS.SAVED);
      }
    } catch (err) {
      // La référence N'AVANCE PAS. Les valeurs du formulaire ne sont pas touchées.
      if (!disposed) emit(AUTOSAVE_STATUS.ERROR, err);
      throw err;
    } finally {
      inFlight -= 1;
    }
  }

  return {
    /** Fixe la référence serveur. N'écrit pas dans le formulaire. */
    setBaseline(next) {
      clearTimer();
      baseline = next ? { ...next } : null;
      if (next) values = { ...next };
      emit(AUTOSAVE_STATUS.IDLE);
    },

    /** Nouvel état du formulaire : programme une sauvegarde si besoin. */
    update(nextValues) {
      values = nextValues || {};
      if (disposed || !baseline || !hasPendingChanges()) return;
      if (status === AUTOSAVE_STATUS.SAVED) emit(AUTOSAVE_STATUS.IDLE);
      clearTimer();
      timer = setTimeoutFn(() => {
        timer = null;
        // Un échec est déjà reporté par le statut ; ne pas le laisser remonter
        // en rejet non géré depuis un timer.
        this.flush().catch(() => {});
      }, debounceMs);
    },

    /**
     * Envoi immédiat. La promesse rendue est résolue quand tout ce qui était en
     * attente est réellement persisté — c'est ce que la fermeture attend.
     */
    flush() {
      clearTimer();
      // Un échec ne doit pas briser la chaîne pour les envois suivants.
      chain = chain.then(runSave, runSave);
      return chain;
    },

    hasPendingChanges,
    getStatus: () => status,

    dispose() {
      disposed = true;
      clearTimer();
    },
  };
}
