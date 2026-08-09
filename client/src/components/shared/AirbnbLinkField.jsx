import { useState } from 'react';
import { ExternalLink, ClipboardPaste, Check } from 'lucide-react';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Button } from '../ui/button';

// Page « Mes annonces » de l'espace hôte : une fois connecté, l'hôte y voit
// toutes ses annonces et peut ouvrir celle à importer pour en copier l'URL.
// (Vérifié : /users/show/me renvoie une 404 chez Airbnb, on ne peut donc pas
// pointer directement vers le profil de l'utilisateur sans connaître son id.)
export const AIRBNB_LISTINGS_URL = 'https://www.airbnb.fr/hosting/listings';

/**
 * Champ de saisie d'un lien Airbnb, avec les deux raccourcis qui suppriment
 * l'essentiel de la friction : ouvrir Airbnb au bon endroit, puis coller
 * l'URL copiée en un clic.
 *
 * Accepte indifféremment l'URL d'une annonce, celle d'un profil hôte, ou un
 * simple identifiant numérique — le serveur sait extraire l'un ou l'autre.
 */
export function AirbnbLinkField({
  id = 'airbnb-url',
  value,
  onChange,
  label = 'Lien Airbnb',
  placeholder = 'https://www.airbnb.fr/rooms/12345678',
  disabled = false,
}) {
  const [justPasted, setJustPasted] = useState(false);
  const [pasteError, setPasteError] = useState('');

  async function handlePaste() {
    setPasteError('');
    try {
      const text = await navigator.clipboard.readText();
      const trimmed = (text || '').trim();
      if (!trimmed) {
        setPasteError('Le presse-papiers est vide.');
        return;
      }
      onChange(trimmed);
      setJustPasted(true);
      setTimeout(() => setJustPasted(false), 1800);
    } catch {
      // Lecture du presse-papiers refusée (permission ou navigateur non
      // compatible) — la saisie manuelle reste toujours possible.
      setPasteError('Collez le lien manuellement (Ctrl+V).');
    }
  }

  return (
    <div className="space-y-2.5">
      <div className="rounded-md border border-border bg-muted/60 p-3">
        <p className="text-xs font-medium text-foreground">Comment récupérer votre lien ?</p>
        <ol className="mt-1.5 list-inside list-decimal space-y-1 text-xs text-muted-foreground">
          <li>Ouvrez vos annonces Airbnb avec le bouton ci-dessous.</li>
          <li>Ouvrez l&apos;annonce à importer et copiez l&apos;URL.</li>
          <li>Revenez ici et cliquez sur « Coller ».</li>
        </ol>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-2.5 w-full"
          onClick={() => window.open(AIRBNB_LISTINGS_URL, '_blank', 'noopener,noreferrer')}
        >
          <ExternalLink className="size-4" />
          Ouvrir mes annonces Airbnb
        </Button>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={id}>{label}</Label>
        <div className="flex gap-2">
          <Input
            id={id}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            disabled={disabled}
            className="flex-1"
          />
          <Button type="button" variant="outline" onClick={handlePaste} disabled={disabled} className="shrink-0">
            {justPasted ? <Check className="size-4 text-success" /> : <ClipboardPaste className="size-4" />}
            <span className="hidden sm:inline">{justPasted ? 'Collé' : 'Coller'}</span>
          </Button>
        </div>
        {pasteError && <p className="text-xs text-muted-foreground">{pasteError}</p>}
        <p className="text-xs text-muted-foreground">
          Astuce : l&apos;URL de votre profil hôte importe tous vos logements d&apos;un coup.
        </p>
      </div>
    </div>
  );
}
