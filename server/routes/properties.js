const express = require('express');
const router = express.Router();
const propertyController = require('../controllers/propertyController');
const {
  importAirbnbListing, scanAirbnbProfile, confirmImport,
  updateFromAirbnb, getPropertyPhotos, deletePropertyPhoto, setMainPhoto,
} = require('../controllers/airbnbImportController');
const { previewArchive, bulkImport } = require('../controllers/archiveImportController');
const propertyFactsController = require('../controllers/propertyFactsController');
const authMiddleware = require('../middleware/auth');
const { importRateLimiter, archiveImportRateLimiter } = require('../middleware/rateLimit');

router.use(authMiddleware);

// ── Import en masse depuis l'archive de donnees personnelles Airbnb ─────────
//
// Le fichier arrive en CORPS BRUT plutot qu'en multipart : le client poste
// directement le File, ce qui evite d'ajouter un analyseur multipart au projet
// et, surtout, evite tout fichier temporaire sur le disque. Il est lu en
// memoire (services/zipReader.js) puis relache.
//
// ZIP d'archive ou JSON deja decompresse : les deux sont acceptes, et le
// service reconnait lequel au CONTENU. Le client poste dans les deux cas en
// application/octet-stream, DELIBEREMENT — un corps annonce application/json
// serait intercepte par le express.json() global de server.js, dont la borne
// est a 1 Mo, bien en dessous d'un export reel.
//
// POURQUOI 200 Mo, ET POURQUOI CE N'EST PAS CE QUI ARRIVE D'HABITUDE
// ------------------------------------------------------------------
// L'export Airbnb est livre NON COMPRESSE : 156 Mo sur l'export de reference,
// dont 70 Mo de conversations et 54 Mo d'historique de navigation. L'ancienne
// borne a 60 Mo refusait donc l'archive reelle avant meme de l'ouvrir.
//
// Le navigateur ouvre desormais l'archive LUI-MEME et n'envoie que les quatre
// fichiers de logement, soit ~13 Mo (client/src/lib/airbnbZip.js). Cette borne
// haute ne sert donc qu'au depot direct — curl, ou un client qui n'aurait pas
// pu pre-filtrer. Elle s'applique AVANT toute lecture ; les bornes de
// decompression (bombe ZIP) sont posees separement dans zipReader, et la liste
// blanche de airbnbExport limite ce qui est reellement decompresse.
router.post(
  '/import-archive/preview',
  archiveImportRateLimiter,
  express.raw({ type: ['application/zip', 'application/x-zip-compressed', 'application/octet-stream'], limit: '200mb' }),
  previewArchive
);
// L'import renvoie les fiches NORMALISEES que la previsualisation a rendues :
// description, adresse, equipements, tarifs et plages de dates bloquees. Sur
// une quarantaine de logements cela depasse la borne globale de 1 Mo posee
// dans server.js, qui vise les formulaires. Un analyseur dedie est donc pose
// ici, et sur cette route seulement.
router.post(
  '/import-archive',
  archiveImportRateLimiter,
  express.json({ limit: '8mb' }),
  bulkImport
);

// ── Centre de vérification des informations trouvées dans les conversations ──
//
// Déclaré AVANT `/:id` : sans cela, « facts » serait interprété comme un
// identifiant de logement par la route générique.
router.get('/facts/pending', propertyFactsController.getPendingFacts);
router.get('/:id/facts', propertyFactsController.getPropertyFacts);
router.post('/:id/facts/confirm-all', propertyFactsController.confirmAll);
router.post('/:id/facts/:factId/confirm', propertyFactsController.confirm);
router.post('/:id/facts/:factId/reject', propertyFactsController.reject);

// Import/scan Airbnb — rate limited (heavy external requests)
router.post('/import-airbnb', importRateLimiter, importAirbnbListing);
router.post('/scan-airbnb-profile', importRateLimiter, scanAirbnbProfile);
router.post('/confirm-import', importRateLimiter, confirmImport);

// Créer une nouvelle propriété
router.post('/', propertyController.createProperty);

// Obtenir toutes les propriétés de l'utilisateur
router.get('/', propertyController.getProperties);

// Obtenir une propriété spécifique
router.get('/:id', propertyController.getPropertyById);

// Mettre a jour une propriete.
//
// PUT et PATCH pointent volontairement sur le MEME gestionnaire : il a toujours
// eu une semantique de fusion (un champ absent du corps n'est pas modifie, et
// context_json est refusionne depuis l'existant). PATCH n'est donc pas un
// second chemin, c'est le verbe honnete pour ce que fait deja l'endpoint — et
// c'est celui qu'emploie la sauvegarde automatique du formulaire, qui n'envoie
// que les champs reellement modifies.
router.put('/:id', propertyController.updateProperty);
router.patch('/:id', propertyController.updateProperty);

// Supprimer une propriété
router.delete('/:id', propertyController.deleteProperty);

// Calendar / Availability
router.get('/:id/calendar', propertyController.getCalendar);
router.post('/:id/calendar', propertyController.addCalendarBlock);
router.delete('/:id/calendar/:blockId', propertyController.deleteCalendarBlock);

// Photos
router.get('/:id/photos', getPropertyPhotos);
router.delete('/:id/photos/:photoId', deletePropertyPhoto);
router.put('/:id/photos/:photoId/main', setMainPhoto);

// Update from Airbnb
router.put('/:id/update-from-airbnb', importRateLimiter, updateFromAirbnb);

module.exports = router;
