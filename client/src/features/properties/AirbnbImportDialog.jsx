import { useRef, useState } from 'react';
import { Loader2, ArrowLeft, ArrowRight, Check, Upload, AlertTriangle, FileArchive, Home, Building2, FileJson } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '../../components/ui/dialog';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Checkbox } from '../../components/ui/checkbox';
import { AirbnbLinkField } from '../../components/shared/AirbnbLinkField';
import { cn } from '../../lib/utils';
import {
  useImportAirbnbListing,
  useScanAirbnbProfile,
  usePreviewAirbnbArchive,
  useImportAirbnbArchive,
} from '../../hooks/useProperties';
import { prepareAirbnbUpload } from '../../lib/airbnbZip';

// Ce que la prévisualisation dit avoir trouvé pour un logement, dans l'ordre
// où on l'affiche. Une ligne n'apparaît que si le fichier correspondant a
// réellement livré quelque chose pour CE logement.
const FOUND_LABELS = [
  ['general', 'Informations générales'],
  ['address', 'Adresse'],
  ['capacity', 'Capacité'],
  ['amenities', 'Équipements'],
  ['rules', 'Règles'],
  ['access', 'Arrivée & accès'],
  ['pricing', 'Tarifs'],
  ['calendar', 'Calendrier'],
  ['reservations', 'Séjours à venir'],
  ['reviews', 'Avis'],
  ['permits', 'Enregistrement'],
  ['facts', 'Infos tirées de vos messages'],
];

// Clés que la prévisualisation ajoute pour l'affichage seul : elles n'ont rien
// à faire dans ce qu'on renvoie à l'import. `facts`, lui, EST renvoyé — c'est
// la matière de l'écran de vérification.
const PREVIEW_ONLY_KEYS = [
  'found', 'already_imported', 'existing_property_id', 'source_file', 'fact_stats',
];

function toImportPayload(listing) {
  const payload = { ...listing };
  for (const key of PREVIEW_ONLY_KEYS) delete payload[key];
  return payload;
}

export function AirbnbImportDialog({ open, onOpenChange, onImported }) {
  const [step, setStep] = useState('choice');
  const [url, setUrl] = useState('');
  const [listings, setListings] = useState([]);
  const [error, setError] = useState('');
  const [importingId, setImportingId] = useState(null);

  // When Airbnb blocks title extraction the server returns the property data
  // with an empty name and needs_name_confirmation — the user confirms it here
  // rather than the app silently saving "Logement Airbnb #<id>".
  const [pendingImport, setPendingImport] = useState(null);
  const [nameInput, setNameInput] = useState('');

  // ── Import en masse depuis l'archive de données personnelles Airbnb ───────
  const [archive, setArchive] = useState(null);     // résultat de la prévisualisation
  const [selected, setSelected] = useState(() => new Set());
  const [summary, setSummary] = useState(null);
  // Ouvrir un ZIP de 156 Mo prend quelques secondes : sans ce témoin, le
  // bouton reste inerte et l'hôte reclique.
  const [preparing, setPreparing] = useState(false);
  const fileInputRef = useRef(null);

  // Guards a double submit: two fast clicks (or Enter held down) used to fire
  // two imports, and with `mutateAsync` in flight `isPending` has not flipped
  // yet on the very next tick.
  const inFlight = useRef(false);

  const importListing = useImportAirbnbListing();
  const scanProfile = useScanAirbnbProfile();
  const previewArchive = usePreviewAirbnbArchive();
  const importArchive = useImportAirbnbArchive();

  function reset() {
    setStep('choice');
    setUrl('');
    setListings([]);
    setError('');
    setImportingId(null);
    setPendingImport(null);
    setNameInput('');
    setArchive(null);
    setSelected(new Set());
    setSummary(null);
    setPreparing(false);
    inFlight.current = false;
  }

  function handleOpenChange(next) {
    if (!next) reset();
    onOpenChange(next);
  }

  async function handleAnalyze(e) {
    e.preventDefault();
    if (inFlight.current) return;
    setError('');
    const trimmed = url.trim();
    if (!trimmed) return;

    // Airbnb sert DEUX formes d'adresse de profil : l'ancienne
    // /users/show/<id> et la nouvelle /users/profile/<id>, qui est celle que
    // l'on obtient aujourd'hui en cliquant sur l'hôte depuis une annonce.
    // Seule la première était reconnue, donc une adresse de profil récente
    // partait dans l'import d'UNE annonce et échouait sans expliquer pourquoi.
    const isProfile = /\/users\/(?:show|profile)\//i.test(trimmed);
    inFlight.current = true;
    try {
      if (isProfile) {
        const result = await scanProfile.mutateAsync(trimmed);
        if (!result.listings || result.listings.length === 0) {
          setError("Aucune annonce n'a été trouvée sur ce profil. Essayez la méthode 2.");
          return;
        }
        // Une seule annonce : autant importer sa fiche complète tout de suite,
        // la liste à cocher n'apporterait rien.
        if (result.listings.length === 1) {
          await runImport(result.listings[0].id, result.listings[0].name);
          return;
        }
        setListings(result.listings);
        // Seules les annonces dont le titre a pu être lu sont cochées : les
        // autres créeraient un logement mal nommé, et le serveur les refuse.
        setSelected(new Set(result.listings.map((l, i) => (l.name ? i : null)).filter((i) => i !== null)));
        setStep('grid');
      } else {
        await runImport(trimmed, null);
      }
    } catch (err) {
      setError(err.message || "Impossible d'analyser ce lien Airbnb.");
    } finally {
      inFlight.current = false;
    }
  }

  async function runImport(listingId, scanName) {
    setImportingId(listingId);
    try {
      const result = await importListing.mutateAsync(listingId);

      if (result?.needs_name_confirmation || !result?.data?.name) {
        // Pre-fill with whatever we do have (a name seen on the host's profile
        // listing grid is often right even when the page itself is blocked).
        setPendingImport(result);
        setNameInput(result?.suggested_name || scanName || '');
        setStep('confirm-name');
        return;
      }

      onImported(result);
      handleOpenChange(false);
    } catch (err) {
      setError(err.message || "Impossible d'importer ce logement.");
    } finally {
      setImportingId(null);
    }
  }

  function handleConfirmName(e) {
    e.preventDefault();
    const confirmed = nameInput.trim();
    if (confirmed.length < 3) return;

    onImported({
      ...pendingImport,
      data: { ...pendingImport.data, name: confirmed },
      // Tells the server this name is the user's, so a later re-scan won't
      // overwrite it (property_profiles.name_source = 'manual').
      name_confirmed_by_user: true,
    });
    handleOpenChange(false);
  }

  /**
   * Un seul lien de profil → tous les logements créés d'un coup.
   *
   * Réutilise l'endpoint d'import en masse de l'archive plutôt que d'ouvrir un
   * second chemin d'écriture : c'est le même contenu (nom, identifiant Airbnb,
   * URL), la même déduplication sur UNIQUE(user_id, airbnb_listing_id), donc
   * relancer le scan met à jour au lieu de dupliquer.
   *
   * Ce que cette voie ne fait PAS : aller chercher la fiche complète de chaque
   * annonce. Vingt pages Airbnb à télécharger tiendraient le dialogue plusieurs
   * minutes et échoueraient à la moindre limitation. Les logements sont donc
   * créés tout de suite, et l'hôte les enrichit ensuite — soit à la main, soit
   * avec « Mettre à jour depuis Airbnb » sur la fiche.
   */
  async function handleImportAllFromProfile() {
    if (inFlight.current) return;
    const chosen = listings.filter((l, i) => selected.has(i) && l.name);
    if (chosen.length === 0) return;
    setError('');
    inFlight.current = true;
    try {
      const result = await importArchive.mutateAsync(
        chosen.map((l) => ({
          // Le vrai titre de l'annonce, résolu par le serveur depuis sa fiche.
          // Aucun nom de repli n'est envoyé : baptiser un logement
          // « Logement Airbnb #<id> » produisait une ligne indiscernable d'une
          // vraie, et c'est ce nom que Michel citait ensuite au voyageur.
          name: l.name,
          external_listing_id: l.id,
          url: l.url || `https://www.airbnb.fr/rooms/${l.id}`,
        }))
      );
      setSummary(result);
      setStep('archive-summary');
    } catch (err) {
      setError(err.message || "L'import a échoué.");
    } finally {
      inFlight.current = false;
    }
  }

  async function handlePickListing(listing) {
    if (inFlight.current || importingId != null) return;
    inFlight.current = true;
    try {
      await runImport(listing.id, listing.name);
    } finally {
      inFlight.current = false;
    }
  }

  // ── Archive ZIP ──────────────────────────────────────────────────────────

  /**
   * Le ZIP complet d'Airbnb, ou des .json choisis un à un.
   *
   * L'archive est ouverte ICI, dans le navigateur, et seuls les fichiers de
   * logement sont téléversés : sur un export réel, 13 Mo au lieu de 156, et
   * surtout les conversations avec les voyageurs, les virements et la pièce
   * d'identité ne quittent jamais la machine de l'hôte (voir lib/airbnbZip.js).
   */
  async function handleArchiveFiles(fileList) {
    const files = Array.from(fileList || []);
    if (files.length === 0 || inFlight.current) return;
    setError('');

    inFlight.current = true;
    setPreparing(true);
    try {
      const { blob } = await prepareAirbnbUpload(files);
      const result = await previewArchive.mutateAsync(blob);
      setArchive(result);
      // Tout est sélectionné par défaut — y compris ce qui est déjà importé,
      // qui sera mis à jour, et que l'hôte peut décocher.
      setSelected(new Set(result.listings.map((_, i) => i)));
      setStep('archive-preview');
    } catch (err) {
      setError(err.message || "Impossible de lire ce fichier.");
    } finally {
      setPreparing(false);
      inFlight.current = false;
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  function toggleListing(index) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  async function handleBulkImport() {
    if (inFlight.current || !archive) return;
    setError('');
    const chosen = archive.listings.filter((_, i) => selected.has(i));
    if (chosen.length === 0) return;

    inFlight.current = true;
    try {
      // La fiche entière repart telle que le serveur l'a normalisée : c'est
      // elle qui porte la description, l'adresse, la capacité, les équipements
      // et les tarifs. Le serveur la repasse intégralement à son filtre de
      // validation avant d'écrire quoi que ce soit.
      const result = await importArchive.mutateAsync(chosen.map(toImportPayload));
      setSummary(result);
      setStep('archive-summary');
    } catch (err) {
      setError(err.message || "L'import a échoué.");
    } finally {
      inFlight.current = false;
    }
  }

  const busy =
    scanProfile.isPending || importListing.isPending || preparing
    || previewArchive.isPending || importArchive.isPending;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      {/* Mobile: near-full-width sheet with its own scroll, so long listing
          grids and the on-screen keyboard never push content off-screen. */}
      <DialogContent className="max-h-[90dvh] w-[calc(100vw-1.5rem)] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Importer mes logements</DialogTitle>
          <DialogDescription>Depuis vos données Airbnb, ou un lien d&apos;annonce.</DialogDescription>
        </DialogHeader>

        {error && <p className="rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}

        {/* Premier écran : le choix, et rien d'autre.
            Les deux voies demandent des gestes très différents — un lien
            d'annonce d'un côté, une adresse de profil ou un export de l'autre.
            Les présenter ensemble obligeait à lire les deux pour comprendre
            laquelle s'applique. */}
        {step === 'choice' && (
          <div className="space-y-3">
            <button
              type="button"
              onClick={() => setStep('single')}
              className="flex w-full items-start gap-3 rounded-md border border-border p-3.5 text-left transition-colors hover:border-primary/40 hover:bg-primary/[0.03]"
            >
              <Home className="mt-0.5 size-4 shrink-0 text-primary" />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold text-foreground">Importer un logement</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  Avec le lien d&apos;une annonce. La fiche est remplie automatiquement.
                </span>
              </span>
              <ArrowRight className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            </button>

            <button
              type="button"
              onClick={() => setStep('all')}
              className="flex w-full items-start gap-3 rounded-md border border-border p-3.5 text-left transition-colors hover:border-primary/40 hover:bg-primary/[0.03]"
            >
              <Building2 className="mt-0.5 size-4 shrink-0 text-primary" />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold text-foreground">Importer toutes mes annonces</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  Avec l&apos;adresse de votre profil hôte, ou votre export de données Airbnb.
                </span>
              </span>
              <ArrowRight className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            </button>

            <DialogFooter>
              <Button type="button" variant="outline" className="w-full sm:w-auto" onClick={() => handleOpenChange(false)}>
                Annuler
              </Button>
            </DialogFooter>
          </div>
        )}

        {/* Un logement, par son lien. La voie d'origine, inchangée. */}
        {step === 'single' && (
          <form className="space-y-3" onSubmit={handleAnalyze}>
            <AirbnbLinkField id="airbnb-url" value={url} onChange={setUrl} disabled={busy} />

            <DialogFooter className="flex-col gap-2 sm:flex-row">
              <Button type="button" variant="outline" className="w-full sm:w-auto" onClick={() => setStep('choice')}>
                <ArrowLeft /> Retour
              </Button>
              <Button type="submit" className="w-full sm:w-auto" disabled={busy || !url.trim()}>
                {(scanProfile.isPending || importListing.isPending) && <Loader2 className="animate-spin" />}
                Analyser et remplir le formulaire
                <ArrowRight />
              </Button>
            </DialogFooter>
          </form>
        )}

        {/* Toutes les annonces.
            L'export passe en premier : c'est la seule voie qui rend une fiche
            complète (description, adresse, capacité, équipements, tarifs,
            calendrier). Le scan de profil, lui, ne rend qu'un nom et un lien —
            il reste offert pour l'hôte qui n'a pas encore demandé son export,
            mais ce n'est plus ce qu'on propose d'abord. */}
        {step === 'all' && (
          <div className="space-y-5">
            <div className="space-y-2.5 rounded-md border border-primary/30 bg-primary/[0.03] p-3.5">
              <div className="flex items-center gap-2">
                <FileArchive className="size-4 text-primary" />
                <h4 className="text-sm font-semibold text-foreground">Importer mon export Airbnb</h4>
              </div>
              <p className="text-xs text-muted-foreground">
                Déposez le fichier ZIP complet fourni par Airbnb. Michel détectera
                automatiquement vos logements et leurs informations.
              </p>

              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept=".zip,.json,application/zip,application/json"
                className="hidden"
                onChange={(e) => handleArchiveFiles(e.target.files)}
              />
              <Button
                type="button"
                className="w-full"
                disabled={busy}
                onClick={() => fileInputRef.current?.click()}
              >
                {preparing || previewArchive.isPending
                  ? <Loader2 className="animate-spin" />
                  : <Upload className="size-4" />}
                Importer mon export Airbnb
              </Button>

              <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
                <FileJson className="mt-0.5 size-3.5 shrink-0" />
                <span>
                  Ou sélectionnez plusieurs fichiers JSON&nbsp;: <strong>listings</strong>,{' '}
                  <strong>listing_pricing</strong>, <strong>listing_calendar</strong>,{' '}
                  <strong>listing_permits</strong>.
                </span>
              </p>

              {preparing ? (
                <p className="text-xs text-muted-foreground">
                  Ouverture de l&apos;archive sur votre appareil…
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  L&apos;archive est ouverte <strong>sur votre appareil</strong> : seuls les
                  fichiers de logement sont envoyés. Vos messages, paiements et pièces
                  d&apos;identité ne quittent pas votre machine, et rien n&apos;est enregistré
                  tant que vous n&apos;avez pas validé.
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                Pour obtenir cet export : Compte → Confidentialité et partage → Vos données,
                au format <strong>JSON</strong>.
              </p>
            </div>

            <form className="space-y-3 rounded-md border border-border p-3.5" onSubmit={handleAnalyze}>
              <div className="flex items-center gap-2">
                <Building2 className="size-4 text-primary" />
                <h4 className="text-sm font-semibold text-foreground">
                  Sinon — depuis mon profil Airbnb
                </h4>
              </div>
              <p className="text-xs text-muted-foreground">
                Sans export sous la main : les logements sont créés avec leur nom et leur
                lien, à compléter ensuite.
              </p>

              <ol className="list-decimal space-y-1 pl-4 text-xs text-muted-foreground">
                <li>Ouvrez l&apos;une de vos annonces sur Airbnb.</li>
                <li>Descendez jusqu&apos;à la section « Hôte ».</li>
                <li>Cliquez sur votre profil d&apos;hôte.</li>
                <li>Copiez l&apos;adresse de la page qui s&apos;ouvre.</li>
              </ol>
              <p className="rounded bg-muted px-2 py-1 text-[11px] text-muted-foreground">
                Exemple : https://www.airbnb.fr/users/profile/1462634058239796981
              </p>

              <div className="space-y-1.5">
                <Label htmlFor="airbnb-profile-url">Adresse du profil</Label>
                <Input
                  id="airbnb-profile-url"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  disabled={busy}
                  placeholder="https://www.airbnb.fr/users/profile/…"
                />
              </div>

              <Button type="submit" className="w-full" disabled={busy || !url.trim()}>
                {scanProfile.isPending ? <Loader2 className="animate-spin" /> : <ArrowRight className="size-4" />}
                Chercher mes annonces
              </Button>
              {/* L'attente est annoncée parce qu'elle est réelle : la page est
                  ouverte dans un vrai navigateur, puis déroulée jusqu'au bout.
                  Une dizaine de secondes sans un mot passerait pour une panne. */}
              {scanProfile.isPending ? (
                <p className="text-xs text-muted-foreground">
                  Ouverture de votre profil et lecture des annonces… Comptez une quinzaine de
                  secondes.
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Airbnb charge ses annonces dans le navigateur : Michel ouvre donc réellement
                  la page. Comptez une quinzaine de secondes. Si Airbnb refuse la lecture,
                  passez par l&apos;export ci-dessus.
                </p>
              )}
            </form>

            <DialogFooter>
              <Button type="button" variant="outline" className="w-full sm:w-auto" onClick={() => setStep('choice')}>
                <ArrowLeft /> Retour
              </Button>
            </DialogFooter>
          </div>
        )}

        {step === 'archive-preview' && archive && (
          <div className="space-y-3">
            {archive.listings.length === 0 ? (
              <div className="space-y-2">
                <p className="flex items-start gap-2 rounded-md bg-warning/10 px-3 py-2 text-sm text-foreground">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
                  Aucun logement n&apos;a été reconnu dans cette archive. Le format de l&apos;export
                  Airbnb évolue : envoyez-nous un exemple anonymisé et la détection sera ajustée.
                </p>
                {archive.scanned_files?.length > 0 && (
                  <details className="text-xs text-muted-foreground">
                    <summary className="cursor-pointer">Fichiers examinés ({archive.scanned_files.length})</summary>
                    <ul className="mt-1 space-y-0.5">
                      {archive.scanned_files.map((f) => <li key={f}>{f}</li>)}
                    </ul>
                  </details>
                )}
              </div>
            ) : (
              <>
                <p className="text-sm text-foreground">
                  <strong>{archive.total}</strong> logement(s) détecté(s).
                  {archive.already_imported > 0 && ` ${archive.already_imported} déjà présent(s).`}
                  {archive.needs_verification > 0 && ` ${archive.needs_verification} sans identifiant Airbnb.`}
                </p>

                {/* Ce que l'analyse des conversations a réellement traité. On
                    annonce des décomptes vérifiables plutôt qu'une promesse :
                    l'hôte voit combien de ses échanges ont pu être rattachés à
                    un logement, et que rien ne sera écrit sans son accord. */}
                {archive.fact_analysis?.facts_total > 0 && (
                  <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
                    <strong className="text-foreground">
                      {archive.fact_analysis.facts_total} information(s)
                    </strong>{' '}
                    repérée(s) dans {archive.fact_analysis.threads_linked} de vos conversations
                    (sur {archive.fact_analysis.threads_in_export} au total).
                    Rien n&apos;est enregistré comme certain : vous confirmerez après l&apos;import.
                  </p>
                )}

                <div className="max-h-[45dvh] space-y-1 overflow-y-auto rounded-md border border-border p-2">
                  {archive.listings.map((listing, index) => (
                    <label
                      key={`${listing.external_listing_id || listing.name}-${index}`}
                      className="flex min-h-11 cursor-pointer items-start gap-2.5 rounded-md px-2 py-1.5 hover:bg-muted"
                    >
                      <Checkbox
                        className="mt-0.5"
                        checked={selected.has(index)}
                        onCheckedChange={() => toggleListing(index)}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-foreground">{listing.name}</span>
                        <span className="block text-xs text-muted-foreground">
                          {listing.external_listing_id
                            ? `ID Airbnb ${listing.external_listing_id}`
                            : 'Sans identifiant Airbnb — à vérifier après import'}
                          {listing.already_imported && ' · déjà présent, sera mis à jour'}
                        </span>

                        {/* Ce qui a réellement été trouvé POUR CE LOGEMENT.
                            Une ligne absente veut dire que le fichier
                            correspondant ne parlait pas de lui — on ne promet
                            rien qu'on n'ait pas lu. */}
                        {listing.found && (
                          <span className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
                            {FOUND_LABELS.filter(([key]) => listing.found[key]).map(([key, label]) => (
                              <span key={key} className="flex items-center gap-1 text-xs text-success">
                                <Check className="size-3 shrink-0" aria-hidden="true" />
                                {label}
                              </span>
                            ))}
                          </span>
                        )}
                      </span>
                    </label>
                  ))}
                </div>

                {archive.warnings?.length > 0 && (
                  <ul className="space-y-0.5 text-xs text-muted-foreground">
                    {archive.warnings.map((w) => <li key={w}>{w}</li>)}
                  </ul>
                )}
              </>
            )}

            <DialogFooter className="flex-col gap-2 sm:flex-row">
              <Button type="button" variant="outline" className="w-full sm:w-auto" onClick={() => setStep('all')}>
                <ArrowLeft /> Retour
              </Button>
              <Button
                type="button"
                className="w-full sm:w-auto"
                disabled={busy || selected.size === 0}
                onClick={handleBulkImport}
              >
                {importArchive.isPending && <Loader2 className="animate-spin" />}
                Importer {selected.size} logement{selected.size > 1 ? 's' : ''}
              </Button>
            </DialogFooter>
          </div>
        )}

        {step === 'archive-summary' && summary && (
          <div className="space-y-3">
            <ul className="space-y-1 text-sm text-foreground">
              <li>{summary.summary.created} logement(s) ajouté(s)</li>
              <li>{summary.summary.updated} mis à jour</li>
              <li>{summary.summary.skipped} déjà présent(s), ignoré(s)</li>
              <li className={summary.summary.failed > 0 ? 'text-danger' : undefined}>
                {summary.summary.failed} en erreur
              </li>
            </ul>

            {summary.details?.failed?.length > 0 && (
              <details className="text-xs text-muted-foreground">
                <summary className="cursor-pointer">Détail des erreurs</summary>
                <ul className="mt-1 space-y-0.5">
                  {summary.details.failed.map((f, i) => (
                    <li key={`${f.name}-${i}`}>{f.name} — {f.reason}</li>
                  ))}
                </ul>
              </details>
            )}

            <p className="text-xs text-muted-foreground">
              Ouvrez chaque logement pour compléter ses informations : Michel s&apos;en sert
              pour répondre aux voyageurs.
            </p>

            <DialogFooter>
              <Button type="button" className="w-full sm:w-auto" onClick={() => handleOpenChange(false)}>
                <Check /> Terminer
              </Button>
            </DialogFooter>
          </div>
        )}

        {step === 'grid' && (
          <div className="space-y-3">
            <p className="text-sm text-foreground">
              <strong>{listings.length}</strong> annonce(s) trouvée(s) sur ce profil.
              {listings.some((l) => !l.name) &&
                " Certaines n'ont pas livré leur titre : décochez-les ou importez-les par leur lien."}
            </p>

            {/* Liste à cocher : l'hôte retire ce qu'il ne veut pas avant
                d'écrire quoi que ce soit. Une annonce dont le titre n'a pas pu
                être lu n'est PAS cochable — l'importer créerait un logement mal
                nommé, ce que ce projet refuse de faire. */}
            <div className="max-h-[45dvh] space-y-1 overflow-y-auto rounded-md border border-border p-2">
              {listings.map((listing, index) => (
                <label
                  key={listing.id}
                  className={cn(
                    'flex min-h-11 items-start gap-2.5 rounded-md px-2 py-1.5',
                    listing.name ? 'cursor-pointer hover:bg-muted' : 'opacity-60'
                  )}
                >
                  <Checkbox
                    className="mt-0.5"
                    disabled={!listing.name}
                    checked={selected.has(index)}
                    onCheckedChange={() => toggleListing(index)}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-foreground">
                      {listing.name || 'Titre non récupéré'}
                    </span>
                    <span className="block text-xs text-muted-foreground">ID Airbnb {listing.id}</span>
                  </span>
                </label>
              ))}
            </div>

            <p className="text-xs text-muted-foreground">
              Les logements sont créés avec leur nom et leur lien Airbnb. Ouvrez ensuite
              chaque fiche pour compléter les informations dont Michel se sert pour répondre.
            </p>

            <DialogFooter className="flex-col gap-2 sm:flex-row">
              <Button type="button" variant="outline" className="w-full sm:w-auto" onClick={() => setStep('all')}>
                <ArrowLeft /> Retour
              </Button>
              <Button
                type="button"
                className="w-full sm:w-auto"
                disabled={busy || selected.size === 0}
                onClick={handleImportAllFromProfile}
              >
                {importArchive.isPending ? <Loader2 className="animate-spin" /> : <Check className="size-4" />}
                Importer {selected.size} logement{selected.size > 1 ? 's' : ''}
              </Button>
            </DialogFooter>
          </div>
        )}

        {step === 'confirm-name' && (
          <form className="space-y-3" onSubmit={handleConfirmName}>
            <p className="rounded-md bg-warning/10 px-3 py-2 text-sm text-foreground">
              {pendingImport?.warning
                || "Airbnb n'a pas laissé récupérer le nom de l'annonce. Vérifiez-le avant de créer le logement."}
            </p>

            <div className="space-y-1.5">
              <Label htmlFor="confirm-listing-name">Nom du logement</Label>
              <Input
                id="confirm-listing-name"
                value={nameInput}
                onChange={(e) => setNameInput(e.target.value)}
                placeholder="Ex. La Villa Cosy - Proche Bordeaux"
                autoFocus
                enterKeyHint="done"
                maxLength={200}
              />
              <p className="text-xs text-muted-foreground">
                Le reste des informations a bien été récupéré. Ce nom sera conservé même après une nouvelle analyse.
              </p>
            </div>

            <DialogFooter className="flex-col gap-2 sm:flex-row">
              <Button type="button" variant="outline" className="w-full sm:w-auto" onClick={() => setStep('all')}>
                <ArrowLeft /> Retour
              </Button>
              <Button type="submit" className="w-full sm:w-auto" disabled={nameInput.trim().length < 3}>
                <Check /> Confirmer et continuer
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
