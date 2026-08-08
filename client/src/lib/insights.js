// Dashboard/priority insights are derived entirely from already-fetched
// conversations & properties — nothing here is fabricated: each number maps
// to a concrete, real field (booking_status, timestamps, profile completeness).
const STALE_HOURS = 6;

function hoursSince(dateString) {
  if (!dateString) return Infinity;
  return (Date.now() - new Date(dateString).getTime()) / 36e5;
}

export function getPendingConversations(conversations = []) {
  return conversations.filter((c) => c.booking_status === 'inquiry' || c.booking_status === 'request');
}

export function getUrgentConversations(conversations = []) {
  return getPendingConversations(conversations).filter((c) => hoursSince(c.updated_at) >= STALE_HOURS);
}

export function getIncompleteProperties(properties = []) {
  return properties.filter((p) => !p.address || !p.description);
}

// Rough, transparently-labelled estimate: time between a conversation's
// creation and its last update, for conversations that already have more
// than one message (i.e. at least one reply happened).
export function estimateAverageResponseTime(conversations = []) {
  const withReplies = conversations.filter((c) => (c.message_count || 0) > 1 && c.created_at && c.updated_at);
  if (withReplies.length === 0) return null;
  const totalMs = withReplies.reduce((sum, c) => sum + (new Date(c.updated_at) - new Date(c.created_at)), 0);
  const avgMinutes = totalMs / withReplies.length / 60000;
  return avgMinutes;
}

export function formatMinutes(minutes) {
  if (minutes == null) return '—';
  if (minutes < 1) return '< 1 min';
  if (minutes < 60) return `~${Math.round(minutes)} min`;
  const hours = minutes / 60;
  if (hours < 24) return `~${hours.toFixed(1)} h`;
  return `~${Math.round(hours / 24)} j`;
}

export function buildDashboardInsights(conversations = [], properties = []) {
  const pending = getPendingConversations(conversations);
  const urgent = getUrgentConversations(conversations);
  const incompleteProperties = getIncompleteProperties(properties);
  const activeAutoReply = properties.filter((p) => p.auto_reply_enabled).length;
  const avgResponseMinutes = estimateAverageResponseTime(conversations);

  const recentActivity = [...conversations]
    .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at))
    .slice(0, 6);

  return {
    pending,
    urgent,
    incompleteProperties,
    activeAutoReply,
    avgResponseMinutes,
    recentActivity,
  };
}
