import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

// Standard shadcn/ui helper — merges conditional class names and resolves Tailwind conflicts.
export function cn(...inputs) {
  return twMerge(clsx(inputs));
}

export function formatDate(dateString, opts = {}) {
  if (!dateString) return '';
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  const diffMs = now - date;
  const diffMin = Math.floor(diffMs / 60000);

  if (!opts.absolute) {
    if (diffMin < 1) return "à l'instant";
    if (diffMin < 60) return `il y a ${diffMin} min`;
    if (diffMin < 60 * 24 && date.toDateString() === now.toDateString()) {
      return date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    }
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (date.toDateString() === yesterday.toDateString()) {
      return `hier à ${date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`;
    }
  }

  return date.toLocaleDateString('fr-FR', {
    day: 'numeric',
    month: 'short',
    year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined,
    ...(opts.withTime ? { hour: '2-digit', minute: '2-digit' } : {}),
  });
}

export function formatDateShort(dateString) {
  if (!dateString) return '';
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

// Placeholder shown when no traveller name could be extracted from the mail.
// Mirrors FALLBACK_GUEST_NAME in server/services/guestNameExtractor.js.
export const FALLBACK_GUEST_NAME = 'Voyageur';

/**
 * Name to display for a conversation.
 *
 * Every Airbnb notification is sent by "Airbnb <express@airbnb.com>", and the
 * sync used to fall back to that From display name — so rows showed "Airbnb"
 * and titles read "Airbnb – La Villa Cosy". The backend now extracts the real
 * traveller name, but this guard keeps any legacy row (or a conversation synced
 * by an older server) from ever rendering as "Airbnb".
 */
export function guestDisplayName(conversation) {
  if (!conversation) return FALLBACK_GUEST_NAME;

  const guestName = (conversation.guest_name || '').trim();
  if (guestName && guestName.toLowerCase() !== 'airbnb') return guestName;

  const title = (conversation.title || '').trim();
  if (title && title.toLowerCase() !== 'airbnb') {
    // Titles are stored as "<name> – <property>"; a leading "Airbnb" segment is
    // the placeholder, not a name.
    const [head] = title.split(/\s+[–—-]\s+/);
    const candidate = (head || '').trim();
    if (candidate && candidate.toLowerCase() !== 'airbnb') return candidate;
    return title.toLowerCase().startsWith('airbnb') ? FALLBACK_GUEST_NAME : title;
  }

  return FALLBACK_GUEST_NAME;
}

export function initials(name) {
  if (!name) return '?';
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// Deterministic color assignment (property/guest id -> palette index), matches legacy behaviour.
const AVATAR_PALETTE = [
  'bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300',
  'bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300',
  'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300',
  'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300',
  'bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300',
  'bg-cyan-100 text-cyan-700 dark:bg-cyan-500/15 dark:text-cyan-300',
  'bg-fuchsia-100 text-fuchsia-700 dark:bg-fuchsia-500/15 dark:text-fuchsia-300',
  'bg-lime-100 text-lime-700 dark:bg-lime-500/15 dark:text-lime-300',
  'bg-orange-100 text-orange-700 dark:bg-orange-500/15 dark:text-orange-300',
  'bg-teal-100 text-teal-700 dark:bg-teal-500/15 dark:text-teal-300',
];

export function avatarColor(id) {
  const n = typeof id === 'number' ? id : String(id || '0').split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  return AVATAR_PALETTE[Math.abs(n) % AVATAR_PALETTE.length];
}

export function truncate(str, len = 80) {
  if (!str) return '';
  return str.length > len ? str.slice(0, len).trimEnd() + '…' : str;
}

export function debounce(fn, wait = 300) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}
