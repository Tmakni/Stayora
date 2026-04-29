/**
 * Host Writing Style Service
 *
 * Analyzes the host's outgoing messages to learn their writing style,
 * then provides style context for AI-generated replies.
 *
 * The style profile includes:
 *   - Greeting patterns (how the host starts messages)
 *   - Sign-off patterns (how the host ends messages)
 *   - Tone indicators (emojis, exclamation marks, formality)
 *   - Sample messages (real examples for few-shot prompting)
 *   - Average message length
 */
const { getDatabase } = require('../config/db');
const logger = require('../utils/logger');

/**
 * Analyze the host's outgoing messages and build a style profile.
 * Stores the result in the users table for reuse.
 */
async function analyzeHostStyle(userId) {
  const db = getDatabase();

  // Fetch host's outgoing messages across all conversations (most recent first)
  // Only use messages synced from Gmail (real host messages), exclude AI-generated ones
  const messages = await db.query(
    `SELECT m.content, m.created_at, m.metadata_json, c.guest_language, c.booking_status
     FROM messages m
     JOIN conversations c ON c.id = m.conversation_id
     WHERE c.user_id = ? AND m.role = 'outgoing'
       AND LENGTH(m.content) > 15
       AND (
         m.metadata_json LIKE '%gmail_sync%'
         OR m.metadata_json IS NULL
       )
       AND m.metadata_json NOT LIKE '%draft_reply%'
     ORDER BY m.created_at DESC
     LIMIT 100`,
    [userId]
  );

  if (messages.length < 3) {
    logger.info(`Host style: not enough outgoing messages for user ${userId} (${messages.length})`);
    return null;
  }

  // Also fetch availability-related exchanges (host reply after guest asks about availability/dates)
  const availMessages = await db.query(
    `SELECT m_out.content as host_reply, m_in.content as guest_question
     FROM messages m_out
     JOIN conversations c ON c.id = m_out.conversation_id
     JOIN messages m_in ON m_in.conversation_id = m_out.conversation_id
       AND m_in.role = 'incoming'
       AND m_in.created_at < m_out.created_at
     WHERE c.user_id = ? AND m_out.role = 'outgoing'
       AND LENGTH(m_out.content) > 15
       AND (
         LOWER(m_in.content) LIKE '%disponib%'
         OR LOWER(m_in.content) LIKE '%dispo %'
         OR LOWER(m_in.content) LIKE '%libre%'
         OR LOWER(m_in.content) LIKE '%available%'
         OR LOWER(m_in.content) LIKE '%réserv%'
         OR LOWER(m_in.content) LIKE '%reserv%'
         OR LOWER(m_in.content) LIKE '%book%'
         OR LOWER(m_in.content) LIKE '%nuit%'
         OR LOWER(m_in.content) LIKE '%séjour%'
         OR LOWER(m_in.content) LIKE '%demande de%'
         OR LOWER(m_in.content) LIKE '%arrivée%'
         OR LOWER(m_in.content) LIKE '%check-in%'
       )
     ORDER BY m_out.created_at DESC
     LIMIT 20`,
    [userId]
  );

  const profile = buildStyleProfile(messages, availMessages);

  // Store in DB
  await db.query(
    'UPDATE users SET host_writing_style = ?, style_analyzed_at = NOW() WHERE id = ?',
    [JSON.stringify(profile), userId]
  );

  logger.info(`Host style: analyzed ${messages.length} messages for user ${userId} — ${profile.sample_messages.length} general + ${profile.availability_samples.length} availability samples`);
  return profile;
}

/**
 * Build a style profile from a list of outgoing messages.
 */
function buildStyleProfile(messages, availMessages = []) {
  const contents = messages.map(m => m.content.trim());

  // --- Greeting patterns ---
  const greetings = new Map();
  const greetingRegex = /^(bonjour|bonsoir|salut|hello|hi|hey|coucou|re-?bonjour|bienvenue|cher|chère|dear)[\s!,.:;]*/i;
  for (const text of contents) {
    const match = text.match(greetingRegex);
    if (match) {
      // Capture up to the first newline or sentence end for more context
      const greetLine = text.split(/[\n.!]/)[0].trim();
      if (greetLine.length <= 80) {
        greetings.set(greetLine, (greetings.get(greetLine) || 0) + 1);
      }
    }
  }

  // --- Sign-off patterns ---
  const signoffs = new Map();
  const signoffRegex = /(?:^|\n)\s*((?:bonne|bon|belle|au plaisir|à bientôt|à très vite|cordialement|bien à vous|bien cordialement|amicalement|à votre disposition|best|regards|cheers|take care|see you|cdlt|bises|warm).{0,80})$/im;
  for (const text of contents) {
    const match = text.match(signoffRegex);
    if (match) {
      const signoff = match[1].trim();
      if (signoff.length >= 5 && signoff.length <= 100) {
        signoffs.set(signoff, (signoffs.get(signoff) || 0) + 1);
      }
    }
  }

  // --- Tone indicators ---
  let emojiCount = 0;
  let exclamationCount = 0;
  let questionCount = 0;
  let formalVous = 0;
  let informalTu = 0;
  let totalLength = 0;

  for (const text of contents) {
    totalLength += text.length;
    // Count emojis (Unicode emoji ranges)
    const emojis = text.match(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}]/gu);
    if (emojis) emojiCount += emojis.length;
    exclamationCount += (text.match(/!/g) || []).length;
    questionCount += (text.match(/\?/g) || []).length;
    // Formality: vous vs tu
    formalVous += (text.match(/\bvous\b|\bvotre\b|\bvos\b/gi) || []).length;
    informalTu += (text.match(/\btu\b|\bton\b|\bta\b|\btes\b/gi) || []).length;
  }

  const avgLength = Math.round(totalLength / contents.length);
  const usesEmojis = emojiCount / contents.length > 0.3;
  const usesExclamations = exclamationCount / contents.length > 1;
  const formality = formalVous > informalTu * 2 ? 'formal' : informalTu > formalVous * 2 ? 'informal' : 'mixed';

  // --- Collect actual emojis used ---
  const emojiMap = new Map();
  for (const text of contents) {
    const emojis = text.match(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}]/gu);
    if (emojis) {
      for (const e of emojis) {
        emojiMap.set(e, (emojiMap.get(e) || 0) + 1);
      }
    }
  }
  const favoriteEmojis = [...emojiMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([e]) => e);

  // --- Detect host name from sign-offs ---
  let hostSignName = null;
  const nameSignoffRegex = /(?:^|\n)\s*([A-ZÀ-Ü][a-zà-ü]{2,15})\s*$/m;
  for (const text of contents) {
    const nameMatch = text.match(nameSignoffRegex);
    if (nameMatch) {
      const name = nameMatch[1];
      // Skip common words that aren't names
      if (!/^(Bonjour|Bonsoir|Merci|Cordialement|Bonne)$/i.test(name)) {
        hostSignName = name;
        break;
      }
    }
  }

  // --- Select best sample messages ---
  // Pick diverse, representative messages (not too short, not too long)
  const samples = selectSampleMessages(contents, 8);

  // --- Availability-specific samples ---
  // These are host replies to availability/reservation questions (with guest question for context)
  const availSamples = [];
  for (const am of availMessages) {
    if (am.host_reply && am.host_reply.trim().length >= 20 && am.host_reply.trim().length <= 600) {
      const isDup = availSamples.some(s => {
        const overlap = commonPrefixLength(s.host_reply.toLowerCase(), am.host_reply.toLowerCase());
        return overlap > Math.min(s.host_reply.length, am.host_reply.length) * 0.5;
      });
      if (!isDup) {
        availSamples.push({
          guest_question: (am.guest_question || '').trim().substring(0, 200),
          host_reply: am.host_reply.trim()
        });
      }
      if (availSamples.length >= 5) break;
    }
  }

  // --- Top greetings & sign-offs ---
  const topGreetings = [...greetings.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([g]) => g);

  const topSignoffs = [...signoffs.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([s]) => s);

  return {
    sample_messages: samples,
    availability_samples: availSamples,
    greetings: topGreetings,
    signoffs: topSignoffs,
    favorite_emojis: favoriteEmojis,
    host_sign_name: hostSignName,
    avg_length: avgLength,
    uses_emojis: usesEmojis,
    uses_exclamations: usesExclamations,
    formality,
    message_count: contents.length,
    analyzed_at: new Date().toISOString()
  };
}

/**
 * Select diverse sample messages that best represent the host's style.
 * Picks messages that are:
 *   - Between 30-500 chars (meaningful but not huge)
 *   - Diverse in content (avoid duplicates/near-duplicates)
 */
function selectSampleMessages(contents, maxSamples) {
  // Filter to good candidates
  const candidates = contents.filter(t => t.length >= 30 && t.length <= 500);

  if (candidates.length <= maxSamples) {
    return candidates;
  }

  // Pick diverse: take from evenly spaced indices across the list
  // The list is already sorted by recency, so this gives a spread over time
  const selected = [];
  const step = Math.floor(candidates.length / maxSamples);

  for (let i = 0; i < candidates.length && selected.length < maxSamples; i += Math.max(step, 1)) {
    const candidate = candidates[i];
    // Skip near-duplicates
    const isDuplicate = selected.some(s => {
      const shorter = Math.min(s.length, candidate.length);
      const overlap = commonPrefixLength(s.toLowerCase(), candidate.toLowerCase());
      return overlap > shorter * 0.6;
    });
    if (!isDuplicate) {
      selected.push(candidate);
    }
  }

  return selected;
}

/**
 * Length of common prefix between two strings.
 */
function commonPrefixLength(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

/**
 * Get cached host style or analyze if needed.
 * Re-analyzes if profile is older than 7 days or doesn't exist.
 */
async function getHostStyle(userId) {
  const db = getDatabase();

  const rows = await db.query(
    'SELECT host_writing_style, style_analyzed_at FROM users WHERE id = ?',
    [userId]
  );

  if (rows.length === 0) return null;

  const { host_writing_style, style_analyzed_at } = rows[0];

  // Return cached if recent (less than 7 days old)
  if (host_writing_style && style_analyzed_at) {
    const age = Date.now() - new Date(style_analyzed_at).getTime();
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    if (age < sevenDays) {
      try {
        return JSON.parse(host_writing_style);
      } catch (_) {}
    }
  }

  // Analyze fresh
  return analyzeHostStyle(userId);
}

/**
 * Build prompt section from host style profile.
 * Returns a string to inject into the system prompt.
 */
function buildStylePromptSection(style) {
  if (!style || !style.sample_messages || style.sample_messages.length === 0) {
    return '';
  }

  let section = '\nSTYLE D\'ÉCRITURE DE L\'HÔTE (REPRODUIS CE STYLE EXACTEMENT):\n';

  // Tone description
  const toneWords = [];
  if (style.formality === 'formal') toneWords.push('vouvoiement');
  else if (style.formality === 'informal') toneWords.push('tutoiement');
  if (style.uses_emojis) toneWords.push('utilise des emojis');
  if (style.uses_exclamations) toneWords.push('ponctuation expressive (!)');

  if (toneWords.length > 0) {
    section += `- Ton: ${toneWords.join(', ')}\n`;
  }
  section += `- Longueur moyenne: ~${style.avg_length} caractères\n`;

  if (style.favorite_emojis && style.favorite_emojis.length > 0) {
    section += `- Emojis préférés de l'hôte: ${style.favorite_emojis.join(' ')} — utilises-en 1 ou 2 MAX par message, en fin de phrase uniquement\n`;
  }
  if (style.host_sign_name) {
    section += `- L'hôte signe souvent ses messages avec son prénom: ${style.host_sign_name}\n`;
  }
  if (style.greetings && style.greetings.length > 0) {
    section += `- Formules d'accueil habituelles: ${style.greetings.join(' / ')}\n`;
  }
  if (style.signoffs && style.signoffs.length > 0) {
    section += `- Formules de fin habituelles: ${style.signoffs.join(' / ')}\n`;
  }

  // Sample messages (few-shot examples)
  section += '\nEXEMPLES DE VRAIES RÉPONSES DE L\'HÔTE (reproduis ce style, ce ton, cette façon d\'écrire):\n';
  for (let i = 0; i < style.sample_messages.length; i++) {
    section += `--- Exemple ${i + 1} ---\n${style.sample_messages[i]}\n`;
  }
  section += '--- Fin des exemples ---\n';
  section += 'IMPORTANT: Tes réponses DOIVENT ressembler à ces exemples. Même ton chaleureux, mêmes emojis, même signature, même façon personnelle de s\'exprimer. NE PAS écrire de façon générique ou corporate.\n';

  return section;
}

module.exports = {
  analyzeHostStyle,
  getHostStyle,
  buildStylePromptSection
};
