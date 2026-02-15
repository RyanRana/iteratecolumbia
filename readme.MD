# TRACE — Trade & Retail Agent for Chain Efficiency

TRACE helps you manage retail supply chains by having agents handle it. You can fund agents with crypto (USDC, USDT, ETH, SOL, BTC) or card, then describe what you need—e.g. “restock laptops for Q1”, "pay the vendor every 4 days" or “what would sell fastest around the holidays”— and it processes your request and sends agents to analyze your data, research macro trends, and execute secure smart contracts to any vendor.



---

## Tech stack

| Layer | Stack |
|-------|--------|
| **Monorepo** | npm workspaces; `concurrently` for multi-process dev |
| **TRACE API** | Node 18+, Express, ES modules, `dotenv` |
| **Search API** | Node, native `http` server, no framework |
| **Frontend** | React 18, Vite 5, Recharts |
| **LLM** | xAI Grok (`https://api.x.ai/v1/chat/completions`) |
| **Data** | JSON catalog + CSV time series; Python 3 synthetic generator |

---

## Services & ports

| Service | Port | Entrypoint | Role |
|---------|------|-------------|------|
| **Search API** | 3000 | `node services/search/index.js` | Catalog search over `data/tech_products.json` |
| **TRACE API** | 3001 | `npm run dev` in `apps/trace` | Inventory, forecast, recommendation chain, health |
| **Frontend** | 5174 | Vite dev server in `apps/trace/frontend` | React SPA (Shop, Dashboard, Agentic restock) |

**Single-command dev (root):** `npm run dev` starts Search (3000) and TRACE app (3001 + 5174) via `concurrently`.

---

## Architecture overview

1. **User** funds wallet (crypto or card), enters prompt, approves payments.
2. **Frontend** calls TRACE API (`POST /api/recommend`, `GET /api/inventory`, `GET /api/dashboard/*`).
3. **TRACE API** runs the recommendation chain (parse → forecast → search queries → WebShop + external search → merge → select/rank); reads inventory/forecast from CSV + `tech_products.json`.
4. **Search API** scores products by query-term overlap (name, category, query); returns up to 20 hits with ASIN, price, category, link.
5. **External search** (unfound queries only): optional Amazon scrape (HTML parse) → DuckDuckGo (`duck-duck-scrape`) → fallback Google Shopping link.

---

## Recommendation chain (POST /api/recommend)

**Request body:** `{ prompt?, fundsCrypto?, forecastHorizon? }`  
**Response:** `{ parsedItems, forecastHorizonDays, recommendation: { items, reasoning, unfound_items? }, totalCost, source, webshopQueries, grokSearchReasoning? }`

### Pipeline (sequential)

| Step | Component | Description |
|------|-----------|-------------|
| 1 | **Parse-items (Grok)** | LLM extracts `items[]`: `name`, `category`, `daily_usage`, `unit`, `context`. System prompt: inventory analyst; output JSON only. |
| 2 | **Demand forecast (no LLM)** | `forecastDemand(parsedItems, horizonDays)`: per item `base_demand = daily_usage * horizon`, `forecasted_units = ceil(base_demand * 1.20)` (20% safety stock). |
| 3 | **Search-queries (Grok)** | LLM returns `search_queries[]` + `reasoning` from prompt + budget. Fallback: parsed item names or prompt. |
| 4 | **WebShop search** | For each query: `GET WEBSHOP_BASE_URL/api/search?q=...`. Collect results; track which queries had zero hits → unfound. |
| 5 | **External search (unfound only)** | For each unfound query: Amazon scrape (regex on HTML, `data-asin`, title/price) with 10s timeout → on fail/empty, DuckDuckGo `search(query + " buy price")` → on fail, single fallback link `EXTERNAL_SHOP_SEARCH_URL=...`. |
| 6 | **Merge** | Dedupe WebShop results by ASIN (first occurrence). |
| 7 | **Select/rank (Grok or rule-based)** | With API key: Grok receives merged list + forecast + budget; returns `items[]` (asin, product_name, quantity, unit_price, reason, link) + reasoning; total ≤ budget; quantities can follow forecasted_units. Without key: take first 8 results with unit_price ≤ funds, quantity 1. |
| 8 | **Unfound items** | `buildUnfoundItems(unfoundQueries, rawSearches, remainingBudget)`: per query, first result or fallback link; parse price from snippet/title; allocate quantity from remaining budget sequentially. |

**Special case:** Prompt matching “what would sell fastest on holidays” (or holiday + sell fastest) returns a hardcoded “PlayStation 5 bundles” recommendation (GameStop link, $499/unit, quantity from budget).

---

## TRACE API endpoints

| Method | Path | Query / Body | Description |
|--------|------|--------------|-------------|
| GET | `/api/inventory` | — | Latest snapshot from CSV: latest row per ASIN (`snapshotDate`, `products[]` with `quantity_on_hand`, `list_price`). |
| GET | `/api/dashboard/series` | `days` (default 90, clamped 7–365) | Time series per product: `{ date, quantity_on_hand, quantity_sold }` from CSV. |
| GET | `/api/dashboard/forecast` | `horizon`, `days_back` (defaults 30, 90) | Per product: Holt forecast, `reorder_point`/`reorder_qty` from `tech_products.json`, `days_until_reorder` (first forecast index ≤ reorder_point when trend &lt; 0). Model label: `Holt double exponential smoothing (level + trend)`. |
| GET | `/api/recommend/health` | — | `{ hasKey, model, message }` — whether Grok key is set and which model is used. |
| POST | `/api/recommend` | Body: `prompt`, `fundsCrypto`, `forecastHorizon` | Full recommendation chain; see above. |

---

## Forecasting (Holt double exponential smoothing)

- **Input:** Time series of `quantity_on_hand` (or `quantity_sold`) per product from CSV.
- **Parameters:** `alpha = 0.3`, `beta = 0.1`, `horizon` (e.g. 30 days).
- **Recurrence:** `L_t = alpha * y_t + (1 - alpha) * (L_{t-1} + b_{t-1})`, `b_t = beta * (L_t - L_{t-1}) + (1 - beta) * b_{t-1}`.
- **Forecast:** `y_{t+k} = max(0, round(L + k * b))` for k = 1..horizon.
- **Reorder:** `reorder_point`, `reorder_qty` from `tech_products.json`; `days_until_reorder` = first k where forecast[k] ≤ reorder_point (when trend &lt; 0).

---

## Search API (port 3000)

- **Endpoint:** `GET /api/search?q=<query>`
- **Data:** `data/tech_products.json` (in-memory).
- **Scoring:** For each product, score = count of query words (length &gt; 1) that appear in `name`, `category`, or `query` (all lowercased). Sort by score desc, then ASIN; filter score &gt; 0; return top 20.
- **Response:** `{ results: [{ asin, product_name, price, category, link }], query }`. `link` = `http://<host>/item_page/shop_agent/<asin>/<encoded_query>/1/{}`.
- **CORS:** `Access-Control-Allow-Origin: *`.

---

## Data layer

### tech_products.json

- **Schema (per product):** `asin`, `name`, `category`, `query`, `list_price`, `cost`, `product_type`, `base_stock_range`, `daily_sales_mean`, `reorder_point`, `reorder_qty`.
- **Used by:** Search API (search + link); TRACE API (reorder_point, reorder_qty for forecast); synthetic inventory generator.

### synthetic_inventory_daily.csv

- **Columns:** `date`, `asin`, `product_name`, `category`, `quantity_on_hand`, `quantity_sold`, `list_price`, etc. (generator-defined).
- **Used by:** TRACE API for `/api/inventory` (latest per ASIN) and `/api/dashboard/series` and `/api/dashboard/forecast` (time series + Holt).

### scripts/generate_synthetic_inventory.py

- **Input:** `data/tech_products.json`.
- **Output:** `data/synthetic_inventory_daily.json`, `data/synthetic_inventory_daily.csv`.
- **Logic:** 364 days per product; `daily_sales = max(0, gauss(mu, sigma))` with `mu = daily_sales_mean * seasonal_multiplier(date) * weekday_multiplier(weekday)`; seasonality (Black Friday, Cyber Monday, back-to-school, summer dip, January lull); when `quantity_on_hand < reorder_point`, add `reorder_qty`; then subtract daily_sales. Seed 42 for reproducibility.

---

## Frontend (React + Vite)

- **Tabs:** Shop | Dashboard | Agentic restock.
- **Shop:** Fund selector (USDC, USDT, ETH, SOL, BTC, Card); CoinGecko live USD rates; prompt textarea; “Get recommendation”; collapsible inventory table (from `/api/inventory`); recommendation list (items + View link, reasoning, unfound_items with links); approve flow: balance → per-item deduction → remaining (USD).
- **Dashboard:** Horizon selector; forecast + series from `/api/dashboard/forecast` and `/api/dashboard/series`; Recharts (area/line); product selector; shows forecast, level, trend, reorder_point, days_until_reorder.
- **Agentic restock:** Products below reorder within horizon; rows with quantity, cancel, approve (smart-contract style).
- **API base:** Dev `http://localhost:3001/api`; prod `/api` (relative).

---

## Configuration (apps/trace/.env)

| Variable | Default | Description |
|----------|---------|-------------|
| `WEBSHOP_BASE_URL` | `http://localhost:3000` | Search API base (no trailing slash). |
| `GROK_API_KEY` or `XAI_API_KEY` | — | xAI API key for parse, search-queries, select/rank. |
| `GROK_MODEL` | `grok-3-mini` | Model for chat completions. |
| `EXTERNAL_SHOP_SEARCH_URL` | `https://www.google.com/search?tbm=shop&q` | Fallback link for unfound queries (append encoded query). |

External search timeout: 10s per query (Amazon and DuckDuckGo).

---

## Scripts (package.json, root)

| Script | Command | Description |
|--------|---------|-------------|
| `dev` | `concurrently "npm run dev:search" "npm run dev:app"` | Search API + TRACE app. |
| `dev:search` | `node services/search/index.js` | Search API only. |
| `dev:app` | `npm run dev --prefix apps/trace` | TRACE API + frontend (apps/trace). |
| `build` | `npm run build --prefix apps/trace` | Production build (frontend). |
| `start` | `npm run start --prefix apps/trace` | Start TRACE app (production). |
| `generate-inventory` | `python3 scripts/generate_synthetic_inventory.py` | Regenerate synthetic CSV/JSON. |

---

## Security & limits

- **Budget cap:** Recommendations and approval flow respect a $10,000 USD cap per approval context.
- **Rates:** Crypto → USD via CoinGecko (frontend); card treated as USD.
- **No auth in this repo:** APIs are unauthenticated; suitable for local/demo. Add auth/middleware for production.

---

## Project layout

```
iteratecolumbia/
├── package.json              # Root scripts, concurrently
├── apps/trace/
│   ├── server/index.js       # TRACE API (Express), recommendation chain, Holt, Grok, external search
│   ├── frontend/             # React + Vite + Recharts
│   ├── .env.example
│   └── package.json
├── services/search/
│   └── index.js              # HTTP search server, tech_products.json
├── data/
│   ├── tech_products.json
│   ├── synthetic_inventory_daily.csv
│   └── README.md
├── scripts/
│   └── generate_synthetic_inventory.py
└── docs/
    └── architecture.md       # High-level Mermaid + data flow table
```

---

## Quick start

```bash
npm install
cd apps/trace && npm install && cd frontend && npm install && cd ../..
npm run dev
```

Open **http://localhost:5174**. Optional: set `GROK_API_KEY` or `XAI_API_KEY` in `apps/trace/.env` for LLM-powered parse, search queries, and select/rank.
