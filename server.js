// server.js
// KASTLR Railway Server
// Runs Express for inventory proxy + schedules daily cron via child_process

import express from 'express';
import fetch from 'node-fetch';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const INVENTORY_SECRET = process.env.INVENTORY_SECRET;

// ── Inventory Proxy Endpoint ──────────────────────────────────────
app.get('/inventory/:steamId', async (req, res) => {
  const secret = req.headers['x-kastlr-secret'];
  if (!INVENTORY_SECRET || secret !== INVENTORY_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { steamId } = req.params;
  if (!/^\d{17}$/.test(steamId)) {
    return res.status(400).json({ error: 'Invalid SteamID' });
  }

  try {
    const steamUrl = `https://steamcommunity.com/inventory/${steamId}/730/2?l=english&count=5000`;
    const response = await fetch(steamUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
      }
    });

    if (response.status === 403) {
      return res.status(200).json({ error: 'private', message: 'Inventory is private' });
    }
    if (response.status === 429) {
      return res.status(200).json({ error: 'rate_limited', message: 'Steam rate limit hit' });
    }
    if (!response.ok) {
      return res.status(200).json({ error: 'steam_error', steam_status: response.status });
    }

    const data = await response.json();
    return res.status(200).json(data);

  } catch (err) {
    console.error('[Inventory] Fetch error:', err.message);
    return res.status(200).json({ error: 'fetch_failed', message: err.message });
  }
});

// ── Health check ──────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// ── Start server ──────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[Server] KASTLR inventory proxy running on port ${PORT}`);
});

// ── Schedule daily cron ───────────────────────────────────────────
// Spawns price_fetch_v6.js as a child process at 14:00 UTC daily
// This keeps the cron file completely untouched and isolated

function msUntilNext14UTC() {
  const now = new Date();
  const next = new Date();
  next.setUTCHours(14, 0, 0, 0);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next - now;
}

function scheduleCron() {
  const delay = msUntilNext14UTC();
  const hours = Math.floor(delay / 1000 / 60 / 60);
  const mins = Math.floor((delay / 1000 / 60) % 60);
  console.log(`[Cron] Next price fetch scheduled in ${hours}h ${mins}m`);

  setTimeout(() => {
    console.log('[Cron] Firing price fetch at', new Date().toISOString());
    const child = spawn('node', [join(__dirname, 'cron/price_fetch_v6.js')], {
      stdio: 'inherit',
      env: process.env,
    });
    child.on('close', (code) => {
      console.log(`[Cron] Price fetch exited with code ${code}`);
      scheduleCron(); // schedule next run
    });
    child.on('error', (err) => {
      console.error('[Cron] Spawn error:', err.message);
      scheduleCron(); // still reschedule even on error
    });
  }, delay);
}

scheduleCron();
