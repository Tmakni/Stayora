import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Loader2, CheckCircle2, Check, AlertTriangle } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../../components/ui/dialog';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../../components/ui/tabs';
import { Button } from '../../components/ui/button';
import { Switch } from '../../components/ui/switch';
import { Label } from '../../components/ui/label';
import { DynamicField } from '../../components/properties-form/DynamicField';
import { PropertyPhotosManager } from './PropertyPhotosManager';
import {
  FIELD_GROUPS,
  FORM_TABS,
  AMENITY_GROUPS,
  normalizePropertyIntoFormData,
  buildEmptyFormData,
} from '../../lib/propertyFields';
import { REPLY_TONES } from '../../lib/constants';
import { useProperty, useCreateProperty, useUpdateProperty, usePatchProperty, usePropertyPhotos } from '../../hooks/useProperties';
import { useAutosave } from '../../hooks/useAutosave';
import { api } from '../../lib/api';

export function PropertyFormDialog({ open, onOpenChange, property, imported, onSaved }) {
  const isEditing = !!property?.id;
  const fullPropertyQuery = useProperty(property?.id, { enabled: open && isEditing });
  const remotePhotosQuery = usePropertyPhotos(property?.id, { enabled: open && isEditing });
  const createProperty = useCreateProperty();
  const updateProperty = useUpdateProperty();
  const patchProperty = usePatchProperty();
  const qc = useQueryClient();

  const [formData, setFormData] = useState(buildEmptyFormData);
  const [localPhotos, setLocalPhotos] = useState([]);
  const [activeTab, setActiveTab] = useState('general');
  const submittingRef = useRef(false);
  const [error, setError] = useState('');
  const [closing, setClosing] = useState(false);

  // Clé de l'ouverture en cours. Le formulaire n'est hydraté qu'UNE fois par
  // ouverture — voir l'effet ci-dessous.
  const hydratedKeyRef = useRef(null);

  // La sauvegarde automatique n'existe que sur un logement déjà créé : tant
  // qu'il n'a pas d'id, il n'y a rien à mettre à jour. La création reste donc
  // un envoi explicite.
  const autosaveEnabled = open && isEditing && !imported;

  const persistPatch = useCallback(
    (patch) => patchProperty.mutateAsync({ id: property.id, payload: patch }),
    // property?.id est la seule dépendance qui compte ; mutateAsync est stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [property?.id]
  );

  const autosave = useAutosave({
    enabled: autosaveEnabled,
    values: formData,
    save: persistPatch,
  });
  const { flush: flushAutosave, setBaseline, hasPendingChanges } = autosave;

  /**
   * Hydratation du formulaire — UNE SEULE FOIS PAR OUVERTURE.
   *
   * L'ancienne version avait `fullPropertyQuery.data` en dépendance et
   * réécrivait `formData` à chaque nouvelle identité de cet objet. Or
   * useProperties invalide la clé ['properties'], qui est un PRÉFIXE de
   * ['properties', id] : supprimer une photo, définir la photo principale ou
   * enregistrer refetchait donc la fiche, et l'effet écrasait toute la saisie
   * en cours avec l'état serveur — en renvoyant au passage sur l'onglet
   * « Général ». C'était la disparition des champs signalée.
   *
   * Le drapeau ci-dessous fige l'hydratation : une fois le dialogue rempli, plus
   * aucun rafraîchissement réseau ne peut toucher ce que l'utilisateur a tapé.
   */
  useEffect(() => {
    if (!open) {
      hydratedKeyRef.current = null;
      // Couper la reference AVANT toute reouverture. Sans cela, rouvrir le
      // dialogue sur un AUTRE logement laisserait le moteur comparer les
      // valeurs encore affichees (celles du logement precedent) a l'ancienne
      // reference, et poster ce differentiel sur le nouvel identifiant.
      setBaseline(null);
      return;
    }

    const key = imported ? 'imported' : isEditing ? `edit:${property.id}` : 'new';
    if (hydratedKeyRef.current === key) return;

    if (imported) {
      const next = normalizePropertyIntoFormData(imported.data || imported);
      hydratedKeyRef.current = key;
      setActiveTab('general');
      setError('');
      setFormData(next);
      setLocalPhotos(imported.photos || []);
      setBaseline(null);
      return;
    }

    if (isEditing) {
      // On attend la fiche complète : hydrater avec un objet partiel, puis
      // compléter, serait une seconde écriture — exactement ce qu'on interdit.
      if (!fullPropertyQuery.data) return;
      let ctx = {};
      try {
        ctx = JSON.parse(fullPropertyQuery.data.context_json || '{}');
      } catch {
        /* contexte illisible : on repart des colonnes seules */
      }
      const next = normalizePropertyIntoFormData({ ...fullPropertyQuery.data, ...ctx });
      hydratedKeyRef.current = key;
      setActiveTab('general');
      setError('');
      setFormData(next);
      // Référence du différentiel : l'état tel que le serveur le connaît.
      setBaseline(next);
      return;
    }

    hydratedKeyRef.current = key;
    setActiveTab('general');
    setError('');
    setFormData(buildEmptyFormData());
    setLocalPhotos([]);
    setBaseline(null);
  }, [open, imported, isEditing, property?.id, fullPropertyQuery.data, setBaseline]);

  function setField(key, value) {
    setFormData((f) => ({ ...f, [key]: value }));
  }

  /** Sauvegarde immédiate — perte de focus, changement d'onglet, fermeture. */
  const saveNow = useCallback(() => {
    if (!autosaveEnabled) return Promise.resolve();
    return flushAutosave().catch(() => {
      /* le statut affiche l'échec ; les valeurs restent dans le formulaire */
    });
  }, [autosaveEnabled, flushAutosave]);

  function handleTabChange(next) {
    // Changer d'onglet n'a jamais démonté l'état (tout vit dans `formData`),
    // mais c'est le moment où l'utilisateur croit avoir « validé » sa saisie.
    saveNow();
    setActiveTab(next);
  }

  /**
   * Fermeture : on n'accepte de fermer qu'une fois la sauvegarde demandée
   * réellement passée. Sinon la dernière frappe, encore dans la temporisation,
   * partirait avec la fenêtre.
   */
  async function handleOpenChange(next) {
    if (next) {
      onOpenChange(true);
      return;
    }
    if (autosaveEnabled && hasPendingChanges()) {
      setClosing(true);
      try {
        await flushAutosave();
      } catch {
        // Échec réseau : on garde la fenêtre ouverte avec les valeurs intactes.
        setClosing(false);
        setError("L'enregistrement a échoué. Vos informations sont toujours là — réessayez.");
        return;
      } finally {
        setClosing(false);
      }
    }
    onOpenChange(false);
  }

  async function handleRemovePhoto(photo) {
    if (isEditing && photo.id) {
      try {
        await api.properties.deletePhoto(property.id, photo.id);
        qc.invalidateQueries({ queryKey: ['properties', property.id, 'photos'] });
        // Deleting the current main photo changes property.main_photo_url, which
        // lives on the ['properties'] list query (used by PropertyCard) — without
        // this the grid keeps showing the deleted photo until a full remount.
        qc.invalidateQueries({ queryKey: ['properties'] });
      } catch (err) {
        toast.error(err.message || 'Échec de la suppression de la photo.');
      }
    } else {
      setLocalPhotos((list) => list.filter((p) => p !== photo));
    }
  }

  async function handleSetMainPhoto(photo) {
    if (isEditing && photo.id) {
      try {
        await api.properties.setMainPhoto(property.id, photo.id);
        qc.invalidateQueries({ queryKey: ['properties', property.id, 'photos'] });
        // Same as above: main_photo_url is part of the ['properties'] list payload.
        qc.invalidateQueries({ queryKey: ['properties'] });
      } catch (err) {
        toast.error(err.message || 'Échec de la mise à jour.');
      }
    } else {
      setLocalPhotos((list) => list.map((p) => ({ ...p, is_main: p === photo })));
    }
  }

  const displayedPhotos = isEditing ? remotePhotosQuery.data?.photos || (Array.isArray(remotePhotosQuery.data) ? remotePhotosQuery.data : []) : localPhotos;

  async function handleSubmit(e) {
    e.preventDefault();
    // Synchronous double-submit guard: `saving` is React state and only becomes
    // true on the next render, so two fast clicks (or Enter held down) both get
    // through and create the property TWICE.
    if (submittingRef.current) return;
    setError('');
    if (!formData.name || !formData.property_type || !formData.bedrooms || !formData.beds || !formData.bathrooms || !formData.max_guests) {
      setError('Merci de renseigner au minimum le nom, le type, les chambres, lits, salles de bain et la capacité.');
      setActiveTab('general');
      return;
    }

    // Logement existant : le bouton force simplement l'envoi de ce qui reste en
    // attente, par le même chemin différentiel que la sauvegarde automatique.
    if (autosaveEnabled) {
      submittingRef.current = true;
      try {
        await flushAutosave();
        toast.success('Logement enregistré');
        onOpenChange(false);
        onSaved?.();
      } catch (err) {
        setError(err.message || "Échec de l'enregistrement.");
      } finally {
        submittingRef.current = false;
      }
      return;
    }

    const payload = { ...formData };
    if (!isEditing) {
      payload.photos = localPhotos;
      if (imported) {
        payload.source = 'airbnb';
        payload.airbnb_listing_id = imported.listing_id || imported.data?.airbnb_listing_id;
        // The user either confirmed the name in the import dialog, or edited
        // the pre-filled one here — either way it is theirs and a later
        // "mettre à jour depuis Airbnb" must not overwrite it.
        payload.name_confirmed_by_user =
          imported.name_confirmed_by_user === true ||
          formData.name !== (imported.data?.name || '');
      }
    }

    submittingRef.current = true;
    try {
      if (isEditing) {
        await updateProperty.mutateAsync({ id: property.id, payload });
        toast.success('Logement mis à jour');
      } else {
        await createProperty.mutateAsync(payload);
        toast.success('Logement ajouté');
      }
      onOpenChange(false);
      onSaved?.();
    } catch (err) {
      if (err.status === 409 && err.data?.alreadyExists) {
        setError('Ce logement Airbnb existe déjà sur votre compte. Modifiez-le depuis sa fiche pour le mettre à jour.');
      } else if (err.status === 400 && err.data?.needs_name_confirmation) {
        setError("Merci de saisir le vrai nom de l'annonce avant d'enregistrer.");
        setActiveTab('general');
      } else {
        setError(err.message || "Échec de l'enregistrement.");
      }
    } finally {
      submittingRef.current = false;
    }
  }

  const saving = createProperty.isPending || updateProperty.isPending || closing;
  const loadingExisting = isEditing && fullPropertyQuery.isLoading;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-3xl p-0 sm:p-0">
        <DialogHeader className="border-b border-border px-4 py-4 pt-safe sm:px-5 sm:pt-4">
          <DialogTitle>{isEditing ? `Modifier ${property?.name || 'le logement'}` : 'Ajouter un logement'}</DialogTitle>
        </DialogHeader>

        {loadingExisting ? (
          <div className="flex items-center justify-center p-16">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <form onSubmit={handleSubmit}>
            <div className="px-4 py-4 sm:px-5">
              {error && <p className="mb-3 rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}

              {imported && (
                <div className="mb-4 flex items-start gap-2 rounded-md border border-success/25 bg-success/10 px-3 py-2 text-xs text-foreground">
                  <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" />
                  Données importées depuis Airbnb — vérifiez et complétez les informations avant d&apos;enregistrer.
                </div>
              )}

              <Tabs value={activeTab} onValueChange={handleTabChange}>
                <TabsList className="sticky top-0 z-10 mb-4 h-auto w-full justify-start gap-1 bg-muted sm:flex-wrap">
                  {FORM_TABS.map((tab) => (
                    <TabsTrigger key={tab.id} value={tab.id} className="text-xs">
                      {tab.label}
                    </TabsTrigger>
                  ))}
                </TabsList>

                {FORM_TABS.map((tab) => (
                  <TabsContent key={tab.id} value={tab.id} className="space-y-6">
                    {tab.id === 'general' && (
                      <div className="space-y-3 rounded-md border border-border p-3.5">
                        <div className="flex items-center justify-between gap-4">
                          <div>
                            <Label>Réponse automatique IA</Label>
                            <p className="text-xs text-muted-foreground">Michel peut préparer des réponses pour ce logement.</p>
                          </div>
                          <Switch
                            checked={!!formData.auto_reply_enabled}
                            onCheckedChange={(v) => { setField('auto_reply_enabled', v); saveNow(); }}
                          />
                        </div>
                        {formData.auto_reply_enabled && (
                          <DynamicField
                            field={{ key: 'reply_tone', label: 'Ton des réponses', type: 'select', options: REPLY_TONES }}
                            value={formData.reply_tone}
                            onChange={(v) => setField('reply_tone', v)}
                            onBlur={saveNow}
                          />
                        )}
                      </div>
                    )}

                    {tab.amenities ? (
                      <AmenitiesFields formData={formData} setField={setField} onBlur={saveNow} />
                    ) : tab.photos ? (
                      <PropertyPhotosManager photos={displayedPhotos} onRemove={handleRemovePhoto} onSetMain={handleSetMainPhoto} />
                    ) : (
                      tab.groups.map((groupId) => {
                        const group = FIELD_GROUPS.find((g) => g.id === groupId);
                        if (!group) return null;
                        return (
                          <div key={group.id}>
                            <h4 className="mb-2.5 text-sm font-semibold text-foreground">{group.title}</h4>
                            <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
                              {group.fields.map((f) => (
                                <DynamicField
                                  key={f.key}
                                  field={f}
                                  value={formData[f.key]}
                                  onChange={(v) => setField(f.key, v)}
                                  onBlur={saveNow}
                                />
                              ))}
                            </div>
                          </div>
                        );
                      })
                    )}
                  </TabsContent>
                ))}
              </Tabs>
            </div>

            {/* Sticky action bar: on a phone the form is long, and the save
                button must stay reachable without scrolling to the bottom.
                pb-safe keeps it above the iPhone home indicator. */}
            <DialogFooter className="sticky bottom-0 items-center gap-2 border-t border-border bg-card px-4 py-3 pb-safe sm:px-5 sm:py-3.5">
              {autosaveEnabled && <AutosaveStatus status={autosave.status} />}
              <Button
                type="button"
                variant="outline"
                className="w-full sm:w-auto"
                onClick={() => handleOpenChange(false)}
                disabled={closing}
              >
                {/* « Annuler » serait mensonger dès lors que la saisie est déjà
                    enregistrée au fil de l'eau : il n'existe aucun mécanisme de
                    restauration des anciennes valeurs. */}
                {autosaveEnabled ? 'Fermer' : 'Annuler'}
              </Button>
              <Button type="submit" className="w-full sm:w-auto" disabled={saving}>
                {saving && <Loader2 className="animate-spin" />}
                Enregistrer le logement
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Statut discret de la sauvegarde automatique. « Enregistré » n'apparaît
 * qu'après confirmation réelle du serveur (voir useAutosave).
 */
function AutosaveStatus({ status }) {
  if (status === 'saving') {
    return (
      <span className="mr-auto flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" /> Enregistrement…
      </span>
    );
  }
  if (status === 'saved') {
    return (
      <span className="mr-auto flex items-center gap-1.5 text-xs text-muted-foreground">
        <Check className="size-3.5 text-success" /> Enregistré
      </span>
    );
  }
  if (status === 'error') {
    return (
      <span className="mr-auto flex items-center gap-1.5 text-xs text-danger">
        <AlertTriangle className="size-3.5" /> Échec de l&apos;enregistrement — vos données sont conservées
      </span>
    );
  }
  return <span className="mr-auto" />;
}

function AmenitiesFields({ formData, setField, onBlur }) {
  return (
    <div className="space-y-5">
      {AMENITY_GROUPS.map((group) => (
        <div key={group.id}>
          <h4 className="mb-2 text-sm font-semibold text-foreground">{group.title}</h4>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3">
            {group.fields.map((f) => (
              <DynamicField
                key={f.key}
                field={{ ...f, type: 'checkbox' }}
                value={formData[f.key]}
                onChange={(v) => setField(f.key, v)}
                onBlur={onBlur}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
