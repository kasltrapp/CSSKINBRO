// cron/market_pro_email.js
// KASTLR Market Pro — daily email summary via the existing Resend setup.
// Reuses RESEND_API_KEY / RESEND_FROM_EMAIL, same as checkAndSendAlerts()
// in price_fetch_v6.js. Sends to vanrenjj@icloud.com by default; override
// with MARKET_PRO_EMAIL_TO if you ever want it to go elsewhere.

import fetch from 'node-fetch';

const RESEND_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'alerts@kastlr.com';
const TO_EMAIL   = process.env.MARKET_PRO_EMAIL_TO || 'vanrenjj@icloud.com';

const RISK_COLOR = {
  'Buy Now': '#00C97A',
  'Follow the Pump': '#F5C842',
  'Medium Risk': '#FF6B00',
  'High Risk': '#FF3333',
};
const EXIT_COLOR = {
  'Great': '#00C97A',
  'Good': '#F5C842',
  'Moderate': '#FF6B00',
  'Low': '#FF3333',
  'Not enough data': '#777777',
};

function badge(text, color) {
  return `<span style="display:inline-block;font-family:'DM Mono',Consolas,monospace;font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;padding:3px 8px;border-radius:3px;background:${color}22;color:${color};white-space:nowrap">${text}</span>`;
}

function moverRowHtml(m) {
  const pctSign = m.pct_change_7d > 0 ? '+' : '';
  return `
  <tr style="border-bottom:1px solid #1E1E1E">
    <td style="padding:10px 12px;font-family:Arial,sans-serif;font-size:13px;color:#F0F0F0">
      ${m.market_hash_name}
      <div style="font-family:'DM Mono',Consolas,monospace;font-size:10px;color:#777;margin-top:3px">${m.item_group || ''} · ${m.qty_prior_day} &rarr; ${m.qty_today} sold</div>
    </td>
    <td style="padding:10px 12px;font-family:'DM Mono',Consolas,monospace;font-size:12px;color:#F0F0F0;text-align:right">$${Number(m.price_now_usd).toLocaleString()}</td>
    <td style="padding:10px 12px;font-family:'DM Mono',Consolas,monospace;font-size:12px;color:#999;text-align:right">${pctSign}${m.pct_change_7d}%</td>
    <td style="padding:10px 12px;text-align:right">${badge(m.entry_risk, RISK_COLOR[m.entry_risk] || '#999')}</td>
    <td style="padding:10px 12px;text-align:right">${badge(m.exit_confidence, EXIT_COLOR[m.exit_confidence] || '#999')}</td>
    <td style="padding:10px 12px;text-align:right"><a href="${m.tracker_url}" style="color:#FF6B00;font-family:'DM Mono',Consolas,monospace;font-size:10px;text-decoration:none">chart &#8599;</a></td>
  </tr>`;
}

export function buildDailyEmailHtml({ today, index, movers, budgetCandidateCount, budget = 1000, prevTurnoverUsd }) {
  const pctVsYesterday = prevTurnoverUsd
    ? (((index.total_turnover_usd - prevTurnoverUsd) / prevTurnoverUsd) * 100).toFixed(1)
    : null;
  const changeLine = pctVsYesterday !== null
    ? `${pctVsYesterday > 0 ? '+' : ''}${pctVsYesterday}% vs yesterday`
    : 'first snapshot — no prior day to compare yet';

  return `
  <div style="background:#080808;padding:24px;font-family:Arial,sans-serif">
    <div style="max-width:640px;margin:0 auto;background:#111;border:1px solid #1E1E1E;border-radius:8px;overflow:hidden">

      <div style="padding:20px 24px;border-bottom:1px solid #1E1E1E">
        <span style="font-family:Georgia,serif;font-size:20px;letter-spacing:2px;color:#FF6B00;font-weight:bold">KASTLR</span>
        <span style="font-family:'DM Mono',Consolas,monospace;font-size:10px;color:#777;letter-spacing:1px;margin-left:10px">MARKET PRO &middot; ${today}</span>
      </div>

      <div style="padding:20px 24px">
        <div style="font-family:'DM Mono',Consolas,monospace;font-size:10px;letter-spacing:2px;color:#777;margin-bottom:6px">TOTAL DAILY TURNOVER</div>
        <div style="font-size:30px;color:#F0F0F0;font-weight:bold">$${index.total_turnover_usd.toLocaleString()}</div>
        <div style="font-family:'DM Mono',Consolas,monospace;font-size:12px;color:#00C97A;margin-top:4px">${changeLine}</div>
        <div style="font-family:'DM Mono',Consolas,monospace;font-size:10px;color:#777;margin-top:10px">
          Reference — liquidity-filtered catalogue index: $${index.catalogue_index_usd.toLocaleString()} across ${index.item_count_index} items
        </div>
      </div>

      <div style="padding:0 24px 20px 24px">
        <div style="font-family:'DM Mono',Consolas,monospace;font-size:10px;letter-spacing:2px;color:#777;margin-bottom:10px">BUFF163 TOP 5 &middot; PRIOR DAY + TODAY</div>
        <table style="width:100%;border-collapse:collapse">
          <tbody>${movers.slice(0, 5).map(moverRowHtml).join('')}</tbody>
        </table>
      </div>

      <div style="padding:0 24px 20px 24px">
        <div style="font-family:'DM Mono',Consolas,monospace;font-size:10px;letter-spacing:2px;color:#777;margin-bottom:6px">BUDGET FILTER</div>
        <div style="font-family:'DM Mono',Consolas,monospace;font-size:12px;color:#00C97A">${budgetCandidateCount} candidates fit a $${budget.toLocaleString()} budget today</div>
        <div style="margin-top:10px">
          <a href="https://kastlr.com/market-pro/market-pro.html" style="display:inline-block;background:#FF6B00;color:#000;font-family:'DM Mono',Consolas,monospace;font-size:11px;font-weight:bold;letter-spacing:1px;text-decoration:none;padding:10px 18px;border-radius:4px">OPEN MARKET PRO &rarr;</a>
        </div>
      </div>

      <div style="padding:16px 24px;border-top:1px solid #1E1E1E;font-family:'DM Mono',Consolas,monospace;font-size:9px;color:#555">
        KASTLR Market Pro &middot; Not financial advice &middot; kastlr.com
      </div>
    </div>
  </div>`;
}

export async function sendDailyMarketProEmail(payload) {
  if (!RESEND_KEY) {
    console.log('[Email] RESEND_API_KEY not set, skipping daily email');
    return;
  }
  const html = buildDailyEmailHtml(payload);
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: TO_EMAIL,
        subject: `KASTLR Market Pro — ${payload.today} — $${payload.index.total_turnover_usd.toLocaleString()} turnover`,
        html,
      }),
    });
    if (!res.ok) throw new Error(`Resend API ${res.status}`);
    console.log(`[Email] Daily Market Pro summary sent to ${TO_EMAIL}`);
  } catch (e) {
    console.error('[Email] Failed to send daily summary:', e.message);
  }
}
