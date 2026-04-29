-- Seed data pour démo rapide

USE airbnb_ai_agent;

-- User demo (password: "demo123")
INSERT INTO users (email, password_hash) VALUES
('demo@airbnb-ai.com', '$2a$10$X3BqJ5V8zPqXfQ5qKWZJ8OLPqwZ8pLXZJ5Q4qKWZJ8OLPqwZ8pLXZ');

-- Property profile demo
INSERT INTO property_profiles (user_id, name, context_json) VALUES
(1, 'Appartement Centre-Ville Paris', '{
  "wifi_password": "paris2024",
  "wifi_name": "AppartParis_Guest",
  "check_in_time": "15:00",
  "check_out_time": "11:00",
  "rules": "Non-fumeur, pas de fêtes, calme après 22h",
  "parking": "Parking payant à 100m (15€/jour)",
  "amenities": "Cuisine équipée, lave-linge, Netflix, climatisation",
  "nearby": "Métro ligne 1 à 3 min à pied, boulangerie en bas de l\'immeuble",
  "access_code": "A1234B",
  "max_guests": 4,
  "early_checkin": "possible si logement libre (frais 20€)",
  "late_checkout": "possible si logement libre (frais 20€)"
}');

-- Conversation demo
INSERT INTO conversations (user_id, title, booking_status, property_id) VALUES
(1, 'Réservation Mars 2026 - John Smith', 'confirmed', 1);

-- Messages demo
INSERT INTO messages (conversation_id, role, content) VALUES
(1, 'incoming', 'Bonjour, nous arrivons demain vers 13h. Est-ce qu\'un check-in anticipé est possible ?'),
(1, 'outgoing', 'Bonjour John ! Merci pour votre message. Le check-in anticipé à 13h est tout à fait possible si le logement est libre. Il y a des frais de 20€ pour cette prestation. Je vous confirme la disponibilité demain matin. À très bientôt !');
