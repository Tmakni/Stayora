# 🏠 Agent IA Airbnb - MVP

Agent IA intelligent pour aider les hôtes Airbnb à répondre automatiquement aux messages des voyageurs. Détecte l'intention, évalue le risque, génère des réponses professionnelles via OpenAI (avec fallback sur templates).

---

## 📋 Table des matières

- [Fonctionnalités](#-fonctionnalités)
- [Stack technique](#-stack-technique)
- [Architecture](#-architecture)
- [Installation](#-installation)
- [Configuration](#-configuration)
- [Utilisation](#-utilisation)
- [API Endpoints](#-api-endpoints)
- [Tests](#-tests)
- [Structure du projet](#-structure-du-projet)
- [Flux complet](#-flux-complet)
- [Conformité & Sécurité](#-conformité--sécurité)

---

## ✨ Fonctionnalités

### MVP Core

- ✅ **Authentification JWT** (register/login/me)
- ✅ **Gestion conversations** (créer, lister, détails, messages)
- ✅ **Génération IA de réponses**
  - Détection d'intention (check-in, wifi, parking, problème, etc.)
  - Évaluation du risque (low/medium/high)
  - Escalade automatique si sensible
  - Questions si info manquante
  - Support FR/EN
- ✅ **Fallback templates** si OpenAI indisponible
- ✅ **Rate limiting** sur endpoints IA
- ✅ **Interface web** simple et fonctionnelle
- ✅ **Tests Jest** sur fonctions critiques

### Détection intelligente

- **Intentions** : check-in, check-out, wifi, parking, amenities, location, price, cancellation, problem, rules, booking, modification
- **Risque** : Mots-clés urgence/legal → high, problème/refund → medium, normal → low
- **Escalade** : Automatique si high risk, cancellation, problème medium, ou message >1000 chars

---

## 🛠 Stack technique

- **Backend** : Node.js + Express
- **Base de données** : MySQL (avec fallback mémoire pour dev)
- **IA** : OpenAI GPT-4o-mini
- **Auth** : JWT stocké en cookie httpOnly
- **Frontend** : HTML/CSS + Vanilla JavaScript
- **Tests** : Jest
- **Sécurité** : Helmet, CORS, rate limiting, sanitization

---

## 🏗 Architecture

```
airbnb-ai-agent/
├── server/
│   ├── server.js                    # Point d'entrée
│   ├── config/
│   │   ├── db.js                    # Init DB (MySQL ou mémoire)
│   │   └── env.js                   # Configuration env
│   ├── db/
│   │   ├── mysql.js                 # Driver MySQL
│   │   └── memory.js                # Fallback mémoire
│   ├── middleware/
│   │   ├── auth.js                  # Vérification JWT
│   │   └── rateLimit.js             # Rate limiter
│   ├── routes/
│   │   ├── auth.js                  # Routes auth
│   │   ├── conversations.js         # Routes conversations
│   │   └── ai.js                    # Routes IA
│   ├── controllers/
│   │   ├── authController.js
│   │   ├── conversationController.js
│   │   └── aiController.js
│   ├── services/
│   │   ├── aiService.js             # OpenAI + orchestration
│   │   ├── promptBuilder.js         # Construction prompts
│   │   ├── intentClassifier.js      # Détection intent/risk
│   │   └── templateService.js       # Fallback templates
│   ├── utils/
│   │   ├── sanitize.js              # Nettoyage inputs
│   │   └── logger.js                # Logging
│   └── tests/                       # Tests Jest
├── client/
│   ├── login.html                   # Page auth
│   ├── index.html                   # Dashboard conversations
│   ├── conversation.html            # Détail conversation + IA
│   ├── app.js                       # Utils frontend
│   └── styles.css                   # Styles
├── schema.sql                       # Schéma MySQL
├── seed.sql                         # Données de démo
├── .env.example                     # Config exemple
├── package.json
└── README.md
```

---

## 🚀 Installation

### Prérequis

- **Node.js** >= 16
- **MySQL** (optionnel - fallback mémoire dispo)
- **Clé OpenAI** (optionnel - fallback templates)

### Étapes

1. **Cloner/Télécharger le projet**

```bash
cd airbnb-ai-agent
```

2. **Installer les dépendances**

```bash
npm install
```

3. **Configuration**

Copier `.env.example` → `.env` et éditer :

```bash
cp .env.example .env
```

Fichier `.env` minimal :

```
PORT=3000
JWT_SECRET=votre-secret-jwt-tres-securise
OPENAI_API_KEY=sk-votre-cle-openai

# Pour dev rapide sans MySQL
USE_MEMORY_DB=true

# Ou avec MySQL
USE_MEMORY_DB=false
DB_HOST=localhost
DB_USER=root
DB_PASSWORD=
DB_NAME=airbnb_ai_agent
```

4. **Setup MySQL (si utilisé)**

```bash
# Créer la base + tables
mysql -u root -p < schema.sql

# Optionnel : charger données de démo
mysql -u root -p < seed.sql
```

5. **Lancer le serveur**

**Production :**
```bash
npm start
```

**Développement (recommandé - auto-reload) :**
```bash
npm run dev
```

Le serveur démarre sur `http://localhost:3000`

---

## ⚙️ Configuration

### Variables d'environnement

| Variable | Description | Default | Requis |
|----------|-------------|---------|--------|
| `PORT` | Port serveur | 3000 | Non |
| `NODE_ENV` | Environnement | development | Non |
| `JWT_SECRET` | Secret JWT | - | **Oui** |
| `JWT_EXPIRES_IN` | Durée validité JWT | 7d | Non |
| `OPENAI_API_KEY` | Clé API OpenAI | - | Non* |
| `USE_MEMORY_DB` | Utiliser DB mémoire | true | Non |
| `DB_HOST` | Host MySQL | localhost | Si MySQL |
| `DB_USER` | User MySQL | root | Si MySQL |
| `DB_PASSWORD` | Password MySQL | - | Si MySQL |
| `DB_NAME` | Nom base MySQL | airbnb_ai_agent | Si MySQL |
| `RATE_LIMIT_WINDOW_MS` | Fenêtre rate limit | 60000 | Non |
| `RATE_LIMIT_MAX_REQUESTS` | Max requêtes IA/min | 10 | Non |

\* Si pas de clé OpenAI : utilise **templates fallback** automatiquement

---

## 📖 Utilisation

### Interface Web

1. **Ouvrir** `http://localhost:3000/login.html`

2. **Créer un compte** (ou utiliser démo si seed chargé)
   - Email: `demo@airbnb-ai.com`
   - Password: `demo123`

3. **Dashboard** : Créer une conversation

4. **Conversation** :
   - Coller un message voyageur
   - Optionnel : nb de personnes, langue
   - Configurer contexte propriété (WiFi, check-in, parking, etc.)
   - Cliquer "Générer une réponse IA"
   - Copier ou sauvegarder la réponse

### Contexte propriété (JSON)

Exemple complet :

```json
{
  "wifi_name": "AppartParis_Guest",
  "wifi_password": "paris2024",
  "check_in_time": "15:00",
  "check_out_time": "11:00",
  "access_code": "A1234B",
  "parking": "Parking payant à 100m (15€/jour)",
  "rules": "Non-fumeur, pas de fêtes, calme après 22h",
  "amenities": "Cuisine équipée, lave-linge, Netflix, climatisation",
  "nearby": "Métro ligne 1 à 3 min, boulangerie en bas",
  "max_guests": 4,
  "early_checkin": "possible si libre (20€)",
  "late_checkout": "possible si libre (20€)"
}
```

---

## 🔌 API Endpoints

### Auth

#### `POST /api/auth/register`

Créer un compte

**Body:**
```json
{
  "email": "user@example.com",
  "password": "securepass123"
}
```

**Response:**
```json
{
  "success": true,
  "user": {
    "id": 1,
    "email": "user@example.com"
  },
  "token": "jwt-token..."
}
```

#### `POST /api/auth/login`

Connexion

**Body:** Identique à register

**Response:** Identique à register

#### `GET /api/auth/me`

Infos utilisateur connecté (nécessite auth)

**Response:**
```json
{
  "user": {
    "id": 1,
    "email": "user@example.com",
    "created_at": "2026-02-09T10:00:00.000Z"
  }
}
```

---

### Conversations

**Toutes les routes nécessitent authentification (JWT cookie ou Bearer token)**

#### `POST /api/conversations`

Créer une conversation

**Body:**
```json
{
  "title": "Réservation Mars 2026 - John",
  "booking_status": "confirmed",
  "property_id": null
}
```

**Response:**
```json
{
  "success": true,
  "conversation": {
    "id": 1,
    "user_id": 1,
    "title": "Réservation Mars 2026 - John",
    "booking_status": "confirmed",
    "property_id": null
  }
}
```

#### `GET /api/conversations`

Liste toutes les conversations

**Response:**
```json
{
  "conversations": [
    {
      "id": 1,
      "title": "...",
      "booking_status": "confirmed",
      "created_at": "...",
      "updated_at": "..."
    }
  ]
}
```

#### `GET /api/conversations/:id`

Détails conversation + messages

**Response:**
```json
{
  "conversation": {
    "id": 1,
    "title": "...",
    "booking_status": "confirmed",
    "property_context": {
      "id": 1,
      "name": "Appartement Paris",
      "context": { ... }
    }
  },
  "messages": [
    {
      "id": 1,
      "role": "incoming",
      "content": "Bonjour...",
      "metadata": null,
      "created_at": "..."
    }
  ]
}
```

#### `POST /api/conversations/:id/messages`

Ajouter un message

**Body:**
```json
{
  "role": "incoming",
  "content": "Quel est le code WiFi?",
  "metadata": {}
}
```

**Response:**
```json
{
  "success": true,
  "message": {
    "id": 2,
    "conversation_id": 1,
    "role": "incoming",
    "content": "...",
    "metadata": null
  }
}
```

---

### IA

#### `POST /api/ai/draft`

**Générer une réponse IA** (nécessite auth + rate limit 10/min)

**Body:**
```json
{
  "conversation_id": 1,
  "incoming_message": "Bonjour, je voudrais le mot de passe WiFi",
  "booking_status": "confirmed",
  "property_context": {
    "wifi_name": "MyWiFi",
    "wifi_password": "pass123"
  },
  "guest_profile": {
    "language": "fr",
    "num_guests": 2
  }
}
```

**Response:**
```json
{
  "success": true,
  "draft_reply": "Bonjour ! Le réseau WiFi est 'MyWiFi' et le mot de passe est 'pass123'. Bon séjour !",
  "intent": "wifi",
  "risk_level": "low",
  "escalate": false,
  "host_note": null,
  "missing_info_questions": []
}
```

**Exemple avec escalade :**

```json
{
  "draft_reply": "Je suis désolé pour ce désagrément...",
  "intent": "problem",
  "risk_level": "high",
  "escalate": true,
  "host_note": "Urgence signalée - traiter immédiatement",
  "missing_info_questions": []
}
```

---

## 🧪 Tests

Lancer les tests Jest :

```bash
npm test

# Avec watch mode
npm run test:watch
```

**Tests inclus :**
- `intentClassifier.test.js` : Détection intent/risk/escalade
- `promptBuilder.test.js` : Construction prompts OpenAI
- `sanitize.test.js` : Nettoyage inputs

**Coverage :**
- Intentions multiples (check-in, wifi, problem, price, etc.)
- Niveaux de risque
- Edge cases (messages longs, JSON invalides, etc.)

---

## 📂 Structure du projet

```
airbnb-ai-agent/
├── server/
│   ├── server.js              # Bootstrap app Express
│   ├── config/
│   │   ├── db.js              # Init DB (auto-fallback)
│   │   └── env.js             # Config centralisée
│   ├── db/
│   │   ├── mysql.js           # Driver MySQL avec pool
│   │   └── memory.js          # Fallback in-memory
│   ├── middleware/
│   │   ├── auth.js            # Vérif JWT (cookie + header)
│   │   └── rateLimit.js       # Express rate limiter
│   ├── routes/
│   │   ├── auth.js            # POST register/login, GET me
│   │   ├── conversations.js   # CRUD conversations + messages
│   │   └── ai.js              # POST /draft
│   ├── controllers/
│   │   ├── authController.js  # Logique auth (bcrypt + JWT)
│   │   ├── conversationController.js
│   │   └── aiController.js    # Orchestration génération IA
│   ├── services/
│   │   ├── aiService.js       # OpenAI API + fallback
│   │   ├── promptBuilder.js   # Prompt engineering
│   │   ├── intentClassifier.js# Rules-based classifier
│   │   └── templateService.js # Templates FR/EN
│   ├── utils/
│   │   ├── sanitize.js        # Inputs cleaning
│   │   └── logger.js          # Console logger simple
│   └── tests/                 # Jest tests
├── client/
│   ├── login.html             # Auth page
│   ├── index.html             # Dashboard
│   ├── conversation.html      # Chat + IA generator
│   ├── app.js                 # Fetch API helpers
│   └── styles.css             # CSS Airbnb-inspired
├── schema.sql                 # MySQL schema
├── seed.sql                   # Demo data
├── .env.example
├── .gitignore
├── package.json
└── README.md
```

---

## 🔄 Flux complet

### Scénario : Hôte reçoit un message "Quel est le code WiFi ?"

1. **Hôte se connecte** → `POST /api/auth/login` → JWT cookie
2. **Dashboard** → `GET /api/conversations` → Liste conversations
3. **Ouvrir conversation** → `GET /api/conversations/1` → Messages existants
4. **Coller message voyageur** : "Quel est le code WiFi ?"
5. **Configurer contexte propriété** (si pas déjà fait) :
   ```json
   { "wifi_name": "MyNetwork", "wifi_password": "secret123" }
   ```
6. **Générer réponse** → `POST /api/ai/draft`
   - Backend :
     - Classifier détecte intent=`wifi`, risk=`low`
     - Prompt builder crée prompt OpenAI avec contexte
     - OpenAI génère réponse JSON
     - Retour : draft, intent, risk, escalate, questions
7. **Affichage** :
   - Intent: `wifi`
   - Risk: `low` (badge vert)
   - Escalate: `false`
   - Réponse : "Bonjour ! Le WiFi est 'MyNetwork', mot de passe 'secret123'. Bon séjour !"
8. **Hôte copie** → Bouton "Copier" → Clipboard
9. **Optionnel : Sauvegarder** → Ajoute message incoming + outgoing dans DB

---

## 🔒 Conformité & Sécurité

### Conformité Airbnb

✅ **AUCUN scraping** - Pas d'accès direct à Airbnb  
✅ **Pas d'API non officielle**  
✅ **3 modes d'input légaux** :
   1. Copier-coller manuel depuis Airbnb
   2. Import depuis emails de notification Airbnb
   3. Webhook simulé interne (aucun lien direct Airbnb)

### Sécurité

- ✅ **Helmet** : Headers sécurisés
- ✅ **CORS** : Origines contrôlées
- ✅ **JWT httpOnly cookies** : Protection XSS
- ✅ **Bcrypt** : Hash passwords (10 rounds)
- ✅ **Rate limiting** : 10 req/min sur /ai/draft
- ✅ **Input sanitization** : Trim, null bytes, longueur max
- ✅ **Script tag removal** : Protection basique XSS
- ✅ **Pas de secrets dans logs**

### Limitations volontaires IA

- ❌ Ne génère **JAMAIS** d'email/téléphone externe
- ❌ Ne génère **JAMAIS** de demande de paiement hors Airbnb
- ❌ N'invente **JAMAIS** d'équipement/règle manquant
- ✅ Si info manquante → **pose des questions**
- ✅ Si situation sensible → **escalade vers hôte**

---

## 🎯 Exemples de requêtes curl

### Register

```bash
curl -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"pass123"}'
```

### Login

```bash
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"pass123"}' \
  -c cookies.txt
```

### Créer conversation

```bash
curl -X POST http://localhost:3000/api/conversations \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -d '{"title":"Test","booking_status":"inquiry"}'
```

### Générer draft IA

```bash
curl -X POST http://localhost:3000/api/ai/draft \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -d '{
    "conversation_id": 1,
    "incoming_message": "What is the WiFi password?",
    "booking_status": "confirmed",
    "property_context": {
      "wifi_name": "MyWiFi",
      "wifi_password": "secret123"
    }
  }'
```

---

## 🚀 Prochaines étapes (hors MVP)

- [ ] Support multi-propriétés par utilisateur
- [ ] Import emails Airbnb (parsing automatique)
- [ ] Historique génération IA (analytics)
- [ ] Fine-tuning modèle sur conversations réelles
- [ ] Support autres langues (ES, IT, DE)
- [ ] Templates personnalisables par hôte
- [ ] Webhooks entrants (intégration tierce)
- [ ] Mode "apprentissage" (feedback sur réponses)

---

## 📝 License

MIT

---

## 🤝 Support

Pour questions ou problèmes :
1. Vérifier logs serveur
2. Tester avec `USE_MEMORY_DB=true` si problème MySQL
3. Vérifier que port 3000 est libre
4. Si OpenAI échoue : vérifier clé API ou utiliser mode fallback

**Happy hosting! 🏡✨**
