// cron/market_pro_snapshot.js
// KASTLR Market Pro - daily total-index + Buff163 top-movers snapshot.
// Imported and called from price_fetch.js's main(), reusing the `rows`
// and `zarRate` already computed in that run (no duplicate catalogue fetch).
//
// IMPORTANT (learned from the first live run): steamwebapi.com's markets=buff
// parameter does NOT return a Buff163-specific sold-count. Each item just
// carries a live snapshot inside its `prices` array, e.g.
//   { "price": 283.05, "source": "buff", "quantity": 4 }
// - "price"    = current Buff163 asking price
// - "quantity" = current number of active Buff163 listings right now
// There is no historical "sold on Buff today" field anywhere in the payload.
//
// So "purchased massively" is inferred, not read directly: we store today's
// buff price + quantity for every item into buff_snapshot_history, then rank
// by how much `quantity` DROPPED since yesterday's stored snapshot - a big
// drop in available listings at a rising price is what it looks like when
// something gets bought up aggressively. This means the very first run after
// this file ships only establishes the baseline; real rankings start
// appearing from the following day's run onward, once there is a prior day
// to diff against.

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
// Pricempire deep link - same slug rule as the approved mockup's kfPricempireUrl.
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

export function pricempireUrl(marketHashName, itemGroup) {
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

  // Pricempire uses a different category segment for gloves than for
  // everything else (skins, knives, agents, etc. all use "skin").
  const category = itemGroup === 'gloves' ? 'glove' : 'skin';

  return `https://pricempire.com/cs2-items/${category}/${slug}${variant ? '/' + variant : ''}`;
}

export function pricempireFallbackUrl(marketHashName) {
  return `https://pricempire.com/cs2-skin-search?query=${encodeURIComponent(marketHashName || '')}`;
}

// ----------------------------------------------------------------------------
// 1. Total daily index
//    total_turnover_*  = HEADLINE (Option 2, agreed): sum(price * sold_7d)
//                        across the whole catalogue. Real dollar turnover.
//    catalogue_index_* = REFERENCE (Option 3, agreed): sum(price) across a
//                        liquidity-filtered subset (sold_7d >= 5).
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
// 2. Buff163 top movers - all categories, no exclusions.
// ----------------------------------------------------------------------------
async function fetchBuffEnrichedItems() {
  const url = `https://www.steamwebapi.com/steam/api/items?key=${SWAPI_KEY}&game=cs2&production=1&markets=buff`;
  const res = await fetch(url, { headers: { 'User-Agent': 'KASTLR/1.0' } });
  if (!res.ok) throw new Error(`Buff163 API failed: ${res.status}`);
  const data = await res.json();
  console.log(`[Buff163] Received ${data.length} items`);
  // Debug line - uncomment to log one raw item and confirm field names again:
  // if (data[0]) console.log('[Buff163] Sample item:', JSON.stringify(data[0], null, 2));
  return data;
}

function extractBuff(item) {
  const list = item.prices;
  if (!Array.isArray(list)) return null;
  const entry = list.find(p => (p.source || '').toLowerCase() === 'buff');
  if (!entry || entry.price == null) return null;
  return {
    price: entry.price,
    quantity: entry.quantity != null ? entry.quantity : null,
  };
}

function entryRiskLabel(pctChange7d, buyingPressure) {
  if (pctChange7d >= 40) return ENTRY_RISK.HIGH;
  if (!buyingPressure && pctChange7d > 0) return ENTRY_RISK.HIGH;
  if (pctChange7d >= 15) return ENTRY_RISK.FOLLOW_PUMP;
  if (pctChange7d >= 5 && buyingPressure) return ENTRY_RISK.BUY_NOW;
  return ENTRY_RISK.MEDIUM;
}

function exitConfidenceLabel(sold7d, categoryAvgSold7d) {
  if (sold7d == null || !categoryAvgSold7d) return EXIT_CONFIDENCE.UNKNOWN;
  if (sold7d >= categoryAvgSold7d * 1.2) return EXIT_CONFIDENCE.GREAT;
  if (sold7d >= categoryAvgSold7d * 0.7) return EXIT_CONFIDENCE.GOOD;
  if (sold7d >= categoryAvgSold7d * 0.3) return EXIT_CONFIDENCE.MODERATE;
  return EXIT_CONFIDENCE.LOW;
}

export async function computeBuffTopMovers(supabase, catalogueRows, today) {
  let buffItems;
  try {
    buffItems = await fetchBuffEnrichedItems();
  } catch (e) {
    console.error('[Buff163] Fetch failed, skipping movers for today:', e.message);
    return [];
  }

  const catalogueMap = {};
  catalogueRows.forEach(r => { catalogueMap[r.market_hash_name] = r; });

  // Category average 7-day sold count (Steam-side, from the main catalogue),
  // used for exit-confidence - this is about general resale liquidity, not
  // Buff163 specifically, which is what actually matters after the 7-day
  // Steam trade lock.
  const catTotals = {};
  for (const r of catalogueRows) {
    if (!r.item_group) continue;
    catTotals[r.item_group] = catTotals[r.item_group] || { sum: 0, n: 0 };
    catTotals[r.item_group].sum += (r.sold_7d || 0);
    catTotals[r.item_group].n += 1;
  }
  const catAvgSold7d = {};
  for (const [cat, t] of Object.entries(catTotals)) {
    catAvgSold7d[cat] = t.n ? t.sum / t.n : null;
  }

  // Build today's buff snapshot rows (every item with a live buff price).
  const todaySnapshot = [];
  const buffByName = {};
  for (const item of buffItems) {
    const name = item.markethashname;
    if (!name) continue;
    const buff = extractBuff(item);
    if (!buff) continue;
    buffByName[name] = { ...buff, itemGroup: catalogueMap[name]?.item_group || item.itemgroup || null };
    todaySnapshot.push({
      snapshot_date: today,
      market_hash_name: name,
      buff_price_usd: buff.price,
      buff_quantity: buff.quantity,
    });
  }
  console.log(`[Buff163] ${todaySnapshot.length} items have a live Buff163 price today`);

  // Store today's snapshot (batched upsert).
  for (let i = 0; i < todaySnapshot.length; i += 500) {
    const batch = todaySnapshot.slice(i, i + 500);
    const { error } = await supabase
      .from('buff_snapshot_history')
      .upsert(batch, { onConflict: 'snapshot_date,market_hash_name' });
    if (error) console.error('[Buff163] Snapshot upsert error:', error.message);
  }

  // Find the most recent PRIOR day we have a snapshot for.
  const { data: prevDateRows } = await supabase
    .from('buff_snapshot_history')
    .select('snapshot_date')
    .neq('snapshot_date', today)
    .order('snapshot_date', { ascending: false })
    .limit(1);

  if (!prevDateRows?.length) {
    console.log('[Buff163] No prior-day snapshot yet - today only establishes the baseline. Real movers start appearing from tomorrow\'s run.');
    return [];
  }
  const prevDate = prevDateRows[0].snapshot_date;

  let prevRows = [];
  let from = 0;
  while (true) {
    const { data: batch } = await supabase
      .from('buff_snapshot_history')
      .select('market_hash_name, buff_price_usd, buff_quantity')
      .eq('snapshot_date', prevDate)
      .range(from, from + 999);
    if (!batch?.length) break;
    prevRows.push(...batch);
    if (batch.length < 1000) break;
    from += 1000;
  }
  const prevMap = {};
  prevRows.forEach(r => { prevMap[r.market_hash_name] = r; });
  console.log(`[Buff163] Comparing against ${prevRows.length} rows from ${prevDate}`);

  // Rank by how much the Buff163 listing quantity dropped since yesterday -
  // the proxy for "bought up aggressively." Only positive drops count as a
  // genuine buying signal.
  const candidates = [];
  for (const [name, buff] of Object.entries(buffByName)) {
    const prev = prevMap[name];
    if (!prev || prev.buff_quantity == null || buff.quantity == null) continue;
    const qtyDrop = prev.buff_quantity - buff.quantity;
    if (qtyDrop <= 0) continue;

    const catalogueRow = catalogueMap[name];
    const price7dAvg = catalogueRow?.price_real_median ?? null; // closest available "recent price" reference
    const pctChange7d = price7dAvg ? ((buff.price - price7dAvg) / price7dAvg) * 100 : 0;

    candidates.push({
      market_hash_name: name,
      item_group: buff.itemGroup,
      qty_prior_day: prev.buff_quantity,
      qty_today: buff.quantity,
      qty_drop: qtyDrop,
      price_now_usd: buff.price,
      price_7d_ago_usd: price7dAvg,
      pct_change_7d: Math.round(pctChange7d * 10) / 10,
      _catAvgSold7d: catAvgSold7d[buff.itemGroup],
    });
  }

  candidates.sort((a, b) => b.qty_drop - a.qty_drop);
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
    buff_listing_count: c.qty_today,
    entry_risk: entryRiskLabel(c.pct_change_7d, true),
    exit_confidence: exitConfidenceLabel(catalogueMap[c.market_hash_name]?.sold_7d, c._catAvgSold7d),
    tracker_url: pricempireUrl(c.market_hash_name, c.item_group),
  }));
}

// ----------------------------------------------------------------------------
// 3. Orchestration - call this once from price_fetch.js, after the existing
//    cs2_prices upsert and cs2_price_history snapshot, passing the same
//    `rows` array and `zarRate` that run already built.
// ----------------------------------------------------------------------------
export async function runMarketProSnapshot(supabase, rows, zarRate) {
  const today = new Date().toISOString().split('T')[0];

  const index = computeMarketIndex(rows, zarRate);
  const { error: idxErr } = await supabase
    .from('market_index_history')
    .upsert({ snapshot_date: today, ...index }, { onConflict: 'snapshot_date' });
  if (idxErr) console.error('[MarketPro] Index upsert error:', idxErr.message);
  else console.log('[MarketPro] Index snapshot stored:', index);

  const movers = await computeBuffTopMovers(supabase, rows, today);
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
