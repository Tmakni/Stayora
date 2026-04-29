/**
 * iCal Calendar Routes
 * 
 * POST   /api/calendar/connect                     - Connect iCal URL to a property
 * DELETE /api/calendar/:propertyId                  - Disconnect calendar
 * GET    /api/calendar/:propertyId                  - Get calendar info + events
 * POST   /api/calendar/:propertyId/sync             - Force manual sync
 * GET    /api/calendar/:propertyId/availability      - Check availability between dates
 */
const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const icalController = require('../controllers/icalController');

router.use(authMiddleware);

router.post('/connect', icalController.connectCalendar);
router.delete('/:propertyId', icalController.disconnectCalendar);
router.get('/:propertyId', icalController.getCalendar);
router.post('/:propertyId/sync', icalController.syncCalendar);
router.get('/:propertyId/availability', icalController.checkAvailability);

module.exports = router;
