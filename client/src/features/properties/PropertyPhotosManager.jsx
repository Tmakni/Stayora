import { ImageOff, Star, Trash2 } from 'lucide-react';
import { cn } from '../../lib/utils';

export function PropertyPhotosManager({ photos = [], onRemove, onSetMain }) {
  if (photos.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-md border border-dashed border-border py-10 text-center">
        <ImageOff className="size-6 text-muted-foreground" />
        <p className="mt-2 text-sm text-muted-foreground">Aucune photo. Importez ce logement depuis Airbnb pour récupérer ses photos.</p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      {photos.map((photo, index) => (
        <div key={photo.id || photo.url || index} className="group relative overflow-hidden rounded-md border border-border">
          <img src={photo.url || photo.image_url} alt={photo.alt || ''} className="aspect-square w-full object-cover" loading="lazy" />
          {photo.is_main ? (
            <span className="absolute left-1.5 top-1.5 rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-semibold text-primary-foreground">Principale</span>
          ) : (
            <button
              type="button"
              onClick={() => onSetMain(photo)}
              className="absolute left-1.5 top-1.5 flex items-center gap-1 rounded-full bg-black/55 px-1.5 py-0.5 text-[10px] font-medium text-white opacity-0 transition-opacity group-hover:opacity-100"
            >
              <Star className="size-3" /> Définir
            </button>
          )}
          <button
            type="button"
            onClick={() => onRemove(photo)}
            className={cn(
              'absolute right-1.5 top-1.5 flex size-6 items-center justify-center rounded-full bg-black/55 text-white opacity-0 transition-opacity group-hover:opacity-100'
            )}
            aria-label="Supprimer la photo"
          >
            <Trash2 className="size-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
