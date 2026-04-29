# 🧪 Guide de test - Agent IA Airbnb

Ce fichier contient des scénarios de test complets pour valider toutes les fonctionnalités du MVP.

---

## ⚡ Test automatisé (Jest)

```bash
cd airbnb-ai-agent
npm test
```

**Résultat attendu :**
```
PASS  server/tests/intentClassifier.test.js
PASS  server/tests/promptBuilder.test.js
PASS  server/tests/sanitize.test.js

Test Suites: 3 passed, 3 total
Tests:       30 passed, 30 total
```

---

## 🌐 Test interface web (manuel)

### Scénario 1 : Authentification

#### Register
1. Démarrer : `npm start`
2. Ouvrir : `http://localhost:3000/login.html`
3. Cliquer "S'inscrire"
4. Saisir :
   - Email : `test1@airbnb.com`
   - Password : `test123`
5. Cliquer "S'inscrire"

**✅ Résultat attendu :**
- Redirection vers dashboard
- Email affiché en haut à droite
- Message de bienvenue vide si première connexion

#### Login
1. Se déconnecter (bouton)
2. Re-login avec les mêmes identifiants

**✅ Résultat attendu :**
- Connexion réussie
- Dashboard affiché

#### Validation errors
1. Essayer register avec :
   - Email invalide : `notanemail`
   - Password trop court : `12345`
   - Email déjà utilisé

**✅ Résultat attendu :**
- Messages d'erreur clairs affichés
- Pas de redirection
- Formulaire reste rempli

---

### Scénario 2 : Gestion conversations

#### Créer conversation
1. Dashboard → Cliquer "+ Nouvelle Conversation"
2. Saisir :
   - Titre : `Test - Voyageur John`
   - Statut : Confirmée
3. Cliquer "Créer"

**✅ Résultat attendu :**
- Ouverture page conversation
- Titre affiché en haut
- Historique vide
- Formulaire message visible

#### Lister conversations
1. Retour dashboard (← Retour)
2. Créer 2 autres conversations

**✅ Résultat attendu :**
- 3 conversations listées
- Dernière créée en premier
- Cliquer sur une → ouverture détails

---

### Scénario 3 : Génération IA (cas simples)

#### Test 1 : Question WiFi (low risk)

**Setup contexte propriété :**
1. Dans conversation, section "Contexte de la propriété"
2. Cliquer "Modifier"
3. Coller :
```json
{
  "wifi_name": "AppartTest_Guest",
  "wifi_password": "test2024",
  "check_in_time": "15:00",
  "check_out_time": "11:00",
  "access_code": "1234A",
  "parking": "Parking gratuit dans la rue",
  "rules": "Non-fumeur",
  "amenities": "Cuisine, WiFi, TV",
  "nearby": "Métro à 5 min"
}
```
4. Cliquer "Sauvegarder"

**Générer réponse :**
1. Message entrant :
```
Bonjour, nous arrivons ce soir. Pouvez-vous nous donner le mot de passe WiFi ?
```
2. Cliquer "✨ Générer une réponse IA"

**✅ Résultat attendu :**
- Intent : `wifi`
- Risk : `low` (badge vert)
- Escalate : Non (pas de badge rouge)
- Réponse contient :
  - "AppartTest_Guest"
  - "test2024"
  - Ton chaleureux
  - En français (détection auto)

3. Cliquer "📋 Copier la réponse"

**✅ Résultat attendu :**
- Message "Réponse copiée" affiché
- Presse-papier contient la réponse

4. Cliquer "💾 Enregistrer comme envoyée"

**✅ Résultat attendu :**
- 2 messages apparaissent dans historique
- Message voyageur (bleu)
- Réponse hôte (vert)

---

#### Test 2 : Check-in en anglais (medium)

**Message entrant :**
```
Hello! We arrive tomorrow at 1 PM. Is early check-in possible?
```

**✅ Résultat attendu :**
- Intent : `check-in`
- Risk : `low`
- Réponse **en anglais** (détection auto)
- Mentionne early check-in possible
- Tone professionnel

---

#### Test 3 : Problème urgent (high risk + escalade)

**Message entrant :**
```
Le chauffage ne fonctionne pas du tout ! Il fait très froid et c'est urgent !!!
```

**✅ Résultat attendu :**
- Intent : `problem`
- Risk : `medium` ou `high` (orange/rouge)
- **Escalate : ⚠️ ESCALADE** (badge rouge visible)
- **Note pour l'hôte** affichée :
  - Ex: "Problème urgent signalé. Contacter immédiatement."
- Réponse empathique
- **NE PAS envoyer automatiquement**

---

#### Test 4 : Information manquante

**Setup :**
1. Modifier contexte, **supprimer** wifi_name et wifi_password
2. Sauvegarder

**Message entrant :**
```
What's the WiFi info?
```

**✅ Résultat attendu :**
- Intent : `wifi`
- **Section "Informations manquantes"** affichée
- Questions listées :
  - "What is the WiFi network name?"
  - "What is the WiFi password?"
- Réponse générique demandant de patienter

---

### Scénario 4 : Langue & profil voyageur

#### Test multilingue

**Messages à tester :**

1. Français :
```
Bonjour, y a-t-il un parking pour notre voiture ?
```
→ Réponse en français, intent `parking`

2. Anglais :
```
Hi, where can we park our car?
```
→ Réponse en anglais, intent `parking`

**✅ Résultat attendu :**
- Détection langue automatique
- Réponses dans la bonne langue
- Info parking du contexte

#### Test profil voyageur

**Setup :**
1. Message : `We are 4 people, is that ok?`
2. **Avant de générer :**
   - Nombre de personnes : `4`
   - Langue : `en`

**✅ Résultat attendu :**
- Réponse peut mentionner capacité (max_guests: 4 dans contexte)
- Confirmation que OK pour 4

---

### Scénario 5 : Historique conversation

1. Créer conversation
2. Ajouter plusieurs échanges :
   - Message 1 : WiFi
   - Réponse 1
   - Message 2 : Check-in
   - Réponse 2
   - Message 3 : Parking
   - Générer (sans enregistrer)

**✅ Résultat attendu :**
- Génération tient compte de l'historique
- Pas de répétition d'infos déjà données
- Réponse cohérente avec contexte

---

## 🔌 Test API (curl)

### Test complet avec curl

```bash
#!/bin/bash

BASE_URL="http://localhost:3000"

# 1. Register
echo "=== REGISTER ==="
REGISTER_RESP=$(curl -s -X POST $BASE_URL/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"curl-test@example.com","password":"test123"}')

echo $REGISTER_RESP | jq

TOKEN=$(echo $REGISTER_RESP | jq -r '.token')
echo "Token: $TOKEN"

# 2. Me
echo -e "\n=== ME ==="
curl -s $BASE_URL/api/auth/me \
  -H "Authorization: Bearer $TOKEN" | jq

# 3. Create conversation
echo -e "\n=== CREATE CONVERSATION ==="
CONV_RESP=$(curl -s -X POST $BASE_URL/api/conversations \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"title":"API Test","booking_status":"confirmed"}')

echo $CONV_RESP | jq

CONV_ID=$(echo $CONV_RESP | jq -r '.conversation.id')
echo "Conversation ID: $CONV_ID"

# 4. Generate draft
echo -e "\n=== GENERATE DRAFT ==="
curl -s -X POST $BASE_URL/api/ai/draft \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "{
    \"conversation_id\": $CONV_ID,
    \"incoming_message\": \"What time is check-in?\",
    \"property_context\": {
      \"check_in_time\": \"15:00\",
      \"access_code\": \"A1234\"
    }
  }" | jq

# 5. Add message
echo -e "\n=== ADD MESSAGE ==="
curl -s -X POST $BASE_URL/api/conversations/$CONV_ID/messages \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"role":"incoming","content":"What time is check-in?"}' | jq

# 6. Get conversation
echo -e "\n=== GET CONVERSATION ==="
curl -s $BASE_URL/api/conversations/$CONV_ID \
  -H "Authorization: Bearer $TOKEN" | jq

# 7. List conversations
echo -e "\n=== LIST CONVERSATIONS ==="
curl -s $BASE_URL/api/conversations \
  -H "Authorization: Bearer $TOKEN" | jq

echo -e "\n=== TESTS COMPLETED ==="
```

**✅ Validation :**
- Tous les appels retournent 200/201
- Token généré valide
- Conversation créée avec bon ID
- Draft généré avec intent/risk
- Messages sauvegardés correctement

---

## 🚨 Test erreurs & edge cases

### Auth errors

```bash
# Invalid credentials
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"wrong@test.com","password":"wrong"}'
# → 401 Unauthorized

# Missing token
curl http://localhost:3000/api/conversations
# → 401 Authentication required

# Invalid token
curl http://localhost:3000/api/auth/me \
  -H "Authorization: Bearer invalid-token"
# → 401 Invalid token
```

### Validation errors

```bash
# Missing required field
curl -X POST http://localhost:3000/api/conversations \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}'
# → 400 Title required

# Invalid booking status
curl -X POST http://localhost:3000/api/conversations \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title":"Test","booking_status":"invalid"}'
# → 400 Invalid booking status
```

### Rate limiting

```bash
# Spam AI endpoint (>10 req/min)
for i in {1..15}; do
  curl -X POST http://localhost:3000/api/ai/draft \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"incoming_message":"test"}'
  echo ""
done
# → Après 10 requêtes : 429 Too Many Requests
```

---

## 📊 Checklist validation complète

### Backend

- [ ] Server démarre sur port 3000
- [ ] Health check `/api/health` répond
- [ ] MySQL connecté OU fallback mémoire actif
- [ ] JWT généré à register/login
- [ ] Auth middleware bloque sans token
- [ ] Rate limit fonctionne (>10 req AI)
- [ ] Sanitization appliquée (test script tag)
- [ ] Logs propres (pas de secrets)

### Services IA

- [ ] Détection intent fonctionne (12 types)
- [ ] Évaluation risk correcte (low/med/high)
- [ ] Escalade déclenchée si nécessaire
- [ ] Langue détectée (FR/EN)
- [ ] OpenAI génère réponse (si clé configurée)
- [ ] Fallback templates si OpenAI down
- [ ] Questions générées si info manquante
- [ ] Contexte propriété utilisé

### Frontend

- [ ] Login page accessible
- [ ] Register fonctionne
- [ ] Login fonctionne
- [ ] Token stocké (localStorage)
- [ ] Redirect si pas auth
- [ ] Dashboard affiche conversations
- [ ] Créer conversation fonctionne
- [ ] Page conversation charge messages
- [ ] Génération IA affiche résultat
- [ ] Badges risk affichés correctement
- [ ] Badge escalade si nécessaire
- [ ] Copier réponse fonctionne
- [ ] Sauvegarder messages fonctionne
- [ ] Modifier contexte propriété fonctionne

### Tests Jest

- [ ] `npm test` passe
- [ ] 30/30 tests OK
- [ ] Coverage > 80% sur services

---

## 🎯 Scénarios métier complets

### Scénario A : Nouvel hôte découvre l'outil

1. Inscription
2. Crée première conversation "Résa Avril - Marie"
3. Configure contexte propriété (WiFi, check-in, etc.)
4. Reçoit message : "Bonjour, comment fait-on pour entrer ?"
5. Génère réponse → copie → envoie sur Airbnb
6. Sauvegarde dans historique

**✅ Success :** Hôte a gagné du temps, réponse pro générée en 10 sec

### Scénario B : Problème urgent à gérer

1. Message voyageur : "Fuite d'eau dans la salle de bain !"
2. Génère réponse → **ESCALADE** détectée
3. Hôte voit note : "Urgence - contacter plombier immédiatement"
4. Hôte **ignore la réponse auto** et répond manuellement
5. Sauvegarde quand même pour historique

**✅ Success :** Système a alerté, hôte a géré manuellement

### Scénario C : Multi-langues

1. Message FR : "Où est le métro ?"
   → Réponse FR générée
2. Message EN : "Where is the metro?"
   → Réponse EN générée
3. Même contexte utilisé

**✅ Success :** Support multilingue automatique

---

## 🏁 Validation finale

**Pour valider le MVP :**

1. ✅ Tous les tests Jest passent
2. ✅ Flux complet web fonctionne (register → conversation → IA → save)
3. ✅ API endpoints répondent correctement
4. ✅ Escalade détectée sur cas urgents
5. ✅ Langue détectée automatiquement
6. ✅ Fallback templates si pas OpenAI
7. ✅ Rate limiting actif
8. ✅ Aucune erreur console navigateur
9. ✅ Aucune erreur logs serveur
10. ✅ Documentation complète et claire

**Si tous les points CI-DESSUS sont ✅ → MVP VALIDÉ 🎉**

---

## 📝 Notes de test

**Environnement de test recommandé :**
- Node.js 18+
- Chrome/Firefox dernière version
- Sans clé OpenAI (tester fallback)
- Puis avec clé OpenAI (tester vraie génération)

**Durée tests complète :**
- Tests auto Jest : 10 secondes
- Tests manuels web : 15 minutes
- Tests API curl : 5 minutes
- **Total : ~20 minutes**

Bons tests ! 🧪✨
