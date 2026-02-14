import React, { useState, useEffect, useRef } from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  Area,
  AreaChart,
  ReferenceLine,
} from 'recharts';

const API = (typeof import.meta !== 'undefined' && import.meta.env?.DEV)
  ? 'http://localhost:3001/api'
  : '/api';

const COINGECKO_IDS = { USDC: 'usd-coin', USDT: 'tether', ETH: 'ethereum', SOL: 'solana', BTC: 'bitcoin' };
const STABLECOINS = ['USDC', 'USDT'];

async function fetchCryptoUsdRate(token) {
  const id = COINGECKO_IDS[token];
  if (!id) return null;
  const r = await fetch(
    `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`
  );
  if (!r.ok) throw new Error(`Rate API ${r.status}`);
  const data = await r.json();
  const rate = data[id]?.usd;
  return typeof rate === 'number' && rate > 0 ? rate : null;
}

async function parseJsonResponse(r) {
  const ct = r.headers.get('content-type') || '';
  if (!ct.includes('application/json')) {
    const text = await r.text();
    if (text.trimStart().startsWith('<!')) {
      throw new Error('Server returned HTML instead of JSON. Is the shop-agent API running on port 3001?');
    }
    throw new Error(r.ok ? 'Invalid response format' : `API error ${r.status}`);
  }
  return r.json();
}

async function apiGet(path) {
  const r = await fetch(`${API}${path}`);
  return parseJsonResponse(r);
}

function SearchBar({ value, onChange, placeholder }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!ref.current) return;
    ref.current.style.height = 'auto';
    ref.current.style.height = Math.min(ref.current.scrollHeight, 200) + 'px';
  }, [value]);
  return (
    <textarea
      ref={ref}
      className="search-bar"
      placeholder={placeholder}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      rows={2}
    />
  );
}

function Dashboard() {
  const [forecast, setForecast] = useState({ products: [], horizon: 30 });
  const [series, setSeries] = useState({ products: [], days: 90 });
  const [loading, setLoading] = useState(true);
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [horizon, setHorizon] = useState(30);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      apiGet(`/dashboard/forecast?horizon=${horizon}&days_back=90`),
      apiGet('/dashboard/series?days=90'),
    ])
      .then(([f, s]) => {
        setForecast(f);
        setSeries(s);
        if (!selectedProduct && s.products?.length) setSelectedProduct(s.products[0].asin);
      })
      .catch((e) => setForecast({ products: [], error: e.message }))
      .finally(() => setLoading(false));
  }, [horizon]);

  const forecastProduct = forecast.products?.find((p) => p.asin === selectedProduct) || forecast.products?.[0];
  const seriesProduct = series.products?.find((p) => p.asin === selectedProduct) || series.products?.[0];

  const chartData = [];
  let lastHistoricalDate = null;
  if (seriesProduct?.series?.length) {
    seriesProduct.series.forEach((p) => {
      lastHistoricalDate = p.date;
      chartData.push({
        date: p.date.slice(5, 10),
        actual: p.quantity_on_hand,
        forecast: null,
      });
    });
  }
  if (forecastProduct?.forecast?.length && lastHistoricalDate) {
    const base = new Date(lastHistoricalDate + 'T12:00:00');
    forecastProduct.forecast.forEach((v, k) => {
      const d = new Date(base);
      d.setDate(d.getDate() + k + 1);
      chartData.push({
        date: d.toISOString().slice(5, 10),
        actual: null,
        forecast: v,
      });
    });
  }

  if (loading) return <div className="card">Loading dashboard…</div>;
  if (forecast.error) return <div className="card" style={{ color: 'var(--red)' }}>{forecast.error}</div>;

  return (
    <div className="dashboard">
      <h2>Inventory &amp; Forecasting</h2>
      <p className="sub">Holt double exponential smoothing (level + trend). Forecast horizon: {horizon} days.</p>

      <div className="card dashboard-controls">
        <label>Product</label>
        <select
          value={selectedProduct || ''}
          onChange={(e) => setSelectedProduct(e.target.value)}
          className="dashboard-select"
        >
          {(forecast.products || []).map((p) => (
            <option key={p.asin} value={p.asin}>{p.product_name}</option>
          ))}
        </select>
        <label style={{ marginLeft: '1rem' }}>Forecast horizon (days)</label>
        <input
          type="number"
          min="7"
          max="90"
          value={horizon}
          onChange={(e) => setHorizon(Number(e.target.value) || 30)}
          style={{ width: '60px', marginLeft: '0.5rem' }}
        />
      </div>

      <div className="card dashboard-chart-wrap">
        <h3>Stock level: actual vs forecast</h3>
        <ResponsiveContainer width="100%" height={320}>
          <AreaChart data={chartData} margin={{ top: 8, right: 16, left: 0, bottom: 8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border, #333)" />
            <XAxis dataKey="date" tick={{ fontSize: 11 }} stroke="var(--muted)" />
            <YAxis tick={{ fontSize: 11 }} stroke="var(--muted)" />
            <Tooltip
              contentStyle={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}
              labelStyle={{ color: 'var(--text)' }}
            />
            <Legend />
            <ReferenceLine
              y={forecastProduct?.reorder_point}
              stroke="var(--red, #f44336)"
              strokeDasharray="4 4"
              label={{ value: 'Reorder point', position: 'right', fill: 'var(--red)' }}
            />
            <Area type="monotone" dataKey="actual" name="Actual stock" stroke="var(--accent, #0a7ea4)" fill="var(--accent)" fillOpacity={0.3} />
            <Line type="monotone" dataKey="forecast" name="Forecast" stroke="var(--green, #4caf50)" strokeDasharray="4 4" dot={false} />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      <div className="card dashboard-insights">
        <h3>Forecasting insights</h3>
        <p className="meta" style={{ marginBottom: '1rem' }}>Model: {forecastProduct?.model ?? 'Holt (level + trend)'}</p>
        <div className="insight-grid">
          {(forecast.products || []).map((p) => (
            <div key={p.asin} className="insight-card">
              <strong>{p.product_name}</strong>
              <div className="insight-row"><span>Current level</span><span>{p.last_quantity}</span></div>
              <div className="insight-row"><span>Trend (units/day)</span><span style={{ color: p.trend < 0 ? 'var(--red)' : 'var(--green)' }}>{p.trend?.toFixed(2) ?? '—'}</span></div>
              <div className="insight-row"><span>Reorder point</span><span>{p.reorder_point || '—'}</span></div>
              <div className="insight-row"><span>Days until reorder</span><span className={p.days_until_reorder != null ? 'warning' : ''}>{p.days_until_reorder != null ? p.days_until_reorder : '—'}</span></div>
              <div className="insight-row"><span>Forecast (day {forecast.horizon})</span><span>{p.forecast?.[forecast.horizon - 1] ?? '—'}</span></div>
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <h3>All products: level &amp; trend</h3>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Product</th>
                <th>Category</th>
                <th>Last qty</th>
                <th>Trend</th>
                <th>Reorder pt</th>
                <th>Days to reorder</th>
              </tr>
            </thead>
            <tbody>
              {(forecast.products || []).map((p) => (
                <tr key={p.asin}>
                  <td>{p.product_name}</td>
                  <td>{p.category}</td>
                  <td>{p.last_quantity}</td>
                  <td style={{ color: p.trend < 0 ? 'var(--red)' : 'var(--green)' }}>{(p.trend ?? 0).toFixed(2)}/day</td>
                  <td>{p.reorder_point ?? '—'}</td>
                  <td className={p.days_until_reorder != null ? 'warning' : ''}>{p.days_until_reorder != null ? p.days_until_reorder : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function AgenticRestock() {
  const [enabled, setEnabled] = useState(true);
  const [forecast, setForecast] = useState({ products: [], horizon: 30 });
  const [inventory, setInventory] = useState({ products: [] });
  const [loading, setLoading] = useState(true);
  const [horizon, setHorizon] = useState(30);
  const [expanded, setExpanded] = useState(null);
  const [cancelled, setCancelled] = useState(new Set());
  const [quantityOverride, setQuantityOverride] = useState({});
  const [approved, setApproved] = useState(new Set());

  useEffect(() => {
    setLoading(true);
    Promise.all([
      apiGet(`/dashboard/forecast?horizon=${horizon}&days_back=90`),
      apiGet('/inventory'),
    ])
      .then(([f, inv]) => {
        setForecast(f);
        setInventory(inv);
      })
      .catch(() => setForecast({ products: [] }))
      .finally(() => setLoading(false));
  }, [horizon]);

  const priceByAsin = {};
  (inventory.products || []).forEach((p) => { priceByAsin[p.asin] = Number(p.list_price) || 0; });

  const restockItems = (forecast.products || [])
    .filter((p) => p.days_until_reorder != null && !cancelled.has(p.asin))
    .map((p) => {
      const qty = quantityOverride[p.asin] ?? p.reorder_qty ?? 1;
      const unitPrice = priceByAsin[p.asin] || 0;
      return {
        ...p,
        restockQty: qty,
        unitPrice,
        lineTotal: qty * unitPrice,
        buyWhen: `In ${p.days_until_reorder} day${p.days_until_reorder === 1 ? '' : 's'}`,
      };
    });

  const toggleExpand = (asin) => setExpanded((id) => (id === asin ? null : asin));
  const handleCancel = (asin) => setCancelled((s) => new Set([...s, asin]));
  const setQty = (asin, val) => {
    const n = parseInt(val, 10);
    setQuantityOverride((o) => ({ ...o, [asin]: Number.isFinite(n) && n > 0 ? n : undefined }));
  };
  const handleApprove = (asin) => setApproved((s) => new Set([...s, asin]));

  if (loading) return <div className="card agentic-restock">Loading agentic restock…</div>;

  return (
    <div className="agentic-restock">
      <h2>Agentic restock</h2>
      <p className="sub">Scheduled restocks from inventory forecasting. Approve or cancel each contract.</p>

      <div className="card agentic-restock-card">
        <label className="agentic-checkbox-wrap">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          <span>Agentic restock enabled</span>
        </label>
        <p className="meta" style={{ marginTop: '0.5rem' }}>
          When enabled, the agent will execute restock orders based on the schedule below.
        </p>
      </div>

      {enabled && (
      <div className="card" style={{ marginTop: '1rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem' }}>
          <h3 style={{ margin: 0 }}>Scheduled restocks</h3>
          <label className="meta">
            Horizon
            <input
              type="number"
              min="7"
              max="90"
              value={horizon}
              onChange={(e) => setHorizon(Number(e.target.value) || 30)}
              style={{ width: '52px', marginLeft: '0.5rem', padding: '0.25rem' }}
            />
            days
          </label>
        </div>

        {restockItems.length === 0 ? (
          <p className="meta">No restocks scheduled. Forecast shows no products below reorder point within the horizon.</p>
        ) : (
          <ul className="restock-list">
            {restockItems.map((item) => {
              const isExpanded = expanded === item.asin;
              const isApproved = approved.has(item.asin);
              return (
                <li key={item.asin} className={`restock-item ${isExpanded ? 'expanded' : ''}`}>
                  <div
                    className="restock-item-header"
                    onClick={() => toggleExpand(item.asin)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => e.key === 'Enter' && toggleExpand(item.asin)}
                  >
                    <div className="restock-item-main">
                      <span className="restock-item-title">{item.product_name}</span>
                      <span className="restock-item-meta">
                        {item.buyWhen} · {item.restockQty} × ${item.unitPrice.toFixed(2)} = <strong>${item.lineTotal.toFixed(2)}</strong>
                      </span>
                    </div>
                    <span className="restock-item-badge">Smart contract</span>
                    <span className="restock-chevron">{isExpanded ? '▼' : '▶'}</span>
                  </div>

                  {isExpanded && (
                    <div className="restock-item-dropdown">
                      <h4 className="restock-dropdown-title">Transparency</h4>
                      <dl className="restock-transparency">
                        <dt>Product</dt>
                        <dd>{item.product_name}</dd>
                        <dt>ASIN</dt>
                        <dd><code>{item.asin}</code></dd>
                        <dt>Category</dt>
                        <dd>{item.category || '—'}</dd>
                        <dt>Current level</dt>
                        <dd>{item.last_quantity}</dd>
                        <dt>Reorder point</dt>
                        <dd>{item.reorder_point ?? '—'}</dd>
                        <dt>Agent will buy</dt>
                        <dd>{item.buyWhen}</dd>
                        <dt>Unit price</dt>
                        <dd>${item.unitPrice.toFixed(2)}</dd>
                        <dt>Quantity</dt>
                        <dd>{item.restockQty}</dd>
                        <dt>Line total</dt>
                        <dd><strong>${item.lineTotal.toFixed(2)}</strong></dd>
                      </dl>

                      <div className="restock-dropdown-actions">
                        <div className="restock-action-row">
                          <label className="restock-qty-label">
                            Quantity
                            <input
                              type="number"
                              min="1"
                              max="999"
                              value={quantityOverride[item.asin] ?? item.reorder_qty ?? 1}
                              onChange={(e) => setQty(item.asin, e.target.value)}
                              className="restock-qty-input"
                            />
                          </label>
                          <button
                            type="button"
                            className="restock-btn-cancel"
                            onClick={(e) => { e.stopPropagation(); handleCancel(item.asin); }}
                            title="Cancel this payment"
                          >
                            ✕ Cancel
                          </button>
                        </div>
                        {!isApproved ? (
                          <button
                            type="button"
                            className="restock-btn-approve"
                            onClick={(e) => { e.stopPropagation(); handleApprove(item.asin); }}
                          >
                            Approve
                          </button>
                        ) : (
                          <span className="restock-approved-badge">Approved</span>
                        )}
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
      )}
    </div>
  );
}

export default function App() {
  const [activeTab, setActiveTab] = useState('shop');
  const [prompt, setPrompt] = useState('');
  const [fundsSource, setFundsSource] = useState('crypto');
  const [fundsAmount, setFundsAmount] = useState('200');
  const [cryptoToken, setCryptoToken] = useState('USDC');
  const [cryptoNetwork, setCryptoNetwork] = useState('ethereum');
  const [fundsFocused, setFundsFocused] = useState(false);
  const [cryptoUsdRate, setCryptoUsdRate] = useState(null);
  const [cryptoRateError, setCryptoRateError] = useState(null);
  const [inventory, setInventory] = useState({ snapshotDate: '', products: [] });
  const [recommendation, setRecommendation] = useState(null);
  const [approved, setApproved] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [inventoryOpen, setInventoryOpen] = useState(false);

  useEffect(() => {
    apiGet('/inventory')
      .then(setInventory)
      .catch((e) => setInventory({ snapshotDate: '', products: [], error: e.message }));
  }, []);

  useEffect(() => {
    if (fundsSource !== 'crypto' || !cryptoToken) return;
    setCryptoUsdRate(null);
    setCryptoRateError(null);
    fetchCryptoUsdRate(cryptoToken)
      .then((rate) => {
        setCryptoUsdRate(rate);
        if (!rate && !STABLECOINS.includes(cryptoToken)) setCryptoRateError('Rate unavailable');
      })
      .catch((e) => {
        setCryptoRateError(e.message || 'Failed to fetch rate');
        if (STABLECOINS.includes(cryptoToken)) setCryptoUsdRate(1);
      });
  }, [fundsSource, cryptoToken]);

  const [forecastDays, setForecastDays] = useState('30');

  const amountNum = Number(fundsAmount) || 0;
  const fundsAmountUsd =
    fundsSource === 'card'
      ? amountNum
      : amountNum * (cryptoUsdRate ?? (STABLECOINS.includes(cryptoToken) ? 1 : 0));

  const MAX_FUNDS_USD = 10000;
  const fundsOverLimit = fundsAmountUsd > MAX_FUNDS_USD;

  const runRecommend = () => {
    setError(null);
    setRecommendation(null);
    setApproved(false);
    setLoading(true);
    fetch(`${API}/recommend`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: prompt.trim() || 'Suggest restock based on current inventory.',
        fundsCrypto: String(fundsAmountUsd),
        forecastHorizon: parseInt(forecastDays) || 30,
      }),
    })
      .then((r) => parseJsonResponse(r))
      .then((data) => {
        if (data.error) throw new Error(data.error);
        setRecommendation(data);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  };

  return (
    <div className="app">
      <h1>TRACE</h1>
      <p className="sub" style={{ marginTop: 0, marginBottom: '0.5rem' }}>Trade &amp; Retail Agent for Chain Efficiency</p>
      <div className="app-tabs">
        <button type="button" className={activeTab === 'shop' ? 'active' : ''} onClick={() => setActiveTab('shop')}>Shop</button>
        <button type="button" className={activeTab === 'dashboard' ? 'active' : ''} onClick={() => setActiveTab('dashboard')}>Dashboard</button>
        <button type="button" className={activeTab === 'agentic' ? 'active' : ''} onClick={() => setActiveTab('agentic')}>Agentic restock</button>
      </div>

      {activeTab === 'dashboard' ? (
        <Dashboard />
      ) : activeTab === 'agentic' ? (
        <AgenticRestock />
      ) : (
        <>
      <p className="sub">Add funds, attach live inventory, and get a transparent buy list. Money is converted to crypto and controlled by the agent.</p>

      <div className="card funds-wrap">
        <label>Fund agent wallet</label>
        <div className="funds-tabs">
          <button
            type="button"
            className={fundsSource === 'crypto' ? 'active' : ''}
            onClick={() => setFundsSource('crypto')}
          >
            Crypto
          </button>
          <button
            type="button"
            className={fundsSource === 'card' ? 'active' : ''}
            onClick={() => setFundsSource('card')}
          >
            Card
          </button>
        </div>

        {fundsSource === 'crypto' ? (
          <>
            <div className="funds-row" style={{ marginBottom: '0.75rem' }}>
              <div style={{ flex: 1 }}>
                <span className="funds-field-label">Token</span>
                <select
                  className="funds-select"
                  value={cryptoToken}
                  onChange={(e) => setCryptoToken(e.target.value)}
                >
                  <option value="USDC">USDC</option>
                  <option value="USDT">USDT</option>
                  <option value="ETH">ETH</option>
                  <option value="SOL">SOL</option>
                  <option value="BTC">BTC</option>
                </select>
              </div>
              <div style={{ flex: 1 }}>
                <span className="funds-field-label">Network</span>
                <select
                  className="funds-select"
                  value={cryptoNetwork}
                  onChange={(e) => setCryptoNetwork(e.target.value)}
                >
                  <option value="ethereum">Ethereum</option>
                  <option value="base">Base</option>
                  <option value="solana">Solana</option>
                  <option value="polygon">Polygon</option>
                  <option value="arbitrum">Arbitrum</option>
                </select>
              </div>
            </div>
            <div style={{ marginBottom: '0.75rem' }}>
              <span className="funds-field-label">Amount</span>
              <div className={`funds-input-wrap${fundsFocused ? ' focused' : ''}`}>
                <input
                  type="text"
                  inputMode="decimal"
                  placeholder="0.00"
                  value={fundsAmount}
                  onChange={(e) => setFundsAmount(e.target.value)}
                  onFocus={() => setFundsFocused(true)}
                  onBlur={() => setFundsFocused(false)}
                  className="funds-amount-input"
                />
                <span className="funds-token-badge">{cryptoToken}</span>
              </div>
            </div>
            <div className="funds-conversion">
              <span className="funds-conversion-icon">&#8776;</span>
              <span>
                {cryptoRateError && !cryptoUsdRate && !STABLECOINS.includes(cryptoToken)
                  ? 'Rate unavailable — enter USD value or try another token'
                  : cryptoUsdRate == null && !STABLECOINS.includes(cryptoToken)
                    ? 'Loading USD rate…'
                    : `$${fundsAmountUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD`}
              </span>
              {cryptoUsdRate != null && !STABLECOINS.includes(cryptoToken) && (
                <span className="meta" style={{ marginLeft: '0.35rem' }}>(1 {cryptoToken} ≈ ${cryptoUsdRate.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })})</span>
              )}
            </div>
            <div className="funds-wallet-row">
              <span className="funds-field-label" style={{ marginBottom: '0.25rem', display: 'block' }}>Agent wallet</span>
              <code className="funds-wallet-addr">0x7a3F...e91D</code>
              <span className="funds-wallet-badge">Connected</span>
            </div>
            {fundsOverLimit && (
              <p style={{ marginTop: '0.75rem', color: 'var(--red, #f44336)', fontWeight: 600, fontSize: '0.95rem' }}>
                Card denied — insufficient funds. Maximum ${MAX_FUNDS_USD.toLocaleString()} USD.
              </p>
            )}
          </>
        ) : (
          <>
            <div style={{ marginBottom: '0.75rem' }}>
              <span className="funds-field-label">Amount (USD)</span>
              <div className={`funds-input-wrap${fundsFocused ? ' focused' : ''}`}>
                <span style={{ color: 'var(--muted)', fontSize: '1rem', paddingLeft: '0.75rem' }}>$</span>
                <input
                  type="text"
                  inputMode="decimal"
                  placeholder="0.00"
                  value={fundsAmount}
                  onChange={(e) => setFundsAmount(e.target.value)}
                  onFocus={() => setFundsFocused(true)}
                  onBlur={() => setFundsFocused(false)}
                  className="funds-amount-input"
                  style={{ paddingLeft: '0.25rem' }}
                />
              </div>
            </div>
            {fundsOverLimit && (
              <p style={{ marginTop: '0.75rem', color: 'var(--red, #f44336)', fontWeight: 600, fontSize: '0.95rem' }}>
                Card denied — insufficient funds. Maximum ${MAX_FUNDS_USD.toLocaleString()} USD.
              </p>
            )}
            <p className="funds-note">Charged to card on file. Converted to agent balance at checkout.</p>
          </>
        )}

        <div className="funds-row" style={{ marginTop: '0.75rem' }}>
          <label style={{ fontSize: '0.85rem', marginRight: '0.5rem' }}>Forecast horizon</label>
          <input
            type="number"
            min="1"
            max="365"
            placeholder="Days"
            value={forecastDays}
            onChange={(e) => setForecastDays(e.target.value)}
            style={{ width: '80px' }}
          />
          <span style={{ fontSize: '0.85rem', marginLeft: '0.5rem', opacity: 0.7 }}>days</span>
        </div>
      </div>

      <div className="card search-wrap">
        <label>What should the agent buy? (prompt)</label>
        <SearchBar
          value={prompt}
          onChange={setPrompt}
          placeholder="e.g. Restock headphones and cables for the holiday rush"
        />
      </div>

      <div className="card inventory-wrap">
        <button
          type="button"
          className="inventory-dropdown-header"
          onClick={() => setInventoryOpen((o) => !o)}
          aria-expanded={inventoryOpen}
        >
          <span className="inventory-dropdown-title">Live inventory (attached)</span>
          <span className="inventory-dropdown-meta">Snapshot: {inventory.snapshotDate || 'Loading…'} · {inventory.products?.length ?? 0} products</span>
          <span className="inventory-dropdown-chevron">{inventoryOpen ? '▼' : '▶'}</span>
        </button>
        {inventoryOpen && (
          <div className="table-wrap" style={{ marginTop: '1rem' }}>
            <table>
              <thead>
                <tr>
                  <th>ASIN</th>
                  <th>Product</th>
                  <th>Category</th>
                  <th>Qty on hand</th>
                  <th>List price</th>
                </tr>
              </thead>
              <tbody>
                {(inventory.products || []).map((p) => (
                  <tr key={p.asin}>
                    <td>{p.asin}</td>
                    <td>{p.product_name}</td>
                    <td>{p.category}</td>
                    <td>{p.quantity_on_hand}</td>
                    <td>${Number(p.list_price).toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div>
        <button
          type="button"
          className="btn-recommend"
          onClick={runRecommend}
          disabled={loading || fundsOverLimit}
        >
          {loading ? 'Getting recommendation…' : fundsOverLimit ? 'Over $10,000 — not allowed' : 'Get agent recommendation'}
        </button>
      </div>

      {error && <div className="card" style={{ color: 'var(--red)' }}>{error}</div>}

      {recommendation && (
        <>
          <div className="card result-wrap">
            <h3>All requested items</h3>
            {!approved && (
              <>
                {(recommendation.source === 'grok' || recommendation.source !== 'webshop' || recommendation.llmError) && (
                  <p className="meta source-badge">
                    {recommendation.source === 'grok' && 'Powered by Grok'}
                    {recommendation.source !== 'grok' && recommendation.source !== 'webshop' && 'Grok unavailable'}
                    {recommendation.llmError && (
                      <span className="llm-error"> — {recommendation.llmError}</span>
                    )}
                  </p>
                )}
                {recommendation.recommendation?.reasoning && recommendation.recommendation.reasoning !== 'No items from your request were in WebShop. Use the links below to search elsewhere.' && (
                  <div className="reasoning">{recommendation.recommendation.reasoning}</div>
                )}
              </>
            )}

            <div className="table-wrap" style={{ marginTop: approved ? 0 : '1rem' }}>
              <table>
                <thead>
                  <tr>
                    <th>Product</th>
                    <th>ASIN</th>
                    <th>Qty</th>
                    <th>Unit Price</th>
                    <th>Line Total</th>
                    <th>Link</th>
                  </tr>
                </thead>
                <tbody>
                  {(recommendation.recommendation?.items ?? []).map((item, i) => (
                    <tr key={'w-' + i}>
                      <td>
                        <strong>{item.product_name}</strong>
                        <div className="item-reason" style={{ fontSize: '0.8rem', opacity: 0.7 }}>{item.reason}</div>
                      </td>
                      <td style={{ fontFamily: 'monospace', fontSize: '0.85rem' }}>{item.asin}</td>
                      <td>{Number(item.quantity).toLocaleString()}</td>
                      <td>${Number(item.unit_price).toFixed(2)}</td>
                      <td><strong>${(item.quantity * item.unit_price).toFixed(2)}</strong></td>
                      <td>
                        {item.link && (
                          <a href={item.link} target="_blank" rel="noopener noreferrer" className="item-link">View</a>
                        )}
                      </td>
                    </tr>
                  ))}
                  {(recommendation.recommendation?.unfound_items ?? []).map((u, i) => (
                    <tr key={'u-' + i}>
                      <td>
                        <strong>
                          {u.link ? (
                            <a href={u.link} target="_blank" rel="noopener noreferrer" className="item-link">{u.product_name || u.query}</a>
                          ) : (
                            u.product_name || u.query
                          )}
                        </strong>
                        <span className="meta" style={{ marginLeft: '0.35rem' }}>(external search)</span>
                      </td>
                      <td style={{ fontFamily: 'monospace', fontSize: '0.85rem' }}>—</td>
                      <td>{u.quantity ?? '—'}</td>
                      <td>{u.unit_price != null ? `$${Number(u.unit_price).toFixed(2)}` : '—'}</td>
                      <td>{u.line_total != null ? `$${Number(u.line_total).toFixed(2)}` : '—'}</td>
                      <td>
                        {u.link && (
                          <a href={u.link} target="_blank" rel="noopener noreferrer" className="item-link">View</a>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr style={{ borderTop: '2px solid var(--border, #333)', fontWeight: 'bold' }}>
                    <td colSpan={4} style={{ textAlign: 'right' }}>Total</td>
                    <td>${(recommendation.totalCost ?? (recommendation.recommendation?.items ?? []).reduce((s, i) => s + i.quantity * i.unit_price, 0)).toFixed(2)}</td>
                    <td></td>
                  </tr>
                  <tr style={{ opacity: 0.7 }}>
                    <td colSpan={4} style={{ textAlign: 'right' }}>Budget (USD):</td>
                    <td>${fundsAmountUsd.toFixed(2)}</td>
                    <td></td>
                  </tr>
                  <tr style={{ color: (fundsAmountUsd - (recommendation.totalCost ?? 0)) >= 0 ? 'var(--green, #4caf50)' : 'var(--red, #f44336)' }}>
                    <td colSpan={4} style={{ textAlign: 'right' }}>Remaining:</td>
                    <td>${(fundsAmountUsd - (recommendation.totalCost ?? 0)).toFixed(2)}</td>
                    <td></td>
                  </tr>
                </tfoot>
              </table>
            </div>

            <div style={{ marginTop: '1rem', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
              {!approved ? (
                <button
                  type="button"
                  className="btn-recommend"
                  onClick={() => setApproved(true)}
                  style={{ padding: '0.5rem 1rem', fontSize: '0.9rem' }}
                >
                  Approve
                </button>
              ) : (
                <span className="meta" style={{ color: 'var(--green)' }}>Approved</span>
              )}
            </div>

            {approved && (() => {
              const items = recommendation.recommendation?.items ?? [];
              const startBalance = fundsAmountUsd;
              let runningBalance = startBalance;
              const paymentSteps = items.map((item) => {
                const lineTotal = item.quantity * item.unit_price;
                runningBalance -= lineTotal;
                return {
                  product_name: item.product_name,
                  quantity: item.quantity,
                  unit_price: item.unit_price,
                  lineTotal,
                  balanceAfter: runningBalance,
                };
              });
              const totalSpent = startBalance - runningBalance;
              return (
                <div className="payment-flow" style={{ marginTop: '1.5rem', paddingTop: '1rem', borderTop: '1px solid var(--border)' }}>
                  <h4 style={{ margin: '0 0 0.75rem 0', fontSize: '0.95rem' }}>Payment</h4>
                  <div className="table-wrap">
                    <table style={{ fontSize: '0.9rem' }}>
                      <thead>
                        <tr>
                          <th style={{ textAlign: 'left' }}>Step</th>
                          <th style={{ textAlign: 'left' }}>Action</th>
                          <th style={{ textAlign: 'right' }}>Amount</th>
                          <th style={{ textAlign: 'right' }}>Balance after</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr>
                          <td>0</td>
                          <td>Agent balance (USD)</td>
                          <td style={{ textAlign: 'right' }}>—</td>
                          <td style={{ textAlign: 'right', fontFamily: 'monospace' }}>${startBalance.toFixed(2)}</td>
                        </tr>
                        {paymentSteps.map((step, i) => (
                          <tr key={i}>
                            <td>{i + 1}</td>
                            <td>Pay for {step.product_name} ({step.quantity} × ${Number(step.unit_price).toFixed(2)})</td>
                            <td style={{ textAlign: 'right', color: 'var(--red)' }}>−${step.lineTotal.toFixed(2)}</td>
                            <td style={{ textAlign: 'right', fontFamily: 'monospace' }}>${step.balanceAfter.toFixed(2)}</td>
                          </tr>
                        ))}
                        <tr style={{ borderTop: '2px solid var(--border)', fontWeight: 'bold' }}>
                          <td colSpan={2}>Remaining balance</td>
                          <td style={{ textAlign: 'right' }}>−${totalSpent.toFixed(2)}</td>
                          <td style={{ textAlign: 'right', fontFamily: 'monospace', color: 'var(--green)' }}>${runningBalance.toFixed(2)}</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>
              );
            })()}

          </div>
        </>
      )}
        </>
      )}
    </div>
  );
}
