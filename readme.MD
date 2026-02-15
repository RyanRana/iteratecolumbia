# TRACE — Trade & Retail Agent for Chain Efficiency

TRACE helps you manage retail supply chains by having agents handle it. Fund agents with crypto (USDC, USDT, ETH, SOL, BTC) or card, then describe what you need—e.g. "restock laptops for Q1", "pay the vendor every 4 days", or "what would sell fastest around the holidays"—and it processes your request and sends agents to analyze your data, research macro trends, and execute secure smart contracts to any vendor.

**[See Demo](./demo.mov)** · **[Architecture](./flow%20model.svg)**

---

## Requirements

- **Node** 18+
- **Python** 3 (for synthetic inventory generator)
- **npm**

---

## Install

```bash
npm install
cd apps/trace && npm install && cd frontend && npm install && cd ../..
```

---

## Setup

```bash
npm run dev
```

Open **http://localhost:5174**. Optionally set `GROK_API_KEY` or `XAI_API_KEY` in `apps/trace/.env` for LLM-powered parse, search queries, and select/rank.
