/**
 * iCal Sync Service
 * 
 * Downloads and parses iCal/ICS calendars from Airbnb (or any source),
 * stores events in the DB, and provides availability checking.
 */
const ical = require('node-ical');
const { getDatabase } = require('../config/db');
const logger = require('../utils/logger');

// ================================================================
// iCal URL validation
// ================================================================

/**
 * Basic validation of an iCal URL.
 * Accepts https:// URLs ending in .ics or containing /ical/ or /calendar/
 */
function isValidIcalUrl(url) {
  if (!url || typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    // Only allow https (Airbnb always uses https)
    if (parsed.protocol !== 'https:') return false;
    // Sanity check: must look like a calendar URL
    const path = parsed.pathname + parsed.search;
    return /\.(ics|ical)$/i.test(path) || /ical|calendar/i.test(path);
  } catch {
    return false;
  }
}

// ================================================================
// Connect / Disconnect calendar
// ================================================================

/**
 * Register an iCal URL for a property.
 * One property can only have one iCal calendar (replaces previous).
 */
async function connectCalendar(userId, propertyId, icalUrl) {
  if (!isValidIcalUrl(icalUrl)) {
    throw new Error('URL iCal invalide. Utilisez une URL https:// se terminant par .ics');
  }

  const db = getDatabase();

  // Verify property belongs to user
  const props = await db.query(
    'SELECT id FROM property_profiles WHERE id = ? AND user_id = ?',
    [propertyId, userId]
  );
  if (props.length === 0) throw new Error('Propriété non trouvée');

  // Upsert: delete existing then insert
  await db.query('DELETE FROM ical_calendars WHERE property_id = ?', [propertyId]);
  await db.query(
    `INSERT INTO ical_calendars (user_id, property_id, ical_url, sync_status)
     VALUES (?, ?, ?, 'pending')`,
    [userId, propertyId, icalUrl]
  );

  // Trigger first sync immediately
  try {
    await syncPropertyCalendar(propertyId);
  } catch (err) {
    logger.warn(`Initial sync failed for property ${propertyId}: ${err.message}`);
    // Don't throw — calendar is registered, sync will retry
  }

  const calendars = await db.query(
    'SELECT * FROM ical_calendars WHERE property_id = ?',
    [propertyId]
  );

  return calendars[0];
}

/**
 * Disconnect (remove) the iCal calendar for a property.
 */
async function disconnectCalendar(userId, propertyId) {
  const db = getDatabase();

  const props = await db.query(
    'SELECT id FROM property_profiles WHERE id = ? AND user_id = ?',
    [propertyId, userId]
  );
  if (props.length === 0) throw new Error('Propriété non trouvée');

  await db.query('DELETE FROM ical_events WHERE property_id = ?', [propertyId]);
  await db.query('DELETE FROM ical_calendars WHERE property_id = ?', [propertyId]);

  return { success: true };
}

// ================================================================
// Sync: download + parse + store events
// ================================================================

/**
 * Sync a single property's iCal calendar.
 * Downloads the .ics file, parses events, and upserts them into ical_events.
 */
async function syncPropertyCalendar(propertyId) {
  const db = getDatabase();

  const calendars = await db.query(
    'SELECT * FROM ical_calendars WHERE property_id = ?',
    [propertyId]
  );
  if (calendars.length === 0) {
    throw new Error('Aucun calendrier iCal connecté pour ce logement');
  }

  const cal = calendars[0];
  logger.info(`[iCal] Syncing property ${propertyId} from ${cal.ical_url}`);

  try {
    // Download and parse the iCal feed
    const events = await ical.async.fromURL(cal.ical_url);

    let synced = 0;
    let skipped = 0;
    const now = new Date().toISOString().slice(0, 10);

    for (const [key, event] of Object.entries(events)) {
      if (event.type !== 'VEVENT') continue;

      const uid = event.uid || key;
      const startDate = event.start ? formatIcalDate(event.start) : null;
      const endDate = event.end ? formatIcalDate(event.end) : null;

      if (!startDate || !endDate) { skipped++; continue; }

      // Skip events that ended more than 30 days ago (keep some history)
      if (endDate < new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10)) {
        skipped++;
        continue;
      }

      const summary = (event.summary || '').substring(0, 500);
      const status = inferEventStatus(event);

      // Upsert by UID: delete old then insert
      await db.query(
        'DELETE FROM ical_events WHERE property_id = ? AND event_uid = ?',
        [propertyId, uid]
      );
      await db.query(
        `INSERT INTO ical_events (property_id, event_uid, start_date, end_date, status, summary, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
        [propertyId, uid, startDate, endDate, status, summary]
      );
      synced++;
    }

    // Update sync status
    await db.query(
      `UPDATE ical_calendars SET last_synced_at = datetime('now'), sync_status = 'ok', sync_error = NULL, updated_at = datetime('now')
       WHERE property_id = ?`,
      [propertyId]
    );

    logger.info(`[iCal] Property ${propertyId} synced: ${synced} events, ${skipped} skipped`);
    return { synced, skipped };

  } catch (err) {
    // Record error
    await db.query(
      `UPDATE ical_calendars SET sync_status = 'error', sync_error = ?, updated_at = datetime('now')
       WHERE property_id = ?`,
      [err.message.substring(0, 500), propertyId]
    );
    logger.error(`[iCal] Sync failed for property ${propertyId}: ${err.message}`);
    throw err;
  }
}

/**
 * Sync ALL registered iCal calendars (called by the scheduler).
 */
async function syncAllCalendars() {
  const db = getDatabase();
  const calendars = await db.query('SELECT property_id FROM ical_calendars');

  let ok = 0;
  let errors = 0;

  for (const cal of calendars) {
    try {
      await syncPropertyCalendar(cal.property_id);
      ok++;
    } catch {
      errors++;
    }
  }

  if (calendars.length > 0) {
    logger.info(`[iCal] Bulk sync done: ${ok} ok, ${errors} errors out of ${calendars.length}`);
  }

  return { total: calendars.length, ok, errors };
}

// ================================================================
// Availability checking
// ================================================================

/**
 * Check if a property is available between two dates.
 * Checks both ical_events AND availability_blocks AND reservations.
 * 
 * @param {number} propertyId
 * @param {string} startDate - YYYY-MM-DD
 * @param {string} endDate - YYYY-MM-DD
 * @returns {{ available: boolean, conflictingBookings: Array }}
 */
async function checkAvailability(propertyId, startDate, endDate) {
  const db = getDatabase();
  const conflicts = [];

  // 1. Check iCal events
  const icalConflicts = await db.query(
    `SELECT start_date, end_date, summary, status FROM ical_events
     WHERE property_id = ? AND end_date > ? AND start_date < ?`,
    [propertyId, startDate, endDate]
  );
  for (const e of icalConflicts) {
    conflicts.push({
      start: e.start_date,
      end: e.end_date,
      source: 'ical',
      summary: e.summary
    });
  }

  // 2. Check manual availability blocks
  const blockConflicts = await db.query(
    `SELECT start_date, end_date, reason, guest_name FROM availability_blocks
     WHERE property_id = ? AND end_date > ? AND start_date < ?`,
    [propertyId, startDate, endDate]
  );
  for (const b of blockConflicts) {
    conflicts.push({
      start: b.start_date,
      end: b.end_date,
      source: 'manual',
      summary: b.guest_name || b.reason
    });
  }

  // 3. Check reservations table
  const resConflicts = await db.query(
    `SELECT check_in_date AS start_date, check_out_date AS end_date, guest_name, status
     FROM reservations
     WHERE property_id = ? AND check_out_date > ? AND check_in_date < ? AND status NOT IN ('cancelled', 'declined')`,
    [propertyId, startDate, endDate]
  );
  for (const r of resConflicts) {
    conflicts.push({
      start: r.start_date,
      end: r.end_date,
      source: 'reservation',
      summary: r.guest_name || r.status
    });
  }

  return {
    available: conflicts.length === 0,
    conflictingBookings: conflicts
  };
}

/**
 * Get all events for a property in a date range (for calendar display).
 */
async function getEvents(propertyId, from, to) {
  const db = getDatabase();

  const icalEvents = await db.query(
    `SELECT id, event_uid, start_date, end_date, status, summary
     FROM ical_events
     WHERE property_id = ? AND end_date >= ? AND start_date <= ?
     ORDER BY start_date ASC`,
    [propertyId, from, to]
  );

  return icalEvents;
}

/**
 * Get calendar connection info for a property.
 */
async function getCalendarInfo(propertyId) {
  const db = getDatabase();
  const calendars = await db.query(
    'SELECT * FROM ical_calendars WHERE property_id = ?',
    [propertyId]
  );
  return calendars.length > 0 ? calendars[0] : null;
}

// ================================================================
// Helpers
// ================================================================

/**
 * Convert an iCal date object to YYYY-MM-DD string.
 */
function formatIcalDate(date) {
  if (!date) return null;
  // node-ical returns Date objects or {type: 'date-time', ...}
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/**
 * Infer a status string from an iCal event.
 */
function inferEventStatus(event) {
  const summary = (event.summary || '').toLowerCase();
  if (summary.includes('reserved') || summary.includes('réservé') || summary.includes('airbnb') || summary.includes('booking')) {
    return 'reserved';
  }
  if (summary.includes('blocked') || summary.includes('bloqué') || summary.includes('not available') || summary.includes('indisponible')) {
    return 'blocked';
  }
  // Default: treat all iCal events as "reserved" (property is not available)
  return 'reserved';
}

module.exports = {
  isValidIcalUrl,
  connectCalendar,
  disconnectCalendar,
  syncPropertyCalendar,
  syncAllCalendars,
  checkAvailability,
  getEvents,
  getCalendarInfo
};
