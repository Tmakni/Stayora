# 📡 Documentation API - Agent IA Airbnb

Base URL : `http://localhost:3000`

---

## 🔐 Authentication

Toutes les routes (sauf `/api/auth/register` et `/api/auth/login`) nécessitent un **JWT token**.

Le token peut être fourni de 2 façons :

1. **Cookie** (automatique après login) : `token=jwt-token-here`
2. **Header** : `Authorization: Bearer jwt-token-here`

---

## Auth Endpoints

### POST `/api/auth/register`

Créer un nouveau compte utilisateur.

**Rate limit :** 50 req / 15 min

**Request Body :**
```json
{
  "email": "user@example.com",
  "password": "securepassword"
}
```

**Validation :**
- Email : format valide, max 255 chars
- Password : min 6 chars

**Success Response (201) :**
```json
{
  "success": true,
  "user": {
    "id": 1,
    "email": "user@example.com"
  },
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

**Error Responses :**

- **400 Bad Request :**
```json
{ "error": "Email and password required" }
{ "error": "Password must be at least 6 characters" }
```

- **409 Conflict :**
```json
{ "error": "Email already registered" }
```

---

### POST `/api/auth/login`

Se connecter avec un compte existant.

**Rate limit :** 50 req / 15 min

**Request Body :**
```json
{
  "email": "user@example.com",
  "password": "securepassword"
}
```

**Success Response (200) :**
```json
{
  "success": true,
  "user": {
    "id": 1,
    "email": "user@example.com"
  },
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

**Error Responses :**

- **400 Bad Request :**
```json
{ "error": "Email and password required" }
```

- **401 Unauthorized :**
```json
{ "error": "Invalid credentials" }
```

---

### GET `/api/auth/me`

Obtenir les informations de l'utilisateur connecté.

**Headers :**
```
Authorization: Bearer {token}
```

**Success Response (200) :**
```json
{
  "user": {
    "id": 1,
    "email": "user@example.com",
    "created_at": "2026-02-09T10:30:00.000Z"
  }
}
```

**Error Responses :**

- **401 Unauthorized :**
```json
{ "error": "Authentication required" }
{ "error": "Invalid token" }
{ "error": "Token expired" }
```

- **404 Not Found :**
```json
{ "error": "User not found" }
```

---

## Conversations Endpoints

### POST `/api/conversations`

Créer une nouvelle conversation.

**Authentication :** Required

**Request Body :**
```json
{
  "title": "Réservation Mars 2026 - John Smith",
  "booking_status": "confirmed",
  "property_id": null
}
```

**Fields :**
- `title` (required) : Titre de la conversation
- `booking_status` (optional) : `inquiry` | `request` | `confirmed` | `checkedin` | `checkedout`
  - Default: `inquiry`
- `property_id` (optional) : ID du profil de propriété (si configuré)

**Success Response (201) :**
```json
{
  "success": true,
  "conversation": {
    "id": 1,
    "user_id": 1,
    "title": "Réservation Mars 2026 - John Smith",
    "booking_status": "confirmed",
    "property_id": null
  }
}
```

**Error Responses :**

- **400 Bad Request :**
```json
{ "error": "Title required" }
{ "error": "Invalid booking status" }
```

---

### GET `/api/conversations`

Lister toutes les conversations de l'utilisateur connecté.

**Authentication :** Required

**Success Response (200) :**
```json
{
  "conversations": [
    {
      "id": 1,
      "title": "Réservation Mars 2026 - John Smith",
      "booking_status": "confirmed",
      "property_id": null,
      "created_at": "2026-02-09T10:30:00.000Z",
      "updated_at": "2026-02-09T14:20:00.000Z"
    },
    {
      "id": 2,
      "title": "Demande info - Sarah",
      "booking_status": "inquiry",
      "property_id": null,
      "created_at": "2026-02-09T11:00:00.000Z",
      "updated_at": "2026-02-09T11:00:00.000Z"
    }
  ]
}
```

Triées par `updated_at` DESC (plus récentes en premier).

---

### GET `/api/conversations/:id`

Obtenir les détails d'une conversation + tous ses messages.

**Authentication :** Required

**URL Parameters :**
- `id` : ID de la conversation

**Success Response (200) :**
```json
{
  "conversation": {
    "id": 1,
    "user_id": 1,
    "title": "Réservation Mars 2026 - John Smith",
    "booking_status": "confirmed",
    "property_id": 1,
    "created_at": "2026-02-09T10:30:00.000Z",
    "updated_at": "2026-02-09T14:20:00.000Z",
    "property_context": {
      "id": 1,
      "name": "Appartement Centre-Ville Paris",
      "context": {
        "wifi_name": "AppartParis_Guest",
        "wifi_password": "paris2024",
        "check_in_time": "15:00",
        "check_out_time": "11:00",
        "access_code": "A1234B",
        "parking": "Parking payant à 100m (15€/jour)",
        "rules": "Non-fumeur, pas de fêtes",
        "amenities": "Cuisine équipée, lave-linge",
        "nearby": "Métro ligne 1 à 3 min",
        "max_guests": 4
      }
    }
  },
  "messages": [
    {
      "id": 1,
      "role": "incoming",
      "content": "Bonjour, nous arrivons demain. Check-in anticipé possible ?",
      "metadata": null,
      "created_at": "2026-02-09T14:15:00.000Z"
    },
    {
      "id": 2,
      "role": "outgoing",
      "content": "Bonjour ! Le check-in anticipé est possible si le logement est libre...",
      "metadata": {
        "intent": "check-in",
        "risk_level": "low",
        "escalate": false
      },
      "created_at": "2026-02-09T14:20:00.000Z"
    }
  ]
}
```

**Error Responses :**

- **403 Forbidden :**
```json
{ "error": "Access denied" }
```

- **404 Not Found :**
```json
{ "error": "Conversation not found" }
```

---

### POST `/api/conversations/:id/messages`

Ajouter un message à une conversation.

**Authentication :** Required

**URL Parameters :**
- `id` : ID de la conversation

**Request Body :**
```json
{
  "role": "incoming",
  "content": "Quel est le code WiFi ?",
  "metadata": {}
}
```

**Fields :**
- `role` (required) : `incoming` (voyageur) | `outgoing` (hôte)
- `content` (required) : Contenu du message
- `metadata` (optional) : Objet JSON libre (ex: résultat IA)

**Success Response (201) :**
```json
{
  "success": true,
  "message": {
    "id": 3,
    "conversation_id": 1,
    "role": "incoming",
    "content": "Quel est le code WiFi ?",
    "metadata": {}
  }
}
```

**Error Responses :**

- **400 Bad Request :**
```json
{ "error": "Role and content required" }
{ "error": "Invalid role" }
```

- **403 Forbidden :**
```json
{ "error": "Access denied" }
```

- **404 Not Found :**
```json
{ "error": "Conversation not found" }
```

---

## AI Endpoint

### POST `/api/ai/draft`

Générer une réponse IA à un message voyageur.

**Authentication :** Required

**Rate limit :** 10 req / minute

**Request Body :**
```json
{
  "conversation_id": 1,
  "incoming_message": "Bonjour, nous arrivons ce soir. Quel est le code pour entrer ?",
  "booking_status": "confirmed",
  "property_context": {
    "wifi_name": "MyWiFi",
    "wifi_password": "password123",
    "check_in_time": "15:00",
    "check_out_time": "11:00",
    "access_code": "A1234B",
    "parking": "Parking gratuit rue adjacente",
    "rules": "Non-fumeur, calme après 22h",
    "amenities": "Cuisine, lave-linge, Netflix",
    "nearby": "Métro à 5 min",
    "max_guests": 4,
    "early_checkin": "possible si libre (20€)",
    "late_checkout": "possible si libre (20€)"
  },
  "guest_profile": {
    "language": "fr",
    "num_guests": 2,
    "dates": "2026-03-15 to 2026-03-20"
  }
}
```

**Fields :**

- `conversation_id` (optional) : ID conversation (pour récupérer historique automatiquement)
- `incoming_message` (required) : Message du voyageur
- `booking_status` (optional) : Statut réservation
  - Values: `inquiry` | `request` | `confirmed` | `checkedin` | `checkedout`
  - Default: `inquiry`
- `property_context` (optional) : Contexte propriété (JSON)
  - Si `conversation_id` fourni et propriété liée → récupéré auto
- `guest_profile` (optional) : Info voyageur
  - `language` : Code langue (fr, en)
  - `num_guests` : Nombre de personnes
  - `dates` : Dates séjour

**Success Response (200) :**

```json
{
  "success": true,
  "draft_reply": "Bonjour ! Le check-in est à partir de 15h. Le code d'accès est A1234B. Si vous arrivez plus tôt, un check-in anticipé est possible si le logement est libre (20€). N'hésitez pas à me confirmer votre heure d'arrivée. Au plaisir de vous accueillir !",
  "intent": "check-in",
  "risk_level": "low",
  "escalate": false,
  "host_note": null,
  "missing_info_questions": []
}
```

**Response Fields :**

- `draft_reply` : Réponse générée prête à copier
- `intent` : Intention détectée
  - Values: `check-in`, `check-out`, `wifi`, `parking`, `amenities`, `location`, `price-negotiation`, `cancellation`, `problem`, `rules`, `booking-inquiry`, `modification`, `other`
- `risk_level` : Niveau de risque
  - Values: `low`, `medium`, `high`
- `escalate` : Nécessite intervention manuelle ?
  - `true` → Ne PAS envoyer auto
  - `false` → Peut être envoyé
- `host_note` : Note pour l'hôte si escalade
- `missing_info_questions` : Liste questions si info manquante (max 3)

**Exemple avec escalade (problème urgent) :**

Request :
```json
{
  "incoming_message": "Le chauffage ne fonctionne pas, il fait très froid ! C'est urgent !",
  "booking_status": "checkedin",
  "property_context": {}
}
```

Response :
```json
{
  "success": true,
  "draft_reply": "Je suis sincèrement désolé pour ce désagrément. Je vais regarder cela immédiatement et revenir vers vous très rapidement. Merci de votre patience.",
  "intent": "problem",
  "risk_level": "high",
  "escalate": true,
  "host_note": "Problème urgent : chauffage en panne. Contacter réparateur et tenir le voyageur informé toutes les heures.",
  "missing_info_questions": []
}
```

**Exemple avec information manquante :**

Request :
```json
{
  "incoming_message": "What is the WiFi password?",
  "property_context": {}
}
```

Response :
```json
{
  "success": true,
  "draft_reply": "Hello! I'll provide you with the WiFi information right away. Let me get that for you.",
  "intent": "wifi",
  "risk_level": "low",
  "escalate": false,
  "host_note": null,
  "missing_info_questions": [
    "What is the WiFi network name?",
    "What is the WiFi password?"
  ]
}
```

**Error Responses :**

- **400 Bad Request :**
```json
{ "error": "incoming_message required" }
```

- **403 Forbidden :**
```json
{ "error": "Access denied" }
```

- **404 Not Found :**
```json
{ "error": "Conversation not found" }
```

- **429 Too Many Requests :**
```json
{ "error": "Too many AI requests from this IP, please try again later." }
```

- **500 Internal Server Error :**
```json
{ 
  "error": "Failed to generate draft",
  "details": "OpenAI API error message here"
}
```

---

## Health Check

### GET `/api/health`

Vérifier que le serveur fonctionne.

**Authentication :** Not required

**Success Response (200) :**
```json
{
  "status": "ok",
  "timestamp": "2026-02-09T14:30:00.000Z"
}
```

---

## Error Handling

Tous les endpoints retournent des erreurs au format JSON :

```json
{
  "error": "Description de l'erreur"
}
```

**Status codes utilisés :**

- `200` OK
- `201` Created
- `400` Bad Request (validation échouée)
- `401` Unauthorized (auth manquante/invalide)
- `403` Forbidden (pas de droits)
- `404` Not Found
- `409` Conflict (ex: email déjà utilisé)
- `429` Too Many Requests (rate limit)
- `500` Internal Server Error

---

## Rate Limiting

### Auth endpoints
- Limite : **50 requêtes / 15 minutes**
- S'applique à : `/api/auth/register`, `/api/auth/login`

### AI endpoint
- Limite : **10 requêtes / minute**
- S'applique à : `/api/ai/draft`

Les headers de réponse incluent :
```
X-RateLimit-Limit: 10
X-RateLimit-Remaining: 9
X-RateLimit-Reset: 1707485400
```

---

## Exemples complets

### Flow complet : Créer conversation → Générer draft → Sauvegarder

```bash
# 1. Register
TOKEN=$(curl -s -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"demo@test.com","password":"demo123"}' \
  | jq -r '.token')

# 2. Créer conversation
CONV_ID=$(curl -s -X POST http://localhost:3000/api/conversations \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"title":"Test API","booking_status":"confirmed"}' \
  | jq -r '.conversation.id')

# 3. Générer draft IA
DRAFT=$(curl -s -X POST http://localhost:3000/api/ai/draft \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "{
    \"conversation_id\": $CONV_ID,
    \"incoming_message\": \"What time is check-in?\",
    \"property_context\": {\"check_in_time\": \"15:00\"}
  }")

echo "Draft generated:"
echo $DRAFT | jq '.draft_reply'

# 4. Sauvegarder message entrant
curl -s -X POST http://localhost:3000/api/conversations/$CONV_ID/messages \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"role":"incoming","content":"What time is check-in?"}'

# 5. Sauvegarder réponse générée
REPLY=$(echo $DRAFT | jq -r '.draft_reply')
curl -s -X POST http://localhost:3000/api/conversations/$CONV_ID/messages \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "{\"role\":\"outgoing\",\"content\":\"$REPLY\"}"

# 6. Récupérer conversation complète
curl -s http://localhost:3000/api/conversations/$CONV_ID \
  -H "Authorization: Bearer $TOKEN" | jq
```

---

**Documentation API complète ✅**
