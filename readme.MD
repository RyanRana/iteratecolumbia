# TRACE

**Trade & Retail Agent for Chain Efficiency**

A **supply chain optimization agent** that safely handles **crypto** and executes **payments autonomously**. TRACE gives enterprises an AI that manages supplier and inventory replenishment end-to-end—from monitoring stock to researching suppliers, optimizing for cost and speed, and paying automatically.

---

## What it is

- **Autonomous AI platform** – Enterprises fund agents with a budget to handle supplier and inventory replenishment for webshops.
- **Real-time monitoring** – The agent monitors stock levels in real time and triggers restocks when needed.
- **Supplier research & optimization** – Researches the best supplier options and optimizes for cost, speed, and fees.
- **Autonomous payments** – Executes payments automatically once you approve recommendations.
- **Outcomes** – Eliminates manual procurement, reduces stockouts and overstock, and saves **15–35%** on supplier and transaction costs.

---

## Crypto & payments

TRACE is built to **safely handle crypto** alongside traditional payment methods. You can fund the agent with **USDC, USDT, ETH, SOL, or BTC** (with live USD conversion) or by card. Budget caps and transparent deduction flows keep spending under control while the agent pays suppliers autonomously after approval.

---

## Prompt interface

Use **natural language** to tell the agent what to buy or how to behave. Describe products, categories, replenishment rules, or constraints in plain language; the agent turns your prompt into searches, supplier choices, and recommendations. No forms or dropdowns required—just describe what you need.

---

## Quick start

**Option A – from repo root (one command):**

```bash
npm install
cd apps/trace && npm install && cd frontend && npm install && cd ../..
npm run dev
```

Then open **http://localhost:5174**. This starts the search API (port 3000) and the TRACE app (API 3001, frontend 5174).

**Option B – two terminals:**

1. **Terminal 1 – search API:** `node services/search/index.js`
2. **Terminal 2 – TRACE app:** `cd apps/trace && npm install && cd frontend && npm install && cd .. && npm run dev`
3. Open **http://localhost:5174**

**Live demo:** [docs/live-demo.mov](docs/live-demo.mov)

---

## Features

- **Fund agent wallet** – Crypto (USDC, USDT, ETH, SOL, BTC with live USD conversion) or card. Budget cap $10,000 USD.
- **Prompt** – Describe what to buy; the agent turns it into searches and returns items with links and prices.
- **Live inventory** – Collapsible table from `data/synthetic_inventory_daily.csv`; used for context and forecasting.
- **Recommendations** – Search + optional Grok AI selection. Each item has product name, quantity, unit price, and **View** link.
- **Approve & payment** – Transparent flow: balance → per-item deduction → remaining (all in USD).
- **Dashboard** – Inventory and forecasting (Holt smoothing), reorder points, trend and “days until reorder.”
- **Agentic restock** – Enable scheduled restocks from forecasting with smart-contract style rows (expand for transparency, quantity, cancel, approve).

---

## Project layout

- **`apps/trace/`** – TRACE app (Node/Express API + Vite/React frontend).
- **`services/search/`** – Search API (port 3000), serves from `data/tech_products.json`.
- **`data/`** – Product catalog and inventory data (see [data/README.md](data/README.md)).
- **`scripts/`** – Utilities (e.g. `generate_synthetic_inventory.py`).
- **`docs/`** – Documentation and [live demo](docs/live-demo.mov).

---

## Config

Copy `apps/trace/.env.example` to `apps/trace/.env` and set:

- **`WEBSHOP_BASE_URL`** – Search API base URL (default `http://localhost:3000`).
- **`GROK_API_KEY`** or **`XAI_API_KEY`** – For AI-powered recommendations; otherwise rule-based selection.
- **`GROK_MODEL`** – Default `grok-3-mini`.

---

## API

- `GET /api/inventory` – Latest inventory snapshot.
- `GET /api/dashboard/forecast?horizon=30&days_back=90` – Forecasting data.
- `GET /api/dashboard/series?days=90` – Time series for charts.
- `POST /api/recommend` – Body: `{ prompt, fundsCrypto, forecastHorizon }`. Returns `{ recommendation: { items, reasoning, unfound_items }, totalCost, source }`.
