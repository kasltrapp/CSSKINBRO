// cron/price_fetch.js
// Railway cron — runs every 6 hours
// Fetches CS2 prices from Pricempire, converts to ZAR, stores to Supabase
// Generates intelligent daily post for Buffer/X

import { createClient } from '@supabase/supabase-js';
import fetch from 'node-fetch';

const SUPABASE_URL     = process.env.SUPABASE_URL;
const SUPABASE_KEY     = process.env.SUPABASE_SERVICE_KEY; // service role for cron
const PRICEMPIRE_KEY   = process.env.PRICEMPIRE_API_KEY;
const FX_API_KEY       = process.env.FX_API_KEY; // exchangerate-api.com free key
const BUFFER_TOKEN     = process.env.BUFFER_ACCESS_TOKEN;
const BUFFER_PROFILE   = process.env.BUFFER_PROFILE_ID; // your X profile ID in Buffer

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── CONFIG ──────────────────────────────────────────────────────────────────
const MIN_PRICE_USD    = 25;    // Only track skins above $25
const MIN_MOVE_PCT     = 5;     // Only alert/post on 5%+ moves
const MIN_VOLUME_MULT  = 1.5;   // Only if volume is 1.5x average
const RARITY_WHITELIST = ['covert', 'contraband', 'extraordinary']; // Covert+ only
// Knife/glove categories always included regardless of rarity label
const CATEGORY_WHITELIST = ['knife', 'gloves'];
// ────────────────────────────────────────────────────────────────────────────

async function getFXRate() {
  try {
    const res  = await fetch(`https://open.er-api.com/v6/latest/USD`);
    const data = await res.json();
    return data.rates.ZAR;
  } catch(e) {
    console.error('[FX] Failed to fetch rate, using fallback:', e.message);
    return 19.0; // fallback
  }
}

async function getPrices() {
  const url = `https://api.pricempire.com/v3/items/prices?api_key=${PRICEMPIRE_KEY}&sources=buff,steam,csfloat&currency=USD`;
  const res  = await fetch(url);
  if (!res.ok) throw new Error(`Pricempire API error: ${res.status}`);
  return res.json();
}

async function getLeaderboard() {
  // Community snapshot, no key needed
  const res  = await fetch('https://explodingcamera.github.io/cs2leaderboard/data/latest/africa.json');
  if (!res.ok) throw new Error('Leaderboard fetch failed');
  return res.json();
}

function isEligible(item) {
  const rarity   = (item.rarity || '').toLowerCase();
  const category = (item.category || '').toLowerCase();
  const price    = item.prices?.buff?.price || item.prices?.steam?.price || 0;

  if (price < MIN_PRICE_USD) return false;
  if (CATEGORY_WHITELIST.some(c => category.includes(c))) return true;
  if (RARITY_WHITELIST.includes(rarity)) return true;
  return false;
}

function calcChange(current, previous) {
  if (!previous || previous === 0) return 0;
  return ((current - previous) / previous) * 100;
}

function formatZAR(usd, rate) {
  return Math.round(usd * rate).toLocaleString('en-ZA');
}

function buildPostText(movers, zarRate) {
  if (movers.length === 0) return null;

  const top = movers[0];
  const sign = top.changePct > 0 ? '↑' : '↓';
  const emoji = top.changePct > 0 ? '🟢' : '🔴';
  const typeTag = top.isKnife ? '★ ' : '';

  const lines = [
    `${emoji} CS2 SKIN ALERT — ZA`,
    ``,
    `${typeTag}${top.name}`,
    `${sign} ${Math.abs(top.changePct).toFixed(1)}% — now R${formatZAR(top.priceUSD, zarRate)}`,
    `(was R${formatZAR(top.prevPriceUSD, zarRate)})`,
    ``,
  ];

  if (movers.length > 1) {
    lines.push('Also moving:');
    movers.slice(1, 4).forEach(m => {
      const s = m.changePct > 0 ? '↑' : '↓';
      lines.push(`${m.isKnife ? '★ ' : ''}${m.name} ${s} ${Math.abs(m.changePct).toFixed(1)}% — R${formatZAR(m.priceUSD, zarRate)}`);
    });
    lines.push('');
  }

  lines.push('Full ZAR prices → csskinbro.com/prices');

  return lines.join('\n');
}

async function pushToBuffer(text) {
  if (!BUFFER_TOKEN || !BUFFER_PROFILE) {
    console.log('[Buffer] Credentials not set, skipping post.');
    console.log('[Buffer] Post preview:\n', text);
    return;
  }
  const res = await fetch('https://api.bufferapp.com/1/updates/create.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      access_token: BUFFER_TOKEN,
      [`profile_ids[]`]: BUFFER_PROFILE,
      text,
      scheduled_at: new Date(Date.now() + 3600000).toISOString(), // 1hr from now
    })
  });
  const data = await res.json();
  if (!data.success) throw new Error('Buffer push failed: ' + JSON.stringify(data));
  console.log('[Buffer] Post queued successfully');
}

async function main() {
  console.log('[PriceFetch] Starting run at', new Date().toISOString());

  // 1. Get FX rate
  const zarRate = await getFXRate();
  console.log('[FX] USD/ZAR:', zarRate);

  // 2. Store FX rate
  await supabase.from('fx_rates').insert({ rate: zarRate, timestamp: new Date() });

  // 3. Get prices
  let priceData;
  try {
    priceData = await getPrices();
  } catch(e) {
    console.error('[Prices] Failed:', e.message);
    process.exit(1);
  }

  // 4. Get previous prices from Supabase for comparison
  const { data: prevPrices } = await supabase
    .from('skin_prices')
    .select('skin_name, usd_price')
    .order('timestamp', { ascending: false })
    .limit(5000);

  const prevMap = {};
  (prevPrices || []).forEach(p => {
    if (!prevMap[p.skin_name]) prevMap[p.skin_name] = p.usd_price;
  });

  // 5. Process and store eligible skins
  const inserts   = [];
  const movers    = [];
  const items     = Object.entries(priceData);

  for (const [name, item] of items) {
    if (!isEligible(item)) continue;

    const priceUSD = item.prices?.buff?.price || item.prices?.steam?.price || 0;
    if (!priceUSD) continue;

    const prevPrice  = prevMap[name];
    const changePct  = calcChange(priceUSD, prevPrice);
    const isKnife    = (item.category || '').toLowerCase().includes('knife');
    const isGloves   = (item.category || '').toLowerCase().includes('glove');

    inserts.push({
      skin_name:  name,
      usd_price:  priceUSD,
      zar_price:  Math.round(priceUSD * zarRate),
      rarity:     item.rarity || 'unknown',
      category:   item.category || 'unknown',
      change_pct: changePct,
      timestamp:  new Date(),
    });

    // Check if this is a notable mover
    if (
      prevPrice &&
      Math.abs(changePct) >= MIN_MOVE_PCT &&
      priceUSD >= MIN_PRICE_USD
    ) {
      movers.push({
        name,
        priceUSD,
        prevPriceUSD: prevPrice,
        changePct,
        rarity: item.rarity,
        isKnife,
        isGloves,
        priority: (isKnife || isGloves ? 100 : 0) + Math.abs(changePct) + (priceUSD / 10),
      });
    }
  }

  // 6. Batch insert to Supabase (1000 at a time)
  const BATCH = 1000;
  for (let i = 0; i < inserts.length; i += BATCH) {
    const { error } = await supabase.from('skin_prices').insert(inserts.slice(i, i + BATCH));
    if (error) console.error('[Supabase] Insert error:', error.message);
  }
  console.log(`[Prices] Stored ${inserts.length} eligible skins`);

  // 7. Sort movers by priority (knives first, then by magnitude × price)
  movers.sort((a,b) => b.priority - a.priority);
  console.log(`[Movers] Found ${movers.length} notable movers`);

  // 8. Build and push X post if there are movers
  if (movers.length > 0) {
    const postText = buildPostText(movers, zarRate);
    try {
      await pushToBuffer(postText);
    } catch(e) {
      console.error('[Buffer] Post failed:', e.message);
    }
  } else {
    console.log('[Post] No significant movers today, skipping post.');
  }

  // 9. Update leaderboard
  try {
    const lb = await getLeaderboard();
    if (lb && lb.length) {
      // Delete today's existing snapshot
      await supabase.from('leaderboard')
        .delete()
        .gte('snapshot_date', new Date().toISOString().split('T')[0]);

      const lbInserts = lb.slice(0, 1000).map(p => ({
        player_name:   p.name,
        cs_rating:     p.rating,
        rank:          p.rank,
        wins:          p.matches_won || 0,
        losses:        p.matches_lost || 0,
        map_stats:     p.map_stats || {},
        snapshot_date: new Date().toISOString().split('T')[0],
        region:        'africa',
      }));

      const { error } = await supabase.from('leaderboard').insert(lbInserts);
      if (error) console.error('[Leaderboard] Insert error:', error.message);
      else console.log(`[Leaderboard] Stored ${lbInserts.length} entries`);
    }
  } catch(e) {
    console.error('[Leaderboard] Fetch failed:', e.message);
  }

  console.log('[PriceFetch] Done at', new Date().toISOString());
}

main().catch(e => {
  console.error('[FATAL]', e);
  process.exit(1);
});
