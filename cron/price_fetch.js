// cron/price_fetch.js
// Railway cron — runs every 6 hours
// Uses free prices.csgotrader.app — no API key needed

import { createClient } from '@supabase/supabase-js';
import fetch from 'node-fetch';

const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_KEY;
const RESEND_KEY    = process.env.RESEND_API_KEY;
const FROM_EMAIL    = process.env.RESEND_FROM_EMAIL || 'alerts@kastlr.com';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── CONFIG ──────────────────────────────────────────────────────────────────
const MIN_PRICE_USD  = 25;
const MIN_MOVE_PCT   = 5;
const PRICE_API = 'https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en/all.json';
const FX_API         = 'https://open.er-api.com/v6/latest/USD';

// Keywords that indicate knives or gloves
const KNIFE_WORDS  = ['knife','karambit','butterfly','bayonet','falchion','flip','gut','huntsman','m9','navaja','shadow daggers','stiletto','talon','ursus','paracord','nomad','survival','skeleton','classic knife','kukri'];
const GLOVE_WORDS  = ['gloves','hand wraps','wraps'];
// ────────────────────────────────────────────────────────────────────────────

async function getFXRate() {
  try {
    const res  = await fetch(FX_API);
    const data = await res.json();
    return data.rates.ZAR;
  } catch(e) {
    console.error('[FX] Failed, using fallback:', e.message);
    return 19.0;
  }
}

async function getPrices() {
  const res = await fetch(PRICE_API);
  if (!res.ok) throw new Error(`CSGOTrader API error: ${res.status}`);
  return res.json();
}

function isKnife(name) {
  const n = name.toLowerCase();
  return KNIFE_WORDS.some(k => n.includes(k));
}

function isGloves(name) {
  const n = name.toLowerCase();
  return GLOVE_WORDS.some(k => n.includes(k));
}

function getUSDPrice(item) {
  // CSGOTrader format: item can have steam, buff, etc
  if (!item) return 0;
  if (typeof item === 'number') return item;
  // Try different price sources in order of preference
  return item.buff163?.starting_at?.price
    || item.steam?.last_24h
    || item.steam?.last_7d
    || item.steam?.last_30d
    || item.bitskins?.price
    || 0;
}

function buildPostText(movers, zarRate) {
  if (!movers.length) return null;
  const top  = movers[0];
  const sign = top.changePct > 0 ? '↑' : '↓';
  const emoji = top.changePct > 0 ? '🟢' : '🔴';
  const prefix = (isKnife(top.name) || isGloves(top.name)) ? '★ ' : '';

  const lines = [
    `${emoji} CS2 SKIN ALERT — ZA`,
    ``,
    `${prefix}${top.name}`,
    `${sign} ${Math.abs(top.changePct).toFixed(1)}% — now R${Math.round(top.priceUSD * zarRate).toLocaleString('en-ZA')}`,
    `(was R${Math.round(top.prevPriceUSD * zarRate).toLocaleString('en-ZA')})`,
    ``,
  ];

  if (movers.length > 1) {
    lines.push('Also moving:');
    movers.slice(1, 4).forEach(m => {
      const s = m.changePct > 0 ? '↑' : '↓';
      const p = (isKnife(m.name) || isGloves(m.name)) ? '★ ' : '';
      lines.push(`${p}${m.name} ${s} ${Math.abs(m.changePct).toFixed(1)}% — R${Math.round(m.priceUSD * zarRate).toLocaleString('en-ZA')}`);
    });
    lines.push('');
  }

  lines.push('Full ZAR prices → kastlr.com/prices');
  return lines.join('\n');
}

async function checkAndSendAlerts(zarRate) {
  if (!RESEND_KEY) { console.log('[Alerts] No Resend key, skipping.'); return; }

  const { data: alerts } = await supabase
    .from('watchlist')
    .select('*')
    .eq('alert_sent', false)
    .eq('confirmed', true);

  if (!alerts || !alerts.length) { console.log('[Alerts] No pending alerts.'); return; }

  for (const alert of alerts) {
    const { data: priceRow } = await supabase
      .from('skin_prices')
      .select('zar_price')
      .eq('skin_name', alert.skin_name)
      .order('timestamp', { ascending: false })
      .limit(1)
      .single();

    if (!priceRow) continue;

    const currentZAR = priceRow.zar_price;
    const triggered  = alert.direction === 'below'
      ? currentZAR <= alert.target_zar
      : currentZAR >= alert.target_zar;

    if (!triggered) continue;

    // Send email via Resend
    try {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${RESEND_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: FROM_EMAIL,
          to: alert.email,
          subject: `Price Alert: ${alert.skin_name} hit your target`,
          html: `
            <h2>Your KASTLR Price Alert Triggered</h2>
            <p><strong>${alert.skin_name}</strong> is now <strong>R${currentZAR.toLocaleString('en-ZA')}</strong></p>
            <p>Your target was R${alert.target_zar.toLocaleString('en-ZA')} (${alert.direction})</p>
            <p><a href="https://kastlr.com/prices">View on KASTLR</a></p>
          `
        })
      });

      await supabase.from('watchlist')
        .update({ alert_sent: true, alert_sent_at: new Date() })
        .eq('id', alert.id);

      console.log(`[Alerts] Sent alert to ${alert.email} for ${alert.skin_name}`);
    } catch(e) {
      console.error('[Alerts] Email failed:', e.message);
    }
  }
}

async function main() {
  console.log('[PriceFetch] Starting run at', new Date().toISOString());

  // 1. FX rate
  const zarRate = await getFXRate();
  console.log('[FX] USD/ZAR:', zarRate);

  await supabase.from('fx_rates').insert({ rate: zarRate, timestamp: new Date() });

  // 2. Get prices
  let priceData;
  try {
    priceData = await getPrices();
    console.log('[Prices] Fetched', Object.keys(priceData).length, 'items');
  } catch(e) {
    console.error('[Prices] Failed:', e.message);
    process.exit(0);
  }

  // 3. Get previous prices for comparison
  const { data: prevPrices } = await supabase
    .from('skin_prices')
    .select('skin_name, usd_price')
    .order('timestamp', { ascending: false })
    .limit(10000);

  const prevMap = {};
  (prevPrices || []).forEach(p => {
    if (!prevMap[p.skin_name]) prevMap[p.skin_name] = p.usd_price;
  });

  // 4. Process eligible skins
  const inserts = [];
  const movers  = [];

  for (const [name, item] of Object.entries(priceData)) {
    const priceUSD = getUSDPrice(item);
    if (!priceUSD || priceUSD < MIN_PRICE_USD) continue;

    const knife    = isKnife(name);
    const gloves   = isGloves(name);
    const prevPrice = prevMap[name];
    const changePct = prevPrice
      ? ((priceUSD - prevPrice) / prevPrice) * 100
      : 0;

    inserts.push({
      skin_name:  name,
      usd_price:  priceUSD,
      zar_price:  Math.round(priceUSD * zarRate),
      rarity:     knife ? 'covert' : gloves ? 'extraordinary' : 'unknown',
      category:   knife ? 'knife' : gloves ? 'gloves' : 'weapon',
      change_pct: changePct,
      timestamp:  new Date(),
    });

    if (prevPrice && Math.abs(changePct) >= MIN_MOVE_PCT) {
      movers.push({
        name, priceUSD, prevPriceUSD: prevPrice, changePct,
        priority: (knife || gloves ? 100 : 0) + Math.abs(changePct) + (priceUSD / 10),
      });
    }
  }

  // 5. Batch insert
  const BATCH = 1000;
  for (let i = 0; i < inserts.length; i += BATCH) {
    const { error } = await supabase.from('skin_prices').insert(inserts.slice(i, i + BATCH));
    if (error) console.error('[Supabase] Insert error:', error.message);
  }
  console.log(`[Prices] Stored ${inserts.length} skins`);

  // 6. Log notable movers
  movers.sort((a, b) => b.priority - a.priority);
  console.log(`[Movers] ${movers.length} notable movers`);

  // 7. Log post to social_posts table (Make.com picks this up)
  if (movers.length > 0) {
    const postText = buildPostText(movers, zarRate);
    if (postText) {
      const { error } = await supabase.from('social_posts').insert({
        post_text: postText,
        status: 'queued',
        trigger: 'cron'
      });
      if (error) console.error('[Social] Log error:', error.message);
      else console.log('[Social] Post queued for Make.com');
    }
  }

  // 8. Check price alerts
  await checkAndSendAlerts(zarRate);

  console.log('[PriceFetch] Done at', new Date().toISOString());
}

main().catch(e => {
  console.error('[FATAL]', e);
  process.exit(0);
});
