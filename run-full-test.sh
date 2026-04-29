#!/bin/bash
cd /mnt/c/home/tom/airbnb-ai-agent

# Reset sync
node reset-sync.js > /tmp/reset-output.txt 2>&1
echo "=== RESET OUTPUT ===" 
cat /tmp/reset-output.txt

# Start server in background
node server/server.js > /tmp/server-output.txt 2>&1 &
SERVER_PID=$!
echo "Server PID: $SERVER_PID"

# Wait for sync cycle (server starts + 5s warm up + initial sync)  
echo "Waiting 20s for sync cycle..."
sleep 20

# Check results
echo "=== SERVER LOG ==="
cat /tmp/server-output.txt

echo ""
echo "=== DB CHECK ==="
node check-sync-result.js > /tmp/check-output.txt 2>&1
cat /tmp/check-output.txt

# Kill server
kill $SERVER_PID 2>/dev/null
echo "Server killed"
