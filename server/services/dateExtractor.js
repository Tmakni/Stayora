/**
 * Date Extraction Service
 * 
 * Extracts start/end dates from guest messages in French and English.
 * Handles patterns like:
 *   - "du 10 au 15 avril"
 *   - "du 4 mai au 7 mai"
 *   - "pour le 12 avril"
 *   - "from April 10 to April 15"
 *   - "disponible le 10/04 ?"
 */
const logger = require('../utils/logger');

// French month names → month number (0-indexed)
const FR_MONTHS = {
  'janvier': 0, 'jan': 0, 'janv': 0,
  'février': 1, 'fevrier': 1, 'fév': 1, 'fev': 1,
  'mars': 2, 'mar': 2,
  'avril': 3, 'avr': 3,
  'mai': 4,
  'juin': 5,
  'juillet': 6, 'juil': 6,
  'août': 7, 'aout': 7,
  'septembre': 8, 'sept': 8, 'sep': 8,
  'octobre': 9, 'oct': 9,
  'novembre': 10, 'nov': 10,
  'décembre': 11, 'decembre': 11, 'déc': 11, 'dec': 11
};

// English month names → month number
const EN_MONTHS = {
  'january': 0, 'jan': 0,
  'february': 1, 'feb': 1,
  'march': 2, 'mar': 2,
  'april': 3, 'apr': 3,
  'may': 4,
  'june': 5, 'jun': 5,
  'july': 6, 'jul': 6,
  'august': 7, 'aug': 7,
  'september': 8, 'sep': 8, 'sept': 8,
  'october': 9, 'oct': 9,
  'november': 10, 'nov': 10,
  'december': 11, 'dec': 11
};

const ALL_MONTHS = { ...FR_MONTHS, ...EN_MONTHS };
const MONTH_PATTERN = Object.keys(ALL_MONTHS).sort((a, b) => b.length - a.length).join('|');

/**
 * Extract start and end dates from a guest message.
 * Returns { startDate: 'YYYY-MM-DD', endDate: 'YYYY-MM-DD' } or null.
 */
function extractDatesFromMessage(message) {
  if (!message || typeof message !== 'string') return null;

  const text = message.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const now = new Date();
  const currentYear = now.getFullYear();

  let result = null;

  // Pattern 0: Airbnb reservation email structured dates
  // ex: "Arrivée 15 avr. 2026" / "Départ 20 avr. 2026"
  // ex: "Arrivée\n15 avr.\nDépart\n20 avr."
  // ex: "Check-in Apr 15, 2026" / "Checkout Apr 20, 2026"
  result = tryPattern_airbnbReservation(text, currentYear);
  if (result) return result;

  // Pattern 1: "du X au Y month" or "du X month au Y month"
  // ex: "du 10 au 15 avril", "du 4 mai au 7 mai"
  result = tryPattern_duXauY(text, currentYear);
  if (result) return result;

  // Pattern 2: "from X to Y" (English)
  result = tryPattern_fromXtoY(text, currentYear);
  if (result) return result;

  // Pattern 3: DD/MM or DD-MM format ranges
  // ex: "10/04 au 15/04", "10-04 - 15-04"
  result = tryPattern_numericRange(text, currentYear);
  if (result) return result;

  // Pattern 4: YYYY-MM-DD format
  result = tryPattern_isoDate(text);
  if (result) return result;

  // Pattern 5: Single date "le 12 avril", "pour le 10 mai"
  result = tryPattern_singleDate(text, currentYear);
  if (result) return result;

  return null;
}

// ================================================================
// Pattern matchers
// ================================================================

function tryPattern_airbnbReservation(text, year) {
  // Airbnb FR emails: "arrivee X month" + "depart Y month" (accents stripped)
  // Formats: "arrivee 15 avr. 2026", "arrivee\n15 avr.", "arrivee : 15 avril"
  const arrivePattern = new RegExp(`(?:arriv[ée]e|check[\\s-]?in|arrive)[\\s:]*[\\n]?\\s*(\\d{1,2})\\s+(${MONTH_PATTERN})\\.?\\s*(?:(\\d{4}))?`, 'i');
  const departPattern = new RegExp(`(?:d[ée]part|check[\\s-]?out|depart(?:ure)?)[\\s:]*[\\n]?\\s*(\\d{1,2})\\s+(${MONTH_PATTERN})\\.?\\s*(?:(\\d{4}))?`, 'i');
  
  const arrMatch = text.match(arrivePattern);
  const depMatch = text.match(departPattern);
  
  if (arrMatch && depMatch) {
    const day1 = parseInt(arrMatch[1]);
    const month1 = ALL_MONTHS[arrMatch[2].toLowerCase()];
    const y1 = arrMatch[3] ? parseInt(arrMatch[3]) : year;
    const day2 = parseInt(depMatch[1]);
    const month2 = ALL_MONTHS[depMatch[2].toLowerCase()];
    const y2 = depMatch[3] ? parseInt(depMatch[3]) : year;
    if (month1 !== undefined && month2 !== undefined) {
      return buildResult(day1, month1, y1, day2, month2, y2);
    }
  }
  
  // Airbnb EN emails: "Check-in Apr 15, 2026" / "Checkout Apr 20, 2026"
  const arrivePatternEN = new RegExp(`(?:check[\\s-]?in|arrive|arrival)[\\s:]*[\\n]?\\s*(${MONTH_PATTERN})\\.?\\s+(\\d{1,2}),?\\s*(?:(\\d{4}))?`, 'i');
  const departPatternEN = new RegExp(`(?:check[\\s-]?out|depart|departure)[\\s:]*[\\n]?\\s*(${MONTH_PATTERN})\\.?\\s+(\\d{1,2}),?\\s*(?:(\\d{4}))?`, 'i');
  
  const arrMatchEN = text.match(arrivePatternEN);
  const depMatchEN = text.match(departPatternEN);
  
  if (arrMatchEN && depMatchEN) {
    const month1 = ALL_MONTHS[arrMatchEN[1].toLowerCase()];
    const day1 = parseInt(arrMatchEN[2]);
    const y1 = arrMatchEN[3] ? parseInt(arrMatchEN[3]) : year;
    const month2 = ALL_MONTHS[depMatchEN[1].toLowerCase()];
    const day2 = parseInt(depMatchEN[2]);
    const y2 = depMatchEN[3] ? parseInt(depMatchEN[3]) : year;
    if (month1 !== undefined && month2 !== undefined) {
      return buildResult(day1, month1, y1, day2, month2, y2);
    }
  }
  
  // Airbnb DD/MM/YYYY structured: "arrivee 15/04/2026" / "depart 20/04/2026"
  const arrNumeric = text.match(/(?:arriv[ée]e|check[\s-]?in)[\s:]*[\n]?\s*(\d{1,2})[/\-](\d{1,2})(?:[/\-](\d{4}))?/i);
  const depNumeric = text.match(/(?:d[ée]part|check[\s-]?out)[\s:]*[\n]?\s*(\d{1,2})[/\-](\d{1,2})(?:[/\-](\d{4}))?/i);
  
  if (arrNumeric && depNumeric) {
    const day1 = parseInt(arrNumeric[1]);
    const month1 = parseInt(arrNumeric[2]) - 1;
    const y1 = arrNumeric[3] ? parseInt(arrNumeric[3]) : year;
    const day2 = parseInt(depNumeric[1]);
    const month2 = parseInt(depNumeric[2]) - 1;
    const y2 = depNumeric[3] ? parseInt(depNumeric[3]) : year;
    if (month1 >= 0 && month1 <= 11 && month2 >= 0 && month2 <= 11) {
      return buildResult(day1, month1, y1, day2, month2, y2);
    }
  }
  
  return null;
}

function tryPattern_duXauY(text, year) {
  // "du 10 au 15 avril" (same month)
  const re1 = new RegExp(`du\\s+(\\d{1,2})\\s+au\\s+(\\d{1,2})\\s+(${MONTH_PATTERN})`, 'i');
  let m = text.match(re1);
  if (m) {
    const day1 = parseInt(m[1]);
    const day2 = parseInt(m[2]);
    const month = ALL_MONTHS[m[3].toLowerCase()];
    if (month !== undefined) {
      return buildResult(day1, month, year, day2, month, year);
    }
  }

  // "du 4 mai au 7 juin" (different months)
  const re2 = new RegExp(`du\\s+(\\d{1,2})\\s+(${MONTH_PATTERN})\\s+au\\s+(\\d{1,2})\\s+(${MONTH_PATTERN})`, 'i');
  m = text.match(re2);
  if (m) {
    const day1 = parseInt(m[1]);
    const month1 = ALL_MONTHS[m[2].toLowerCase()];
    const day2 = parseInt(m[3]);
    const month2 = ALL_MONTHS[m[4].toLowerCase()];
    if (month1 !== undefined && month2 !== undefined) {
      const y2 = month2 < month1 ? year + 1 : year;
      return buildResult(day1, month1, year, day2, month2, y2);
    }
  }

  // "entre le 10 et le 15 avril"
  const re3 = new RegExp(`entre\\s+le\\s+(\\d{1,2})\\s+et\\s+le\\s+(\\d{1,2})\\s+(${MONTH_PATTERN})`, 'i');
  m = text.match(re3);
  if (m) {
    const day1 = parseInt(m[1]);
    const day2 = parseInt(m[2]);
    const month = ALL_MONTHS[m[3].toLowerCase()];
    if (month !== undefined) {
      return buildResult(day1, month, year, day2, month, year);
    }
  }

  return null;
}

function tryPattern_fromXtoY(text, year) {
  // "from April 10 to April 15" or "from 10 April to 15 April"
  const re1 = new RegExp(`from\\s+(${MONTH_PATTERN})\\s+(\\d{1,2})\\s+to\\s+(${MONTH_PATTERN})\\s+(\\d{1,2})`, 'i');
  let m = text.match(re1);
  if (m) {
    const month1 = ALL_MONTHS[m[1].toLowerCase()];
    const day1 = parseInt(m[2]);
    const month2 = ALL_MONTHS[m[3].toLowerCase()];
    const day2 = parseInt(m[4]);
    if (month1 !== undefined && month2 !== undefined) {
      return buildResult(day1, month1, year, day2, month2, year);
    }
  }

  // "from 10 to 15 April"
  const re2 = new RegExp(`from\\s+(\\d{1,2})\\s+to\\s+(\\d{1,2})\\s+(${MONTH_PATTERN})`, 'i');
  m = text.match(re2);
  if (m) {
    const day1 = parseInt(m[1]);
    const day2 = parseInt(m[2]);
    const month = ALL_MONTHS[m[3].toLowerCase()];
    if (month !== undefined) {
      return buildResult(day1, month, year, day2, month, year);
    }
  }

  return null;
}

function tryPattern_numericRange(text, year) {
  // "10/04 au 15/04" or "10-04 au 15-04" or "10/04 - 15/04"
  const re = /(\d{1,2})[/\-](\d{1,2})\s*(?:au|-|à)\s*(\d{1,2})[/\-](\d{1,2})/;
  const m = text.match(re);
  if (m) {
    const day1 = parseInt(m[1]);
    const month1 = parseInt(m[2]) - 1; // 0-indexed
    const day2 = parseInt(m[3]);
    const month2 = parseInt(m[4]) - 1;
    if (month1 >= 0 && month1 <= 11 && month2 >= 0 && month2 <= 11) {
      return buildResult(day1, month1, year, day2, month2, year);
    }
  }
  return null;
}

function tryPattern_isoDate(text) {
  // "2026-04-10 au 2026-04-15" or two ISO dates
  const re = /(\d{4}-\d{2}-\d{2})\s*(?:au|to|-|à)\s*(\d{4}-\d{2}-\d{2})/;
  const m = text.match(re);
  if (m) {
    const d1 = new Date(m[1]);
    const d2 = new Date(m[2]);
    if (!isNaN(d1.getTime()) && !isNaN(d2.getTime())) {
      return {
        startDate: m[1],
        endDate: m[2]
      };
    }
  }
  return null;
}

function tryPattern_singleDate(text, year) {
  // "le 12 avril", "pour le 10 mai", "le 5 juin"
  const re = new RegExp(`(?:le|pour le|pour|ce|nuit du)\\s+(\\d{1,2})\\s+(${MONTH_PATTERN})`, 'i');
  const m = text.match(re);
  if (m) {
    const day = parseInt(m[1]);
    const month = ALL_MONTHS[m[2].toLowerCase()];
    if (month !== undefined) {
      // Single date → assume one night (startDate = day, endDate = day+1)
      const start = new Date(year, month, day);
      const end = new Date(year, month, day + 1);
      if (!isNaN(start.getTime())) {
        return {
          startDate: formatDate(start),
          endDate: formatDate(end)
        };
      }
    }
  }
  return null;
}

// ================================================================
// Helpers
// ================================================================

function buildResult(day1, month1, year1, day2, month2, year2) {
  const start = new Date(year1, month1, day1);
  const end = new Date(year2, month2, day2);

  if (isNaN(start.getTime()) || isNaN(end.getTime())) return null;

  // If dates are in the past, assume next year
  const now = new Date();
  if (end < now) {
    start.setFullYear(start.getFullYear() + 1);
    end.setFullYear(end.getFullYear() + 1);
  }

  if (start >= end) return null;

  return {
    startDate: formatDate(start),
    endDate: formatDate(end)
  };
}

function formatDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Quick check: does this message ask about availability/dates?
 */
function isAvailabilityQuestion(message) {
  if (!message) return false;
  const text = message.toLowerCase();
  const patterns = [
    /disponible|dispo|libre|available|availability/,
    /du\s+\d+\s+(au|à)\s+\d+/,
    /\d{1,2}[/\-]\d{1,2}\s*(au|-)\s*\d{1,2}/,
    /réserver|reserver|book|reserve/,
    /dates?\s+(de\s+)?séjour/,
    /nuit(s|ée)?\s+du/,
    /check[\s-]?in/,
    /from\s+\w+\s+\d+\s+to/,
    // Airbnb reservation request patterns
    /demande\s+de\s+r[ée]servation/,
    /reservation\s+request/,
    /booking\s+request/,
    /demande\s+(?:de\s+)?renseignement/,
    /inquiry/,
    /(?:arriv[ée]e|check[\s-]?in)[\s:]+\d/,
    /(?:d[ée]part|check[\s-]?out)[\s:]+\d/,
    /voyageur|guest|traveler/,
    /\d+\s+nuit/,
    /\d+\s+night/
  ];
  return patterns.some(p => p.test(text));
}

/**
 * Extract dates from an Airbnb email subject line.
 * Subjects look like: "Demande d'information pour Le Cocon Terracotta - Spa, 1–6 avr."
 * or "Réservation pour Le Cocon Terracotta - Spa, 28–29 mars"
 * or "Réservation pour Le Cocon Terracotta - Spa, 28 mars–2 avr."
 */
function extractDatesFromSubject(subject) {
  if (!subject || typeof subject !== 'string') return null;
  const text = subject.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const year = new Date().getFullYear();

  // Pattern 1: "DD–DD month" (same month, en-dash or hyphen)
  const re1 = new RegExp(`(\\d{1,2})\\s*[–\\-]\\s*(\\d{1,2})\\s+(${MONTH_PATTERN})\\.?`, 'i');
  let m = text.match(re1);
  if (m) {
    const day1 = parseInt(m[1]);
    const day2 = parseInt(m[2]);
    const month = ALL_MONTHS[m[3].toLowerCase()];
    if (month !== undefined) {
      return buildResult(day1, month, year, day2, month, year);
    }
  }

  // Pattern 2: "DD month–DD month" (different months)
  const re2 = new RegExp(`(\\d{1,2})\\s+(${MONTH_PATTERN})\\.?\\s*[–\\-]\\s*(\\d{1,2})\\s+(${MONTH_PATTERN})\\.?`, 'i');
  m = text.match(re2);
  if (m) {
    const day1 = parseInt(m[1]);
    const month1 = ALL_MONTHS[m[2].toLowerCase()];
    const day2 = parseInt(m[3]);
    const month2 = ALL_MONTHS[m[4].toLowerCase()];
    if (month1 !== undefined && month2 !== undefined) {
      const y2 = month2 < month1 ? year + 1 : year;
      return buildResult(day1, month1, year, day2, month2, y2);
    }
  }

  return null;
}

module.exports = {
  extractDatesFromMessage,
  extractDatesFromSubject,
  isAvailabilityQuestion
};
