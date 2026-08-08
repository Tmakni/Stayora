import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '../../components/ui/dialog';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '../../components/ui/select';
import { useCreateConversation } from '../../hooks/useConversations';
import { useProperties } from '../../hooks/useProperties';
import { BOOKING_STATUS_OPTIONS } from '../../lib/constants';

export function NewConversationDialog({ open, onOpenChange, onCreated }) {
  const { data: properties } = useProperties();
  const createConversation = useCreateConversation();

  const [title, setTitle] = useState('');
  const [propertyId, setPropertyId] = useState('');
  const [status, setStatus] = useState('inquiry');
  const [error, setError] = useState('');

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (!title.trim()) {
      setError('Le titre / nom du voyageur est requis.');
      return;
    }
    try {
      const result = await createConversation.mutateAsync({
        title: title.trim(),
        property_id: propertyId ? Number(propertyId) : null,
        booking_status: status,
      });
      toast.success('Conversation créée');
      onOpenChange(false);
      setTitle('');
      setPropertyId('');
      setStatus('inquiry');
      onCreated?.(result.conversation.id);
    } catch (err) {
      setError(err.message || 'Échec de la création.');
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Nouvelle conversation</DialogTitle>
        </DialogHeader>

        <form className="space-y-3.5" onSubmit={handleSubmit}>
          {error && <p className="rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}

          <div className="space-y-1.5">
            <Label htmlFor="conv-title">Titre / Nom du voyageur</Label>
            <Input id="conv-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="ex. Marie Dupont" />
          </div>

          <div className="space-y-1.5">
            <Label>Logement</Label>
            <Select value={propertyId} onValueChange={setPropertyId}>
              <SelectTrigger>
                <SelectValue placeholder="Aucun logement associé" />
              </SelectTrigger>
              <SelectContent>
                {(properties || []).map((p) => (
                  <SelectItem key={p.id} value={String(p.id)}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label>Statut</Label>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {BOOKING_STATUS_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Annuler
            </Button>
            <Button type="submit" disabled={createConversation.isPending}>
              {createConversation.isPending && <Loader2 className="animate-spin" />}
              Créer
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
