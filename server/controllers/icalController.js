/**
 * iCal Calendar Controller
 * 
 * Handles iCal connection, sync, and availability API endpoints.
 */
const logger = require('../utils/logger');
const { validateExternalUrl, validateId, validateDateString } = require('../utils/sanitize');

function getIcalService() {
  return require('../services/icalService');
}

/**
 * POST /api/calendar/connect
 * Body: { property_id, ical_url }
 */
async function connectCalendar(req, res) {
  try {
    const icalService = getIcalService();
    const { property_id, ical_url } = req.body;

    if (!property_id || !ical_url) {
      return res.status(400).json({ error: 'property_id et ical_url requis' });
    }

    // SSRF protection — validate URL before making any request
    const urlCheck = validateExternalUrl(ical_url);
    if (!urlCheck.valid) {
      return res.status(400).json({ error: `URL invalide: ${urlCheck.reason}` });
    }

    const calendar = await icalService.connectCalendar(req.userId, property_id, urlCheck.url);
    logger.info(`iCal connected for property ${property_id} by user ${req.userId}`);

    return res.json({ success: true, calendar });
  } catch (err) {
    logger.error('Connect calendar error:', err.message);
    return res.status(400).json({ error: err.message });
  }
}

/**
 * DELETE /api/calendar/:propertyId
 */
async function disconnectCalendar(req, res) {
  try {
    const icalService = getIcalService();
    const { propertyId } = req.params;
    await icalService.disconnectCalendar(req.userId, propertyId);
    return res.json({ success: true });
  } catch (err) {
    logger.error('Disconnect calendar error:', err.message);
    return res.status(400).json({ error: err.message });
  }
}

/**
 * GET /api/calendar/:propertyId
 * Returns calendar info + events in date range.
 * Query params: from (YYYY-MM-DD), to (YYYY-MM-DD)
 */
async function getCalendar(req, res) {
  try {
    const icalService = getIcalService();
    const { propertyId } = req.params;
    let from = req.query.from || new Date().toISOString().slice(0, 10);
    let to = req.query.to || new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10);

    if (!validateDateString(from) || !validateDateString(to)) {
      return res.status(400).json({ error: 'Invalid date format (YYYY-MM-DD)' });
    }

    const calendarInfo = await icalService.getCalendarInfo(propertyId);
    const events = await icalService.getEvents(propertyId, from, to);

    return res.json({
      success: true,
      connected: !!calendarInfo,
      calendar: calendarInfo,
      events,
      from,
      to
    });
  } catch (err) {
    logger.error('Get calendar error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

/**
 * POST /api/calendar/:propertyId/sync
 * Force manual sync of the iCal calendar.
 */
async function syncCalendar(req, res) {
  try {
    const icalService = getIcalService();
    const { propertyId } = req.params;
    const result = await icalService.syncPropertyCalendar(propertyId);
    return res.json({ success: true, ...result });
  } catch (err) {
    logger.error('Sync calendar error:', err.message);
    return res.status(400).json({ error: err.message });
  }
}

/**
 * GET /api/calendar/:propertyId/availability?start=YYYY-MM-DD&end=YYYY-MM-DD
 * Check if property is available between two dates.
 */
async function checkAvailability(req, res) {
  try {
    const icalService = getIcalService();
    const { propertyId } = req.params;
    const { start, end } = req.query;

    if (!start || !end) {
      return res.status(400).json({ error: 'Paramètres start et end requis (YYYY-MM-DD)' });
    }

    // Validate date format
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
      return res.status(400).json({ error: 'Format de date invalide (YYYY-MM-DD)' });
    }

    if (start >= end) {
      return res.status(400).json({ error: 'La date de fin doit être après la date de début' });
    }

    const result = await icalService.checkAvailability(propertyId, start, end);
    return res.json({ success: true, ...result });
  } catch (err) {
    logger.error('Check availability error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

module.exports = {
  connectCalendar,
  disconnectCalendar,
  getCalendar,
  syncCalendar,
  checkAvailability
};
