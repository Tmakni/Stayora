#!/bin/bash
sqlite3 /home/tom/.local/share/airbnb-ai-agent/airbnb_ai_agent.db <<'SQL'
ALTER TABLE conversations ADD COLUMN airbnb_reply_url TEXT;
SQL
echo "Migration done"
