#!/bin/bash
source ~/.nvm/nvm.sh
nvm use 20
cd /mnt/c/home/tom/airbnb-ai-agent

# Generate a valid JWT token
TOKEN=$(node -e "
require('dotenv').config();
const jwt = require('jsonwebtoken');
const secret = process.env.JWT_SECRET || 'default-secret-change-me';
const token = jwt.sign({ userId: 1 }, secret, { expiresIn: '1h' });
process.stdout.write(token);
")

echo "Token: ${TOKEN:0:20}..."

# Trigger Gmail sync
echo "Triggering Gmail sync..."
curl -s http://localhost:3000/api/gmail/sync/1 \
  -X POST \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  2>/dev/null

echo ""
echo "Done."
