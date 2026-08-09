import { useRef, useState } from 'react';
import { Loader2, ArrowLeft, ArrowRight, Check } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '../../components/ui/dialog';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { AirbnbLinkField } from '../../components/shared/AirbnbLinkField';
import { useImportAirbnbListing, useScanAirbnbProfile } from '../../hooks/useProperties';

export function AirbnbImportDialog({ open, onOpenChange, onImported }) {
  const [step, setStep] = useState('url');
  const [url, setUrl] = useState('');
  const [listings, setListings] = useState([]);
  const [error, setError] = useState('');
  const [importingId, setImportingId] = useState(null);

  // When Airbnb blocks title extraction the server returns the property data
  // with an empty name and needs_name_confirmation — the user confirms it here
  // rather than the app silently saving "Logement Airbnb #<id>".
  const [pendingImport, setPendingImport] = useState(null);
  const [nameInput, setNameInput] = useState('');

  // Guards a double submit: two fast clicks (or Enter held down) used to fire
  // two imports, and with `mutateAsync` in flight `isPending` has not flipped
  // yet on the very next tick.
  const inFlight = useRef(false);

  const importListing = useImportAirbnbListing();
  const scanProfile = useScanAirbnbProfile();

  function reset() {
    setStep('url');
    setUrl('');
    setListings([]);
    setError('');
    setImportingId(null);
    setPendingImport(null);
    setNameInput('');
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

    const isProfile = /\/users\/show\//i.test(trimmed);
    inFlight.current = true;
    try {
      if (isProfile) {
        const result = await scanProfile.mutateAsync(trimmed);
        if (!result.listings || result.listings.length === 0) {
          setError("Aucun logement n'a été trouvé sur ce profil.");
          return;
        }
        if (result.listings.length === 1) {
          await runImport(result.listings[0].id, result.listings[0].name);
          return;
        }
        setListings(result.listings);
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

  async function handlePickListing(listing) {
    if (inFlight.current || importingId != null) return;
    inFlight.current = true;
    try {
      await runImport(listing.id, listing.name);
    } finally {
      inFlight.current = false;
    }
  }

  const busy = scanProfile.isPending || importListing.isPending;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      {/* Mobile: near-full-width sheet with its own scroll, so long listing
          grids and the on-screen keyboard never push content off-screen. */}
      <DialogContent className="max-h-[90dvh] w-[calc(100vw-1.5rem)] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Connecter Airbnb</DialogTitle>
          <DialogDescription>Importez vos logements en quelques clics.</DialogDescription>
        </DialogHeader>

        {error && <p className="rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}

        {step === 'url' && (
          <form className="space-y-3" onSubmit={handleAnalyze}>
            <AirbnbLinkField id="airbnb-url" value={url} onChange={setUrl} disabled={busy} />

            <DialogFooter className="flex-col gap-2 sm:flex-row">
              <Button type="button" variant="outline" className="w-full sm:w-auto" onClick={() => handleOpenChange(false)}>
                Annuler
              </Button>
              <Button type="submit" className="w-full sm:w-auto" disabled={busy || !url.trim()}>
                {busy && <Loader2 className="animate-spin" />}
                Analyser et remplir le formulaire
                <ArrowRight />
              </Button>
            </DialogFooter>
          </form>
        )}

        {step === 'grid' && (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">{listings.length} logement(s) trouvé(s) — choisissez celui à importer.</p>
            <div className="grid max-h-[50dvh] grid-cols-1 gap-2 overflow-y-auto sm:grid-cols-2">
              {listings.map((listing) => (
                <button
                  key={listing.id}
                  type="button"
                  onClick={() => handlePickListing(listing)}
                  disabled={importingId != null}
                  className="flex min-h-11 flex-col items-start rounded-md border border-border p-3 text-left transition-colors hover:border-primary/40 hover:bg-primary/[0.03] disabled:opacity-50"
                >
                  <span className="text-sm font-medium text-foreground">{listing.name || `Logement #${listing.id}`}</span>
                  <span className="mt-1 text-xs text-muted-foreground">ID Airbnb {listing.id}</span>
                  {importingId === listing.id && <Loader2 className="mt-2 size-4 animate-spin text-primary" />}
                </button>
              ))}
            </div>
            <Button type="button" variant="outline" size="sm" onClick={() => setStep('url')}>
              <ArrowLeft /> Retour
            </Button>
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
              <Button type="button" variant="outline" className="w-full sm:w-auto" onClick={() => setStep('url')}>
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
