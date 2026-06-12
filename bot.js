/* ============================================================
   KASTLR Discord Bot — bot.js
   Version 1.1 — June 2026
   Commands: !price <skin name>
   Allowed channels: deal-check, general
   ============================================================ */

import https from 'https';
import { WebSocket } from 'ws';
import fetch from 'node-fetch';

const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const SB_URL    = 'https://ikzlzrkuxndxzzfhwurb.supabase.co';
const SB_ANON   = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlremx6cmt1eG5keHp6Zmh3dXJiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA2MDQyMDksImV4cCI6MjA5NjE4MDIwOX0.7XLB-H4WwNjvQq5QjBg8Ab2kma1DG20vMtWPOhb-1nk';

const ALLOWED_CHANNELS = ['deal-check', 'general'];
const DISCORD_API = 'https://discord.com/api/v10';

/* ── Discord API requests via https ── */
function request(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const url = new URL(DISCORD_API + path);
    const opts = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method,
      headers: {
        'Authorization': `Bot ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'KASTLR Bot (kastlr.com, 1.0)'
      }
    };
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { resolve(data); } });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

/* ── Supabase query via node-fetch ── */
async function lookupPrice(query) {
  const q = query.replace(/ /g, '%20');
  const url = `${SB_URL}/rest/v1/cs2_prices?market_hash_name=ilike.*${q}*&zar_real=gt.0&order=sold_7d.desc.nullslast&limit=5&select=market_hash_name,item_group,wear,is_stattrak,is_souvenir,zar_real,zar_steam,change_pct_real,sold_7d`;
  console.log('[Bot] Querying:', url);
  const res = await fetch(url, {
    headers: {
      'apikey': SB_ANON,
      'Authorization': 'Bearer ' + SB_ANON
    }
  });
  const data = await res.json();
  console.log('[Bot] Results:', JSON.stringify(data).substring(0, 200));
  return Array.isArray(data) ? data : [];
}

/* ── Format ZAR ── */
function zar(n) { return n ? 'R' + Math.round(n).toLocaleString('en-ZA') : '—'; }

/* ── Build Discord embed ── */
function buildEmbed(results, query) {
  const WEAR = { fn:'FN', mw:'MW', ft:'FT', ww:'WW', bs:'BS' };
  if (!results.length) {
    return { embeds: [{ color: 0xFF3333, title: '❌ No Results', description: `No CS2 skin found matching **${query}**\n\nTry: \`!price AK-47 | Redline\``, footer: { text: 'KASTLR · kastlr.com' } }] };
  }
  const fields = results.map(item => {
    const type = item.is_stattrak ? '🟡 ST™' : item.is_souvenir ? '🔵 SV' : '⚪ Normal';
    const wear = item.wear ? ` · ${WEAR[item.wear]||item.wear}` : '';
    const pct = Number(item.change_pct_real||0);
    const pctStr = Math.abs(pct) > 0.5 ? ` · ${pct>0?'↑':'↓'}${Math.abs(pct).toFixed(1)}%` : '';
    const vol = item.sold_7d ? ` · ${item.sold_7d} sold/7d` : '';
    return {
      name: item.market_hash_name.replace(/\([^)]+\)/,'').trim(),
      value: `${type}${wear}\n**${zar(item.zar_real)}** Consolidated market${item.zar_steam ? ` · Steam ${zar(item.zar_steam)}` : ''}${pctStr}${vol}`,
      inline: false
    };
  });
  return { embeds: [{ color: 0xFF6B00, title: `🔍 Price Results for "${query}"`, fields, footer: { text: 'KASTLR · Real market prices in ZAR · kastlr.com' }, timestamp: new Date().toISOString() }] };
}

/* ── Gateway ── */
let ws, heartbeatInterval, sessionId, sequence = null, resumeUrl = null;

function connect() {
  ws = new WebSocket('wss://gateway.discord.gg/?v=10&encoding=json');
  ws.on('open', () => console.log('[Bot] Connected to Discord Gateway'));
  ws.on('message', async raw => {
    const { op, d, t, s } = JSON.parse(raw);
    if (s) sequence = s;
    if (op === 10) {
      heartbeatInterval = setInterval(() => ws.send(JSON.stringify({ op: 1, d: sequence })), d.heartbeat_interval);
      ws.send(JSON.stringify({ op: 2, d: { token: BOT_TOKEN, intents: 33280, properties: { os: 'linux', browser: 'kastlr-bot', device: 'kastlr-bot' } } }));
    }
    if (op === 7) reconnect();
    if (op === 9) setTimeout(() => connect(), 5000);
    if (op === 0) {
      if (t === 'READY') { sessionId = d.session_id; resumeUrl = d.resume_gateway_url; console.log(`[Bot] Logged in as ${d.user.username}`); }
      if (t === 'MESSAGE_CREATE') await handleMessage(d);
    }
  });
  ws.on('close', code => { console.log(`[Bot] Disconnected (${code}) — reconnecting...`); clearInterval(heartbeatInterval); setTimeout(() => reconnect(), 5000); });
  ws.on('error', err => console.error('[Bot] WebSocket error:', err.message));
}

function reconnect() {
  clearInterval(heartbeatInterval);
  try { ws?.terminate(); } catch(e) {}
  if (sessionId && resumeUrl) {
    ws = new WebSocket(resumeUrl + '?v=10&encoding=json');
    ws.on('open', () => ws.send(JSON.stringify({ op: 6, d: { token: BOT_TOKEN, session_id: sessionId, seq: sequence } })));
  } else { connect(); }
}

/* ── Message handler ── */
async function handleMessage(msg) {
  if (msg.author?.bot) return;
  const content = (msg.content || '').trim();
  if (!content.toLowerCase().startsWith('!price')) return;
  try {
    const channel = await request('GET', `/channels/${msg.channel_id}`, null, BOT_TOKEN);
    const name = (channel.name || '').toLowerCase();
    console.log('[Bot] Channel name:', name);
    if (!ALLOWED_CHANNELS.some(c => name.includes(c))) return;
  } catch(e) { console.error('[Bot] Channel check error:', e.message); return; }
  const query = content.slice(6).trim();
  if (!query) {
    await request('POST', `/channels/${msg.channel_id}/messages`, { content: '**Usage:** `!price <skin name>`\nExample: `!price AK-47 | Redline`' }, BOT_TOKEN);
    return;
  }
  await request('POST', `/channels/${msg.channel_id}/typing`, {}, BOT_TOKEN);
  try {
    const results = await lookupPrice(query);
    await request('POST', `/channels/${msg.channel_id}/messages`, buildEmbed(results, query), BOT_TOKEN);
  } catch(e) {
    console.error('[Bot] Error:', e.message);
    await request('POST', `/channels/${msg.channel_id}/messages`, { content: '⚠️ Something went wrong. Try again.' }, BOT_TOKEN);
  }
}

/* ── Start ── */
if (!BOT_TOKEN) {
  console.error('[Bot] DISCORD_BOT_TOKEN not set — bot will not start');
} else {
  connect();
}
