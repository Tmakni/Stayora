// In-memory fallback database pour dev sans MySQL

const data = {
  users: [],
  conversations: [],
  messages: [],
  propertyProfiles: [],
  webhookLogs: [],
  airbnbAccounts: [],
  reservations: [],
  airbnbThreads: [],
  syncLogs: [],
  auditLogs: []
};

let userIdCounter = 1;
let conversationIdCounter = 1;
let messageIdCounter = 1;
let propertyIdCounter = 1;
let webhookLogIdCounter = 1;
let airbnbAccountIdCounter = 1;
let reservationIdCounter = 1;
let airbnbThreadIdCounter = 1;
let syncLogIdCounter = 1;
let auditLogIdCounter = 1;

async function query(sql, params = []) {
  const sqlLower = sql.toLowerCase().trim();
  
  // INSERT user
  if (sqlLower.includes('insert into users')) {
    const user = {
      id: userIdCounter++,
      email: params[0],
      password_hash: params[1],
      created_at: new Date()
    };
    data.users.push(user);
    return { insertId: user.id };
  }
  
  // SELECT user by email
  if (sqlLower.includes('select') && sqlLower.includes('from users') && sqlLower.includes('where email')) {
    const user = data.users.find(u => u.email === params[0]);
    return user ? [user] : [];
  }
  
  // SELECT user by id
  if (sqlLower.includes('select') && sqlLower.includes('from users') && sqlLower.includes('where id')) {
    const user = data.users.find(u => u.id === parseInt(params[0]));
    return user ? [user] : [];
  }
  
  // INSERT conversation
  if (sqlLower.includes('insert into conversations')) {
    const conv = {
      id: conversationIdCounter++,
      user_id: parseInt(params[0]),
      title: params[1],
      booking_status: params[2] || 'inquiry',
      property_id: params[3] ? parseInt(params[3]) : null,
      reservation_id: params[4] ? parseInt(params[4]) : null,
      airbnb_thread_id: params[5] || null,
      external_id: params[6] || params[4] || null,
      external_provider: params[7] || params[5] || null,
      guest_name: params[8] || params[6] || null,
      guest_language: params[9] || params[7] || null,
      created_at: new Date(),
      updated_at: new Date()
    };
    data.conversations.push(conv);
    return { insertId: conv.id };
  }
  
  // SELECT conversations by user
  if (sqlLower.includes('select') && sqlLower.includes('from conversations') && sqlLower.includes('where user_id')) {
    const convs = data.conversations.filter(c => c.user_id === parseInt(params[0]));
    return convs.sort((a, b) => b.created_at - a.created_at);
  }

  // SELECT conversation by external_id
  if (sqlLower.includes('select') && sqlLower.includes('from conversations') && sqlLower.includes('where external_id')) {
    const conv = data.conversations.find(c => c.external_id === params[0] && c.external_provider === 'superhot');
    return conv ? [conv] : [];
  }
  
  // SELECT conversation by id
  if (sqlLower.includes('select') && sqlLower.includes('from conversations') && sqlLower.includes('where id')) {
    const conv = data.conversations.find(c => c.id === parseInt(params[0]));
    return conv ? [conv] : [];
  }
  
  // INSERT message
  if (sqlLower.includes('insert into messages')) {
    const msg = {
      id: messageIdCounter++,
      conversation_id: parseInt(params[0]),
      role: params[1],
      content: params[2],
      metadata_json: params[3] || null,
      created_at: params[4] ? new Date(params[4]) : new Date()
    };
    data.messages.push(msg);
    return { insertId: msg.id };
  }
  
  // SELECT messages by conversation
  if (sqlLower.includes('select') && sqlLower.includes('from messages') && sqlLower.includes('where conversation_id')) {
    let msgs = data.messages.filter(m => m.conversation_id === parseInt(params[0]));
    if (sqlLower.includes('order by created_at desc')) {
      msgs.sort((a, b) => b.created_at - a.created_at);
      if (sqlLower.includes('limit') && params.length > 1) {
        msgs = msgs.slice(0, parseInt(params[1]));
      }
    } else {
      msgs.sort((a, b) => a.created_at - b.created_at);
    }
    return msgs;
  }
  
  // INSERT property profile
  if (sqlLower.includes('insert into property_profiles')) {
    const prop = {
      id: propertyIdCounter++,
      user_id: params[0],
      name: params[1],
      property_type: params[2],
      bedrooms: params[3],
      beds: params[4],
      bathrooms: params[5],
      max_guests: params[6],
      has_wifi: params[7],
      has_kitchen: params[8],
      has_parking: params[9],
      has_pool: params[10],
      has_gym: params[11],
      has_tv: params[12],
      has_washing_machine: params[13],
      has_air_conditioning: params[14],
      has_heating: params[15],
      has_workspace: params[16],
      has_hair_dryer: params[17],
      has_iron: params[18],
      has_bathtub: params[19],
      has_dryer: params[20],
      has_dishwasher: params[21],
      has_microwave: params[22],
      has_refrigerator: params[23],
      has_coffee_maker: params[24],
      has_smoke_detector: params[25],
      has_carbon_monoxide_detector: params[26],
      has_fire_extinguisher: params[27],
      has_first_aid_kit: params[28],
      has_bbq: params[29],
      has_terrace: params[30],
      has_garden: params[31],
      has_netflix: params[32],
      has_fireplace: params[33],
      allows_pets: params[34],
      allows_smoking: params[35],
      allows_events: params[36],
      address: params[37],
      description: params[38],
      house_rules: params[39],
      auto_reply_enabled: !!params[40],
      reply_tone: params[41] || 'professional',
      context_json: params[42],
      created_at: new Date(),
      updated_at: new Date()
    };
    data.propertyProfiles.push(prop);
    return { insertId: prop.id };
  }
  
  // SELECT property profiles by user_id with superhot_listing_id or LIKE filter
  if (sqlLower.includes('select') && sqlLower.includes('from property_profiles') && sqlLower.includes('where user_id') && (sqlLower.includes('superhot_listing_id') || sqlLower.includes('like'))) {
    const userId = parseInt(params[0]);
    const listingId = params[1];
    const likePattern = params[2] || '';
    const props = data.propertyProfiles.filter(p => {
      if (p.user_id !== userId) return false;
      if (p.superhot_listing_id === listingId) return true;
      if (likePattern && p.context_json && p.context_json.includes(likePattern.replace(/%/g, ''))) return true;
      return false;
    });
    return props;
  }

  // SELECT property profiles by user
  if (sqlLower.includes('select') && sqlLower.includes('from property_profiles') && sqlLower.includes('where user_id')) {
    const props = data.propertyProfiles.filter(p => p.user_id === parseInt(params[0]));
    return props.sort((a, b) => b.created_at - a.created_at);
  }
  
  // SELECT property profile by id and user
  if (sqlLower.includes('select') && sqlLower.includes('from property_profiles') && sqlLower.includes('where id') && sqlLower.includes('and user_id')) {
    const prop = data.propertyProfiles.find(p => p.id === parseInt(params[0]) && p.user_id === parseInt(params[1]));
    return prop ? [prop] : [];
  }
  
  // SELECT property profile by id
  if (sqlLower.includes('select') && sqlLower.includes('from property_profiles') && sqlLower.includes('where id')) {
    const prop = data.propertyProfiles.find(p => p.id === parseInt(params[0]));
    return prop ? [prop] : [];
  }
  
  // UPDATE conversations
  if (sqlLower.includes('update conversations')) {
    // Handle WHERE reservation_id = ?
    if (sqlLower.includes('where reservation_id')) {
      const resaId = parseInt(params[params.length - 1]);
      const matchingConvs = data.conversations.filter(c => c.reservation_id === resaId);
      matchingConvs.forEach(conv => {
        if (params[0]) conv.booking_status = params[0];
        conv.updated_at = new Date();
      });
      return { affectedRows: matchingConvs.length };
    }
    // Handle WHERE id = ?
    const convId = params[params.length - 1];
    const conv = data.conversations.find(c => c.id === parseInt(convId));
    if (conv) {
      if (params.includes('inquiry') || params.includes('confirmed') || params.includes('checkedin') || params.includes('checkedout') || params.includes('request')) {
        const status = params.find(p => ['inquiry','request','confirmed','checkedin','checkedout'].includes(p));
        if (status) conv.booking_status = status;
      }
      conv.updated_at = new Date();
      return { affectedRows: 1 };
    }
    return { affectedRows: 0 };
  }

  // INSERT webhook_logs
  if (sqlLower.includes('insert into webhook_logs')) {
    const log = { id: webhookLogIdCounter++, provider: params[0], payload_json: params[1], processed: false, received_at: new Date() };
    data.webhookLogs.push(log);
    return { insertId: log.id };
  }

  // UPDATE webhook_logs
  if (sqlLower.includes('update webhook_logs')) {
    return { affectedRows: 1 };
  }

  // ================================================================
  // Airbnb Accounts
  // ================================================================

  // INSERT airbnb_accounts
  if (sqlLower.includes('insert into airbnb_accounts')) {
    const account = {
      id: airbnbAccountIdCounter++,
      user_id: parseInt(params[0]),
      airbnb_email: params[1],
      access_token_enc: params[2],
      refresh_token_enc: params[3] || null,
      token_expires_at: params[4] || null,
      airbnb_user_id: params[5] || null,
      display_name: params[6] || null,
      is_active: true,
      last_sync_at: null,
      sync_status: 'idle',
      sync_error: null,
      created_at: new Date(),
      updated_at: new Date()
    };
    data.airbnbAccounts.push(account);
    return { insertId: account.id };
  }

  // SELECT airbnb_accounts by user_id and airbnb_email
  if (sqlLower.includes('from airbnb_accounts') && sqlLower.includes('where user_id') && sqlLower.includes('airbnb_email')) {
    const acc = data.airbnbAccounts.find(a => a.user_id === parseInt(params[0]) && a.airbnb_email === params[1]);
    return acc ? [acc] : [];
  }

  // SELECT airbnb_accounts by id and user_id and is_active
  if (sqlLower.includes('from airbnb_accounts') && sqlLower.includes('where id') && sqlLower.includes('user_id') && sqlLower.includes('is_active')) {
    const acc = data.airbnbAccounts.find(a => a.id === parseInt(params[0]) && a.user_id === parseInt(params[1]) && a.is_active);
    return acc ? [acc] : [];
  }

  // SELECT all active airbnb_accounts (no user_id filter — used by scheduler)
  if (sqlLower.includes('from airbnb_accounts') && sqlLower.includes('is_active') && !sqlLower.includes('user_id')) {
    return data.airbnbAccounts.filter(a => a.is_active);
  }

  // SELECT airbnb_accounts by user_id (list)
  if (sqlLower.includes('from airbnb_accounts') && sqlLower.includes('where user_id')) {
    return data.airbnbAccounts.filter(a => a.user_id === parseInt(params[0])).sort((a, b) => b.created_at - a.created_at);
  }

  // UPDATE airbnb_accounts
  if (sqlLower.includes('update airbnb_accounts')) {
    const setMatch = sql.match(/SET\s+([\s\S]+?)\s+WHERE/i);
    const whereMatch = sql.match(/WHERE\s+id\s*=\s*\?/i);
    if (whereMatch) {
      const accId = parseInt(params[params.length - 1]);
      const acc = data.airbnbAccounts.find(a => a.id === accId);
      if (acc && setMatch) {
        const assignments = setMatch[1].split(',').map(s => s.trim());
        assignments.forEach((assignment, i) => {
          const fieldMatch = assignment.match(/^(\w+)\s*=\s*(\?|NOW\(\))/i);
          if (fieldMatch) {
            const field = fieldMatch[1];
            const isNow = fieldMatch[2].toUpperCase() === 'NOW()';
            acc[field] = isNow ? new Date() : params[i];
          }
        });
        acc.updated_at = new Date();
      }
      return { affectedRows: acc ? 1 : 0 };
    }
    return { affectedRows: 0 };
  }

  // ================================================================
  // Reservations
  // ================================================================

  // INSERT reservations
  if (sqlLower.includes('insert into reservations')) {
    const resa = {
      id: reservationIdCounter++,
      user_id: parseInt(params[0]),
      property_id: params[1] ? parseInt(params[1]) : null,
      airbnb_account_id: params[2] ? parseInt(params[2]) : null,
      airbnb_reservation_id: params[3] || null,
      airbnb_listing_id: params[4] || null,
      confirmation_code: params[5] || null,
      guest_name: params[6] || null,
      guest_email: params[7] || null,
      guest_phone: params[8] || null,
      number_of_guests: parseInt(params[9]) || 1,
      check_in_date: params[10],
      check_out_date: params[11],
      booked_at: params[12] || null,
      total_price: params[13] || null,
      currency: params[14] || 'EUR',
      host_payout: params[15] || null,
      status: params[16] || 'pending',
      airbnb_raw_json: params[17] || null,
      last_synced_at: new Date(),
      previous_status: null,
      status_changed_at: null,
      conversation_id: null,
      created_at: new Date(),
      updated_at: new Date()
    };
    data.reservations.push(resa);
    return { insertId: resa.id };
  }

  // SELECT reservations by airbnb_reservation_id
  if (sqlLower.includes('from reservations') && sqlLower.includes('airbnb_reservation_id')) {
    const resa = data.reservations.find(r => r.airbnb_reservation_id === params[0]);
    return resa ? [resa] : [];
  }

  // SELECT reservations by user_id (list)
  if (sqlLower.includes('from reservations') && sqlLower.includes('where user_id')) {
    let results = data.reservations.filter(r => r.user_id === parseInt(params[0]));
    // Apply optional filters
    if (params[1] && sqlLower.includes('status = ?')) {
      results = results.filter(r => r.status === params[1]);
    }
    if (params.length > 2 && sqlLower.includes('property_id = ?')) {
      const propId = parseInt(params[params.length - 1]);
      results = results.filter(r => r.property_id === propId);
    }
    return results.sort((a, b) => new Date(b.check_in_date) - new Date(a.check_in_date));
  }

  // SELECT reservation by id and user_id
  if (sqlLower.includes('from reservations') && sqlLower.includes('where id') && sqlLower.includes('user_id')) {
    const resa = data.reservations.find(r => r.id === parseInt(params[0]) && r.user_id === parseInt(params[1]));
    return resa ? [resa] : [];
  }

  // UPDATE reservations
  if (sqlLower.includes('update reservations')) {
    const setMatch = sql.match(/SET\s+([\s\S]+?)\s+WHERE/i);
    const resaId = parseInt(params[params.length - 1]);
    const resa = data.reservations.find(r => r.id === resaId);
    if (resa && setMatch) {
      const assignments = setMatch[1].split(',').map(s => s.trim());
      let paramIdx = 0;
      assignments.forEach(assignment => {
        const fieldMatch = assignment.match(/^(\w+)\s*=\s*(\?|NOW\(\)|COALESCE\(.*\))/i);
        if (fieldMatch) {
          const field = fieldMatch[1];
          const expr = fieldMatch[2];
          if (expr.toUpperCase() === 'NOW()') {
            resa[field] = new Date();
          } else if (expr.toUpperCase().startsWith('COALESCE')) {
            resa[field] = params[paramIdx] || resa[field];
            paramIdx++;
          } else {
            resa[field] = params[paramIdx];
            paramIdx++;
          }
        }
      });
      resa.updated_at = new Date();
      return { affectedRows: 1 };
    }
    return { affectedRows: 0 };
  }

  // ================================================================
  // Airbnb Threads
  // ================================================================

  // INSERT airbnb_threads
  if (sqlLower.includes('insert into airbnb_threads')) {
    const thread = {
      id: airbnbThreadIdCounter++,
      user_id: parseInt(params[0]),
      airbnb_account_id: parseInt(params[1]),
      airbnb_thread_id: params[2],
      reservation_id: params[3] ? parseInt(params[3]) : null,
      conversation_id: params[4] ? parseInt(params[4]) : null,
      guest_name: params[5] || null,
      guest_airbnb_id: params[6] || null,
      listing_name: params[7] || null,
      airbnb_listing_id: params[8] || null,
      last_message_at: params[9] || new Date(),
      unread_count: parseInt(params[10]) || 0,
      last_synced_at: new Date(),
      created_at: new Date(),
      updated_at: new Date()
    };
    data.airbnbThreads.push(thread);
    return { insertId: thread.id };
  }

  // SELECT airbnb_threads by account and thread_id
  if (sqlLower.includes('from airbnb_threads') && sqlLower.includes('airbnb_account_id') && sqlLower.includes('airbnb_thread_id')) {
    const thread = data.airbnbThreads.find(t => t.airbnb_account_id === parseInt(params[0]) && t.airbnb_thread_id === params[1]);
    return thread ? [thread] : [];
  }

  // UPDATE airbnb_threads
  if (sqlLower.includes('update airbnb_threads')) {
    const threadId = parseInt(params[params.length - 1]);
    const thread = data.airbnbThreads.find(t => t.id === threadId);
    if (thread) {
      if (params[0]) thread.guest_name = params[0];
      if (params[1]) thread.last_message_at = params[1];
      thread.unread_count = parseInt(params[2]) || 0;
      thread.last_synced_at = new Date();
      thread.updated_at = new Date();
      return { affectedRows: 1 };
    }
    return { affectedRows: 0 };
  }

  // ================================================================
  // Sync Logs
  // ================================================================

  // INSERT sync_logs
  if (sqlLower.includes('insert into sync_logs')) {
    const log = {
      id: syncLogIdCounter++,
      user_id: parseInt(params[0]),
      airbnb_account_id: params[1] ? parseInt(params[1]) : null,
      sync_type: params[2],
      status: params[3],
      items_synced: 0,
      error_message: null,
      started_at: new Date(),
      completed_at: null
    };
    data.syncLogs.push(log);
    return { insertId: log.id };
  }

  // SELECT sync_logs by user_id
  if (sqlLower.includes('from sync_logs') && sqlLower.includes('where user_id')) {
    return data.syncLogs
      .filter(l => l.user_id === parseInt(params[0]))
      .sort((a, b) => b.started_at - a.started_at)
      .slice(0, 50);
  }

  // UPDATE sync_logs
  if (sqlLower.includes('update sync_logs')) {
    const logId = parseInt(params[params.length - 1]);
    const log = data.syncLogs.find(l => l.id === logId);
    if (log) {
      if (params[0]) log.status = params[0];
      if (params.length > 2) log.items_synced = parseInt(params[1]) || 0;
      if (params.length > 2) log.completed_at = new Date();
      if (sqlLower.includes('error_message') && params[1]) log.error_message = params[1];
      return { affectedRows: 1 };
    }
    return { affectedRows: 0 };
  }

  // ================================================================
  // Audit Logs
  // ================================================================

  // INSERT audit_logs
  if (sqlLower.includes('insert into audit_logs')) {
    const log = {
      id: auditLogIdCounter++,
      user_id: params[0] ? parseInt(params[0]) : null,
      action: params[1],
      entity_type: params[2] || null,
      entity_id: params[3] ? parseInt(params[3]) : null,
      ip_address: params[4] || null,
      user_agent: params[5] || null,
      details: params[6] || null,
      created_at: new Date()
    };
    data.auditLogs.push(log);
    return { insertId: log.id };
  }

  // SELECT property profile by id (no user filter – for webhook lookup)
  if (sqlLower.includes('select') && sqlLower.includes('from property_profiles') && !sqlLower.includes('user_id') && sqlLower.includes('where')) {
    const prop = data.propertyProfiles.find(p => p.superhot_listing_id === params[0]);
    return prop ? [{ ...prop, owner_id: prop.user_id }] : [];
  }

  // UPDATE property profile
  if (sqlLower.includes('update property_profiles')) {
    const propertyId = params[params.length - 2];
    const userId = params[params.length - 1];
    const propIndex = data.propertyProfiles.findIndex(
      p => p.id === parseInt(propertyId) && p.user_id === parseInt(userId)
    );

    if (propIndex !== -1) {
      // Parse SET clause to extract field names and apply values
      // SQL shape: UPDATE property_profiles SET field1 = ?, field2 = ? WHERE id = ? AND user_id = ?
      const setMatch = sql.match(/SET\s+([\s\S]+?)\s+WHERE/i);
      if (setMatch) {
        const assignments = setMatch[1].split(',').map(s => s.trim());
        assignments.forEach((assignment, i) => {
          const fieldMatch = assignment.match(/^(\w+)\s*=\s*\?/);
          if (fieldMatch) {
            const field = fieldMatch[1];
            const value = params[i];
            // Cast booleans for known boolean fields
            const boolFields = ['has_wifi','has_kitchen','has_parking','has_pool','has_gym','has_tv',
              'has_washing_machine','has_air_conditioning','has_heating','has_workspace',
              'has_hair_dryer','has_iron',
              'has_bathtub','has_dryer','has_dishwasher','has_microwave','has_refrigerator','has_coffee_maker',
              'has_smoke_detector','has_carbon_monoxide_detector','has_fire_extinguisher','has_first_aid_kit',
              'has_bbq','has_terrace','has_garden','has_netflix','has_fireplace',
              'allows_pets','allows_smoking','allows_events','auto_reply_enabled'];
            data.propertyProfiles[propIndex][field] = boolFields.includes(field) ? !!value : value;
          }
        });
      }
      data.propertyProfiles[propIndex].updated_at = new Date();
      return { affectedRows: 1 };
    }
    return { affectedRows: 0 };
  }
  
  // DELETE property profile
  if (sqlLower.includes('delete from property_profiles')) {
    const propertyId = params[0];
    const userId = params[1];
    const propIndex = data.propertyProfiles.findIndex(p => p.id === parseInt(propertyId) && p.user_id === parseInt(userId));
    
    if (propIndex !== -1) {
      data.propertyProfiles.splice(propIndex, 1);
      return { affectedRows: 1 };
    }
    return { affectedRows: 0 };
  }
  
  return [];
}

async function testConnection() {
  // Always succeeds for memory DB
  return true;
}

async function close() {
  // No-op for memory DB
}

module.exports = {
  query,
  testConnection,
  close
};
