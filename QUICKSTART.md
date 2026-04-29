# 🚀 Guide de démarrage rapide - Agent IA Airbnb

## Installation en 3 minutes

### 1. Installer les dépendances

```bash
cd airbnb-ai-agent
npm install
```

⏱️ **Durée** : ~30 secondes (installe Express, OpenAI, JWT, nodemon, etc.)

### 2. Configurer (optionnel)

Le fichier `.env` est déjà configuré pour un démarrage rapide avec :
- Base de données **en mémoire** (pas besoin de MySQL)
- **Templates fallback** (pas besoin de clé OpenAI)

**Pour activer OpenAI** (optionnel) :
- Éditer `.env`
- Ajouter votre clé : `OPENAI_API_KEY=sk-votre-cle-ici`

**Pour utiliser MySQL** (optionnel) :
1. Éditer `.env` : `USE_MEMORY_DB=false`
2. Configurer DB_HOST, DB_USER, DB_PASSWORD
3. Créer la base : `mysql -u root -p < schema.sql`

### 3. Lancer le serveur

**Option A : Mode production**
```bash
npm start
```

**Option B : Mode développement (avec auto-reload)**
```bash
npm run dev
```

Le serveur démarre sur `http://localhost:3000`

💡 **Recommandé** : Utiliser `npm run dev` en développement - le serveur redémarre automatiquement à chaque modification de code !

#### Différence entre les modes

| Mode | Commande | Usage | Auto-reload |
|------|----------|-------|-------------|
| **Dev** | `npm run dev` | Développement local | ✅ Oui (nodemon) |
| **Prod** | `npm start` | Production / Test final | ❌ Non |

**Pendant le développement**, si tu modifies un fichier backend (ex: `server/services/aiService.js`), le serveur redémarre automatiquement avec `npm run dev` !

---

## 🎯 Test rapide du flux complet

### Étape 1 : Créer un compte

1. Ouvrir `http://localhost:3000/login.html`
2. Cliquer "S'inscrire"
3. Email : `test@airbnb-ai.com`
4. Mot de passe : `test123`
5. Cliquer "S'inscrire"

→ Redirection automatique vers le dashboard

### Étape 2 : Créer une conversation

1. Cliquer "+ Nouvelle Conversation"
2. Titre : `Test - Voyageur John`
3. Statut : Confirmée
4. Cliquer "Créer"

→ Ouverture de la page conversation

### Étape 3 : Configurer le contexte propriété

1. Dans la section "Contexte de la propriété", cliquer "Modifier"
2. Coller ce JSON :

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
  "nearby": "Métro ligne 1 à 3 min à pied",
  "max_guests": 4
}
```

3. Cliquer "Sauvegarder"

### Étape 4 : Tester la génération IA

#### Test 1 : Question WiFi (simple)

1. Dans "Message entrant", coller :
```
Bonjour, nous arrivons ce soir. Quel est le mot de passe WiFi ?
```

2. Cliquer "✨ Générer une réponse IA"

**Résultat attendu :**
- Intent : `wifi`
- Risk : `low` (badge vert)
- Réponse proposée avec le WiFi et mot de passe
- Bouton "Copier" fonctionne

#### Test 2 : Check-in anticipé (moyen)

1. Nouveau message :
```
Hello! We are arriving tomorrow at 1 PM. Is early check-in possible?
```

2. Générer

**Résultat attendu :**
- Intent : `check-in`
- Réponse en **anglais** (détection automatique)
- Mention des frais early check-in si configuré

#### Test 3 : Problème urgent (escalade)

1. Nouveau message :
```
Le chauffage ne fonctionne pas, il fait très froid. C'est urgent !
```

2. Générer

**Résultat attendu :**
- Intent : `problem`
- Risk : `medium` ou `high`
- **Escalate : ⚠️ ESCALADE**
- Note pour l'hôte affichée

### Étape 5 : Sauvegarder et visualiser

1. Cliquer "💾 Enregistrer comme envoyée"
2. Les messages apparaissent dans l'historique (bleu = voyageur, vert = hôte)

---

## 🧪 Tester l'API directement

### Register

```bash
curl -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"api@test.com","password":"test123"}'
```

Copier le `token` de la réponse.

### Créer conversation

```bash
curl -X POST http://localhost:3000/api/conversations \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer VOTRE_TOKEN_ICI" \
  -d '{"title":"API Test","booking_status":"inquiry"}'
```

Copier l'`id` de la conversation.

### Générer draft IA

```bash
curl -X POST http://localhost:3000/api/ai/draft \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer VOTRE_TOKEN_ICI" \
  -d '{
    "incoming_message": "What time is check-in?",
    "booking_status": "confirmed",
    "property_context": {
      "check_in_time": "15:00"
    }
  }'
```

---

## ✅ Vérifier l'installation

### Lancer les tests

```bash
npm test
```

**Tous les tests doivent passer :**
- ✅ Intent Classifier (8 tests)
- ✅ Prompt Builder (6 tests)
- ✅ Sanitize (16 tests)

---

## 🔧 Résolution de problèmes

### nodemon: not found (npm run dev)

**Erreur :** `sh: 1: nodemon: not found`

**Solution :**
```bash
# Installer toutes les dépendances (y compris nodemon)
npm install

# Puis relancer
npm run dev
```

**Si le problème persiste :**
```bash
# Installer nodemon manuellement
npm install --save-dev nodemon

# Ou utiliser npm start à la place
npm start
```

### Le serveur ne démarre pas

**Erreur : Port already in use**
```bash
# Changer le port dans .env
PORT=3001
```

**Erreur : Module not found**
```bash
# Réinstaller
rm -rf node_modules package-lock.json
npm install
```

### L'IA ne génère pas de réponse

**Sans clé OpenAI :** L'app utilise automatiquement les templates fallback. C'est normal !

**Avec clé OpenAI mais erreur :**
- Vérifier que la clé commence par `sk-`
- Vérifier le crédit OpenAI
- Checker les logs serveur pour le message d'erreur

### La page est blanche

- Ouvrir la console navigateur (F12)
- Vérifier que le serveur tourne sur le bon port
- Essayer `http://localhost:3000/login.html` directement

### Les tests échouent

```bash
# Vérifier la version Node
node --version  # Doit être >= 16

# Nettoyer et relancer
npm test -- --clearCache
npm test
```

---

## 📊 Comprendre les résultats IA

### Intentions détectées

| Intent | Exemple message | Réponse type |
|--------|----------------|--------------|
| `check-in` | "Quelle heure pour check-in?" | Horaire + code accès |
| `wifi` | "WiFi password please?" | Nom réseau + mot de passe |
| `parking` | "Où garer ma voiture?" | Info parking |
| `problem` | "Le chauffage est cassé" | Excuses + action rapide |
| `price-negotiation` | "Réduction possible?" | Tarifs actuels |

### Niveaux de risque

| Risk | Signification | Action |
|------|---------------|--------|
| `low` | Question normale | Réponse auto OK |
| `medium` | Problème mineur | Vérifier réponse |
| `high` | Urgence/litige | **ESCALADE** obligatoire |

### Escalade

Quand `escalate: true` :
- ⚠️ Badge rouge affiché
- Note explicative pour l'hôte
- **Ne PAS envoyer la réponse auto**
- Traiter manuellement

---

## 🎨 Personnalisation

### Modifier les templates fallback

Fichier : `server/services/templateService.js`

Ajouter/modifier dans `TEMPLATES` :

```javascript
'custom-intent': {
  fr: "Votre message personnalisé en français",
  en: "Your custom message in English"
}
```

### Ajouter une intention

1. Fichier : `server/services/intentClassifier.js`
2. Ajouter dans `INTENTS` :
```javascript
MY_INTENT: 'my-intent'
```
3. Ajouter dans `INTENT_KEYWORDS` :
```javascript
[INTENTS.MY_INTENT]: ['mot1', 'mot2', 'keyword']
```

### Changer le style

Fichier : `client/styles.css`

Modifier les variables CSS en haut :
```css
:root {
  --primary-color: #FF5A5F;  /* Couleur principale */
  --secondary-color: #00A699; /* Couleur secondaire */
  /* ... */
}
```

---

## 🚀 Passer en production

### Checklist

- [ ] Changer `JWT_SECRET` (min 32 chars aléatoires)
- [ ] Configurer MySQL (pas de mémoire DB en prod)
- [ ] Ajouter clé OpenAI
- [ ] `NODE_ENV=production`
- [ ] Configurer HTTPS (reverse proxy nginx/caddy)
- [ ] Activer logs persistants
- [ ] Backup régulier de la DB
- [ ] Rate limits adaptés au trafic

### Déploiement simple

```bash
# Sur serveur
git clone votre-repo
cd airbnb-ai-agent
npm install --production
cp .env.example .env
# Éditer .env avec vraies valeurs

# Avec PM2 (recommandé)
npm install -g pm2
pm2 start server/server.js --name airbnb-ai
pm2 save
pm2 startup
```

---

**Vous êtes prêt ! 🎉**

Pour toute question : consulter le [README.md](README.md) complet.
