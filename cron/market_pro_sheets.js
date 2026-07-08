// cron/market_pro_sheets.js
// KASTLR Market Pro - daily append to Google Sheets via a service account.
// Every run only ever APPENDS new rows, it never overwrites the sheet, so
// yesterday's data is always still there when you open it tomorrow.
//
// Requires npm package: googleapis
//
// Env vars (set on Railway):
//   GOOGLE_SERVICE_ACCOUNT_EMAIL
//   GOOGLE_PRIVATE_KEY          (paste with \n literal escapes; surrounding
//                                quotes, if pasted by accident, are stripped
//                                automatically below)
//   GOOGLE_SHEET_ID             (the long id from the sheet's URL)
//
// The target Google Sheet needs 3 tabs, created once, named exactly:
//   "Turnover history"   - Date | Turnover (USD) | Turnover (ZAR) | Catalogue Index (USD) | Catalogue Index (ZAR) | Items (turnover) | Items (index) | FX rate
//   "Buff163 movers log" - Date | Rank | Item | Category | Qty prior day | Qty today | Price now (USD) | Price 7d ago (USD) | 7d change % | Entry risk | Exit confidence | Tracker link
//   "Summary"            - Date | Headline | Turnover (USD) | Turnover change % | Top mover | Top mover risk | Budget candidates (<=$1000)
// The service account email must be given Editor access to the sheet.

import { google } from 'googleapis';

function getAuth() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  let key = process.env.GOOGLE_PRIVATE_KEY || '';

  if (key.startsWith('"') && key.endsWith('"')) {
    key = key.slice(1, -1);
  }
  key = key.replace(/\\n/g, '\n');

  if (!email || !key) {
    throw new Error('Missing GOOGLE_SERVICE_ACCOUNT_EMAIL or GOOGLE_PRIVATE_KEY env vars');
  }

  return new google.auth.JWT({
    email: email,
    key: key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

async function appendRows(sheets, sheetId, tabName, rows) {
  if (!rows.length) return;
  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: "'" + tabName + "'!A1",
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: rows },
  });
}

export async function appendDailySnapshotToSheets(args) {
  const today = args.today;
  const index = args.index;
  const movers = args.movers;
  const budgetCandidateCount = args.budgetCandidateCount;

  const sheetId = process.env.GOOGLE_SHEET_ID;
  if (!sheetId) {
    console.log('[Sheets] GOOGLE_SHEET_ID not set, skipping Sheets export');
    return;
  }

  const auth = getAuth();
  try {
    await auth.authorize();
  } catch (e) {
    console.error('[Sheets] Auth failed - check GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_PRIVATE_KEY and that the sheet is shared with that email as Editor:', e.message);
    throw e;
  }

  const sheets = google.sheets({ version: 'v4', auth: auth });

  const turnoverRow = [
    today,
    index.total_turnover_usd,
    index.total_turnover_zar,
    index.catalogue_index_usd,
    index.catalogue_index_zar,
    index.item_count_turnover,
    index.item_count_index,
    index.fx_rate_used,
  ];
  await appendRows(sheets, sheetId, 'Turnover history', [turnoverRow]);

  const moverRows = [];
  for (let i = 0; i < movers.length; i++) {
    const m = movers[i];
    moverRows.push([
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
  }
  await appendRows(sheets, sheetId, 'Buff163 movers log', moverRows);

  const top = movers.length ? movers[0] : null;
  const turnoverLabel = 'Turnover $' + index.total_turnover_usd.toLocaleString() + ' across ' + index.item_count_turnover + ' traded items';
  const summaryRow = [
    today,
    turnoverLabel,
    index.total_turnover_usd,
    '',
    top ? top.market_hash_name : '',
    top ? top.entry_risk : '',
    budgetCandidateCount == null ? '' : budgetCandidateCount,
  ];
  await appendRows(sheets, sheetId, 'Summary', [summaryRow]);

  console.log('[Sheets] Daily snapshot appended to all 3 tabs');
}
