#!/bin/bash
sqlite3 /home/tom/.local/share/airbnb-ai-agent/airbnb_ai_agent.db <<'SQL'
PRAGMA table_info(conversations);
SQL
