import { useState } from 'react';
import { toast } from 'sonner';
import { CalendarCheck2, CalendarX2, Loader2, RefreshCw, Unlink } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { useICalInfo, useConnectICal, useDisconnectICal, useSyncICal } from '../../hooks/useCalendar';
import { formatDate, cn } from '../../lib/utils';

export function ICalConnectionCard({ propertyId, from, to }) {
  const { data, isLoading } = useICalInfo(propertyId, from, to);
  const connectIcal = useConnectICal();
  const disconnectIcal = useDisconnectICal();
  const syncIcal = useSyncICal();
  const [showForm, setShowForm] = useState(false);
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');

  const connected = data?.connected;
  const calendar = data?.calendar;
  const syncing = calendar?.sync_status === 'syncing' || calendar?.sync_status === 'pending';
  const hasError = calendar?.sync_status === 'error';

  async function handleConnect(e) {
    e.preventDefault();
    setError('');
    if (!url.trim()) return;
    try {
      await connectIcal.mutateAsync({ propertyId, icalUrl: url.trim() });
      toast.success('Calendrier iCal connecté');
      setShowForm(false);
      setUrl('');
    } catch (err) {
      setError(err.message || 'Connexion impossible.');
    }
  }

  async function handleDisconnect() {
    try {
      await disconnectIcal.mutateAsync(propertyId);
      toast.success('Calendrier déconnecté');
    } catch (err) {
      toast.error(err.message || 'Échec de la déconnexion.');
    }
  }

  async function handleSync() {
    try {
      await syncIcal.mutateAsync(propertyId);
      toast.success('Synchronisation lancée');
    } catch (err) {
      toast.error(err.message || 'Échec de la synchronisation.');
    }
  }

  if (isLoading) return null;

  return (
    <div className="rounded-lg border border-border bg-card p-3.5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span
            className={cn(
              'flex size-8 items-center justify-center rounded-md',
              connected && !hasError ? 'bg-success/10 text-success' : hasError ? 'bg-danger/10 text-danger' : 'bg-muted text-muted-foreground'
            )}
          >
            {connected && !hasError ? <CalendarCheck2 className="size-4" /> : <CalendarX2 className="size-4" />}
          </span>
          <div>
            <p className="text-sm font-medium text-foreground">
              {connected ? 'Calendrier iCal connecté' : 'Calendrier iCal non connecté'}
              {syncing && <span className="ml-1.5 text-xs font-normal text-muted-foreground">(synchronisation…)</span>}
            </p>
            <p className="text-xs text-muted-foreground">
              {hasError
                ? `Erreur de synchronisation : ${calendar?.sync_error || 'inconnue'}`
                : connected
                ? `Dernière synchronisation : ${calendar?.last_synced_at ? formatDate(calendar.last_synced_at, { withTime: true }) : '—'}`
                : "Ajoutez le lien iCal de votre logement (Airbnb, Booking...) pour synchroniser ses réservations."}
            </p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {connected ? (
            <>
              <Button size="sm" variant="outline" onClick={handleSync} disabled={syncIcal.isPending}>
                {syncIcal.isPending ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                Synchroniser
              </Button>
              <Button size="sm" variant="outline" className="text-danger hover:bg-danger/10" onClick={handleDisconnect} disabled={disconnectIcal.isPending}>
                <Unlink /> Déconnecter
              </Button>
            </>
          ) : (
            <Button size="sm" onClick={() => setShowForm((v) => !v)}>
              Connecter un calendrier
            </Button>
          )}
        </div>
      </div>

      {showForm && !connected && (
        <form onSubmit={handleConnect} className="mt-3 space-y-2 border-t border-border pt-3">
          <div className="rounded-md bg-muted/60 p-2.5 text-xs text-muted-foreground">
            📋 Airbnb : Calendrier → Disponibilité → Synchroniser les calendriers → Exporter le calendrier.
          </div>
          {error && <p className="text-xs text-danger">{error}</p>}
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://www.airbnb.fr/calendar/ical/....ics" />
            <Button type="submit" disabled={connectIcal.isPending} className="shrink-0">
              {connectIcal.isPending && <Loader2 className="animate-spin" />}
              Connecter
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
