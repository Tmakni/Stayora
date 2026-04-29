# Fonctionnalité de Gestion des Propriétés

## Vue d'ensemble

Cette fonctionnalité permet aux utilisateurs d'ajouter et de gérer leurs propriétés Airbnb directement depuis la page d'accueil. Les utilisateurs peuvent créer des propriétés en remplissant un formulaire avec des informations essentielles et en cochant des cases pour les équipements et règles.

## Nouveautés

### 1. Schéma de base de données étendu

La table `property_profiles` a été étendue avec les champs suivants :

#### Informations de base (obligatoires)
- `name` : Nom de la propriété
- `property_type` : Type (appartement, maison, villa, studio, loft, chalet)
- `bedrooms` : Nombre de chambres
- `beds` : Nombre de lits
- `bathrooms` : Nombre de salles de bain
- `max_guests` : Nombre maximum de voyageurs

#### Équipements (optionnels)
- Wi-Fi
- Cuisine
- Parking
- Piscine
- Salle de sport
- Télévision
- Lave-linge
- Climatisation
- Chauffage
- Espace de travail
- Sèche-cheveux
- Fer à repasser

#### Règles de la maison (optionnels)
- Animaux acceptés
- Fumeurs acceptés
- Événements autorisés

#### Informations supplémentaires (optionnels)
- Adresse
- Description
- Règlement intérieur

### 2. API Backend

Nouvelles routes disponibles :

```
POST   /api/properties          - Créer une nouvelle propriété
GET    /api/properties          - Récupérer toutes les propriétés de l'utilisateur
GET    /api/properties/:id      - Récupérer une propriété spécifique
PUT    /api/properties/:id      - Mettre à jour une propriété
DELETE /api/properties/:id      - Supprimer une propriété
```

### 3. Interface utilisateur

#### Page d'accueil améliorée
- Section "Mes Propriétés" en haut de la page
- Affichage en grille des propriétés existantes
- Bouton "Ajouter une Propriété"

#### Modal de création de propriété
- Formulaire en plusieurs sections :
  - Informations de base (obligatoires)
  - Équipements (cases à cocher avec emojis)
  - Règles de la maison (cases à cocher)
  - Informations supplémentaires (optionnelles)
- Design intuitif avec des icônes emoji pour chaque équipement
- Validation des champs obligatoires

## Installation et Migration

### 1. Mettre à jour la base de données

Option A : Base de données vierge
```bash
mysql -u root -p < schema.sql
```

Option B : Base de données existante (migration)
```bash
mysql -u root -p < migrations/001_add_property_fields.sql
```

### 2. Redémarrer le serveur

```bash
cd server
npm start
```

## Utilisation

1. Connectez-vous à votre compte
2. Sur la page d'accueil, cliquez sur "Ajouter une Propriété"
3. Remplissez les informations obligatoires :
   - Nom de la propriété
   - Type de propriété
   - Nombre de chambres, lits, salles de bain
   - Nombre maximum de voyageurs
4. Cochez les équipements disponibles dans votre propriété
5. Définissez les règles de la maison
6. Ajoutez des informations supplémentaires (optionnel)
7. Cliquez sur "Créer la propriété"

## Fichiers modifiés/créés

### Backend
- `server/controllers/propertyController.js` (nouveau)
- `server/routes/properties.js` (nouveau)
- `server/server.js` (modifié)
- `schema.sql` (modifié)
- `migrations/001_add_property_fields.sql` (nouveau)

### Frontend
- `client/index.html` (modifié)
- `client/styles.css` (modifié)
- `client/app.js` (modifié)

## Fonctionnalités futures

- Modifier une propriété existante
- Supprimer une propriété
- Ajouter des photos de la propriété
- Associer automatiquement une propriété à une conversation
- Import/export des informations de propriété
- Validation avancée des données

## Notes techniques

- Les équipements et règles sont stockés comme des booléens dans la base de données
- Un JSON complet est également stocké dans `context_json` pour la compatibilité avec l'IA
- Toutes les routes API nécessitent une authentification
- Les propriétés sont liées à l'utilisateur via `user_id`
