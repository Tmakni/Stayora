const express = require('express');
const router = express.Router();
const propertyController = require('../controllers/propertyController');
const {
  importAirbnbListing, scanAirbnbProfile, confirmImport,
  updateFromAirbnb, getPropertyPhotos, deletePropertyPhoto, setMainPhoto,
} = require('../controllers/airbnbImportController');
const authMiddleware = require('../middleware/auth');
const { importRateLimiter } = require('../middleware/rateLimit');

router.use(authMiddleware);

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

// Mettre à jour une propriété
router.put('/:id', propertyController.updateProperty);

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
