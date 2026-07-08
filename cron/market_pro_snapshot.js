// cron/market_pro_snapshot.js
// KASTLR Market Pro — daily total-index + Buff163 top-movers snapshot.
// Imported and called from price_fetch_v6.js's main(), reusing the `rows`
// and `zarRate` already computed in that run (no duplicate catalogue fetch).
//
// This module only ever WRITES to: market_index_history, buff_top_movers.
// It does not touch cs2_prices, cs2_price_history, or any existing table/view.
// The one line it asks you to add to price_fetch_v6.js (see market_pro_INTEGRATION.md)
// only adds a new `tracker_url` value to the row object that script already builds.

import fetch from 'node-fetch';

const SWAPI_KEY = process.env.STEAMWEBAPI_KEY;

export const ENTRY_RISK = {
  BUY_NOW: 'Buy Now',
  FOLLOW_PUMP: 'Follow the Pump',
  MEDIUM: 'Medium Risk',
  HIGH: 'High Risk',
};

export const EXIT_CONFIDENCE = {
  GREAT: 'Great',
  GOOD: 'Good',
  MODERATE: 'Moderate',
  LOW: 'Low',
  UNKNOWN: 'Not enough data',
};

// ----------------------------------------------------------------------------
// Pricempire deep link — same slug rule as the approved mockup's kfPricempireUrl.
// Falls back to Pricempire's own search results page if the guessed slug is
// wrong (rare items: agents, patches, music kits, unusual naming).
// ----------------------------------------------------------------------------
const WEAR_SLUG = {
  'Factory New': 'factory-new',
  'Minimal Wear': 'minimal-wear',
  'Field-Tested': 'field-tested',
  'Well-Worn': 'well-worn',
  'Battle-Scarred': 'battle-scarred',
};

export function pricempireUrl(marketHashName) {
  let name = marketHashName || '';
  if (!name) return null;
  let stattrak = false, souvenir = false;

  if (name.startsWith('StatTrak')) {
    stattrak = true;
    name = name.replace(/^StatTrak.{1,3}\s*/, '');
  }
  if (name.startsWith('Souvenir')) {
    souvenir = true;
    name = name.replace(/^Souvenir\s*/, '');
  }

  let wearSlug = '';
  const m = name.match(/\(([^)]+)\)\s*$/);
  if (m && WEAR_SLUG[m[1]]) {
    wearSlug = WEAR_SLUG[m[1]];
    name = name.slice(0, m.index).trim();
  }

  const slug = name
    .replace(/★/g, '')
    .replace(/\|/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');

  let variant = '';
  if (stattrak && wearSlug) variant = 'stattrak-' + wearSlug;
  else if (souvenir && wearSlug) variant = 'souvenir-' + wearSlug;
  else if (wearSlug) variant = wearSlug;

  return `https://pricempire.com/cs2-items/skin/${slug}${variant ? '/' + variant : ''}`;
}

export function pricempireFallbackUrl(marketHashName) {
  return `https://pricempire.com/cs2-skin-search?query=${encodeURIComponent(marketHashName || '')}`;
}

// ----------------------------------------------------------------------------
// 1. Total daily index
//    total_turnover_*  = HEADLINE (Option 2, agreed): sum(price * sold_7d)
//                        across the whole catalogue. Real dollar turnover.
//    catalogue_index_* = REFERENCE (Option 3, agreed): sum(price) across a
//                        liquidity-filtered subset (sold_7d >= 5). Less noisy
//                        than a raw sum of every price, still just a price
//                        level — not presented as a "cap".
// ----------------------------------------------------------------------------
export function computeMarketIndex(rows, zarRate) {
  let turnoverUsd = 0, turnoverZar = 0, turnoverCount = 0;
  let indexUsd = 0, indexZar = 0, indexCount = 0;

  for (const r of rows) {
    const price = r.price_real || r.price_steam;
    if (!price) continue;
    const priceZar = r.zar_real || r.zar_steam || Math.round(price * zarRate);

    if (r.sold_7d > 0) {
      turnoverUsd += price * r.sold_7d;
      turnoverZar += priceZar * r.sold_7d;
      turnoverCount++;
    }
    if (r.sold_7d >= 5) {
      indexUsd += price;
      indexZar += priceZar;
      indexCount++;
    }
  }

  return {
    total_turnover_usd: Math.round(turnoverUsd * 100) / 100,
    total_turnover_zar: Math.round(turnoverZar),
    catalogue_index_usd: Math.round(indexUsd * 100) / 100,
    catalogue_index_zar: Math.round(indexZar),
    item_count_turnover: turnoverCount,
    item_count_index: indexCount,
    fx_rate_used: zarRate,
  };
}

// ----------------------------------------------------------------------------
// 2. Buff163 top movers — all categories, no exclusions.
//
// IMPORTANT — verify before relying on this in production:
// steamwebapi.com's exact field names for `markets=buff` were confirmed to
// exist (via their docs) but not verified against a live response in this
// session. On the FIRST real run, uncomment the debug line in
// fetchBuffEnrichedItems() to log one raw item's keys, then adjust the
// `item.xxx ?? item.yyy` fallback chains below to match reality.
// ----------------------------------------------------------------------------
async function fetchBuffEnrichedItems() {
  const url = `https://www.steamwebapi.com/steam/api/items?key=${SWAPI_KEY}&game=cs2&production=1&markets=buff`;
  const res = await fetch(url, { headers: { 'User-Agent': 'KASTLR/1.0' } });
  if (!res.ok) throw new Error(`Buff163 API failed: ${res.status}`);
  const data = await res.json();
  console.log(`[Buff163] Received ${data.length} items`);
  // Debug line — uncomment on first run to confirm real field names:
  if (data[0]) console.log('[Buff163] Sample item:', JSON.stringify(data[0], null, 2));
  return data;
}

function entryRiskLabel(pctChange7d, volumeHolding) {
  if (pctChange7d >= 40) return ENTRY_RISK.HIGH;
  if (!volumeHolding && pctChange7d > 0) return ENTRY_RISK.HIGH;
  if (pctChange7d >= 15) return ENTRY_RISK.FOLLOW_PUMP;
  if (pctChange7d >= 5 && volumeHolding) return ENTRY_RISK.BUY_NOW;
  return ENTRY_RISK.MEDIUM;
}

function exitConfidenceLabel(qtyToday, categoryAvgQty) {
  if (qtyToday == null || !categoryAvgQty) return EXIT_CONFIDENCE.UNKNOWN;
  if (qtyToday >= categoryAvgQty * 1.2) return EXIT_CONFIDENCE.GREAT;
  if (qtyToday >= categoryAvgQty * 0.7) return EXIT_CONFIDENCE.GOOD;
  if (qtyToday >= categoryAvgQty * 0.3) return EXIT_CONFIDENCE.MODERATE;
  return EXIT_CONFIDENCE.LOW;
}

export async function computeBuffTopMovers(catalogueRows) {
  let buffItems;
  try {
    buffItems = await fetchBuffEnrichedItems();
  } catch (e) {
    console.error('[Buff163] Fetch failed, skipping movers for today:', e.message);
    return [];
  }

  // Category average daily-sold count, used for relative exit-confidence scoring.
  const catTotals = {};
  for (const r of catalogueRows) {
    if (!r.item_group) continue;
    catTotals[r.item_group] = catTotals[r.item_group] || { sum: 0, n: 0 };
    catTotals[r.item_group].sum += (r.sold_7d || 0) / 7; // approx daily
    catTotals[r.item_group].n += 1;
  }
  const catAvgDailyQty = {};
  for (const [cat, t] of Object.entries(catTotals)) {
    catAvgDailyQty[cat] = t.n ? t.sum / t.n : null;
  }

  const catalogueMap = {};
  catalogueRows.forEach(r => { catalogueMap[r.market_hash_name] = r; });

  const candidates = buffItems.map(item => {
    const name = item.markethashname;
    if (!name) return null;
    const cat = catalogueMap[name]?.item_group || item.itemgroup || null;

    const qtyToday   = item.buffsold24h ?? item.bufflastsale24h ?? item.buffsoldtoday ?? 0;
    const qtyPrior   = item.buffsoldprevday ?? item.bufflastsale24hprev ?? item.buffsoldyesterday ?? qtyToday;
    const priceNow   = item.buffsellprice ?? item.buffprice ?? item.buffpricelatest ?? null;
    const price7dAgo = item.buffpricelastweek ?? item.buffprice7d ?? item.buffprice7dago ?? null;

    if (!priceNow || !qtyToday) return null;

    const pctChange7d = price7dAgo ? ((priceNow - price7dAgo) / price7dAgo) * 100 : 0;

    return {
      market_hash_name: name,
      item_group: cat,
      qty_prior_day: qtyPrior,
      qty_today: qtyToday,
      price_now_usd: priceNow,
      price_7d_ago_usd: price7dAgo,
      pct_change_7d: Math.round(pctChange7d * 10) / 10,
      buff_listing_count: item.bufflistingcount ?? item.bufflistings ?? null,
      _volumeHolding: qtyPrior ? qtyToday >= qtyPrior * 0.85 : true,
      _catAvgDailyQty: catAvgDailyQty[cat],
    };
  }).filter(Boolean);

  // "Purchased massively" — rank by today's sold volume, no category exclusions.
  candidates.sort((a, b) => b.qty_today - a.qty_today);
  const top10 = candidates.slice(0, 10);

  return top10.map((c, idx) => ({
    rank: idx + 1,
    market_hash_name: c.market_hash_name,
    item_group: c.item_group,
    qty_prior_day: c.qty_prior_day,
    qty_today: c.qty_today,
    price_now_usd: c.price_now_usd,
    price_7d_ago_usd: c.price_7d_ago_usd,
    pct_change_7d: c.pct_change_7d,
    buff_listing_count: c.buff_listing_count,
    entry_risk: entryRiskLabel(c.pct_change_7d, c._volumeHolding),
    exit_confidence: exitConfidenceLabel(c.qty_today, c._catAvgDailyQty),
    tracker_url: pricempireUrl(c.market_hash_name),
  }));
}

// ----------------------------------------------------------------------------
// 3. Orchestration — call this once from price_fetch_v6.js, after the
//    existing cs2_prices upsert and cs2_price_history snapshot, passing the
//    same `rows` array and `zarRate` that run already built.
// ----------------------------------------------------------------------------
export async function runMarketProSnapshot(supabase, rows, zarRate) {
  const today = new Date().toISOString().split('T')[0];

  // 1. Total index
  const index = computeMarketIndex(rows, zarRate);
  const { error: idxErr } = await supabase
    .from('market_index_history')
    .upsert({ snapshot_date: today, ...index }, { onConflict: 'snapshot_date' });
  if (idxErr) console.error('[MarketPro] Index upsert error:', idxErr.message);
  else console.log('[MarketPro] Index snapshot stored:', index);

  // 2. Buff163 top movers
  const movers = await computeBuffTopMovers(rows);
  if (movers.length) {
    const moverRows = movers.map(m => ({ snapshot_date: today, ...m }));
    const { error: moverErr } = await supabase
      .from('buff_top_movers')
      .upsert(moverRows, { onConflict: 'snapshot_date,market_hash_name' });
    if (moverErr) console.error('[MarketPro] Movers upsert error:', moverErr.message);
    else console.log(`[MarketPro] ${moverRows.length} Buff163 movers stored`);
  } else {
    console.log('[MarketPro] No Buff163 movers computed today');
  }

  return { today, index, movers };
}
