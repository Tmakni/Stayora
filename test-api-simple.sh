#!/bin/bash

echo "=== Test API Propriétés ==="

# Créer un utilisateur et obtenir le token
echo ""
echo "1. Création/Connexion utilisateur..."
REGISTER_RESPONSE=$(curl -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"user001@test.com","password":"Test1234!"}' \
  -s -w "\n%{http_code}")

HTTP_CODE=$(echo "$REGISTER_RESPONSE" | tail -n1)
BODY=$(echo "$REGISTER_RESPONSE" | head -n-1)

if [ "$HTTP_CODE" = "201" ] || [ "$HTTP_CODE" = "200" ]; then
    TOKEN=$(echo "$BODY" | grep -o '"token":"[^"]*' | grep -o '[^"]*$')
    echo "OK - Nouveau compte créé (HTTP $HTTP_CODE)"
else
    # Si le compte existe, se connecter
    echo "Le compte existe, connexion..."
    LOGIN_RESPONSE=$(curl -X POST http://localhost:3000/api/auth/login \
      -H "Content-Type: application/json" \
      -d '{"email":"user001@test.com","password":"Test1234!"}' \
      -s -w "\n%{http_code}")
    
    HTTP_CODE=$(echo "$LOGIN_RESPONSE" | tail -n1)
    BODY=$(echo "$LOGIN_RESPONSE" | head -n-1)
    TOKEN=$(echo "$BODY" | grep -o '"token":"[^"]*' | grep -o '[^"]*$')
    echo "OK - Connexion réussie (HTTP $HTTP_CODE)"
fi

if [ -z "$TOKEN" ]; then
    echo "ERREUR - Pas de token obtenu"
    echo "Response: $BODY"
    exit 1
fi

echo "Token: ${TOKEN:0:30}..."

# Créer une propriété
echo ""
echo "2. Création d'une propriété..."
PROPERTY_RESPONSE=$(curl -X POST http://localhost:3000/api/properties \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"name":"Villa de Test","property_type":"villa","bedrooms":4,"beds":5,"bathrooms":3,"max_guests":8,"has_wifi":true,"has_kitchen":true,"has_pool":true,"has_parking":true,"description":"Belle villa"}' \
  -s -w "\n%{http_code}")

HTTP_CODE=$(echo "$PROPERTY_RESPONSE" | tail -n1)
BODY=$(echo "$PROPERTY_RESPONSE" | head -n-1)

echo "HTTP Code: $HTTP_CODE"
echo "Response: $BODY"

# Lister les propriétés
echo ""
echo "3. Liste des propriétés..."
LIST_RESPONSE=$(curl -X GET http://localhost:3000/api/properties \
  -H "Authorization: Bearer $TOKEN" \
  -s -w "\n%{http_code}")

HTTP_CODE=$(echo "$LIST_RESPONSE" | tail -n1)
BODY=$(echo "$LIST_RESPONSE" | head -n-1)

echo "HTTP Code: $HTTP_CODE"
echo "Response: $BODY"

echo ""
echo "=== Test terminé ==="
