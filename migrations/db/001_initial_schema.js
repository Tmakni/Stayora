/**
 * Migration 001 — Schéma initial complet
 *
 * Crée toutes les tables du projet avec les contraintes, index,
 * et relations de clés étrangères.
 *
 * Compatible : SQLite (dev) + MySQL (prod) via Knex.
 */

exports.up = async function (knex) {

  // ── users ────────────────────────────────────────────────────────────────
  await knex.schema.createTable('users', (t) => {
    t.increments('id').primary();
    t.string('email', 255).notNullable().unique();
    t.string('password_hash', 255).notNullable();
    t.timestamp('created_at').defaultTo(knex.fn.now());
  });

  // ── property_profiles ────────────────────────────────────────────────────
  await knex.schema.createTable('property_profiles', (t) => {
    t.increments('id').primary();
    t.integer('user_id').unsigned().notNullable()
      .references('id').inTable('users').onDelete('CASCADE');

    t.string('name', 255).notNullable();
    t.string('property_type', 100).notNullable();
    t.integer('bedrooms').notNullable();
    t.integer('beds').notNullable();
    t.integer('bathrooms').notNullable();
    t.integer('max_guests').notNullable();

    // Équipements
    t.boolean('has_wifi').defaultTo(false);
    t.boolean('has_kitchen').defaultTo(false);
    t.boolean('has_parking').defaultTo(false);
    t.boolean('has_pool').defaultTo(false);
    t.boolean('has_gym').defaultTo(false);
    t.boolean('has_tv').defaultTo(false);
    t.boolean('has_washing_machine').defaultTo(false);
    t.boolean('has_air_conditioning').defaultTo(false);
    t.boolean('has_heating').defaultTo(false);
    t.boolean('has_workspace').defaultTo(false);
    t.boolean('has_hair_dryer').defaultTo(false);
    t.boolean('has_iron').defaultTo(false);
    t.boolean('has_bathtub').defaultTo(false);
    t.boolean('has_dryer').defaultTo(false);
    t.boolean('has_dishwasher').defaultTo(false);
    t.boolean('has_microwave').defaultTo(false);
    t.boolean('has_refrigerator').defaultTo(false);
    t.boolean('has_coffee_maker').defaultTo(false);
    t.boolean('has_smoke_detector').defaultTo(false);
    t.boolean('has_carbon_monoxide_detector').defaultTo(false);
    t.boolean('has_fire_extinguisher').defaultTo(false);
    t.boolean('has_first_aid_kit').defaultTo(false);
    t.boolean('has_bbq').defaultTo(false);
    t.boolean('has_terrace').defaultTo(false);
    t.boolean('has_garden').defaultTo(false);
    t.boolean('has_netflix').defaultTo(false);
    t.boolean('has_fireplace').defaultTo(false);

    // Règles
    t.boolean('allows_pets').defaultTo(false);
    t.boolean('allows_smoking').defaultTo(false);
    t.boolean('allows_events').defaultTo(false);

    // Infos texte
    t.text('address').nullable();
    t.text('description').nullable();
    t.text('house_rules').nullable();

    // Auto-reply IA
    t.boolean('auto_reply_enabled').defaultTo(false);
    t.string('reply_tone', 50).defaultTo('professional');

    // Intégration Airbnb
    t.string('superhot_listing_id', 255).nullable();

    // Contexte IA (blob JSON avec toutes les infos pratiques)
    t.text('context_json').nullable();

    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.timestamp('updated_at').defaultTo(knex.fn.now());

    t.index('user_id', 'idx_pp_user_id');
  });

  // ── airbnb_accounts ──────────────────────────────────────────────────────
  await knex.schema.createTable('airbnb_accounts', (t) => {
    t.increments('id').primary();
    t.integer('user_id').unsigned().notNullable()
      .references('id').inTable('users').onDelete('CASCADE');

    t.string('airbnb_email', 255).notNullable();
    t.text('access_token_enc').nullable();     // AES-256-GCM chiffré
    t.text('refresh_token_enc').nullable();    // AES-256-GCM chiffré
    t.timestamp('token_expires_at').nullable();
    t.string('airbnb_user_id', 100).nullable();
    t.string('display_name', 255).nullable();
    t.boolean('is_active').defaultTo(true);
    t.timestamp('last_sync_at').nullable();
    t.enu('sync_status', ['idle', 'syncing', 'error']).defaultTo('idle');
    t.text('sync_error').nullable();

    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.timestamp('updated_at').defaultTo(knex.fn.now());

    t.unique(['user_id', 'airbnb_email'], 'uq_user_airbnb_email');
    t.index('user_id', 'idx_aa_user_id');
  });

  // ── reservations ─────────────────────────────────────────────────────────
  await knex.schema.createTable('reservations', (t) => {
    t.increments('id').primary();
    t.integer('user_id').unsigned().notNullable()
      .references('id').inTable('users').onDelete('CASCADE');
    t.integer('property_id').unsigned().nullable()
      .references('id').inTable('property_profiles').onDelete('SET NULL');
    t.integer('airbnb_account_id').unsigned().nullable()
      .references('id').inTable('airbnb_accounts').onDelete('SET NULL');

    t.string('airbnb_reservation_id', 100).unique().nullable();
    t.string('airbnb_listing_id', 100).nullable();
    t.string('confirmation_code', 50).nullable();
    t.string('guest_name', 255).nullable();
    t.string('guest_email', 255).nullable();
    t.string('guest_phone', 100).nullable();
    t.text('guest_photo_url').nullable();
    t.integer('number_of_guests').defaultTo(1);
    t.date('check_in_date').notNullable();
    t.date('check_out_date').notNullable();
    t.timestamp('booked_at').nullable();
    t.decimal('total_price', 10, 2).nullable();
    t.string('currency', 10).defaultTo('EUR');
    t.decimal('host_payout', 10, 2).nullable();
    t.enu('status', ['pending','accepted','confirmed','checkedin','checkedout','cancelled','denied','expired']).defaultTo('pending');
    t.string('previous_status', 50).nullable();
    t.timestamp('status_changed_at').nullable();
    t.integer('conversation_id').unsigned().nullable();
    t.text('airbnb_raw_json').nullable();     // JSON brut de l'API Airbnb
    t.timestamp('last_synced_at').nullable();

    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.timestamp('updated_at').defaultTo(knex.fn.now());

    t.index('user_id',       'idx_res_user_id');
    t.index('status',        'idx_res_status');
    t.index('check_in_date', 'idx_res_checkin');
  });

  // ── conversations ────────────────────────────────────────────────────────
  await knex.schema.createTable('conversations', (t) => {
    t.increments('id').primary();
    t.integer('user_id').unsigned().notNullable()
      .references('id').inTable('users').onDelete('CASCADE');

    t.string('title', 255).notNullable();
    t.enu('booking_status', ['inquiry','request','confirmed','checkedin','checkedout']).defaultTo('inquiry');
    t.integer('property_id').unsigned().nullable()
      .references('id').inTable('property_profiles').onDelete('SET NULL');
    t.integer('reservation_id').unsigned().nullable()
      .references('id').inTable('reservations').onDelete('SET NULL');

    t.string('airbnb_thread_id', 100).nullable();
    t.string('external_id', 255).nullable();
    t.string('external_provider', 50).nullable();
    t.string('guest_name', 255).nullable();
    t.string('guest_language', 10).nullable();

    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.timestamp('updated_at').defaultTo(knex.fn.now());

    t.index('user_id',          'idx_conv_user_id');
    t.index('created_at',       'idx_conv_created');
    t.index('reservation_id',   'idx_conv_resa');
    t.index('airbnb_thread_id', 'idx_conv_thread');
  });

  // ── messages ─────────────────────────────────────────────────────────────
  await knex.schema.createTable('messages', (t) => {
    t.increments('id').primary();
    t.integer('conversation_id').unsigned().notNullable()
      .references('id').inTable('conversations').onDelete('CASCADE');

    t.enu('role', ['incoming', 'outgoing', 'system']).notNullable();
    t.text('content').notNullable();
    t.text('metadata_json').nullable();
    t.timestamp('created_at').defaultTo(knex.fn.now());

    t.index('conversation_id', 'idx_msg_conv_id');
    t.index('created_at',      'idx_msg_created');
  });

  // ── airbnb_threads ───────────────────────────────────────────────────────
  await knex.schema.createTable('airbnb_threads', (t) => {
    t.increments('id').primary();
    t.integer('user_id').unsigned().notNullable()
      .references('id').inTable('users').onDelete('CASCADE');
    t.integer('airbnb_account_id').unsigned().notNullable()
      .references('id').inTable('airbnb_accounts').onDelete('CASCADE');

    t.string('airbnb_thread_id', 100).notNullable();
    t.integer('reservation_id').unsigned().nullable()
      .references('id').inTable('reservations').onDelete('SET NULL');
    t.integer('conversation_id').unsigned().nullable()
      .references('id').inTable('conversations').onDelete('SET NULL');

    t.string('guest_name', 255).nullable();
    t.string('guest_airbnb_id', 100).nullable();
    t.string('listing_name', 255).nullable();
    t.string('airbnb_listing_id', 100).nullable();
    t.timestamp('last_message_at').nullable();
    t.integer('unread_count').defaultTo(0);
    t.timestamp('last_synced_at').nullable();

    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.timestamp('updated_at').defaultTo(knex.fn.now());

    t.unique(['airbnb_account_id', 'airbnb_thread_id'], 'uq_thread');
    t.index('user_id', 'idx_at_user_id');
  });

  // ── user_integrations ────────────────────────────────────────────────────
  await knex.schema.createTable('user_integrations', (t) => {
    t.increments('id').primary();
    t.integer('user_id').unsigned().notNullable()
      .references('id').inTable('users').onDelete('CASCADE');

    t.string('provider', 50).notNullable().defaultTo('superhot');
    t.text('api_key_enc').nullable();        // AES-256-GCM chiffré
    t.string('webhook_secret', 255).nullable();
    t.boolean('is_active').defaultTo(false);

    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.timestamp('updated_at').defaultTo(knex.fn.now());

    t.unique(['user_id', 'provider'], 'uq_user_provider');
    t.index('user_id', 'idx_ui_user_id');
  });

  // ── webhook_logs ─────────────────────────────────────────────────────────
  await knex.schema.createTable('webhook_logs', (t) => {
    t.increments('id').primary();
    t.integer('user_id').unsigned().nullable()
      .references('id').inTable('users').onDelete('SET NULL');

    t.string('provider', 50).notNullable();
    t.text('payload_json').notNullable();
    t.boolean('processed').defaultTo(false);
    t.integer('conversation_id').unsigned().nullable();
    t.boolean('auto_replied').defaultTo(false);
    t.text('error_message').nullable();
    t.timestamp('received_at').defaultTo(knex.fn.now());

    t.index('received_at', 'idx_wl_received');
    t.index('user_id',     'idx_wl_user_id');
  });

  // ── sync_logs ────────────────────────────────────────────────────────────
  await knex.schema.createTable('sync_logs', (t) => {
    t.increments('id').primary();
    t.integer('user_id').unsigned().notNullable()
      .references('id').inTable('users').onDelete('CASCADE');
    t.integer('airbnb_account_id').unsigned().nullable();

    t.enu('sync_type', ['messages', 'reservations', 'full']).notNullable();
    t.enu('status', ['started', 'completed', 'failed']).notNullable();
    t.integer('items_synced').defaultTo(0);
    t.text('error_message').nullable();
    t.timestamp('started_at').defaultTo(knex.fn.now());
    t.timestamp('completed_at').nullable();

    t.index('user_id', 'idx_sl_user_id');
  });

  // ── audit_logs ───────────────────────────────────────────────────────────
  await knex.schema.createTable('audit_logs', (t) => {
    t.increments('id').primary();
    t.integer('user_id').unsigned().nullable()
      .references('id').inTable('users').onDelete('SET NULL');

    t.string('action', 100).notNullable();
    t.string('entity_type', 50).nullable();
    t.integer('entity_id').nullable();
    t.string('ip_address', 45).nullable();
    t.text('user_agent').nullable();
    t.text('details').nullable();
    t.timestamp('created_at').defaultTo(knex.fn.now());

    t.index('user_id',    'idx_al_user_id');
    t.index('action',     'idx_al_action');
    t.index('created_at', 'idx_al_created');
  });
};

exports.down = async function (knex) {
  // On supprime dans l'ordre inverse des dépendances FK
  await knex.schema.dropTableIfExists('audit_logs');
  await knex.schema.dropTableIfExists('sync_logs');
  await knex.schema.dropTableIfExists('webhook_logs');
  await knex.schema.dropTableIfExists('user_integrations');
  await knex.schema.dropTableIfExists('airbnb_threads');
  await knex.schema.dropTableIfExists('messages');
  await knex.schema.dropTableIfExists('conversations');
  await knex.schema.dropTableIfExists('reservations');
  await knex.schema.dropTableIfExists('airbnb_accounts');
  await knex.schema.dropTableIfExists('property_profiles');
  await knex.schema.dropTableIfExists('users');
};
