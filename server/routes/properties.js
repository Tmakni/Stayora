const express = require('express');
const router = express.Router();
const propertyController = require('../controllers/propertyController');
const {
  importAirbnbListing, scanAirbnbProfile, confirmImport,
  updateFromAirbnb, getPropertyPhotos, deletePropertyPhoto, setMainPhoto,
} = require('../controllers/airbnbImportController');
const { previewArchive, bulkImport } = require('../controllers/archiveImportController');
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
// 60 Mo : un export Airbnb complet tient tres largement dedans, et la borne
// s'applique AVANT toute lecture. Les bornes de decompression (bombe ZIP) sont
// posees separement dans zipReader.
router.post(
  '/import-archive/preview',
  archiveImportRateLimiter,
  express.raw({ type: ['application/zip', 'application/x-zip-compressed', 'application/octet-stream'], limit: '60mb' }),
  previewArchive
);
router.post('/import-archive', archiveImportRateLimiter, bulkImport);

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
