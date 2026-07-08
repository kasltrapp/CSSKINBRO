// cron/market_pro_sheets.js
// KASTLR Market Pro — daily append to Google Sheets via a service account.
// This is why it builds "continuously, without fail": every run only ever
// APPENDS new rows, it never overwrites the sheet, so yesterday's data is
// always still there when you open it tomorrow.
//
// Requires npm package: googleapis
//   npm install googleapis
//
// Env vars (set on Railway, see market_pro_INTEGRATION.md for how to get them):
//   GOOGLE_SERVICE_ACCOUNT_EMAIL
//   GOOGLE_PRIVATE_KEY          (paste with \n literal escapes, see below)
//   GOOGLE_SHEET_ID             (the long id from the sheet's URL)
//
// The target Google Sheet needs 3 tabs, created once, named exactly:
//   "Turnover history"   — headers: Date | Turnover (USD) | Turnover (ZAR) | Catalogue Index (USD) | Catalogue Index (ZAR) | Items (turnover) | Items (index) | FX rate
//   "Buff163 movers log" — headers: Date | Rank | Item | Category | Qty prior day | Qty today | Price now (USD) | Price 7d ago (USD) | 7d change % | Entry risk | Exit confidence | Tracker link
//   "Summary"            — headers: Date | Headline | Turnover (USD) | Turnover change % | Top mover | Top mover risk | Budget candidates (<=$1000)
// The service account email must be given Editor access to the sheet (share it
// like you'd share with a person, paste the service account email).

import { google } from 'googleapis';

function getAuth() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const key = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (!email || !key) {
    throw new Error('Missing GOOGLE_SERVICE_ACCOUNT_EMAIL or GOOGLE_PRIVATE_KEY env vars');
  }
  return new google.auth.JWT(email, null, key, ['https://www.googleapis.com/auth/spreadsheets']);
}

async function appendRows(sheets, sheetId, tabName, rows) {
  if (!rows.length) return;
  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: `'${tabName}'!A1`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: rows },
  });
}

export async function appendDailySnapshotToSheets({ today, index, movers, budgetCandidateCount }) {
  const sheetId = process.env.GOOGLE_SHEET_ID;
  if (!sheetId) {
    console.log('[Sheets] GOOGLE_SHEET_ID not set, skipping Sheets export');
    return;
  }

  const auth = getAuth();
  const sheets = google.sheets({ version: 'v4', auth });

  // Turnover history — one row per day
  await appendRows(sheets, sheetId, 'Turnover history', [[
    today,
    index.total_turnover_usd,
    index.total_turnover_zar,
    index.catalogue_index_usd,
    index.catalogue_index_zar,
    index.item_count_turnover,
    index.item_count_index,
    index.fx_rate_used,
  ]]);

  // Buff163 movers log — one row per mover per day
  const moverRows = movers.map(m => [
    today,
    m.rank,
    m.market_hash_name,
    m.item_group || '',
    m.qty_prior_day,
    m.qty_today,
    m.price_now_usd,
    m.price_7d_ago_usd,
    m.pct_change_7d,
    m.entry_risk,
    m.exit_confidence,
    m.tracker_url,
  ]);
  await appendRows(sheets, sheetId, 'Buff163 movers log', moverRows);

  // Summary — one human-readable row per day
  const top = movers[0];
  await appendRows(sheets, sheetId, 'Summary', [[
    today,
    `Turnover $${index.total_turnover_usd.toLocaleString()} across ${index.item_count_turnover} traded items`,
    index.total_turnover_usd,
    '', // change % filled in by a sheet formula comparing to the row above, see market_pro_INTEGRATION.md
    top ? top.market_hash_name : '',
    top ? top.entry_risk : '',
    budgetCandidateCount ?? '',
  ]]);

  console.log('[Sheets] Daily snapshot appended to all 3 tabs');
}
