#!/bin/bash
source ~/.nvm/nvm.sh
nvm use 20
cd /mnt/c/home/tom/airbnb-ai-agent
echo "Starting server..."
timeout 10 node server/server.js 2>&1
echo "EXIT CODE: $?"
