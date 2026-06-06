// cron/price_fetch.js - v5
// 90 iconic skins, all wears, Normal + StatTrak
// Steam Market API - free, no key needed

import { createClient } from '@supabase/supabase-js';
import fetch from 'node-fetch';
import ws from 'ws';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const RESEND_KEY   = process.env.RESEND_API_KEY;
const FROM_EMAIL   = process.env.RESEND_FROM_EMAIL || 'alerts@kastlr.com';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  realtime: { transport: ws }
});

const FX_API = 'https://open.er-api.com/v6/latest/USD';

const WEARS = ['Factory New','Minimal Wear','Field-Tested','Well-Worn','Battle-Scarred'];

// 90 base skin names - we generate all wear variants automatically
const BASE_SKINS = [
  // AK-47 (15)
  'AK-47 | Redline',
  'AK-47 | Anubis',
  'AK-47 | Case Hardened',
  'AK-47 | Fire Serpent',
  'AK-47 | Fuel Injector',
  'AK-47 | Wild Lotus',
  'AK-47 | Vulcan',
  'AK-47 | Asiimov',
  'AK-47 | Neon Revolution',
  'AK-47 | Black Laminate',
  'AK-47 | The Empress',
  'AK-47 | Gold Arabesque',
  'AK-47 | Inheritance',
  'AK-47 | Slate',
  'AK-47 | Head Shot',
  // AWP (15)
  'AWP | Asiimov',
  'AWP | Dragon Lore',
  'AWP | Gungnir',
  'AWP | Hyper Beast',
  'AWP | Neo-Noir',
  'AWP | Medusa',
  'AWP | Fade',
  'AWP | Printstream',
  'AWP | Desert Hydra',
  'AWP | Duality',
  'AWP | Wildfire',
  'AWP | Chromatic Aberration',
  'AWP | Containment Breach',
  'AWP | Lightning Strike',
  'AWP | Fever Dream',
  // M4A4 (10)
  'M4A4 | Howl',
  'M4A4 | In Living Color',
  'M4A4 | Spider Lily',
  'M4A4 | The Emperor',
  'M4A4 | Desolate Space',
  'M4A4 | Asiimov',
  'M4A4 | Neo-Noir',
  'M4A4 | Buzz Kill',
  'M4A4 | Temukau',
  'M4A4 | Hellfire',
  // M4A1-S (10)
  'M4A1-S | Printstream',
  'M4A1-S | Black Lotus',
  'M4A1-S | Night Terror',
  'M4A1-S | Hyper Beast',
  'M4A1-S | Cyrex',
  'M4A1-S | Master Piece',
  'M4A1-S | Decimator',
  'M4A1-S | Imminent Danger',
  'M4A1-S | Welcome to the Jungle',
  'M4A1-S | Emphorosaur-S',
  // USP-S (8)
  'USP-S | Printstream',
  'USP-S | Kill Confirmed',
  'USP-S | The Traitor',
  'USP-S | Neo-Noir',
  'USP-S | Orion',
  'USP-S | Stainless',
  'USP-S | Monster Mashup',
  'USP-S | Overgrowth',
  // Glock-18 (8)
  'Glock-18 | Fade',
  'Glock-18 | Vogue',
  'Glock-18 | Water Elemental',
  'Glock-18 | Gamma Doppler',
  'Glock-18 | Neo-Noir',
  'Glock-18 | Bullet Queen',
  'Glock-18 | Wasteland Rebel',
  'Glock-18 | Brass',
  // Knives (15)
  '★ M9 Bayonet | Doppler',
  '★ M9 Bayonet | Fade',
  '★ M9 Bayonet | Marble Fade',
  '★ Karambit | Doppler',
  '★ Karambit | Marble Fade',
  '★ Butterfly Knife | Doppler',
  '★ Butterfly Knife | Marble Fade',
  '★ Talon Knife | Doppler',
  '★ Talon Knife | Fade',
  '★ Stiletto Knife | Doppler',
  '★ Flip Knife | Doppler',
  '★ Flip Knife | Fade',
  '★ Shadow Daggers | Doppler',
  '★ Kukri Knife | Doppler',
  '★ Skeleton Knife | Stained',
  // Gloves (12)
  "Sport Gloves | Pandora's Box",
  'Sport Gloves | Vice',
  'Sport Gloves | Amphibious',
  'Sport Gloves | Superconductor',
  'Specialist Gloves | Crimson Kimono',
  'Specialist Gloves | Fade',
  'Specialist Gloves | Marble Fade',
  'Driver Gloves | Crimson Weave',
  'Driver Gloves | Imperial Plaid',
  'Hand Wraps | Cobalt Skulls',
  'Moto Gloves | Spearmint',
  'Broken Fang Gloves | Unhinged',
];

// Skins that only come in FN (knives/gloves mostly)
const FN_ONLY = [
  '★ M9 Bayonet | Doppler', '★ M9 Bayonet | Fade', '★ M9 Bayonet | Marble Fade',
  '★ Karambit | Doppler', '★ Karambit | Marble Fade',
  '★ Butterfly Knife | Doppler', '★ Butterfly Knife | Marble Fade',
  '★ Talon Knife | Doppler', '★ Talon Knife | Fade',
  '★ Stiletto Knife | Doppler', '★ Flip Knife | Doppler', '★ Flip Knife | Fade',
  '★ Shadow Daggers | Doppler', '★ Kukri Knife | Doppler', '★ Skeleton Knife | Stained',
  'AWP | Dragon Lore', 'AWP | Gungnir', 'AWP | Lightning Strike',
  'AK-47 | Wild Lotus', 'AK-47 | Gold Arabesque', 'M4A4 | Howl',
];

// Gloves only come in FT/WW/BS
const GLOVE_BASES = [
  "Sport Gloves | Pandora's Box", 'Sport Gloves | Vice', 'Sport Gloves | Amphibious',
  'Sport Gloves | Superconductor', 'Specialist Gloves | Crimson Kimono',
  'Specialist Gloves | Fade', 'Specialist Gloves | Marble Fade',
  'Driver Gloves | Crimson Weave', 'Driver Gloves | Imperial Plaid',
  'Hand Wraps | Cobalt Skulls', 'Moto Gloves | Spearmint', 'Broken Fang Gloves | Unhinged',
];

const GLOVE_WEARS = ['Field-Tested', 'Well-Worn', 'Battle-Scarred'];

// No StatTrak for gloves or some special skins
const NO_STATTRAK = [
  ...GLOVE_BASES,
  'AWP | Dragon Lore', 'AWP | Gungnir', 'AWP | Medusa',
  'AK-47 | Wild Lotus', 'AK-47 | Gold Arabesque', 'AK-47 | Fire Serpent',
  'M4A4 | Howl',
];

const KNIFE_WORDS = ['knife','karambit','butterfly','bayonet','falchion','flip','gut','huntsman','m9','navaja','shadow daggers','stiletto','talon','ursus','paracord','nomad','survival','skeleton','classic knife','kukri'];
const GLOVE_WORDS = ['gloves','hand wraps','wraps'];

function isKnife(n)  { return KNIFE_WORDS.some(k => n.toLowerCase().includes(k)); }
function isGloves(n) { return GLOVE_WORDS.some(k => n.toLowerCase().includes(k)); }

function getWearsForSkin(base) {
  if (GLOVE_BASES.includes(base)) return GLOVE_WEARS;
  if (FN_ONLY.includes(base)) return ['Factory New'];
  return WEARS;
}

function hasStatTrak(base) {
  return !NO_STATTRAK.includes(base) && !isGloves(base);
}

async function getFXRate() {
  try {
    const res  = await fetch(FX_API);
    const data = await res.json();
    return data.rates.ZAR;
  } catch(e) {
    console.error('[FX] Failed, using fallback 19.0');
    return 19.0;
  }
}

async function fetchPrice(marketHashName) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const url = `https://steamcommunity.com/market/priceoverview/?appid=730&currency=1&market_hash_name=${encodeURIComponent(marketHashName)}`;
      const res  = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!res.ok) { await new Promise(r => setTimeout(r, 8000)); continue; }
      const data = await res.json();
      if (!data.success) { await new Promise(r => setTimeout(r, 8000)); continue; }
      const raw = data.lowest_price || data.median_price;
      if (!raw) { await new Promise(r => setTimeout(r, 8000)); continue; }
      return parseFloat(raw.replace(/[^0-9.]/g, ''));
    } catch(e) {
      await new Promise(r => setTimeout(r, 8000));
    }
  }
  return null;
}

function buildPostText(movers, zarRate) {
  if (!movers.length) return null;
  const top   = movers[0];
  const sign  = top.changePct > 0 ? '↑' : '↓';
  const emoji = top.changePct > 0 ? '🟢' : '🔴';
  const price = Math.round(top.priceUSD * zarRate).toLocaleString('en-ZA');
  const prev  = Math.round(top.prevPriceUSD * zarRate).toLocaleString('en-ZA');
  const pct   = Math.abs(top.changePct).toFixed(1);

  const text = `${emoji} CS2 ZA — ${top.name}\n${sign} ${pct}% · R${price} (was R${prev})\n\nkastlr.com/prices`;

  return text.length <= 260 ? text : text.substring(0, 257) + '...';
}

async function checkAndSendAlerts(zarRate) {
  if (!RESEND_KEY) { console.log('[Alerts] No Resend key, skipping.'); return; }
  const { data: alerts } = await supabase.from('watchlist').select('*').eq('alert_sent', false).eq('confirmed', true);
  if (!alerts || !alerts.length) { console.log('[Alerts] No pending alerts.'); return; }
  for (const alert of alerts) {
    const { data: priceRow } = await supabase.from('skin_prices').select('zar_price').eq('skin_name', alert.skin_name).order('timestamp', { ascending: false }).limit(1).single();
    if (!priceRow) continue;
    const currentZAR = priceRow.zar_price;
    const triggered  = alert.direction === 'below' ? currentZAR <= alert.target_zar : currentZAR >= alert.target_zar;
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
      console.log(`[Alerts] Sent to ${alert.email} for ${alert.skin_name}`);
    } catch(e) {
      console.error('[Alerts] Email failed:', e.message);
    }
  }
}

async function fetchLeaderboard() {
  try {
    const res = await fetch('https://explodingcamera.github.io/cs2leaderboard/data/latest/africa.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data || !data.length) throw new Error('No data');
    await supabase.from('leaderboard').delete().eq('snapshot_date', new Date().toISOString().split('T')[0]);
    const inserts = data.slice(0, 1000).map(p => ({
      player_name: p.name, cs_rating: p.rating, rank: p.rank,
      wins: p.matches_won || 0, losses: p.matches_lost || 0,
      map_stats: p.map_stats || {}, snapshot_date: new Date().toISOString().split('T')[0], region: 'africa',
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

  // FX rate
  const zarRate = await getFXRate();
  console.log('[FX] USD/ZAR:', zarRate);
  await supabase.from('fx_rates').insert({ rate: zarRate, timestamp: new Date() });

  // Get previous prices for change calculation
  const { data: prevPrices } = await supabase.from('skin_prices').select('skin_name, usd_price').order('timestamp', { ascending: false }).limit(50000);
  const prevMap = {};
  (prevPrices || []).forEach(p => { if (!prevMap[p.skin_name]) prevMap[p.skin_name] = p.usd_price; });

  const inserts = [];
  const movers  = [];
  let fetched   = 0;

  for (const base of BASE_SKINS) {
    const wears = getWearsForSkin(base);
    const types = hasStatTrak(base) ? [false, true] : [false];

    for (const st of types) {
      for (const wear of wears) {
        const prefix    = st ? 'StatTrak™ ' : '';
        const fullName  = `${prefix}${base} (${wear})`;
        const knife     = isKnife(base);
        const gloves    = isGloves(base);

        const priceUSD = await fetchPrice(fullName);
        await new Promise(r => setTimeout(r, 4000));

        if (!priceUSD || priceUSD < 1) {
          console.log(`[Skip] ${fullName}`);
          continue;
        }

        const prevPrice = prevMap[fullName];
        const changePct = prevPrice ? ((priceUSD - prevPrice) / prevPrice) * 100 : 0;

        inserts.push({
          skin_name:  fullName,
          usd_price:  priceUSD,
          zar_price:  Math.round(priceUSD * zarRate),
          rarity:     knife ? 'covert' : gloves ? 'extraordinary' : 'unknown',
          category:   knife ? 'knife' : gloves ? 'gloves' : 'weapon',
          change_pct: changePct,
          timestamp:  new Date(),
        });

        fetched++;
        console.log(`[${fetched}] ${fullName}: $${priceUSD} = R${Math.round(priceUSD * zarRate)}`);

        if (prevPrice && Math.abs(changePct) >= 5) {
          movers.push({
            name: fullName, priceUSD, prevPriceUSD: prevPrice, changePct,
            priority: (knife || gloves ? 100 : 0) + Math.abs(changePct) + (priceUSD / 10),
          });
        }
      }
    }
  }

  // Batch insert
  const BATCH = 500;
  for (let i = 0; i < inserts.length; i += BATCH) {
    const { error } = await supabase.from('skin_prices').insert(inserts.slice(i, i + BATCH));
    if (error) console.error('[Supabase] Insert error:', error.message);
  }
  console.log(`[Prices] Stored ${inserts.length} entries`);

  // Queue social post
  movers.sort((a, b) => b.priority - a.priority);
  if (movers.length > 0) {
    const postText = buildPostText(movers, zarRate);
    if (postText) {
      await supabase.from('social_posts').insert({ post_text: postText, status: 'queued', trigger: 'cron' });
      console.log('[Social] Post queued');
    }
  }

  await checkAndSendAlerts(zarRate);
  await fetchLeaderboard();

  console.log('[PriceFetch] Done at', new Date().toISOString());
}

main().catch(e => {
  console.error('[FATAL]', e);
  process.exit(0);
});
