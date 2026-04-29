#!/bin/bash
cd /mnt/c/home/tom/airbnb-ai-agent
node server/server.js > /mnt/c/home/tom/airbnb-ai-agent/wsl-server.log 2>&1 &
PID=$!
for i in $(seq 1 20); do
  sleep 2
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/ 2>/dev/null)
  if [ "$STATUS" = "200" ] || [ "$STATUS" = "302" ]; then
    echo "Server UP after $((i*2))s (PID=$PID)"
    cat /mnt/c/home/tom/airbnb-ai-agent/wsl-server.log
    exit 0
  fi
done
echo "FAILED"
cat /mnt/c/home/tom/airbnb-ai-agent/wsl-server.log
kill $PID 2>/dev/null
exit 1
