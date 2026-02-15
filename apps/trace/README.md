# TRACE app

Frontend + API for the TRACE agent: finds items via the **search API**, returns recommendations with product links, and supports crypto/card funding, live inventory, forecasting, and agentic restock.

## Quick start

1. **Start the search API** (from repo root): `node services/search/index.js`
2. **From this directory** (`apps/trace/`):

   ```bash
   npm install
   cd frontend && npm install && cd ..
   npm run dev
   ```

3. Open **http://localhost:5174**

Inventory and product data are read from the repo **`data/`** directory (relative to repo root).

## Config

Copy `.env.example` to `.env`. Key options:

- **`WEBSHOP_BASE_URL`** – Search API base URL (default `http://localhost:3000`).
- **`GROK_API_KEY`** or **`XAI_API_KEY`** – For AI-powered recommendations.
- **`GROK_MODEL`** – Default `grok-3-mini`.

## API

- `GET /api/inventory` – Latest inventory snapshot (from `data/synthetic_inventory_daily.csv`).
- `POST /api/recommend` – Body: `{ prompt?, fundsCrypto?, forecastHorizon? }`. Returns recommendations with items, reasoning, and links.
- `GET /api/dashboard/forecast` – Forecasting data.
- `GET /api/dashboard/series` – Time series for charts.
