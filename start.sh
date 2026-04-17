#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# AEO Research Harness — Quick Start Script
# Run from the project root: bash start.sh
# ─────────────────────────────────────────────────────────────────────────────

set -e

BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo ""
echo -e "${BOLD}╔══════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║  Adaptive Edge Orchestrator (AEO)        ║${NC}"
echo -e "${BOLD}║  IEEE Research Benchmark Harness         ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════════╝${NC}"
echo ""

# Check node
if ! command -v node &> /dev/null; then
  echo -e "${RED}✗ Node.js not found. Install Node.js 18+ from https://nodejs.org${NC}"
  exit 1
fi
NODE_VER=$(node -v)
echo -e "${GREEN}✓ Node.js ${NODE_VER}${NC}"

# Check model
MODEL_PATH="${MODEL_PATH:-./backend/models/gemma-3-1b-it-Q4_K_M.gguf}"
if [ -f "$MODEL_PATH" ]; then
  SIZE=$(du -sh "$MODEL_PATH" | cut -f1)
  echo -e "${GREEN}✓ Model found: ${MODEL_PATH} (${SIZE})${NC}"
else
  echo -e "${YELLOW}⚠ Model not found at: ${MODEL_PATH}${NC}"
  echo -e "${YELLOW}  Running in MOCK mode (realistic latency simulation).${NC}"
  echo -e "${YELLOW}  To use the real model, run: node scripts/download-model.js${NC}"
fi

# Install deps if needed
if [ ! -d "node_modules" ]; then
  echo ""
  echo "Installing root dependencies..."
  npm install --silent
fi
if [ ! -d "backend/node_modules" ]; then
  echo "Installing backend dependencies..."
  npm install --prefix backend --silent
fi
if [ ! -d "frontend/node_modules" ]; then
  echo "Installing frontend dependencies..."
  npm install --prefix frontend --silent
fi

# Copy env if missing
if [ ! -f "backend/.env" ]; then
  cp backend/.env.example backend/.env
  echo -e "${YELLOW}⚠ Created backend/.env from .env.example${NC}"
fi

echo ""
echo -e "${BOLD}Starting servers...${NC}"
echo -e "  Backend:  ${GREEN}http://localhost:3001${NC}"
echo -e "  Frontend: ${GREEN}http://localhost:3000${NC}"
echo ""

npm run dev
