/**
 * Sauvegarde automatique du formulaire de logement — le moteur.
 *
 * Le défaut d'origine n'était PAS l'absence d'autosave : c'était que l'état du
 * formulaire pouvait être réécrit par le réseau. PropertyFormDialog avait
 * `fullPropertyQuery.data` en dépendance de son effet d'hydratation, et
 * useProperties invalide la clé ['properties'] — un PRÉFIXE de ['properties', id].
 * Supprimer une photo, définir la photo principale ou enregistrer refetchait
 * donc la fiche, et l'effet écrasait toute la saisie en cours avec l'état
 * serveur, en renvoyant au passage sur l'onglet « Général ».
 *
 * Le moteur testé ici est volontairement SANS React (client/src/lib/
 * autosaveEngine.js) : toute la logique risquée y est isolée, donc vérifiable
 * sans ajouter jsdom ni bibliothèque de test de composants au projet.
 *
 * Ce qui est verrouillé :
 *   - le moteur n'écrit jamais dans les valeurs affichées ;
 *   - seul le différentiel part, donc une section n'efface pas les autres ;
 *   - les envois sont sérialisés : une réponse en retard ne peut pas écraser
 *     une modification plus récente ;
 *   - un échec réseau ne perd rien et laisse le champ à renvoyer ;
 *   - « Enregistré » n'apparaît qu'après confirmation réelle du serveur.
 */

// Le moteur est un vrai module ES (le client est en "type": "module"), donc il
// est charge par import() dynamique. C'est ce que rend possible le drapeau
// --experimental-vm-modules du script `npm test` : aucun outillage
// supplementaire (jsdom, babel, bibliotheque de test de composants) n'a ete
// ajoute au projet pour ce fichier.
let createAutosaveEngine;
let AUTOSAVE_STATUS;

beforeAll(async () => {
  const mod = await import('../../client/src/lib/autosaveEngine.js');
  createAutosaveEngine = mod.createAutosaveEngine;
  AUTOSAVE_STATUS = mod.AUTOSAVE_STATUS;
});

/** Petite fabrique : un `save` dont on contrôle la résolution à la main. */
function deferredSaver() {
  const calls = [];
  const save = (patch) => {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    calls.push({ patch, resolve, reject });
    return promise;
  };
  return { save, calls };
}

function makeEngine(save, extra = {}) {
  const statuses = [];
  const engine = createAutosaveEngine({
    save,
    debounceMs: 0,
    onStatus: (s) => statuses.push(s),
    ...extra,
  });
  return { engine, statuses };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe("le moteur n'envoie que le différentiel", () => {
  it('ne poste que les champs réellement modifiés', async () => {
    const sent = [];
    const { engine } = makeEngine(async (patch) => { sent.push(patch); });

    engine.setBaseline({ name: 'Villa', wifi_password: 'abc', access_code: '1234' });
    engine.update({ name: 'Villa', wifi_password: 'nouveau', access_code: '1234' });
    await engine.flush();

    expect(sent).toEqual([{ wifi_password: 'nouveau' }]);
  });

  it("n'envoie rien quand rien n'a changé", async () => {
    const sent = [];
    const { engine } = makeEngine(async (patch) => { sent.push(patch); });

    engine.setBaseline({ name: 'Villa', beds: 2 });
    engine.update({ name: 'Villa', beds: 2 });
    await engine.flush();

    expect(sent).toEqual([]);
    expect(engine.hasPendingChanges()).toBe(false);
  });

  it("modifier une section ne renvoie aucun champ des autres sections", async () => {
    // Le cas signalé : remplir « Arrivée & Accès » puis « Hôte & FAQ » ne doit
    // rien réécrire de « Connectivité », sinon une valeur périmée y retourne.
    const sent = [];
    const { engine } = makeEngine(async (patch) => { sent.push(patch); });

    engine.setBaseline({ key_location: '', wifi_name: 'BOX-42', host_name: '' });

    engine.update({ key_location: 'Boîte à clés', wifi_name: 'BOX-42', host_name: '' });
    await engine.flush();

    engine.update({ key_location: 'Boîte à clés', wifi_name: 'BOX-42', host_name: 'Delphine' });
    await engine.flush();

    expect(sent).toEqual([{ key_location: 'Boîte à clés' }, { host_name: 'Delphine' }]);
    // wifi_name n'a JAMAIS été renvoyé : il ne peut donc pas être écrasé.
    expect(sent.some((p) => 'wifi_name' in p)).toBe(false);
  });

  it('accumule des modifications rapides sur plusieurs champs en un seul envoi', async () => {
    const sent = [];
    const { engine } = makeEngine(async (patch) => { sent.push(patch); });

    engine.setBaseline({ a: '', b: '', c: '' });
    engine.update({ a: '1', b: '', c: '' });
    engine.update({ a: '1', b: '2', c: '' });
    engine.update({ a: '1', b: '2', c: '3' });
    await engine.flush();

    expect(sent).toEqual([{ a: '1', b: '2', c: '3' }]);
  });
});

describe('les réponses ne peuvent pas arriver dans le désordre', () => {
  it('sérialise les envois : la seconde requête ne part pas avant la réponse de la première', async () => {
    const { save, calls } = deferredSaver();
    const { engine } = makeEngine(save);

    engine.setBaseline({ champ: 'v0' });

    engine.update({ champ: 'v1' });
    const first = engine.flush();
    await tick();
    expect(calls).toHaveLength(1);

    // Deuxième modification pendant que la première est encore en vol.
    engine.update({ champ: 'v2' });
    const second = engine.flush();
    await tick();
    // Toujours une seule requête partie : la seconde attend.
    expect(calls).toHaveLength(1);

    calls[0].resolve();
    await first;
    await tick();

    expect(calls).toHaveLength(2);
    expect(calls[1].patch).toEqual({ champ: 'v2' });

    calls[1].resolve();
    await second;
  });

  it("une réponse ancienne ne fait pas repartir une valeur périmée", async () => {
    // La requête portant v1 se termine APRÈS que l'utilisateur a tapé v2. Ni la
    // référence ni l'envoi suivant ne doivent revenir à v1.
    // Temporisation volontairement longue : tout est déclenché à la main ici,
    // pour que l'ordre testé soit celui écrit et non celui d'un minuteur.
    const sent = [];
    const gates = [];
    const { engine } = makeEngine(
      (patch) => { sent.push(patch); return new Promise((resolve) => gates.push(resolve)); },
      { debounceMs: 100000 }
    );

    engine.setBaseline({ champ: 'v0' });
    engine.update({ champ: 'v1' });
    const first = engine.flush();
    await tick();
    expect(sent).toEqual([{ champ: 'v1' }]);

    // L'utilisateur tape v2 pendant que v1 est encore en vol.
    engine.update({ champ: 'v2' });
    const second = engine.flush();
    await tick();
    // Rien de neuf n'est parti : les envois sont sérialisés.
    expect(sent).toHaveLength(1);

    // La réponse de v1 arrive seulement maintenant, donc après la saisie de v2.
    gates[0]();
    await first;
    await tick();

    // C'est bien v2 qui part ensuite — aucun retour à v1.
    expect(sent).toEqual([{ champ: 'v1' }, { champ: 'v2' }]);
    gates[1]();
    await second;
    await tick();

    expect(engine.hasPendingChanges()).toBe(false);
  });
});

describe('un échec réseau ne perd rien', () => {
  it('conserve la modification et la renvoie à la tentative suivante', async () => {
    const attempts = [];
    let failNext = true;
    const { engine, statuses } = makeEngine(async (patch) => {
      attempts.push(patch);
      if (failNext) { failNext = false; throw new Error('réseau indisponible'); }
    });

    engine.setBaseline({ access_code: '' });
    engine.update({ access_code: 'A1B2' });

    await expect(engine.flush()).rejects.toThrow('réseau indisponible');
    expect(statuses).toContain(AUTOSAVE_STATUS.ERROR);
    // La valeur est toujours « à envoyer » : rien n'a été considéré comme acquis.
    expect(engine.hasPendingChanges()).toBe(true);

    await engine.flush();
    expect(attempts).toEqual([{ access_code: 'A1B2' }, { access_code: 'A1B2' }]);
    expect(engine.hasPendingChanges()).toBe(false);
    expect(engine.getStatus()).toBe(AUTOSAVE_STATUS.SAVED);
  });

  it("un échec ne bloque pas les sauvegardes suivantes", async () => {
    let calls = 0;
    const { engine } = makeEngine(async () => {
      calls += 1;
      if (calls === 1) throw new Error('coupure');
    });

    engine.setBaseline({ a: '' });
    engine.update({ a: '1' });
    await expect(engine.flush()).rejects.toThrow('coupure');

    engine.update({ a: '2' });
    await engine.flush();
    expect(engine.hasPendingChanges()).toBe(false);
  });
});

describe('le statut est honnête', () => {
  it('n\'annonce « Enregistré » qu\'après la confirmation du serveur', async () => {
    const { save, calls } = deferredSaver();
    const { engine, statuses } = makeEngine(save);

    engine.setBaseline({ champ: '' });
    engine.update({ champ: 'x' });
    const done = engine.flush();
    await tick();

    expect(statuses).toContain(AUTOSAVE_STATUS.SAVING);
    expect(statuses).not.toContain(AUTOSAVE_STATUS.SAVED);

    calls[0].resolve();
    await done;
    expect(engine.getStatus()).toBe(AUTOSAVE_STATUS.SAVED);
  });
});

describe('isolation entre deux logements', () => {
  it("couper la référence empêche d'écrire les valeurs d'un logement sur un autre", async () => {
    // Scénario réel : on modifie le logement A sans fermer, puis on ouvre B.
    // Sans coupure de la référence, le différentiel de A partirait sur l'id de B.
    const sent = [];
    const { engine } = makeEngine(async (patch) => { sent.push(patch); });

    engine.setBaseline({ name: 'Logement A', wifi_name: 'BOX-A' });
    engine.update({ name: 'Logement A modifié', wifi_name: 'BOX-A' });

    // Fermeture du dialogue : la référence est coupée (PropertyFormDialog).
    engine.setBaseline(null);
    await engine.flush();
    expect(sent).toEqual([]);

    // Ouverture du logement B : rien de A ne doit subsister.
    engine.setBaseline({ name: 'Logement B', wifi_name: 'BOX-B' });
    await engine.flush();
    expect(sent).toEqual([]);
    expect(engine.hasPendingChanges()).toBe(false);
  });
});
