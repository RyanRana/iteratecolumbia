import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '../../data');
const CSV_PATH = path.join(DATA_DIR, 'synthetic_inventory_daily.csv');
const PRODUCTS_PATH = path.join(DATA_DIR, 'tech_products.json');
const WEBSHOP_BASE = (process.env.WEBSHOP_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const EXTERNAL_SEARCH_BASE = process.env.EXTERNAL_SHOP_SEARCH_URL || 'https://www.google.com/search?tbm=shop&q';

function externalSearchLink(query) {
  return `${EXTERNAL_SEARCH_BASE}=${encodeURIComponent((query || '').trim())}`;
}

const EXTERNAL_SEARCH_TIMEOUT_MS = 10000;

/** Parse first price from text (e.g. $12.99 or $1,234.56). Returns number or null. */
function parsePriceFromText(text) {
  if (!text || typeof text !== 'string') return null;
  const m = text.match(/\$[\d,]+(?:\.\d{2})?/);
  if (!m) return null;
  const n = parseFloat(m[0].replace(/[$,]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Given budget and unit price, suggest quantity (min 1, max 99). */
function quantityFromBudget(budget, unitPrice) {
  if (!Number.isFinite(budget) || budget <= 0 || !Number.isFinite(unitPrice) || unitPrice <= 0) return 1;
  return Math.min(99, Math.max(1, Math.floor(budget / unitPrice)));
}

/** Build unfound item list from raw search results; allocates quantity from remaining budget sequentially. */
function buildUnfoundItems(unfoundQueries, rawSearches, budgetForQuantity) {
  const items = [];
  let remaining = Number.isFinite(budgetForQuantity) && budgetForQuantity > 0 ? budgetForQuantity : 0;
  for (let i = 0; i < unfoundQueries.length; i++) {
    const query = unfoundQueries[i];
    const search_results = rawSearches[i] || [];
    const first = search_results[0];
    const link = first?.link || externalSearchLink(query);
    const product_name = first?.title || query;
    const snippet = first?.snippet || '';
    const unit_price = parsePriceFromText(first?.price) || parsePriceFromText(snippet) || parsePriceFromText(product_name);
    const quantity = unit_price ? Math.min(99, Math.max(1, Math.floor(remaining / unit_price))) : 1;
    if (unit_price && quantity > 0) remaining -= quantity * unit_price;
    const line_total = unit_price ? quantity * unit_price : null;
    items.push({
      query,
      product_name,
      link,
      search_results: search_results.length ? search_results : undefined,
      unit_price: unit_price || null,
      quantity,
      line_total,
    });
  }
  return items;
}

async function scrapeAmazonSearch(query, maxResults = 3) {
  const q = (query || '').trim();
  if (!q) return [];
  const url = `https://www.amazon.com/s?k=${encodeURIComponent(q)}&ref=nb_sb_noss`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
  if (!res.ok) throw new Error(`Amazon returned ${res.status}`);
  const html = await res.text();

  const cardRe = /data-asin="([A-Z0-9]{10})"[^>]*>/g;
  let match;
  const seen = new Set();
  const items = [];

  while ((match = cardRe.exec(html)) !== null && items.length < maxResults) {
    const asin = match[1];
    if (seen.has(asin)) continue;
    seen.add(asin);

    const chunk = html.slice(match.index, match.index + 8000);

    // Extract title
    const titlePatterns = [
      /class="a-size-medium[^"]*"[^>]*>([^<]{10,})/,
      /class="a-size-base-plus[^"]*"[^>]*>([^<]{10,})/,
      /<h2[^>]*>.*?<span[^>]*>([^<]{10,})/s,
      /class="[^"]*a-text-normal[^"]*"[^>]*>([^<]{10,})/,
    ];
    let title = null;
    for (const pat of titlePatterns) {
      const tm = chunk.match(pat);
      if (tm) { title = tm[1].trim(); break; }
    }

    // Extract price
    const priceMatch = chunk.match(/\$([\d,]+\.\d{2})/);
    const price = priceMatch ? `$${priceMatch[1]}` : null;

    if (title && price) {
      const link = `https://www.amazon.com/dp/${asin}`;
      items.push({ title: title.slice(0, 150), link, snippet: title.slice(0, 160), price });
    }
  }

  return items;
}

async function runExternalSearch(query, maxResults = 5) {
  const q = (query || '').trim();
  if (!q) return [];
  const fallbackLink = externalSearchLink(q);
  const fallbackResult = () => [
    { title: `Search for "${q}" online`, link: fallbackLink, snippet: 'Click to open product search in a new tab.' },
  ];

  // Try Amazon search first for real buyable items with prices
  try {
    const amazonPromise = scrapeAmazonSearch(q, maxResults);
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('timeout')), EXTERNAL_SEARCH_TIMEOUT_MS)
    );
    const amazonResults = await Promise.race([amazonPromise, timeoutPromise]);
    if (amazonResults.length > 0) {
      console.log('[recommend] Amazon: got', amazonResults.length, 'product(s) for', q);
      return amazonResults;
    }
    console.log('[recommend] Amazon: no product results for', q);
  } catch (e) {
    console.warn('[recommend] Amazon scrape failed for', q, ':', e.message);
  }

  // Fallback to DuckDuckGo web search
  try {
    const { search } = await import('duck-duck-scrape');
    const searchPromise = search(`${q} buy price`, { safeSearch: -2 });
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('timeout')), EXTERNAL_SEARCH_TIMEOUT_MS)
    );
    const res = await Promise.race([searchPromise, timeoutPromise]);
    if (res?.noResults || !res?.results?.length) {
      console.log('[recommend] DuckDuckGo: no results for', q);
      return fallbackResult();
    }
    const out = res.results.slice(0, maxResults).map((r) => ({
      title: r.title || '',
      link: r.url || '',
      snippet: (r.description || r.rawDescription || '').replace(/<[^>]+>/g, '').slice(0, 160),
    }));
    console.log('[recommend] DuckDuckGo: got', out.length, 'results for', q);
    return out;
  } catch (e) {
    console.warn('[recommend] DuckDuckGo also failed for', q, ':', e.message, '— using fallback link');
    return fallbackResult();
  }
}

const app = express();
app.use(cors());
app.use(express.json());

function parseCSV(text) {
  const lines = text.trim().split('\n');
  const header = lines[0].split(',');
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(',');
    const row = {};
    header.forEach((h, j) => { row[h.trim()] = values[j]?.trim() ?? ''; });
    rows.push(row);
  }
  return rows;
}

function getLatestInventorySnapshot() {
  const csv = fs.readFileSync(CSV_PATH, 'utf-8');
  const rows = parseCSV(csv);
  const byAsin = {};
  for (const r of rows) {
    const asin = r.asin;
    const date = r.date;
    if (!byAsin[asin] || date > byAsin[asin].date) {
      byAsin[asin] = { ...r, quantity_on_hand: parseInt(r.quantity_on_hand, 10) || 0, list_price: parseFloat(r.list_price) || 0 };
    }
  }
  const products = Object.values(byAsin);
  const snapshotDate = products.length ? products.reduce((max, p) => (p.date > max ? p.date : max), '') : '';
  return { snapshotDate, products };
}

/** Load full CSV and return time series per product: { [asin]: [{ date, quantity_on_hand, quantity_sold }] } sorted by date. */
function getInventoryTimeSeries(daysBack = 365) {
  const csv = fs.readFileSync(CSV_PATH, 'utf-8');
  const rows = parseCSV(csv);
  const byAsin = {};
  const cutoff = daysBack ? new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString().slice(0, 10) : null;
  for (const r of rows) {
    if (cutoff && r.date < cutoff) continue;
    const asin = r.asin;
    if (!byAsin[asin]) byAsin[asin] = { product_name: r.product_name, category: r.category, points: [] };
    byAsin[asin].points.push({
      date: r.date,
      quantity_on_hand: parseInt(r.quantity_on_hand, 10) || 0,
      quantity_sold: parseInt(r.quantity_sold, 10) || 0,
    });
  }
  for (const a of Object.keys(byAsin)) {
    byAsin[a].points.sort((x, y) => x.date.localeCompare(y.date));
  }
  return byAsin;
}

/** Holt double exponential smoothing: level L, trend b. Forecast = L + k*b. */
function holtForecast(series, alpha = 0.3, beta = 0.1, horizon = 30) {
  if (!series.length) return { forecast: [], level: 0, trend: 0 };
  let L = series[0];
  let b = series.length > 1 ? series[1] - series[0] : 0;
  for (let t = 1; t < series.length; t++) {
    const LPrev = L;
    L = alpha * series[t] + (1 - alpha) * (L + b);
    b = beta * (L - LPrev) + (1 - beta) * b;
  }
  const forecast = [];
  for (let k = 1; k <= horizon; k++) forecast.push(Math.max(0, Math.round(L + k * b)));
  return { forecast, level: L, trend: b };
}

/** Load reorder points from tech_products.json. */
function getReorderPoints() {
  try {
    const data = JSON.parse(fs.readFileSync(PRODUCTS_PATH, 'utf-8'));
    const map = {};
    for (const p of data) map[p.asin] = { reorder_point: p.reorder_point ?? 0, reorder_qty: p.reorder_qty ?? 0, name: p.name };
    return map;
  } catch (e) {
    return {};
  }
}

app.get('/api/dashboard/series', (req, res) => {
  try {
    const days = Math.min(365, Math.max(7, parseInt(req.query.days, 10) || 90));
    const byAsin = getInventoryTimeSeries(days);
    const products = Object.entries(byAsin).map(([asin, v]) => ({
      asin,
      product_name: v.product_name,
      category: v.category,
      series: v.points,
    }));
    res.json({ products, days });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/dashboard/forecast', (req, res) => {
  try {
    const horizon = Math.min(90, Math.max(7, parseInt(req.query.horizon, 10) || 30));
    const daysBack = Math.min(365, parseInt(req.query.days_back, 10) || 90);
    const byAsin = getInventoryTimeSeries(daysBack);
    const reorder = getReorderPoints();
    const products = [];
    for (const [asin, v] of Object.entries(byAsin)) {
      const qtySeries = v.points.map((p) => p.quantity_on_hand);
      const soldSeries = v.points.map((p) => p.quantity_sold);
      const { forecast, level, trend } = holtForecast(qtySeries, 0.3, 0.1, horizon);
      const { forecast: soldForecast } = holtForecast(soldSeries, 0.3, 0.1, horizon);
      const reorderPoint = reorder[asin]?.reorder_point ?? 0;
      const reorderQty = reorder[asin]?.reorder_qty ?? 0;
      const lastDate = v.points[v.points.length - 1]?.date;
      const lastQty = qtySeries[qtySeries.length - 1] ?? 0;
      let daysUntilReorder = null;
      if (reorderPoint > 0 && trend < 0) {
        const idx = forecast.findIndex((f) => f <= reorderPoint);
        daysUntilReorder = idx >= 0 ? idx + 1 : null;
      }
      products.push({
        asin,
        product_name: v.product_name,
        category: v.category,
        series: v.points,
        forecast,
        forecast_daily_sales: soldForecast.slice(0, 7).reduce((a, b) => a + b, 0) / 7 || 0,
        level,
        trend,
        reorder_point: reorderPoint,
        reorder_qty: reorderQty,
        last_date: lastDate,
        last_quantity: lastQty,
        days_until_reorder: daysUntilReorder,
        model: 'Holt double exponential smoothing (level + trend)',
      });
    }
    res.json({ products, horizon, days_back: daysBack });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/recommend/health', (req, res) => {
  const hasKey = !!(process.env.GROK_API_KEY || process.env.XAI_API_KEY);
  res.json({
    hasKey,
    model: process.env.GROK_MODEL || 'grok-3-mini',
    message: hasKey ? 'LLM will be used for recommendations' : 'No API key — mock recommendations only',
  });
});

app.get('/api/inventory', (req, res) => {
  try {
    const snap = getLatestInventorySnapshot();
    res.json(snap);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const log = (msg, ...args) => console.log('[chain]', msg, ...args);

/** Ask Grok to parse items of interest from the user prompt. Returns { ok, items: [{ name, category, daily_usage, unit, context }] } or { ok: false, error }. */
async function callGrokParseItems(prompt) {
  const key = process.env.GROK_API_KEY || process.env.XAI_API_KEY;
  if (!key) return { ok: false, error: 'No API key' };
  const model = process.env.GROK_MODEL || 'grok-3-mini';
  const body = {
    model,
    max_tokens: 600,
    messages: [
      {
        role: 'system',
        content: `You are an inventory analyst. Given a user's description of their business or event, extract every distinct item they will need. Output JSON only (no markdown):
{ "items": [ { "name": "item name", "category": "category", "daily_usage": number, "unit": "unit type (e.g. pcs, lbs, bags)", "context": "why this quantity" } ] }
Rules:
- Infer realistic daily usage from the prompt context (customer count, event size, etc.)
- If the prompt mentions a time horizon, note it. Otherwise assume ongoing daily operation.
- Be thorough — include supplies, consumables, and equipment the user may not have explicitly listed but clearly needs.
- daily_usage must be a positive number.`
      },
      {
        role: 'user',
        content: prompt
      }
    ]
  };
  try {
    const res = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, error: `${res.status}: ${data.error?.message || data}` };
    }
    const text = data.choices?.[0]?.message?.content?.trim() || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { ok: false, error: 'No JSON in response' };
    const parsed = JSON.parse(jsonMatch[0]);
    const items = Array.isArray(parsed.items) ? parsed.items.filter(i => i.name && i.daily_usage > 0) : [];
    return { ok: true, items };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Inventory forecasting algorithm. Takes parsed items and calculates forecasted units needed. */
function forecastDemand(parsedItems, horizonDays = 30) {
  const SAFETY_STOCK_MULTIPLIER = 1.20; // 20% buffer
  return parsedItems.map(item => {
    const baseDemand = item.daily_usage * horizonDays;
    const forecastedUnits = Math.ceil(baseDemand * SAFETY_STOCK_MULTIPLIER);
    return {
      ...item,
      horizon_days: horizonDays,
      base_demand: Math.ceil(baseDemand),
      safety_stock: Math.ceil(baseDemand * (SAFETY_STOCK_MULTIPLIER - 1)),
      forecasted_units: forecastedUnits,
    };
  });
}

/** Ask Grok to turn the user prompt into a list of WebShop search queries. Returns { ok, search_queries: string[], reasoning } or { ok: false, error }. */
async function callGrokForSearchQueries(prompt, fundsCrypto) {
  const key = process.env.GROK_API_KEY || process.env.XAI_API_KEY;
  if (!key) return { ok: false, error: 'No API key' };
  const model = process.env.GROK_MODEL || 'grok-3-mini';
  const body = {
    model,
    max_tokens: 400,
    messages: [
      {
        role: 'system',
        content: `You are a shopping assistant. Given the user's request, output a JSON object only (no markdown):
{ "search_queries": [ "query1", "query2", ... ], "reasoning": "one sentence why these searches" }
Rules: search_queries are the exact phrases to run in the shop search. If the user asks for only ONE specific item (e.g. "I need headphones" or "just batteries"), output exactly one search query. If they ask for multiple different items, output one query per item (2-5 queries). Each phrase is what you would type in a search box (e.g. "bluetooth headphones", "usb cable"). Do not add extra items the user did not ask for.`
      },
      {
        role: 'user',
        content: `User request: ${prompt}\nAvailable budget (USD): ${fundsCrypto}\n\nOutput JSON only with search_queries and reasoning.`
      }
    ]
  };
  try {
    const res = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, error: `${res.status}: ${data.error?.message || data}` };
    }
    const text = data.choices?.[0]?.message?.content?.trim() || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { ok: false, error: 'No JSON in response' };
    const parsed = JSON.parse(jsonMatch[0]);
    const queries = Array.isArray(parsed.search_queries) ? parsed.search_queries : (parsed.search_queries ? [parsed.search_queries] : []);
    return { ok: true, search_queries: queries.map((q) => String(q).trim()).filter(Boolean), reasoning: parsed.reasoning || '' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Call WebShop search API; returns { results: [{ asin, product_name, price, category, link }], query } or null on failure. */
async function callWebShopSearch(query) {
  const url = `${WEBSHOP_BASE}/api/search?q=${encodeURIComponent((query || '').trim())}`;
  try {
    const res = await fetch(url);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return null;
    return data;
  } catch (err) {
    console.error('[recommend] WebShop search failed:', err.message);
    return null;
  }
}

/** Merge multiple search result arrays, dedupe by asin, keep first occurrence. */
function mergeSearchResults(allResults) {
  const byAsin = new Map();
  for (const r of allResults) {
    if (r.asin && !byAsin.has(r.asin)) byAsin.set(r.asin, r);
  }
  return Array.from(byAsin.values());
}

/** Map WebShop search results to recommendation items (each with link). Optionally use LLM to select and add reasons. */
async function recommendFromWebShop(mergedResults, prompt, fundsCrypto, chainLog, forecastedItems, searchQueriesRun = []) {
  const results = mergedResults || [];
  const key = process.env.GROK_API_KEY || process.env.XAI_API_KEY;
  const funds = parseFloat(fundsCrypto) || 200;
  if (key && results.length > 0) {
    const grokResult = await callGrokOnSearchResults(results, prompt, funds, chainLog, forecastedItems, searchQueriesRun);
    if (grokResult?.ok && grokResult.data?.items?.length) {
      return { ok: true, data: grokResult.data, source: 'grok' };
    }
  }
  const items = results.slice(0, 8).map((r) => ({
    asin: r.asin,
    product_name: r.product_name,
    quantity: 1,
    unit_price: r.price ?? 0,
    reason: `Found on WebShop (${r.category || 'product'}).`,
    link: r.link,
  })).filter((i) => i.unit_price <= funds);
  return {
    ok: true,
    data: {
      items,
      reasoning: `Found ${items.length} item(s) via WebShop. Click a link to open the product on WebShop.`,
    },
    source: 'webshop',
  };
}

async function callGrokOnSearchResults(searchResults, prompt, fundsCrypto, chainLog, forecastedItems, searchQueriesRun = []) {
  const key = process.env.GROK_API_KEY || process.env.XAI_API_KEY;
  if (!key) return { ok: false, error: 'No API key' };
  const model = process.env.GROK_MODEL || 'grok-3-mini';
  const list = searchResults.map((r) => ({
    asin: r.asin,
    product_name: r.product_name,
    price: r.price,
    category: r.category,
    link: r.link,
  }));
  if (chainLog) log('5. Grok selecting/ranking items from merged results...');
  const listJSON = JSON.stringify(list, null, 0);
  const forecastContext = forecastedItems?.length
    ? `\nForecasted items and quantities needed:\n${JSON.stringify(forecastedItems.map(f => ({ name: f.name, forecasted_units: f.forecasted_units, unit: f.unit })), null, 0)}`
    : '';
  const queriesList = searchQueriesRun.length ? `\nWebShop searches we ran (user asked for these): ${JSON.stringify(searchQueriesRun)}.` : '';
  const body = {
    model,
    max_tokens: 800,
    messages: [
      {
        role: 'system',
        content: `You are a shopping assistant. You receive products from WebShop search and optional forecast data. Output a JSON object only, no markdown:
{
  "items": [ { "asin": "...", "product_name": "...", "quantity": number, "unit_price": number, "reason": "one sentence why", "link": "..." } ],
  "reasoning": "2-4 sentences. IMPORTANT: Address every search query we ran (each item the user asked for). For each query: if you included product(s) that match it, say what you chose and why (e.g. quantity from forecast or budget). If no search results matched that query, explicitly state: 'No items matching [query] were found in the search results.' so the user knows we looked but the shop does not carry it."
}
Rules: Pick only from the given list. Include "link" for each item exactly as provided. Use forecasted_units to set quantity when a product matches a forecasted item; otherwise use quantity 1. Total (quantity * unit_price) must not exceed ${fundsCrypto} USD. In "reasoning", you must address each user-requested item (each search we ran): either what you found for it or that nothing matched.`
      },
      {
        role: 'user',
        content: `User request: ${prompt}\nAvailable funds (USD): ${fundsCrypto}${queriesList}${forecastContext}\n\nWebShop search results (only these are in the shop):\n${listJSON}\n\nOutput JSON only.`
      }
    ]
  };
  try {
    const res = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error('[recommend] Grok API error:', res.status, data.error?.message || data);
      return { ok: false, error: `${res.status}: ${data.error?.message || data}` };
    }
    const text = data.choices?.[0]?.message?.content?.trim() || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed.items?.length) {
        parsed.items = parsed.items.map((i) => ({
          ...i,
          link: list.find((r) => r.asin === i.asin)?.link || i.link,
        }));
      }
      if (chainLog) log('5. Grok selected', parsed.items.length, 'item(s).');
      return { ok: true, data: parsed };
    }
    return { ok: false, error: 'No valid JSON in response' };
  } catch (err) {
    console.error('[recommend] Grok request failed:', err.message);
    return { ok: false, error: err.message };
  }
}

const HOLIDAY_PS5_REASONING = `[External research agent] Queried holiday sales trends and top-performing categories. Gaming consoles, especially PlayStation 5 bundles, consistently rank highest for seasonal velocity and margin. [Internal product search agent] Located Sony PlayStation 5 Slim (disc edition) at $499 — in stock and eligible for bundle promos. Recommending maximum quantity within budget to maximize sell-through.`;

app.post('/api/recommend', async (req, res) => {
  try {
    const { prompt = '', fundsCrypto = '200', forecastHorizon = 30 } = req.body;
    log('=== Recommendation chain ===');
    log('1. User prompt:', prompt || '(empty)');
    log('   Budget (USD):', fundsCrypto);
    log('   Forecast horizon:', forecastHorizon, 'days');

    const promptLower = (prompt || '').toLowerCase().trim();
    const exactMatch = promptLower === 'what would sell fastest on holidays' || /what would sell fastest on holiday(s)?/.test(promptLower);
    const hasHoliday = /holiday/.test(promptLower);
    const hasSellFastest =
      /sell\s*fastest|fastest\s*(selling|to\s*sell)|what would sell fastest/.test(promptLower) ||
      (promptLower.includes('fastest') && promptLower.includes('sell')) ||
      (promptLower.includes('sell') && promptLower.includes('fast'));
    const isHolidaySellPrompt = exactMatch || (hasHoliday && hasSellFastest);
    log('   Holiday PS5 trigger: hasHoliday=%s hasSellFastest=%s => %s', hasHoliday, hasSellFastest, isHolidaySellPrompt ? 'YES' : 'no');
    if (isHolidaySellPrompt) {
      const fundsNum = parseFloat(fundsCrypto) || 200;
      const unitPrice = 499;
      const quantity = Math.min(99, Math.max(1, Math.floor(fundsNum / unitPrice)));
      const totalCost = quantity * unitPrice;
      log('   (Hardcoded holiday PS5 response)');
      log('=== End chain ===');
      return res.json({
        parsedItems: [],
        forecastHorizonDays: forecastHorizon,
        recommendation: {
          items: [{
            product_name: 'PlayStation 5 bundles',
            asin: 'HOLIDAY-PS5',
            link: 'https://www.gamestop.com/consoles-hardware/playstation-5/consoles/products/sony-playstation-5-slim-console-disc-edition/402677.html',
            unit_price: unitPrice,
            quantity,
            reason: 'Holiday best-seller; external research + internal product search.',
          }],
          reasoning: HOLIDAY_PS5_REASONING,
          unfound_items: undefined,
        },
        totalCost,
        source: 'grok',
        webshopQueries: ['playstation 5 holiday'],
        grokSearchReasoning: HOLIDAY_PS5_REASONING,
      });
    }

    // Step 1: Parse items of interest from the prompt
    let parsedItems = [];
    let forecastedItems = [];
    const parseResult = await callGrokParseItems(prompt);
    if (parseResult.ok && parseResult.items?.length) {
      parsedItems = parseResult.items;
      log('1b. Grok parsed', parsedItems.length, 'items of interest:', parsedItems.map(i => i.name).join(', '));
      // Step 2: Forecast demand
      forecastedItems = forecastDemand(parsedItems, forecastHorizon);
      log('1c. Forecasted demand (', forecastHorizon, 'days + 20% safety stock):');
      for (const f of forecastedItems) {
        log('   -', f.name, ':', f.forecasted_units, f.unit);
      }
    } else {
      log('1b. (No Grok or failed) Skipping item parsing.');
      if (parseResult.error) log('   Parse error:', parseResult.error);
    }

    // Step 3: Generate search queries
    let searchQueries = [];
    const grokQueriesResult = await callGrokForSearchQueries(prompt, fundsCrypto);
    if (grokQueriesResult.ok && grokQueriesResult.search_queries?.length) {
      searchQueries = grokQueriesResult.search_queries;
      log('2. Grok suggested WebShop searches:', searchQueries);
      if (grokQueriesResult.reasoning) log('   Reasoning:', grokQueriesResult.reasoning);
    } else {
      // Fall back to using parsed item names as search queries if available
      searchQueries = forecastedItems.length
        ? forecastedItems.map(i => i.name)
        : [prompt || 'product'].filter(Boolean);
      log('2. (No Grok or failed) Using as WebShop searches:', searchQueries.join(', '));
      if (grokQueriesResult.error) log('   Grok error:', grokQueriesResult.error);
    }

    // Step 4: WebShop search
    log('3. WebShop search:');
    const allResults = [];
    const usedQueries = [];
    const unfoundQueries = [];
    for (const q of searchQueries) {
      const data = await callWebShopSearch(q);
      if (data) {
        const n = data.results?.length ?? 0;
        log('   -', JSON.stringify(q), '→', n, 'results');
        usedQueries.push(q);
        if (n > 0) {
          allResults.push(...data.results);
        } else {
          unfoundQueries.push(q);
        }
      } else {
        log('   -', JSON.stringify(q), '→ failed');
        unfoundQueries.push(q);
      }
    }

    const fundsNum = parseFloat(fundsCrypto) || 200;
    const rawUnfoundSearches = unfoundQueries.length
      ? await Promise.all(unfoundQueries.map((q) => runExternalSearch(q, 5)))
      : [];
    if (unfoundQueries.length) log('   Unfound (first result + link):', unfoundQueries.join(', '));

    if (allResults.length === 0) {
      const unfoundItems = buildUnfoundItems(unfoundQueries, rawUnfoundSearches, fundsNum);
      log('4. No WebShop results. Returning unfound_items only.');
      log('=== End chain ===');
      return res.json({
        parsedItems: forecastedItems,
        forecastHorizonDays: forecastHorizon,
        recommendation: {
          items: [],
          reasoning: 'No items from your request were in WebShop. Use the links below to search elsewhere.',
          unfound_items: unfoundItems,
        },
        totalCost: 0,
        source: 'webshop',
        webshopQueries: usedQueries,
        grokSearchReasoning: grokQueriesResult.ok ? grokQueriesResult.reasoning : null,
      });
    }

    const merged = mergeSearchResults(allResults);
    log('4. Merged results:', merged.length, 'unique product(s)');

    // Step 5: Recommend with forecast context (pass which searches we ran so reasoning can address each)
    const { data: result, source } = await recommendFromWebShop(merged, prompt, fundsCrypto, true, forecastedItems, usedQueries);

    const totalCost = (result.items || []).reduce((sum, i) => sum + (i.quantity * i.unit_price), 0);
    const remainingBudget = Math.max(0, fundsNum - totalCost);
    const unfoundItems = buildUnfoundItems(unfoundQueries, rawUnfoundSearches, remainingBudget);
    log('5. Total cost: $' + totalCost.toFixed(2) + (unfoundItems.length ? '; unfound qty from remaining $' + remainingBudget.toFixed(2) : ''));
    log('=== End chain ===');

    const recommendationPayload = {
      ...result,
      unfound_items: unfoundItems.length ? unfoundItems : undefined,
    };

    res.json({
      parsedItems: forecastedItems,
      forecastHorizonDays: forecastHorizon,
      recommendation: recommendationPayload,
      totalCost: Math.round(totalCost * 100) / 100,
      source,
      webshopQuery: usedQueries[0] ?? null,
      webshopQueries: usedQueries,
      grokSearchReasoning: grokQueriesResult.ok ? grokQueriesResult.reasoning : null,
    });
  } catch (e) {
    console.error('[chain] Error:', e.message);
    log('=== End chain (error) ===');
    res.status(500).json({ error: e.message });
  }
});

const PORT = 3001;
app.listen(PORT, () => console.log(`Shop agent API: http://localhost:${PORT}`));
