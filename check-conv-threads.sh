#!/bin/bash
# Check if any airbnb_thread_id values exist, and look at metadata of messages
sqlite3 /home/tom/.local/share/airbnb-ai-agent/airbnb_ai_agent.db <<'SQL'
SELECT id, title, airbnb_thread_id, external_id, external_provider, guest_name FROM conversations ORDER BY id DESC LIMIT 15;
SQL
