// Mirrors the legacy app's simple per-conversation "last read" tracking.
const PREFIX = 'conv_read_';

export function isUnread(conversation) {
  if (!conversation?.updated_at) return false;
  const stored = localStorage.getItem(PREFIX + conversation.id);
  if (!stored) return (conversation.message_count || 0) > 0;
  return new Date(conversation.updated_at).getTime() > Number(stored);
}

export function markRead(conversationId) {
  localStorage.setItem(PREFIX + conversationId, String(Date.now()));
}
