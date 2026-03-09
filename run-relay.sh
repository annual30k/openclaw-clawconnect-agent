#!/bin/bash
# run-relay.sh — convenience script to start both backend and relay client
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

echo "Starting clawai-backend..."
cd "$ROOT_DIR/clawai-backend"
node dist/index.js &
BACKEND_PID=$!
echo "Backend started (PID=$BACKEND_PID)"

sleep 1

echo "Starting clawai-relay-client..."
cd "$ROOT_DIR/clawai-relay-client"
node dist/index.js run &
CLIENT_PID=$!
echo "Relay client started (PID=$CLIENT_PID)"

trap "echo 'Stopping...'; kill $BACKEND_PID $CLIENT_PID 2>/dev/null; exit 0" INT TERM

wait
