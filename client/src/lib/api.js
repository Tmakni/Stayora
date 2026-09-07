// Centralised API client — every network call in the app goes through here.
// All endpoints are the existing, unmodified Express routes (see API.md).
const TOKEN_KEY = 'token';
const EMAIL_KEY = 'user_email';

export class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
  }
}

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}
export function setSession(token, email) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  if (email) localStorage.setItem(EMAIL_KEY, email);
}
export function getStoredEmail() {
  return localStorage.getItem(EMAIL_KEY);
}
export function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(EMAIL_KEY);
}

let refreshPromise = null;

async function tryRefreshToken() {
  const token = getToken();
  if (!token) return false;
  if (!refreshPromise) {
    refreshPromise = fetch('/api/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ token }),
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.token) {
          setSession(data.token);
          return true;
        }
        return false;
      })
      .catch(() => false)
      .finally(() => {
        refreshPromise = null;
      });
  }
  return refreshPromise;
}

async function request(path, { method = 'GET', body, params, rawBody, rawType, _retried } = {}) {
  const token = getToken();
  let url = path;
  if (params && Object.keys(params).length > 0) {
    const qs = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')
    ).toString();
    if (qs) url += (path.includes('?') ? '&' : '?') + qs;
  }

  let res;
  try {
    res = await fetch(url, {
      method,
      credentials: 'include',
      headers: {
        // `rawBody` sert au depot d'archive : le fichier part tel quel, sans
        // enveloppe multipart. Cela evite d'ajouter un analyseur multipart au
        // serveur et, surtout, tout fichier temporaire sur son disque.
        'Content-Type': rawBody !== undefined ? (rawType || 'application/octet-stream') : 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: rawBody !== undefined ? rawBody : body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (networkErr) {
    throw new ApiError('Connexion impossible. Vérifiez votre réseau.', 0, null);
  }

  if (res.status === 401 && token && !_retried && !path.startsWith('/api/auth/')) {
    const refreshed = await tryRefreshToken();
    if (refreshed) return request(path, { method, body, params, rawBody, rawType, _retried: true });
    clearSession();
    const err = new ApiError('Session expirée. Veuillez vous reconnecter.', 401, null);
    err.sessionExpired = true;
    throw err;
  }

  let data = null;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (!res.ok) {
    throw new ApiError(data?.error || data?.message || `Erreur ${res.status}`, res.status, data);
  }

  return data ?? {};
}

export const api = {
  auth: {
    login: (email, password) => request('/api/auth/login', { method: 'POST', body: { email, password } }),
    register: (email, password) => request('/api/auth/register', { method: 'POST', body: { email, password } }),
    me: () => request('/api/auth/me'),
    refresh: (token) => request('/api/auth/refresh', { method: 'POST', body: { token } }),
    changePassword: (payload) => request('/api/auth/password', { method: 'PUT', body: payload }),
    requestPasswordReset: (email) => request('/api/auth/forgot-password', { method: 'POST', body: { email } }),
    resetPassword: (payload) => request('/api/auth/reset-password', { method: 'POST', body: payload }),
    // Irréversible : supprime le compte et toutes les données associées (RGPD).
    deleteAccount: (password) => request('/api/auth/account', { method: 'DELETE', body: { password } }),
  },

  properties: {
    list: () => request('/api/properties'),
    get: (id) => request(`/api/properties/${id}`),
    create: (payload) => request('/api/properties', { method: 'POST', body: payload }),
    update: (id, payload) => request(`/api/properties/${id}`, { method: 'PUT', body: payload }),
    // Mise a jour partielle : un champ absent du corps veut dire « ne pas
    // modifier ». C'est ce que la sauvegarde automatique du formulaire emploie,
    // pour qu'une section ne puisse jamais effacer les autres.
    patch: (id, payload) => request(`/api/properties/${id}`, { method: 'PATCH', body: payload }),
    // Import en masse depuis les donnees personnelles Airbnb : le ZIP fourni
    // par Airbnb, ou le fichier JSON qu'il contient si l'hote l'a decompresse.
    // Deux temps : previsualisation (rien n'est ecrit), puis import de la
    // selection. Le fichier est poste en corps brut.
    //
    // Toujours application/octet-stream, y compris pour un .json : le serveur
    // reconnait le format au contenu, et un corps annonce application/json
    // serait capte par l'analyseur JSON global borne a 1 Mo.
    previewArchive: (file) =>
      request('/api/properties/import-archive/preview', {
        method: 'POST',
        rawBody: file,
        rawType: 'application/octet-stream',
      }),
    importArchive: (listings) =>
      request('/api/properties/import-archive', { method: 'POST', body: { listings } }),
    remove: (id) => request(`/api/properties/${id}`, { method: 'DELETE' }),
    getCalendar: (id, params) => request(`/api/properties/${id}/calendar`, { params }),
    addCalendarBlock: (id, payload) => request(`/api/properties/${id}/calendar`, { method: 'POST', body: payload }),
    importAirbnb: (url) => request('/api/properties/import-airbnb', { method: 'POST', body: { url } }),
    scanAirbnbProfile: (profileUrl) =>
      request('/api/properties/scan-airbnb-profile', { method: 'POST', body: { profileUrl } }),
    updateFromAirbnb: (id) => request(`/api/properties/${id}/update-from-airbnb`, { method: 'PUT' }),
    // Centre de vérification : ce que Michel a trouvé dans les conversations de
    // l'hôte et qui attend son accord. Rien de ce qui est listé là n'a été
    // écrit dans la fiche.
    getFacts: (id) => request(`/api/properties/${id}/facts`),
    getPendingFacts: () => request('/api/properties/facts/pending'),
    confirmFact: (id, factId, value) =>
      request(`/api/properties/${id}/facts/${factId}/confirm`, {
        method: 'POST',
        body: value === undefined || value === null ? {} : { value },
      }),
    rejectFact: (id, factId) =>
      request(`/api/properties/${id}/facts/${factId}/reject`, { method: 'POST' }),
    confirmAllFacts: (id) =>
      request(`/api/properties/${id}/facts/confirm-all`, { method: 'POST' }),
    getPhotos: (id) => request(`/api/properties/${id}/photos`),
    deletePhoto: (id, photoId) => request(`/api/properties/${id}/photos/${photoId}`, { method: 'DELETE' }),
    setMainPhoto: (id, photoId) => request(`/api/properties/${id}/photos/${photoId}/main`, { method: 'PUT' }),
  },

  conversations: {
    // Returns the raw envelope ({ conversations, limit, offset, has_more }) so
    // callers can page. `.list()` with no args keeps the previous behaviour of
    // fetching the first page.
    list: (params) => request('/api/conversations', { params }),
    get: (id) => request(`/api/conversations/${id}`),
    create: (payload) => request('/api/conversations', { method: 'POST', body: payload }),
    update: (id, payload) => request(`/api/conversations/${id}`, { method: 'PUT', body: payload }),
    addMessage: (id, payload) => request(`/api/conversations/${id}/messages`, { method: 'POST', body: payload }),
    sendAirbnb: (id, message) => request(`/api/conversations/${id}/send-airbnb`, { method: 'POST', body: { message } }),
    // Réponse par e-mail : on n'envoie que du TEXTE. Le destinataire est résolu
    // côté serveur depuis les en-têtes du mail Airbnb reçu (jamais par le client).
    reply: (id, message) => request(`/api/conversations/${id}/reply`, { method: 'POST', body: { message } }),
    replyStatus: (id) => request(`/api/conversations/${id}/reply-status`),
    retryReply: (id, queueId) => request(`/api/conversations/${id}/reply/${queueId}/retry`, { method: 'POST' }),
  },

  ai: {
    generateDraft: (payload) => request('/api/ai/draft', { method: 'POST', body: payload }),
  },

  calendarApi: {
    connect: (propertyId, icalUrl) => request('/api/calendar/connect', { method: 'POST', body: { property_id: propertyId, ical_url: icalUrl } }),
    disconnect: (propertyId) => request(`/api/calendar/${propertyId}`, { method: 'DELETE' }),
    get: (propertyId, params) => request(`/api/calendar/${propertyId}`, { params }),
    sync: (propertyId) => request(`/api/calendar/${propertyId}/sync`, { method: 'POST' }),
    checkAvailability: (propertyId, start, end) => request(`/api/calendar/${propertyId}/availability`, { params: { start, end } }),
  },

  gmail: {
    getAuthUrl: () => request('/api/gmail/auth-url'),
    getAccounts: () => request('/api/gmail/accounts'),
    removeAccount: (id) => request(`/api/gmail/accounts/${id}`, { method: 'DELETE' }),
    reauthorize: (accountId) => request(`/api/gmail/reauthorize/${accountId}`),
    purgeNonAirbnb: () => request('/api/gmail/purge-non-airbnb', { method: 'DELETE' }),
  },

  settings: {
    getAutoReply: () => request('/api/settings/auto-reply'),
    updateAutoReply: (payload) => request('/api/settings/auto-reply', { method: 'PUT', body: payload }),
  },

  sync: {
    getAirbnbAccounts: () => request('/api/sync/accounts'),
    addAirbnbAccount: (payload) => request('/api/sync/accounts', { method: 'POST', body: payload }),
    removeAirbnbAccount: (id) => request(`/api/sync/accounts/${id}`, { method: 'DELETE' }),
    syncMessages: (accountId) => request(`/api/sync/messages/${accountId}`, { method: 'POST' }),
    syncReservations: (accountId) => request(`/api/sync/reservations/${accountId}`, { method: 'POST' }),
    fullSync: (accountId) => request(`/api/sync/full/${accountId}`, { method: 'POST' }),
    getReservations: (params) => request('/api/sync/reservations', { params }),
    getReservation: (id) => request(`/api/sync/reservations/${id}`),
    getLogs: () => request('/api/sync/logs'),
    eventsUrl: () => `/api/sync/events?token=${encodeURIComponent(getToken() || '')}`,
  },
};
