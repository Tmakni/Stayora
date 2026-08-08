import {
  Home,
  MessageSquare,
  Building2,
  Calendar,
  Zap,
  Plug,
  Settings,
} from 'lucide-react';

// Primary navigation — shared by the desktop sidebar and mobile bottom nav.
export const NAV_ITEMS = [
  { to: '/', label: 'Accueil', icon: Home, end: true },
  { to: '/conversations', label: 'Conversations', icon: MessageSquare },
  { to: '/properties', label: 'Logements', icon: Building2 },
  { to: '/calendar', label: 'Calendrier', icon: Calendar },
  { to: '/automations', label: 'Automatisations', icon: Zap },
  { to: '/integrations', label: 'Intégrations', icon: Plug },
  { to: '/settings', label: 'Paramètres', icon: Settings },
];

// Mobile bottom nav keeps only the highest-frequency destinations (thumb-friendly).
export const MOBILE_NAV_ITEMS = [
  { to: '/', label: 'Accueil', icon: Home, end: true },
  { to: '/conversations', label: 'Messages', icon: MessageSquare },
  { to: '/properties', label: 'Logements', icon: Building2 },
  { to: '/calendar', label: 'Calendrier', icon: Calendar },
  { to: '/settings', label: 'Réglages', icon: Settings },
];

// booking_status is the one real, persisted status field on a conversation.
export const BOOKING_STATUS = {
  inquiry: { label: 'Nouvelle demande', tone: 'primary' },
  request: { label: 'À confirmer', tone: 'secondary' },
  confirmed: { label: 'Confirmée', tone: 'success' },
  checkedin: { label: 'Séjour en cours', tone: 'success' },
  checkedout: { label: 'Séjour terminé', tone: 'muted' },
};

export const BOOKING_STATUS_OPTIONS = [
  { value: 'inquiry', label: 'Demande d\u2019information' },
  { value: 'request', label: 'Demande de réservation' },
  { value: 'confirmed', label: 'Confirmée' },
  { value: 'checkedin', label: 'En cours de séjour' },
  { value: 'checkedout', label: 'Terminée' },
];

// Platforms are not all real backend integrations (only Airbnb/Gmail accounts truly
// exist server-side). This config is used to render a best-effort badge from
// conversation.external_provider / title / guest_name text — see getPlatform().
export const PLATFORMS = {
  airbnb: { label: 'Airbnb', dot: 'bg-[#FF5A5F]', text: 'text-[#FF5A5F]', bg: 'bg-[#FF5A5F]/10' },
  booking: { label: 'Booking.com', dot: 'bg-[#003580]', text: 'text-[#003580] dark:text-[#5b8ff2]', bg: 'bg-[#003580]/10' },
  vrbo: { label: 'Vrbo', dot: 'bg-[#3D67FF]', text: 'text-[#3D67FF]', bg: 'bg-[#3D67FF]/10' },
  gmail: { label: 'Gmail', dot: 'bg-[#EA4335]', text: 'text-[#EA4335]', bg: 'bg-[#EA4335]/10' },
  other: { label: 'Autre', dot: 'bg-muted-foreground', text: 'text-muted-foreground', bg: 'bg-muted' },
};

export function getPlatform(conversation) {
  if (!conversation) return 'other';
  const haystack = `${conversation.external_provider || ''} ${conversation.title || ''} ${conversation.guest_name || ''}`.toLowerCase();
  if (conversation.is_airbnb || conversation.airbnb_thread_id || haystack.includes('airbnb')) return 'airbnb';
  if (haystack.includes('booking.com') || haystack.includes('booking com')) return 'booking';
  if (haystack.includes('vrbo') || haystack.includes('homeaway')) return 'vrbo';
  if (conversation.external_provider === 'gmail') return 'gmail';
  return 'other';
}

export const INTENT_LABELS = {
  general: 'Général',
  check_in: 'Arrivée',
  check_out: 'Départ',
  wifi: 'WiFi',
  parking: 'Parking',
  amenities: 'Équipements',
  location: 'Localisation',
  rules: 'Règlement',
  problem: 'Problème',
  price_negotiation: 'Tarif',
  cancellation: 'Annulation',
  availability: 'Disponibilité',
  other: 'Autre',
};

export const RISK_LEVELS = {
  low: { label: 'Risque faible', tone: 'success' },
  medium: { label: 'Risque modéré', tone: 'warning' },
  high: { label: 'Risque élevé', tone: 'danger' },
  critical: { label: 'Critique', tone: 'danger' },
};

export const PROPERTY_TYPES = [
  { value: 'apartment', label: 'Appartement' },
  { value: 'house', label: 'Maison' },
  { value: 'villa', label: 'Villa' },
  { value: 'studio', label: 'Studio' },
  { value: 'loft', label: 'Loft' },
  { value: 'chalet', label: 'Chalet' },
];

export const REPLY_TONES = [
  { value: 'professional', label: 'Professionnel' },
  { value: 'friendly', label: 'Chaleureux' },
  { value: 'concise', label: 'Concis' },
  { value: 'luxe', label: 'Prestige' },
];
