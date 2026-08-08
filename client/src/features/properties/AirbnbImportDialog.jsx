import { useState } from 'react';
import { Loader2, ArrowLeft, ArrowRight } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '../../components/ui/dialog';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { useImportAirbnbListing, useScanAirbnbProfile } from '../../hooks/useProperties';

export function AirbnbImportDialog({ open, onOpenChange, onImported }) {
  const [step, setStep] = useState('url');
  const [url, setUrl] = useState('');
  const [listings, setListings] = useState([]);
  const [error, setError] = useState('');
  const [importingId, setImportingId] = useState(null);

  const importListing = useImportAirbnbListing();
  const scanProfile = useScanAirbnbProfile();

  function reset() {
    setStep('url');
    setUrl('');
    setListings([]);
    setError('');
    setImportingId(null);
  }

  function handleOpenChange(next) {
    if (!next) reset();
    onOpenChange(next);
  }

  async function handleAnalyze(e) {
    e.preventDefault();
    setError('');
    const trimmed = url.trim();
    if (!trimmed) return;

    const isProfile = /\/users\/show\//i.test(trimmed);
    try {
      if (isProfile) {
        const result = await scanProfile.mutateAsync(trimmed);
        if (!result.listings || result.listings.length === 0) {
          setError("Aucun logement n'a été trouvé sur ce profil.");
          return;
        }
        if (result.listings.length === 1) {
          await importAndFinish(result.listings[0].id);
          return;
        }
        setListings(result.listings);
        setStep('grid');
      } else {
        await importAndFinish(trimmed);
      }
    } catch (err) {
      setError(err.message || "Impossible d'analyser ce lien Airbnb.");
    }
  }

  async function importAndFinish(listingId) {
    setImportingId(listingId);
    try {
      const result = await importListing.mutateAsync(listingId);
      onImported(result);
      handleOpenChange(false);
    } catch (err) {
      setError(err.message || "Impossible d'importer ce logement.");
    } finally {
      setImportingId(null);
    }
  }

  const busy = scanProfile.isPending || importListing.isPending;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Connecter Airbnb</DialogTitle>
          <DialogDescription>Importez vos logements en quelques clics.</DialogDescription>
        </DialogHeader>

        {error && <p className="rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}

        {step === 'url' && (
          <form className="space-y-3" onSubmit={handleAnalyze}>
            <div className="rounded-md border border-border bg-muted/60 p-3 text-xs text-muted-foreground">
              <p className="font-medium text-foreground">📋 Comment trouver le lien ?</p>
              <p className="mt-1">Un seul logement : collez son URL Airbnb (ex. airbnb.fr/rooms/12345678).</p>
              <p className="mt-1">Tous vos logements : collez l&apos;URL de votre profil hôte (Airbnb → votre photo → « Voir le profil »).</p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="airbnb-url">Lien Airbnb</Label>
              <Input
                id="airbnb-url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://www.airbnb.fr/rooms/12345678"
              />
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
                Annuler
              </Button>
              <Button type="submit" disabled={busy || !url.trim()}>
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
            <div className="grid max-h-80 grid-cols-1 gap-2 overflow-y-auto sm:grid-cols-2">
              {listings.map((listing) => (
                <button
                  key={listing.id}
                  type="button"
                  onClick={() => importAndFinish(listing.id)}
                  disabled={importingId != null}
                  className="flex flex-col items-start rounded-md border border-border p-3 text-left transition-colors hover:border-primary/40 hover:bg-primary/[0.03] disabled:opacity-50"
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
      </DialogContent>
    </Dialog>
  );
}
