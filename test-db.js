// Test simple de la création de propriété
const { getDatabase } = require('./server/config/db');
const { initDatabase } = require('./server/config/db');

async function test() {
  try {
    console.log('1. Initialisation de la base de donnees...');
    await initDatabase();
    console.log('OK - Base de donnees initialisee');
    
    console.log('');
    console.log('2. Recuperation de linstance db...');
    const db = getDatabase();
    console.log('OK - Instance db recuperee:', typeof db);
    console.log('  db.query est une fonction:', typeof db.query === 'function');
    
    console.log('');
    console.log('3. Test de creation de propriete...');
    const userId = 1;
    const result = await db.query(
      `INSERT INTO property_profiles (
        user_id, name, property_type, bedrooms, beds, bathrooms, max_guests,
        has_wifi, has_kitchen, has_parking, has_pool, has_gym, has_tv,
        has_washing_machine, has_air_conditioning, has_heating, has_workspace,
        has_hair_dryer, has_iron, allows_pets, allows_smoking, allows_events,
        address, description, house_rules, context_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        userId, 'Test Villa', 'villa', 3, 4, 2, 6,
        true, true, true, true, false, true,
        false, true, true, false, false, false, false, false, false,
        'Test Address', 'Test Description', 'Test Rules', '{"test": true}'
      ]
    );
    
    console.log('OK - Propriete creee!');
    console.log('  Resultat:', result);
    console.log('  insertId:', result ? result.insertId : 'undefined');
    
    console.log('');
    console.log('4. Recuperation des proprietes...');
    const properties = await db.query(
      'SELECT * FROM property_profiles WHERE user_id = ?',
      [userId]
    );
    console.log('OK - Proprietes:', properties);
    console.log('  Nombre:', properties ? properties.length : 0);
    
  } catch (error) {
    console.error('');
    console.error('ERREUR:', error.message);
    console.error('Stack:', error.stack);
  }
}

test();
