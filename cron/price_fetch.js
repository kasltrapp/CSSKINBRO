// cron/price_fetch_v6.js
// KASTLR CS2 Full Market Index
// Uses steamwebapi.com Item+ — pulls entire CS2 catalog once daily
// Upserts into cs2_prices — no accumulation, stays in free Supabase tier

import { createClient } from '@supabase/supabase-js';
import fetch from 'node-fetch';
import ws from 'ws';

const SUPABASE_URL    = process.env.SUPABASE_URL;
const SUPABASE_KEY    = process.env.SUPABASE_SERVICE_KEY;
const SWAPI_KEY       = process.env.STEAMWEBAPI_KEY;   // new env var
const RESEND_KEY      = process.env.RESEND_API_KEY;
const FROM_EMAIL      = process.env.RESEND_FROM_EMAIL || 'alerts@kastlr.com';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  realtime: { transport: ws }
});

const FX_API = 'https://open.er-api.com/v6/latest/USD';

async function getFXRate() {
  try {
    const res  = await fetch(FX_API);
    const data = await res.json();
    return data.rates.ZAR;
  } catch(e) {
    console.error('[FX] Failed, using fallback');
    return 19.0;
  }
}

async function fetchAllItems() {
  console.log('[API] Fetching full CS2 catalog from steamwebapi.com...');
  const url = `https://www.steamwebapi.com/steam/api/items?key=${SWAPI_KEY}&game=cs2&production=1`;
  const res  = await fetch(url, { headers: { 'User-Agent': 'KASTLR/1.0' } });
  if (!res.ok) throw new Error(`API failed: ${res.status}`);
  const data = await res.json();
  console.log(`[API] Received ${data.length} items`);
  return data;
}

async function main() {
  console.log('[KASTLR] Full market pull starting at', new Date().toISOString());

  // FX rate
  const zarRate = await getFXRate();
  console.log('[FX] USD/ZAR:', zarRate);
  await supabase.from('fx_rates').insert({ rate: zarRate, timestamp: new Date() });

  // Fetch previous prices for change calculation
  // Paginate prev prices — Supabase caps at 1000 per call
let prevData = [];
let prevFrom = 0;
while (true) {
  const { data: batch } = await supabase
    .from('cs2_prices')
    .select('market_hash_name, price_steam, price_real')
    .range(prevFrom, prevFrom + 999);
  if (!batch?.length) break;
  prevData.push(...batch);
  if (batch.length < 1000) break;
  prevFrom += 1000;
}
console.log(`[Prev] Loaded ${prevData.length} previous prices`);
  const prevMap = {};
  (prevData || []).forEach(p => {
    prevMap[p.market_hash_name] = {
      steam: p.price_steam,
      real:  p.price_real
    };
  });
  console.log(`[Prev] Loaded ${Object.keys(prevMap).length} previous prices`);

  // Fetch all items
  const items = await fetchAllItems();

  // Build upsert rows
  const rows = [];
  for (const item of items) {
    const prev         = prevMap[item.markethashname] || {};
    const priceSteam   = item.pricelatest   || item.pricemedian || null;
    const priceReal    = item.pricereal     || null;
    const priceMix     = item.pricemix      || priceReal || priceSteam || null;

    const changeSteam  = prev.steam && priceSteam
      ? ((priceSteam - prev.steam) / prev.steam) * 100
      : 0;
    const changeReal   = prev.real && priceReal
      ? ((priceReal - prev.real) / prev.real) * 100
      : 0;

    rows.push({
      market_hash_name:  item.markethashname,
      normalized_name:   item.normalizedname,
      slug:              item.slug,
      item_group:        item.itemgroup,
      item_type:         item.itemtype,
      item_name:         item.itemname,
      wear:              item.wear,
      is_stattrak:       item.isstattrak   || false,
      is_souvenir:       item.issouvenir   || false,
      is_star:           item.isstar       || false,
      rarity:            item.rarity,
      rarity_color:      item.color,
      price_steam:       priceSteam,
      price_steam_median: item.pricemedian || null,
      price_real:        priceReal,
      price_real_median: item.pricerealmedian || null,
      price_mix:         priceMix,
      zar_steam:         priceSteam ? Math.round(priceSteam * zarRate) : null,
      zar_real:          priceReal  ? Math.round(priceReal  * zarRate) : null,
      zar_mix:           priceMix   ? Math.round(priceMix   * zarRate) : null,
      prev_steam:        prev.steam  || null,
      prev_real:         prev.real   || null,
      change_pct_steam:  parseFloat(changeSteam.toFixed(2)),
      change_pct_real:   parseFloat(changeReal.toFixed(2)),
      sold_24h:          item.sold24h    || 0,
      sold_7d:           item.sold7d     || 0,
      sold_30d:          item.sold30d    || 0,
      buy_order:         item.buyorderprice || null,
      offer_volume:      item.offervolume   || 0,
	  image_url:         item.itemimage || item.image,
      steam_url:         item.steamurl,
	  variants:          item.variants || null,
	  updated_at:        new Date(),
    });
  }

  // Upsert in batches of 500
  const BATCH = 500;
  let upserted = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const { error } = await supabase
      .from('cs2_prices')
      .upsert(batch, { onConflict: 'market_hash_name' });
    if (error) console.error('[Supabase] Upsert error:', error.message);
    else upserted += batch.length;
    console.log(`[Upsert] ${upserted}/${rows.length}`);
  }
  console.log(`[Prices] Done — ${upserted} items stored`);

// Daily price history snapshot
  const today = new Date().toISOString().split('T')[0];
  const historyRows = rows
    .filter(r => r.zar_real && r.zar_real > 0)
    .map(r => ({
      market_hash_name: r.market_hash_name,
      zar_real:         r.zar_real,
      zar_steam:        r.zar_steam,
      zar_mix:          r.zar_mix,
      change_pct_real:  r.change_pct_real,
      sold_7d:          r.sold_7d,
      snapshot_date:    today
    }));
  // Insert in batches of 500
  let historyInserted = 0;
  for (let i = 0; i < historyRows.length; i += 500) {
    const batch = historyRows.slice(i, i + 500);
    const { error } = await supabase.from('cs2_price_history').insert(batch);
    if (error) console.error('[History] Insert error:', error.message);
    else historyInserted += batch.length;
  }
  console.log(`[History] ${historyInserted} rows snapshotted for ${today}`);
	
  // Social post — top movers
  const movers = rows
    .filter(r => r.price_real && Math.abs(r.change_pct_real) >= 5)
    .sort((a,b) => Math.abs(b.change_pct_real) - Math.abs(a.change_pct_real))
    .slice(0, 1);

  if (movers.length) {
    const top   = movers[0];
    const sign  = top.change_pct_real > 0 ? '↑' : '↓';
    const emoji = top.change_pct_real > 0 ? '🟢' : '🔴';
    const shortName = top.market_hash_name.length > 60
      ? top.market_hash_name.substring(0, 57) + '...'
      : top.market_hash_name;
    const text = `${emoji} CS2 ZA — ${shortName}\n${sign} ${Math.abs(top.change_pct_real).toFixed(1)}% · R${top.zar_real?.toLocaleString('en-ZA')} (was R${Math.round((top.prev_real||0) * zarRate).toLocaleString('en-ZA')})\n\nkastlr.com/prices`;
    await supabase.from('social_posts').insert({ post_text: text, status: 'queued', trigger: 'cron' });
    console.log('[Social] Post queued:', text.length, 'chars');

	// Market digest post
  const digestText = `📊 CS2 ZA Market Digest updated\n\nTop movers, buy low watch & category breakdown — all in ZAR\n\nkastlr.com/market\n@kastlrcsgo`;
  await supabase.from('social_posts').insert({ post_text: digestText, status: 'queued', trigger: 'cron' });
  console.log('[Social] Market digest post queued');
	  
    // Discord webhook
    try {
      await fetch('https://discord.com/api/webhooks/1514811034496405525/7EINubJikI0wPPcA5Xd0-QqSZU-VT93NyWGKNycq88tD-aK5-I55Kjrhz407HCIgWhGo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'KASTLR Price Bot',
          content: text
        })
      });
      console.log('[Discord] Post sent');
    } catch(e) { console.error('[Discord] Failed:', e.message); }
  }

  // Alerts
  await checkAndSendAlerts(zarRate);

  // Leaderboard
  await fetchLeaderboard();

  console.log('[KASTLR] Full market pull complete at', new Date().toISOString());
}

async function checkAndSendAlerts(zarRate) {
  if (!RESEND_KEY) return;
  const { data: alerts } = await supabase.from('watchlist').select('*').eq('alert_sent', false).eq('confirmed', true);
  if (!alerts?.length) return;
  for (const alert of alerts) {
    const { data: priceRow } = await supabase
      .from('cs2_prices')
      .select('zar_real, zar_steam')
      .eq('market_hash_name', alert.skin_name)
      .single();
    if (!priceRow) continue;
    const currentZAR = priceRow.zar_real || priceRow.zar_steam;
    if (!currentZAR) continue;
    const triggered = alert.direction === 'below' ? currentZAR <= alert.target_zar : currentZAR >= alert.target_zar;
    if (!triggered) continue;
    try {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: FROM_EMAIL, to: alert.email,
          subject: `Price Alert: ${alert.skin_name} hit your target`,
          html: `<h2>Your KASTLR Price Alert Triggered</h2><p><strong>${alert.skin_name}</strong> is now <strong>R${currentZAR.toLocaleString('en-ZA')}</strong></p><p>Your target was R${alert.target_zar.toLocaleString('en-ZA')} (${alert.direction})</p><p><a href="https://kastlr.com/prices">View on KASTLR</a></p>`
        })
      });
      await supabase.from('watchlist').update({ alert_sent: true, alert_sent_at: new Date() }).eq('id', alert.id);
      console.log(`[Alerts] Sent to ${alert.email}`);
    } catch(e) { console.error('[Alerts] Failed:', e.message); }
  }
}

async function fetchLeaderboard() {
  try {
    const res = await fetch('https://explodingcamera.github.io/cs2leaderboard/data/latest/africa.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data?.length) throw new Error('No data');
    const today = new Date().toISOString().split('T')[0];
    await supabase.from('leaderboard').delete().eq('snapshot_date', today);
    const inserts = data.slice(0, 1000).map(p => ({
      player_name: p.name, cs_rating: p.rating, rank: p.rank,
      wins: p.matches_won || 0, losses: p.matches_lost || 0,
      map_stats: p.map_stats || {}, snapshot_date: today, region: 'africa',
    }));
    const { error } = await supabase.from('leaderboard').insert(inserts);
    if (error) throw error;
    console.log(`[Leaderboard] ${inserts.length} players stored`);
  } catch(e) { console.error('[Leaderboard] Failed:', e.message); }
}

main().catch(e => {
  console.error('[FATAL]', e);
  process.exit(0);
});
