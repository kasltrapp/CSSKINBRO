/* ============================================================
   KASTLR Discord Bot — bot.js
   Version 1.0 — June 2026
   Commands: !price <skin name>
   Allowed channels: deal-check, general
   ============================================================ */

const https = require('https');

const BOT_TOKEN   = process.env.DISCORD_BOT_TOKEN;
const SB_URL      = 'https://ikzlzrkuxndxzzfhwurb.supabase.co';
const SB_ANON     = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlremx6cmt1eG5keHp6Zmh3dXJiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA2MDQyMDksImV4cCI6MjA5NjE4MDIwOX0.7XLB-H4WwNjvQq5QjBg8Ab2kma1DG20vMtWPOhb-1nk';

// Channels where !price command is allowed (partial name match)
const ALLOWED_CHANNELS = ['deal-check', 'general'];

const DISCORD_API = 'https://discord.com/api/v10';

/* ── HTTP helper ── */
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
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch(e) { resolve(data); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

/* ── Supabase query ── */
function sbFetch(path) {
  return new Promise((resolve, reject) => {
    const url = new URL(SB_URL + path);
    const opts = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'GET',
      headers: {
        'apikey': SB_ANON,
        'Authorization': 'Bearer ' + SB_ANON
      }
    };
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch(e) { resolve([]); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

/* ── Format ZAR ── */
function zar(n) {
  return n ? 'R' + Math.round(n).toLocaleString('en-ZA') : '—';
}

/* ── Price lookup ── */
async function lookupPrice(query) {
  const encoded = encodeURIComponent(`%${query}%`);
  const path = `/rest/v1/cs2_prices?market_hash_name=ilike.${encoded}&zar_real=gt.0&order=sold_7d.desc.nullslast&limit=5&select=market_hash_name,item_group,wear,is_stattrak,is_souvenir,zar_real,zar_steam,change_pct_real,sold_7d`;
  const data = await sbFetch(path);
  return Array.isArray(data) ? data : [];
}

/* ── Build Discord embed ── */
function buildEmbed(results, query) {
  if (!results.length) {
    return {
      embeds: [{
        color: 0xFF3333,
        title: '❌ No Results',
        description: `No CS2 skin found matching **${query}**\n\nTry a more specific search e.g. \`!price AK-47 Redline FT\``,
        footer: { text: 'KASTLR · kastlr.com' }
      }]
    };
  }

  const WEAR = { fn:'FN', mw:'MW', ft:'FT', ww:'WW', bs:'BS' };

  const fields = results.map(item => {
    const name = item.market_hash_name;
    const type = item.is_stattrak ? '🟡 ST™' : item.is_souvenir ? '🔵 SV' : '⚪ Normal';
    const wear = item.wear ? ` · ${WEAR[item.wear]||item.wear}` : '';
    const pct = Number(item.change_pct_real||0);
    const pctStr = Math.abs(pct) > 0.5 ? ` · ${pct>0?'↑':'↓'}${Math.abs(pct).toFixed(1)}%` : '';
    const vol = item.sold_7d ? ` · ${item.sold_7d} sold/7d` : '';
    return {
      name: name.replace(/\([^)]+\)/,'').trim(),
      value: `${type}${wear}\n**${zar(item.zar_real)}** real market${item.zar_steam ? ` · Steam ${zar(item.zar_steam)}` : ''}${pctStr}${vol}`,
      inline: false
    };
  });

  return {
    embeds: [{
      color: 0xFF6B00,
      title: `🔍 Price Results for "${query}"`,
      fields,
      footer: { text: 'KASTLR · Real market prices in ZAR · kastlr.com' },
      timestamp: new Date().toISOString()
    }]
  };
}

/* ── Gateway WebSocket ── */
const { WebSocket } = require('ws') || (() => {
  try { return require('ws'); } catch(e) { return null; }
})();

let ws;
let heartbeatInterval;
let sessionId;
let sequence = null;
let resumeUrl = null;

function connect() {
  ws = new WebSocket('wss://gateway.discord.gg/?v=10&encoding=json');

  ws.on('open', () => console.log('[Bot] Connected to Discord Gateway'));

  ws.on('message', async raw => {
    const payload = JSON.parse(raw);
    const { op, d, t, s } = payload;
    if (s) sequence = s;

    // Opcode 10 — Hello
    if (op === 10) {
      heartbeatInterval = setInterval(() => {
        ws.send(JSON.stringify({ op: 1, d: sequence }));
      }, d.heartbeat_interval);

      // Identify
      ws.send(JSON.stringify({
        op: 2,
        d: {
          token: BOT_TOKEN,
          intents: 33280, // GUILDS + GUILD_MESSAGES + MESSAGE_CONTENT
          properties: { os: 'linux', browser: 'kastlr-bot', device: 'kastlr-bot' }
        }
      }));
    }

    // Opcode 7 — Reconnect
    if (op === 7) reconnect();

    // Opcode 9 — Invalid session
    if (op === 9) {
      setTimeout(() => connect(), 5000);
    }

    // Opcode 0 — Dispatch
    if (op === 0) {
      if (t === 'READY') {
        sessionId = d.session_id;
        resumeUrl = d.resume_gateway_url;
        console.log(`[Bot] Logged in as ${d.user.username}`);
      }

      if (t === 'MESSAGE_CREATE') {
        await handleMessage(d);
      }
    }
  });

  ws.on('close', (code) => {
    console.log(`[Bot] Disconnected (${code}) — reconnecting...`);
    clearInterval(heartbeatInterval);
    setTimeout(() => reconnect(), 5000);
  });

  ws.on('error', err => {
    console.error('[Bot] WebSocket error:', err.message);
  });
}

function reconnect() {
  clearInterval(heartbeatInterval);
  if (ws) { try { ws.terminate(); } catch(e) {} }
  if (sessionId && resumeUrl) {
    ws = new WebSocket(resumeUrl + '?v=10&encoding=json');
    ws.on('open', () => {
      ws.send(JSON.stringify({
        op: 6,
        d: { token: BOT_TOKEN, session_id: sessionId, seq: sequence }
      }));
    });
  } else {
    connect();
  }
}

/* ── Message handler ── */
async function handleMessage(msg) {
  // Ignore bots
  if (msg.author?.bot) return;

  // Check allowed channels
  const channelName = msg.channel_name || '';
  const allowed = ALLOWED_CHANNELS.some(c => (msg.channel_id && true)); // fallback — always process, filter below

  const content = (msg.content || '').trim();
  if (!content.toLowerCase().startsWith('!price')) return;

  // Get channel info to check name
  try {
    const channel = await request('GET', `/channels/${msg.channel_id}`, null, BOT_TOKEN);
    const name = (channel.name || '').toLowerCase();
    if (!ALLOWED_CHANNELS.some(c => name.includes(c))) return;
  } catch(e) {
    return;
  }

  const query = content.slice(6).trim();
  if (!query) {
    await request('POST', `/channels/${msg.channel_id}/messages`, {
      content: '**Usage:** `!price <skin name>`\nExample: `!price AK-47 Redline FT`'
    }, BOT_TOKEN);
    return;
  }

  // Typing indicator
  await request('POST', `/channels/${msg.channel_id}/typing`, {}, BOT_TOKEN);

  try {
    const results = await lookupPrice(query);
    const embed = buildEmbed(results, query);
    await request('POST', `/channels/${msg.channel_id}/messages`, embed, BOT_TOKEN);
  } catch(e) {
    console.error('[Bot] Error handling !price:', e.message);
    await request('POST', `/channels/${msg.channel_id}/messages`, {
      content: '⚠️ Something went wrong. Try again in a moment.'
    }, BOT_TOKEN);
  }
}

/* ── Start ── */
if (!BOT_TOKEN) {
  console.error('[Bot] DISCORD_BOT_TOKEN not set — bot will not start');
} else {
  // Install ws if needed
  try {
    require('ws');
    connect();
  } catch(e) {
    console.error('[Bot] Missing "ws" package — run: npm install ws');
  }
}

module.exports = { connect };
