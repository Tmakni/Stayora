/**
 * Migration 005 — iCal calendars, events & availability blocks
 *
 * Adds the tables required by the iCal sync feature:
 *   - ical_calendars   : stores the iCal URL linked to a property
 *   - ical_events      : parsed VEVENT entries from the iCal feed
 *   - availability_blocks : manual date blocks (reserved / maintenance…)
 */
exports.up = async function (knex) {

  // ── availability_blocks ──────────────────────────────────────────────────
  await knex.schema.createTable('availability_blocks', (t) => {
    t.increments('id').primary();
    t.integer('property_id').unsigned().notNullable()
      .references('id').inTable('property_profiles').onDelete('CASCADE');
    t.integer('user_id').unsigned().notNullable()
      .references('id').inTable('users').onDelete('CASCADE');
    t.date('start_date').notNullable();
    t.date('end_date').notNullable();
    t.string('reason', 255).defaultTo('reserved');
    t.string('guest_name', 255).nullable();
    t.string('source', 50).defaultTo('manual');
    t.integer('reservation_id').unsigned().nullable()
      .references('id').inTable('reservations').onDelete('SET NULL');
    t.text('notes').nullable();
    t.timestamp('created_at').defaultTo(knex.fn.now());

    t.index('property_id', 'idx_ab_property');
    t.index(['start_date', 'end_date'], 'idx_ab_dates');
  });

  // ── ical_calendars ───────────────────────────────────────────────────────
  await knex.schema.createTable('ical_calendars', (t) => {
    t.increments('id').primary();
    t.integer('user_id').unsigned().notNullable()
      .references('id').inTable('users').onDelete('CASCADE');
    t.integer('property_id').unsigned().notNullable()
      .references('id').inTable('property_profiles').onDelete('CASCADE');
    t.text('ical_url').notNullable();
    t.timestamp('last_synced_at').nullable();
    t.string('sync_status', 20).defaultTo('pending');
    t.text('sync_error').nullable();
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.timestamp('updated_at').defaultTo(knex.fn.now());

    t.index('property_id', 'idx_ical_cal_property');
    t.index('user_id', 'idx_ical_cal_user');
  });

  // ── ical_events ──────────────────────────────────────────────────────────
  await knex.schema.createTable('ical_events', (t) => {
    t.increments('id').primary();
    t.integer('property_id').unsigned().notNullable()
      .references('id').inTable('property_profiles').onDelete('CASCADE');
    t.string('event_uid', 500).notNullable();
    t.date('start_date').notNullable();
    t.date('end_date').notNullable();
    t.string('status', 50).defaultTo('confirmed');
    t.text('summary').nullable();
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.timestamp('updated_at').defaultTo(knex.fn.now());

    t.index('property_id', 'idx_ical_ev_property');
    t.index('event_uid', 'idx_ical_ev_uid');
    t.index(['start_date', 'end_date'], 'idx_ical_ev_dates');
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('ical_events');
  await knex.schema.dropTableIfExists('ical_calendars');
  await knex.schema.dropTableIfExists('availability_blocks');
};
