// cron/price_fetch.js
// Railway cron — runs every 6 hours
// Uses Steam Market API — free, no key, no blocking

import { createClient } from '@supabase/supabase-js';
import fetch from 'node-fetch';
import ws from 'ws';

const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_KEY;
const RESEND_KEY    = process.env.RESEND_API_KEY;
const FROM_EMAIL    = process.env.RESEND_FROM_EMAIL || 'alerts@kastlr.com';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  realtime: { transport: ws }
});

// ── CONFIG ──────────────────────────────────────────────────────────────────
const MIN_PRICE_USD = 25;
const MIN_MOVE_PCT  = 5;
const FX_API        = 'https://open.er-api.com/v6/latest/USD';

const SKINS = [
  'AK-47 | Anubis (Field-Tested)',
  'AK-47 | Case Hardened (Factory New)',
  'AK-47 | Fuel Injector (Factory New)',
  'AK-47 | Fire Serpent (Field-Tested)',
  'AK-47 | Redline (Field-Tested)',
  'AK-47 | Asiimov (Field-Tested)',
  'M4A4 | In Living Color (Field-Tested)',
  'M4A4 | Howl (Field-Tested)',
  'M4A1-S | Printstream (Factory New)',
  'M4A1-S | Hyper Beast (Factory New)',
  'AWP | Dragon Lore (Factory New)',
  'AWP | Gungnir (Factory New)',
  'AWP | Asiimov (Field-Tested)',
  'AWP | Fade (Factory New)',
  'AWP | Medusa (Factory New)',
  'Desert Eagle | Printstream (Factory New)',
  'Desert Eagle | Printstream (Field-Tested)',
  'Desert Eagle | Blaze (Factory New)',
  'USP-S | Printstream (Factory New)',
  'USP-S | The Traitor (Field-Tested)',
  'USP-S | Kill Confirmed (Factory New)',
  'Glock-18 | Vogue (Field-Tested)',
  'Glock-18 | Fade (Factory New)',
  'SSG 08 | Blood in the Water (Factory New)',
  '★ Butterfly Knife | Gamma Doppler (Factory New)',
  '★ Butterfly Knife | Fade (Factory New)',
  '★ Butterfly Knife | Lore (Factory New)',
  '★ Butterfly Knife | Doppler (Factory New)',
  '★ Karambit | Fade (Factory New)',
  '★ Karambit | Gamma Doppler (Factory New)',
  '★ Karambit | Doppler (Factory New)',
  '★ M9 Bayonet | Gamma Doppler (Factory New)',
  '★ M9 Bayonet | Fade (Factory New)',
  '★ Talon Knife | Doppler (Factory New)',
  '★ Talon Knife | Fade (Factory New)',
  '★ Kukri Knife | Doppler (Factory New)',
  '★ Kukri Knife | Fade (Factory New)',
  '★ Shadow Daggers | Gamma Doppler (Factory New)',
  '★ Stiletto Knife | Doppler (Factory New)',
  '★ Ursus Knife | Doppler (Factory New)',
  '★ Flip Knife | Gamma Doppler (Factory New)',
  'Sport Gloves | Pandora\'s Box (Field-Tested)',
  'Sport Gloves | Slingshot (Field-Tested)',
  'Sport Gloves | Nocts (Field-Tested)',
  'Broken Fang Gloves | Jade (Field-Tested)',
  'Specialist Gloves | Marble Fade (Field-Tested)',
  'Driver Gloves | Snow Leopard (Field-Tested)',
  'Hand Wraps | Cobalt Skulls (Field-Tested)'
];

const KNIFE_WORDS = ['knife','karambit','butterfly','bayonet','falchion','flip','gut','huntsman','m9','navaja','shadow daggers','stiletto','talon','ursus','paracord','nomad','survival','skeleton','classic knife','kukri'];
const GLOVE_WORDS = ['gloves','hand wraps','wraps'];
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
  const results = {};
  for (const name of SKINS) {
    try {
      const url = `https://steamcommunity.com/market/priceoverview/?appid=730&currency=1&market_hash_name=${encodeURIComponent(name)}`;
      const res  = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });

      if (!res.ok) {
        console.log(`[Prices] Skipped ${name}: HTTP ${res.status}`);
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }

      const data = await res.json();
      if (data.success && data.lowest_price) {
        const price = parseFloat(data.lowest_price.replace(/[^0-9.]/g, ''));
        if (price > 0) {
          results[name] = { price, icon_url: null };
          console.log(`[Prices] ${name}: $${price}`);
        }
      }

      // Fetch icon URL from Steam market listing
      try {
        await new Promise(r => setTimeout(r, 1500));
        const iconRes  = await fetch(
          `https://steamcommunity.com/market/listings/730/${encodeURIComponent(name)}/render?count=1&currency=1&language=english&format=json`,
          { headers: { 'User-Agent': 'Mozilla/5.0' } }
        );
        const iconData = await iconRes.json();
        const assets   = iconData?.assets?.['730']?.['2'];
        if (assets && results[name]) {
          const firstAsset = Object.values(assets)[0];
          if (firstAsset?.icon_url) {
            results[name].icon_url = `https://steamcommunity-a.akamaihd.net/economy/image/${firstAsset.icon_url}/360fx360f`;
          }
        }
      } catch(e) {
        // icon fetch failed silently
      }

      await new Promise(r => setTimeout(r, 2000));
    } catch(e) {
      console.log(`[Prices] Skipped ${name}:`, e.message);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
  return results;
}

function isKnife(name) {
  return KNIFE_WORDS.some(k => name.toLowerCase().includes(k));
}

function isGloves(name) {
  return GLOVE_WORDS.some(k => name.toLowerCase().includes(k));
}

function buildPostText(movers, zarRate) {
  if (!movers.length) return null;
  const top    = movers[0];
  const sign   = top.changePct > 0 ? '↑' : '↓';
  const emoji  = top.changePct > 0 ? '🟢' : '🔴';
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

      console.log(`[Alerts] Sent to ${alert.email} for ${alert.skin_name}`);
    } catch(e) {
      console.error('[Alerts] Email failed:', e.message);
    }
  }
}

async function fetchLeaderboard() {
  try {
    const res = await fetch('https://explodingcamera.github.io/cs2leaderboard/data/latest/africa.json');
    if (!res.ok) throw new Error(`Leaderboard fetch failed: ${res.status}`);
    const data = await res.json();
    if (!data || !data.length) throw new Error('No leaderboard data');

    await supabase.from('leaderboard')
      .delete()
      .eq('snapshot_date', new Date().toISOString().split('T')[0]);

    const inserts = data.slice(0, 1000).map(p => ({
      player_name:   p.name,
      cs_rating:     p.rating,
      rank:          p.rank,
      wins:          p.matches_won || 0,
      losses:        p.matches_lost || 0,
      map_stats:     p.map_stats || {},
      snapshot_date: new Date().toISOString().split('T')[0],
      region:        'africa',
    }));

    const { error } = await supabase.from('leaderboard').insert(inserts);
    if (error) throw error;
    console.log(`[Leaderboard] Stored ${inserts.length} players`);
  } catch(e) {
    console.error('[Leaderboard] Failed:', e.message);
  }
}

async function main() {
  console.log('[PriceFetch] Starting run at', new Date().toISOString());

  // 1. FX rate
  const zarRate = await getFXRate();
  console.log('[FX] USD/ZAR:', zarRate);
  await supabase.from('fx_rates').insert({ rate: zarRate, timestamp: new Date() });

  // 2. Get prices from Steam Market
  let priceData;
  try {
    priceData = await getPrices();
    console.log('[Prices] Fetched', Object.keys(priceData).length, 'items');
  } catch(e) {
    console.error('[Prices] Failed:', e.message);
    process.exit(0);
  }

  if (Object.keys(priceData).length === 0) {
    console.log('[Prices] No data returned, exiting cleanly.');
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

  // 4. Process skins
  const inserts = [];
  const movers  = [];

  for (const [name, item] of Object.entries(priceData)) {
    const priceUSD = item.price;
    if (!priceUSD || priceUSD < MIN_PRICE_USD) continue;

    const knife     = isKnife(name);
    const gloves    = isGloves(name);
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
      icon_url:   item.icon_url || null,
      timestamp:  new Date(),
    });

    if (prevPrice && Math.abs(changePct) >= MIN_MOVE_PCT) {
      movers.push({
        name, priceUSD, prevPriceUSD: prevPrice, changePct,
        priority: (knife || gloves ? 100 : 0) + Math.abs(changePct) + (priceUSD / 10),
      });
    }
  }

  // 5. Insert to Supabase
  if (inserts.length > 0) {
    const { error } = await supabase.from('skin_prices').insert(inserts);
    if (error) console.error('[Supabase] Insert error:', error.message);
    else console.log(`[Prices] Stored ${inserts.length} skins`);
  }

  // 6. Queue social post if movers found
  movers.sort((a, b) => b.priority - a.priority);
  console.log(`[Movers] ${movers.length} notable movers`);

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

  // 7. Check alerts
  await checkAndSendAlerts(zarRate);

  // 8. Leaderboard
  await fetchLeaderboard();

  console.log('[PriceFetch] Done at', new Date().toISOString());
}

main().catch(e => {
  console.error('[FATAL]', e);
  process.exit(0);
});
