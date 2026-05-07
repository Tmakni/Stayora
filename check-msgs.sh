#!/bin/bash
sqlite3 /home/tom/.local/share/airbnb-ai-agent/airbnb_ai_agent.db <<'SQL'
SELECT id, role, substr(content,1,300) FROM messages WHERE conversation_id=71 ORDER BY created_at LIMIT 3;
SQL
