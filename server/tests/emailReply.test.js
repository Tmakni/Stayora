/**
 * Email reply — MIME, recipient validation, and the auto-reply policy.
 *
 * NO REAL MESSAGE IS EVER SENT: every test here works on pure functions
 * (MIME construction, address checks, policy decisions). Nothing touches the
 * Gmail API. The send path itself is additionally protected by
 * EMAIL_REPLY_DRY_RUN, exercised in the queue suite.
 *
 * Fixtures come from real Airbnb mail inspected on a live account:
 *   From        Airbnb <express@airbnb.com>
 *   Reply-To    4xxxxxxxxxxxx@reply.airbnb.com
 *   Message-ID  <xxx@geopod-ismtpd-NN>
 */

const {
  parseAddress,
  validateReplyAddress,
  maskAddress,
  encodeHeaderValue,
  buildReplySubject,
  buildReferences,
  normalizeMessageId,
  buildMimeMessage,
  toBase64Url,
  isRetryableError,
} = require('../services/emailReplyService');

const policy = require('../services/autoReplyPolicy');

const REAL_REPLY_TO = '4gv8m2q1x0zd@reply.airbnb.com';
const REAL_MESSAGE_ID = '<j5tKq9wLR2mAbCd@geopod-ismtpd-6>';
const REAL_SUBJECT = "Objet : Demande d'information pour La Villa Cosy - Proche Bordeaux, 24–28 août";

describe('recipient validation', () => {
  it('accepts the per-thread Airbnb reply address', () => {
    const result = validateReplyAddress(REAL_REPLY_TO);
    expect(result.valid).toBe(true);
    expect(result.address).toBe(REAL_REPLY_TO);
  });

  it('accepts a display-name form and lowercases the address', () => {
    expect(validateReplyAddress(`Airbnb <${REAL_REPLY_TO.toUpperCase()}>`))
      .toMatchObject({ valid: true, address: REAL_REPLY_TO });
  });

  it('REFUSES the visible From address — replying there reaches nobody', () => {
    for (const address of ['express@airbnb.com', 'automated@airbnb.com', 'noreply@airbnb.com']) {
      expect(validateReplyAddress(address).valid).toBe(false);
    }
  });

  it('refuses any non-Airbnb domain', () => {
    for (const address of [
      'attacker@evil.com',
      'guest@gmail.com',
      // suffix confusion — must not be treated as an Airbnb domain
      'x@reply.airbnb.com.evil.tld',
      'x@notreply.airbnb.com.attacker.net',
    ]) {
      expect(validateReplyAddress(address).valid).toBe(false);
    }
  });

  it('refuses malformed or empty input', () => {
    for (const value of ['', null, undefined, 'pas-une-adresse', '@nope', 'a@b', 42]) {
      expect(validateReplyAddress(value).valid).toBe(false);
    }
  });

  it('masks the routing token so it never lands in logs', () => {
    const masked = maskAddress(REAL_REPLY_TO);
    expect(masked).toContain('@reply.airbnb.com');
    // The token identifies a specific Airbnb thread — it must not be readable.
    expect(masked).not.toContain('gv8m2q1x0zd');
  });

  it('parses addresses out of common header shapes', () => {
    expect(parseAddress('Airbnb <a@reply.airbnb.com>')).toBe('a@reply.airbnb.com');
    expect(parseAddress('  A@Reply.Airbnb.Com ')).toBe('a@reply.airbnb.com');
    expect(parseAddress('mailto:a@reply.airbnb.com')).toBe('a@reply.airbnb.com');
  });
});

describe('MIME construction', () => {
  function build(overrides = {}) {
    return buildMimeMessage({
      from: 'host@gmail.com',
      to: REAL_REPLY_TO,
      subject: buildReplySubject(REAL_SUBJECT),
      bodyText: 'Bonjour Florine,\n\nLe check-in est à 15h.\n\nÀ bientôt',
      inReplyTo: REAL_MESSAGE_ID,
      references: buildReferences(null, REAL_MESSAGE_ID),
      ...overrides,
    });
  }

  function headersOf(mime) {
    const raw = mime.split('\r\n\r\n')[0];
    const map = {};
    for (const line of raw.split('\r\n')) {
      const idx = line.indexOf(':');
      if (idx > 0) map[line.slice(0, idx).toLowerCase()] = line.slice(idx + 1).trim();
    }
    return map;
  }

  function bodyOf(mime) {
    return Buffer.from(mime.split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString('utf8');
  }

  it('sets the threading headers Airbnb and mail clients need', () => {
    const headers = headersOf(build());
    expect(headers.to).toBe(REAL_REPLY_TO);
    expect(headers.from).toBe('host@gmail.com');
    expect(headers['in-reply-to']).toBe(REAL_MESSAGE_ID);
    expect(headers.references).toContain(REAL_MESSAGE_ID);
    expect(headers['mime-version']).toBe('1.0');
    expect(headers['content-type']).toContain('charset="UTF-8"');
  });

  it('prefixes the subject with Re: exactly once', () => {
    expect(buildReplySubject(REAL_SUBJECT)).toBe(`Re: ${REAL_SUBJECT}`);
    expect(buildReplySubject(`Re: ${REAL_SUBJECT}`)).toBe(`Re: ${REAL_SUBJECT}`);
    expect(buildReplySubject('')).toBe('Re:');
  });

  it('encodes an accented subject as RFC 2047 and keeps it decodable', () => {
    const headers = headersOf(build());
    expect(headers.subject).toMatch(/^=\?UTF-8\?B\?/);
    const encoded = headers.subject.replace(/^=\?UTF-8\?B\?/, '').replace(/\?=$/, '');
    expect(Buffer.from(encoded, 'base64').toString('utf8')).toBe(`Re: ${REAL_SUBJECT}`);
  });

  it('round-trips an accented body intact', () => {
    const body = 'Bonjour Gaëlle,\n\nLe wifi est « VillaCosy », à bientôt ! 😊';
    expect(bodyOf(build({ bodyText: body }))).toBe(body);
  });

  it('blocks header injection through the subject', () => {
    const mime = build({ subject: 'Salut\r\nBcc: victime@evil.com' });
    const headers = headersOf(mime);
    // The CRLF must be neutralised, so no Bcc header can be forged.
    expect(headers.bcc).toBeUndefined();
    expect(headers.subject).toContain('Bcc: victime@evil.com'); // as inert text
    expect(mime.split('\r\n\r\n')[0]).not.toMatch(/^Bcc:/m);
  });

  it('refuses to build without a recipient, sender or body', () => {
    expect(() => build({ to: '' })).toThrow(/destinataire/i);
    expect(() => build({ from: '' })).toThrow(/expéditeur/i);
    expect(() => build({ bodyText: '   ' })).toThrow(/corps vide/i);
  });

  it('produces url-safe base64 for the Gmail API', () => {
    const encoded = toBase64Url(build());
    expect(encoded).not.toMatch(/[+/=]/);
  });

  it('normalises a Message-ID that arrives without angle brackets', () => {
    expect(normalizeMessageId('abc@geopod-ismtpd-6')).toBe('<abc@geopod-ismtpd-6>');
    expect(normalizeMessageId('<abc@geopod-ismtpd-6>')).toBe('<abc@geopod-ismtpd-6>');
    expect(normalizeMessageId('')).toBe('');
    // A bracket-less id must still make it into References.
    expect(buildReferences(null, 'abc@geopod-ismtpd-6')).toBe('<abc@geopod-ismtpd-6>');
  });

  it('keeps the existing References chain and appends the answered id', () => {
    const chain = buildReferences('<a@x> <b@y>', REAL_MESSAGE_ID);
    expect(chain).toBe(`<a@x> <b@y> ${REAL_MESSAGE_ID}`);
    // No duplicates when the id is already in the chain.
    expect(buildReferences(`<a@x> ${REAL_MESSAGE_ID}`, REAL_MESSAGE_ID))
      .toBe(`<a@x> ${REAL_MESSAGE_ID}`);
  });

  it('strips CR/LF from any header value', () => {
    expect(encodeHeaderValue('a\r\nb')).toBe('a b');
  });
});

describe('retryable vs permanent errors', () => {
  it('retries rate limits and server-side failures', () => {
    expect(isRetryableError({ code: 429 })).toBe(true);
    expect(isRetryableError({ code: 503 })).toBe(true);
    expect(isRetryableError({ message: 'ETIMEDOUT' })).toBe(true);
    expect(isRetryableError({ message: 'socket hang up' })).toBe(true);
  });

  it('does not retry client-side rejections', () => {
    expect(isRetryableError({ code: 400 })).toBe(false);
    expect(isRetryableError({ code: 403, message: 'Forbidden' })).toBe(false);
  });
});

describe('auto-reply policy', () => {
  const factualReply = 'Bonjour, le check-in est possible à partir de 15h et le wifi est VillaCosy.';

  it('allows a factual answer when automatic mode is on', () => {
    const verdict = policy.evaluateAutoReply({
      incomingMessage: 'Bonjour, à quelle heure est le check-in ?',
      aiResult: { intent: 'check-in', risk_level: 'low', draft_reply: factualReply, confidence: 0.95 },
      userMode: 'auto',
    });
    expect(verdict.allowed).toBe(true);
  });

  it('never sends automatically while in manual mode', () => {
    expect(policy.evaluateAutoReply({
      incomingMessage: 'code wifi ?',
      aiResult: { intent: 'wifi', risk_level: 'low', draft_reply: factualReply, confidence: 0.95 },
      userMode: 'manual',
    })).toMatchObject({ allowed: false, code: 'manual_mode' });
  });

  it('the emergency stop overrides everything', () => {
    expect(policy.evaluateAutoReply({
      incomingMessage: 'code wifi ?',
      aiResult: { intent: 'wifi', risk_level: 'low', draft_reply: factualReply, confidence: 0.95 },
      userMode: 'auto',
      paused: true,
    })).toMatchObject({ allowed: false, code: 'emergency_stop' });
  });

  it('a property set to manual overrides the global automatic setting', () => {
    expect(policy.evaluateAutoReply({
      incomingMessage: 'code wifi ?',
      aiResult: { intent: 'wifi', risk_level: 'low', draft_reply: factualReply, confidence: 0.95 },
      userMode: 'auto',
      propertyMode: 'manual',
    }).allowed).toBe(false);
  });

  it('forces manual review for every forbidden category', () => {
    const forbidden = [
      ['cancellation', 'Je veux annuler ma réservation'],
      ['price-negotiation', 'Vous pouvez faire une réduction ?'],
      ['modification', 'Je voudrais changer mes dates'],
      ['problem', 'La douche est cassée'],
    ];
    for (const [intent, message] of forbidden) {
      const verdict = policy.evaluateAutoReply({
        incomingMessage: message,
        aiResult: { intent, risk_level: 'low', draft_reply: 'Une réponse parfaitement rédigée et assez longue.' },
        userMode: 'auto',
      });
      expect(verdict.allowed).toBe(false);
    }
  });

  it('catches sensitive wording even when the intent looks harmless', () => {
    // Classified as "wifi", but the guest is really asking for money back.
    const verdict = policy.evaluateAutoReply({
      incomingMessage: "Le wifi ne marche pas, je demande un remboursement",
      aiResult: { intent: 'wifi', risk_level: 'low', draft_reply: factualReply, confidence: 0.95 },
      userMode: 'auto',
    });
    expect(verdict).toMatchObject({ allowed: false, code: 'sensitive_wording' });
  });

  it('respects the model refusing to answer', () => {
    for (const [field, code] of [
      ['escalate', 'ai_escalate'],
      ['needs_host', 'ai_needs_host'],
      ['no_reply_needed', 'no_reply_needed'],
    ]) {
      expect(policy.evaluateAutoReply({
        incomingMessage: 'Une question',
        aiResult: { intent: 'wifi', risk_level: 'low', draft_reply: factualReply, [field]: true, confidence: 0.95 },
        userMode: 'auto',
      })).toMatchObject({ allowed: false, code });
    }
  });

  it('blocks anything with a medium or high risk score', () => {
    for (const risk of ['medium', 'high']) {
      expect(policy.evaluateAutoReply({
        incomingMessage: 'Une question',
        aiResult: { intent: 'wifi', risk_level: risk, draft_reply: factualReply, confidence: 0.95 },
        userMode: 'auto',
      }).allowed).toBe(false);
    }
  });

  it('refuses an answer that does not actually answer', () => {
    const hedges = [
      "Je ne sais pas, contactez votre hôte pour cette information précise.",
      "Je vais me renseigner et je reviens vers vous dès que possible ici.",
      "Le code est [MANQUANT] et je vous le communique dès que possible ok.",
      "I don't know, please contact the host about this particular question.",
    ];
    for (const reply of hedges) {
      expect(policy.evaluateAutoReply({
        incomingMessage: 'Le parking est où ?',
        aiResult: { intent: 'parking', risk_level: 'low', draft_reply: reply, confidence: 0.95 },
        userMode: 'auto',
      }).allowed).toBe(false);
    }
  });

  it('refuses an empty, too short or absurdly long answer', () => {
    const long = 'a'.repeat(policy.MAX_REPLY_CHARS + 1);
    for (const reply of ['', '   ', 'Oui.', long]) {
      expect(policy.evaluateAutoReply({
        incomingMessage: 'Le parking est où ?',
        aiResult: { intent: 'parking', risk_level: 'low', draft_reply: reply, confidence: 0.95 },
        userMode: 'auto',
      }).allowed).toBe(false);
    }
  });

  it('does not auto-send open-ended topics', () => {
    for (const intent of ['other', 'booking-inquiry']) {
      expect(policy.evaluateAutoReply({
        incomingMessage: 'Bonjour, une question générale sur le séjour',
        aiResult: { intent, risk_level: 'low', draft_reply: factualReply, confidence: 0.95 },
        userMode: 'auto',
      })).toMatchObject({ allowed: false, code: 'intent_not_whitelisted' });
    }
  });

  it('resolveMode: property wins over global, pause wins over both', () => {
    expect(policy.resolveMode({ userMode: 'auto', propertyMode: null })).toBe('auto');
    expect(policy.resolveMode({ userMode: 'manual', propertyMode: 'auto' })).toBe('auto');
    expect(policy.resolveMode({ userMode: 'auto', propertyMode: 'manual' })).toBe('manual');
    expect(policy.resolveMode({ userMode: 'auto', propertyMode: 'auto', paused: true })).toBe('manual');
    // Nothing configured at all → manual.
    expect(policy.resolveMode({})).toBe('manual');
  });
});
