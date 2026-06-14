/* ============================================================
   KASTLR Weekly Digest Sender
   Schedule: Monday 06:00 UTC (08:00 SAST)
   Add to server.js:
     const { scheduleWeeklyDigest } = require('./weekly_digest.js');
     scheduleWeeklyDigest();
   ============================================================ */

const { createClient } = require('@supabase/supabase-js');

const SB_URL  = process.env.SUPABASE_URL;
const SB_KEY  = process.env.SUPABASE_SERVICE_KEY;
const RESEND  = process.env.RESEND_API_KEY;
const SITE    = 'https://kastlr.com';
const FROM    = 'noreply@kastlr.com';

function getWeekNumber(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

function zarFmt(n) { return 'R' + Math.round(n).toLocaleString('en-ZA'); }
function pctFmt(n) { return (n > 0 ? '+' : '') + Number(n).toFixed(1) + '%'; }

/* ── FETCH MARKET DATA ─────────────────────────────────────── */
async function fetchDigestData(db) {
  const WEAPON_GROUPS = ['rifle','sniper rifle','pistol','smg','shotgun','machinegun','knife','gloves'];

  const [gainRes, loseRes, tradedRes, dipRes, fxRes] = await Promise.all([
    // Top 5 gainers
    db.from('cs2_prices')
      .select('market_hash_name,item_group,zar_real,change_pct_real,image_url')
      .in('item_group', WEAPON_GROUPS)
      .eq('is_souvenir', false)
      .gt('change_pct_real', 0.5)
      .lte('change_pct_real', 200)
      .gte('zar_real', 50)
      .gte('sold_7d', 10)
      .not('change_pct_real', 'is', null)
      .order('change_pct_real', { ascending: false })
      .limit(5),

    // Top 5 losers
    db.from('cs2_prices')
      .select('market_hash_name,item_group,zar_real,change_pct_real,image_url')
      .in('item_group', WEAPON_GROUPS)
      .eq('is_souvenir', false)
      .lt('change_pct_real', -0.5)
      .gte('change_pct_real', -80)
      .gte('zar_real', 50)
      .gte('sold_7d', 10)
      .not('change_pct_real', 'is', null)
      .order('change_pct_real', { ascending: true })
      .limit(5),

    // Most traded
    db.from('cs2_prices')
      .select('market_hash_name,item_group,zar_real,sold_7d')
      .in('item_group', [...WEAPON_GROUPS, 'container'])
      .eq('is_souvenir', false)
      .gte('sold_7d', 10)
      .gt('zar_real', 0)
      .order('sold_7d', { ascending: false })
      .limit(1),

    // Buy low watch — biggest dip
    db.from('cs2_prices')
      .select('market_hash_name,item_group,zar_real,change_pct_real')
      .in('item_group', WEAPON_GROUPS)
      .eq('is_souvenir', false)
      .lt('change_pct_real', -20)
      .gte('change_pct_real', -80)
      .gte('zar_real', 200)
      .gte('sold_7d', 5)
      .not('change_pct_real', 'is', null)
      .order('change_pct_real', { ascending: true })
      .limit(1),

    // FX rate
    db.from('fx_rates')
      .select('rate,timestamp')
      .order('timestamp', { ascending: false })
      .limit(1),
  ]);

  return {
    gainers: gainRes.data || [],
    losers:  loseRes.data || [],
    traded:  tradedRes.data?.[0] || null,
    dip:     dipRes.data?.[0] || null,
    rate:    fxRes.data?.[0]?.rate || null,
  };
}

/* ── FORMAT SKIN NAME ──────────────────────────────────────── */
function formatName(hash) {
  return (hash || '')
    .replace(/StatTrak™\s*/g, 'ST™ ')
    .replace(/\s*\([^)]+\)/g, '')
    .trim();
}

/* ── BUILD EMAIL HTML ──────────────────────────────────────── */
function buildEmailHtml({ gainers, losers, traded, dip, rate, week, year, unsubUrl }) {
  const weekLabel = `WEEK ${week}, ${year}`;

  function moverRow(item, dir) {
    const name    = formatName(item.market_hash_name);
    const pct     = Number(item.change_pct_real);
    const colour  = dir === 'up' ? '#00C97A' : '#FF3333';
    const arrow   = dir === 'up' ? '↑' : '↓';
    const link    = `${SITE}/prices/?search=${encodeURIComponent(item.market_hash_name)}`;
    return `
    <tr>
      <td style="padding:12px 16px;border-bottom:1px solid #1A1A1A">
        <a href="${link}" style="text-decoration:none">
          <span style="font-family:'Courier New',monospace;font-size:12px;color:#F0F0F0;display:block">${name}</span>
          <span style="font-family:'Courier New',monospace;font-size:10px;color:#555555;text-transform:uppercase;letter-spacing:1px">${item.item_group || ''}</span>
        </a>
      </td>
      <td style="padding:12px 16px;border-bottom:1px solid #1A1A1A;text-align:right;white-space:nowrap">
        <span style="font-family:Arial,sans-serif;font-size:18px;font-weight:900;color:#FF6B00">${zarFmt(item.zar_real)}</span>
      </td>
      <td style="padding:12px 16px;border-bottom:1px solid #1A1A1A;text-align:right;white-space:nowrap">
        <span style="font-family:'Courier New',monospace;font-size:13px;font-weight:700;color:${colour}">${arrow} ${Math.abs(pct).toFixed(1)}%</span>
      </td>
    </tr>`;
  }

  const gainRows = gainers.map(i => moverRow(i, 'up')).join('');
  const loseRows = losers.map(i => moverRow(i, 'dn')).join('');

  const tradedBlock = traded ? `
  <tr><td colspan="3" style="padding:24px 16px 8px">
    <p style="font-family:'Courier New',monospace;font-size:9px;letter-spacing:3px;color:#FF6B00;text-transform:uppercase;margin:0 0 12px">Most Traded This Week</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#1A1A1A;border:1px solid #242424">
      <tr>
        <td style="padding:14px 16px">
          <span style="font-family:'Courier New',monospace;font-size:13px;color:#F0F0F0;display:block">${formatName(traded.market_hash_name)}</span>
          <span style="font-family:'Courier New',monospace;font-size:10px;color:#555555;text-transform:uppercase;letter-spacing:1px">${traded.item_group || ''} · ${(traded.sold_7d || 0).toLocaleString('en-ZA')} sold this week</span>
        </td>
        <td style="padding:14px 16px;text-align:right">
          <span style="font-family:Arial,sans-serif;font-size:20px;font-weight:900;color:#FF6B00">${zarFmt(traded.zar_real)}</span>
        </td>
      </tr>
    </table>
  </td></tr>` : '';

  const dipBlock = dip ? `
  <tr><td colspan="3" style="padding:24px 16px 8px">
    <p style="font-family:'Courier New',monospace;font-size:9px;letter-spacing:3px;color:#FF6B00;text-transform:uppercase;margin:0 0 12px">Buy Low Watch</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#1A1A1A;border:1px solid #242424;border-top:2px solid #FF3333">
      <tr>
        <td style="padding:14px 16px">
          <span style="font-family:'Courier New',monospace;font-size:13px;color:#F0F0F0;display:block">${formatName(dip.market_hash_name)}</span>
          <span style="font-family:'Courier New',monospace;font-size:10px;color:#FF3333;letter-spacing:1px">DOWN ${Math.abs(Number(dip.change_pct_real)).toFixed(1)}% — Not financial advice</span>
        </td>
        <td style="padding:14px 16px;text-align:right;vertical-align:middle">
          <span style="font-family:Arial,sans-serif;font-size:20px;font-weight:900;color:#FF6B00;display:block">${zarFmt(dip.zar_real)}</span>
          <a href="https://tradeit.gg/csgo/store?aff=kastlrcsgo&search=${encodeURIComponent(dip.market_hash_name)}" style="font-family:'Courier New',monospace;font-size:9px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#000;background:#FF6B00;padding:6px 12px;text-decoration:none;display:inline-block;margin-top:6px">BUY ↗</a>
        </td>
      </tr>
    </table>
  </td></tr>` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>KASTLR Weekly — ${weekLabel}</title>
</head>
<body style="margin:0;padding:0;background:#0A0A0A;font-family:Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0A0A0A;padding:40px 20px">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%">

  <!-- Logo -->
  <tr><td style="padding-bottom:24px;text-align:center">
    <a href="${SITE}" style="text-decoration:none">
      <span style="font-family:Arial,sans-serif;font-size:28px;font-weight:900;letter-spacing:4px;color:#FF6B00">KASTLR</span>
    </a>
  </td></tr>

  <!-- Orange line -->
  <tr><td style="height:2px;background:linear-gradient(90deg,transparent,#FF6B00,transparent)"></td></tr>

  <!-- Header -->
  <tr><td style="background:#141414;border:1px solid #242424;border-top:none;padding:28px 24px">
    <p style="font-family:'Courier New',monospace;font-size:9px;letter-spacing:4px;color:#FF6B00;text-transform:uppercase;margin:0 0 8px">KASTLR WEEKLY</p>
    <h1 style="font-family:Arial,sans-serif;font-size:26px;font-weight:900;color:#F0F0F0;margin:0 0 8px;letter-spacing:1px">${weekLabel}</h1>
    <p style="font-family:'Courier New',monospace;font-size:11px;color:#555555;margin:0">
      CS2 skin market digest in ZAR · South Africa
      ${rate ? ` · USD/ZAR R${Number(rate).toFixed(2)}` : ''}
    </p>
  </td></tr>

  <!-- Gainers -->
  <tr><td style="background:#141414;border:1px solid #242424;border-top:none;padding:0">
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr><td colspan="3" style="padding:20px 16px 4px">
        <p style="font-family:'Courier New',monospace;font-size:9px;letter-spacing:3px;color:#00C97A;text-transform:uppercase;margin:0">↑ Top Gainers (24hr)</p>
      </td></tr>
      ${gainRows}
      <!-- Losers header -->
      <tr><td colspan="3" style="padding:20px 16px 4px;border-top:1px solid #242424">
        <p style="font-family:'Courier New',monospace;font-size:9px;letter-spacing:3px;color:#FF3333;text-transform:uppercase;margin:0">↓ Top Losers (24hr)</p>
      </td></tr>
      ${loseRows}
      ${tradedBlock}
      ${dipBlock}
    </table>
  </td></tr>

  <!-- CTA -->
  <tr><td style="background:#141414;border:1px solid #242424;border-top:none;padding:28px 24px;text-align:center">
    <p style="font-family:'Courier New',monospace;font-size:11px;color:#555555;margin:0 0 20px">Full market breakdown, category trends and more:</p>
    <a href="${SITE}/market/" style="display:inline-block;background:#FF6B00;color:#000;font-family:'Courier New',monospace;font-size:11px;font-weight:700;letter-spacing:3px;text-transform:uppercase;padding:14px 36px;text-decoration:none;border-radius:2px">
      VIEW FULL DIGEST ↗
    </a>
  </td></tr>

  <!-- Footer -->
  <tr><td style="padding:24px 0;text-align:center">
    <p style="font-family:'Courier New',monospace;font-size:10px;color:#333333;letter-spacing:1px;margin:0 0 8px">
      KASTLR &mdash; South Africa's CS2 Hub &mdash; Not affiliated with Valve Corporation
    </p>
    <p style="font-family:'Courier New',monospace;font-size:10px;color:#333333;margin:0">
      <a href="${SITE}" style="color:#555555;text-decoration:none">kastlr.com</a>
      &nbsp;·&nbsp;
      <a href="${unsubUrl}" style="color:#555555;text-decoration:none">Unsubscribe</a>
    </p>
    <p style="font-family:'Courier New',monospace;font-size:9px;color:#242424;margin:8px 0 0">
      Prices are updated daily. This is not financial advice. CS2 skins are digital items in a video game.
    </p>
  </td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}

/* ── SEND TO ALL CONFIRMED SUBSCRIBERS ─────────────────────── */
async function sendWeeklyDigest() {
  console.log('[KASTLR Weekly] Starting digest send...');
  const db = createClient(SB_URL, SB_KEY);

  try {
    // Fetch market data
    const data = await fetchDigestData(db);
    console.log(`[KASTLR Weekly] Data fetched — ${data.gainers.length} gainers, ${data.losers.length} losers`);

    // Fetch confirmed subscribers
    const { data: subscribers, error } = await db
      .from('newsletter_subscribers')
      .select('email, unsubscribe_token')
      .eq('confirmed', true)
      .eq('unsubscribed', false);

    if (error) throw error;
    if (!subscribers?.length) {
      console.log('[KASTLR Weekly] No confirmed subscribers. Skipping.');
      return;
    }

    console.log(`[KASTLR Weekly] Sending to ${subscribers.length} subscribers...`);

    const now  = new Date();
    const week = getWeekNumber(now);
    const year = now.getFullYear();
    const subject = `KASTLR WEEKLY — Week ${week}, ${year}`;

    let sent = 0, failed = 0;

    // Send individually so each has a unique unsubscribe link
    for (const sub of subscribers) {
      const unsubUrl = `https://newsletter.kastlrapp.workers.dev/newsletter/unsubscribe?token=${sub.unsubscribe_token}`;
      const html = buildEmailHtml({ ...data, week, year, unsubUrl });

      try {
        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${RESEND}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: FROM,
            to: sub.email,
            subject,
            html,
          }),
        });

        if (res.ok) {
          sent++;
        } else {
          const err = await res.text();
          console.error(`[KASTLR Weekly] Failed ${sub.email}: ${err}`);
          failed++;
        }

        // Rate limit — Resend allows 2 req/sec on free tier
        await new Promise(r => setTimeout(r, 550));

      } catch (e) {
        console.error(`[KASTLR Weekly] Error sending to ${sub.email}:`, e.message);
        failed++;
      }
    }

    console.log(`[KASTLR Weekly] Done. Sent: ${sent}, Failed: ${failed}`);

  } catch (e) {
    console.error('[KASTLR Weekly] Fatal error:', e);
  }
}

/* ── SCHEDULER ─────────────────────────────────────────────── */
function scheduleWeeklyDigest() {
  function msUntilNextMonday0600UTC() {
    const now = new Date();
    const next = new Date(now);
    // Find next Monday
    const day = now.getUTCDay(); // 0=Sun, 1=Mon...
    const daysUntilMonday = day === 1 ? 7 : (8 - day) % 7;
    next.setUTCDate(now.getUTCDate() + daysUntilMonday);
    next.setUTCHours(6, 0, 0, 0); // 06:00 UTC = 08:00 SAST
    // If it's Monday and before 06:00 UTC, send today
    if (day === 1 && now.getUTCHours() < 6) {
      next.setUTCDate(now.getUTCDate());
    }
    return next.getTime() - now.getTime();
  }

  function scheduleNext() {
    const ms = msUntilNextMonday0600UTC();
    const hours = Math.round(ms / 1000 / 60 / 60);
    console.log(`[KASTLR Weekly] Next digest in ~${hours} hours`);
    setTimeout(async () => {
      await sendWeeklyDigest();
      scheduleNext(); // reschedule after firing
    }, ms);
  }

  scheduleNext();
}

module.exports = { scheduleWeeklyDigest, sendWeeklyDigest };
