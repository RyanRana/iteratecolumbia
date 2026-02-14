# TRACE

**Trade & Retail Agent for Chain Efficiency**

TRACE is an agent that recommends products from WebShop search, supports crypto or card funding, live inventory, forecasting, and agentic restock scheduling.

---

## Quick start

1. **Start the WebShop search API** (port 3000):

   ```bash
   cd WebShop-master
   node search_server.js
   ```

2. **Start TRACE** (API on 3001, frontend on 5174):

   ```bash
   cd WebShop-master/shop-agent
   npm install
   cd frontend && npm install && cd ..
   npm run dev
   ```

3. Open **http://localhost:5174** in your browser.

---

## Features

- **Fund agent wallet** – Crypto (USDC, USDT, ETH, SOL, BTC with live USD conversion) or card. Budget cap $10,000 USD.
- **Prompt** – Describe what to buy; the agent turns it into WebShop searches and returns items with links and prices.
- **Live inventory** – Collapsible table from `data/synthetic_inventory_daily.csv`; used for context and forecasting.
- **Recommendations** – WebShop search + optional Grok AI selection. Each item has product name, quantity, unit price, and **View** link. Unfound queries get external search and first-result link.
- **Approve & payment** – Transparent payment flow: balance → per-item deduction → remaining (all in USD).
- **Dashboard** – Inventory and forecasting (Holt smoothing), reorder points, trend and “days until reorder.”
- **Agentic restock** – Checkbox to enable; list of scheduled restocks from forecasting with smart-contract style rows (expand for transparency, quantity, cancel, approve).

---

## Project layout

- **`WebShop-master/shop-agent/`** – TRACE app (Node/Express API + Vite/React frontend).
- **`WebShop-master/search_server.js`** – Minimal WebShop search API (no Python), serves from `data/tech_products.json`.
- **`WebShop-master/data/`** – Products and inventory data (e.g. `tech_products.json`, `synthetic_inventory_daily.csv`).

---

## Config (shop-agent)

- **`WEBSHOP_BASE_URL`** – WebShop base URL (default `http://localhost:3000`).
- **`GROK_API_KEY`** or **`XAI_API_KEY`** – For Grok-powered recommendations; otherwise rule-based selection.
- **`GROK_MODEL`** – Default `grok-3-mini`.

---

## API (shop-agent)

- `GET /api/inventory` – Latest inventory snapshot.
- `GET /api/dashboard/forecast?horizon=30&days_back=90` – Forecasting data.
- `GET /api/dashboard/series?days=90` – Time series for charts.
- `POST /api/recommend` – Body: `{ prompt, fundsCrypto, forecastHorizon }`. Returns `{ recommendation: { items, reasoning, unfound_items }, totalCost, source }`.
