import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import cors from 'cors';
import { verifyUser } from './db.js';
import { CrashGame } from './game.js';

const app    = express();
const server = createServer(app);
const wss    = new WebSocketServer({ server, path: '/ws' });

app.use(cors());
app.use(express.json());

// ── WebSocket client registry ────────────────────────────────────────────────
const clients = new Set();

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) ws.send(data);
  }
}

// ── Game ─────────────────────────────────────────────────────────────────────
const game = new CrashGame(broadcast);

// ── REST ──────────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true }));

app.get('/state', (_req, res) => res.json(game.getState()));

app.get('/history', (_req, res) => res.json(game.history.slice(0, 20)));

// ── WebSocket ────────────────────────────────────────────────────────────────
wss.on('connection', async (ws, req) => {
  const url    = new URL(req.url, 'http://localhost');
  const token  = url.searchParams.get('token');
  let   userId = null;

  if (token) {
    userId = await verifyUser(token).catch(() => null);
  }

  clients.add(ws);

  // Send current state immediately on connect
  ws.send(JSON.stringify({
    type:    'state',
    history: game.history.slice(0, 20),
    ...game.getState(),
  }));

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    try {
      if (msg.type === 'bet') {
        if (!userId) return ws.send(JSON.stringify({ type: 'error', message: 'unauthorized' }));
        const bet = await game.placeBet(
          userId,
          Number(msg.amount),
          msg.currency ?? 'INR',
          msg.auto_cashout ?? null,
        );
        ws.send(JSON.stringify({ type: 'bet_confirmed', bet_id: bet.id }));
      }

      if (msg.type === 'cashout') {
        if (!userId) return ws.send(JSON.stringify({ type: 'error', message: 'unauthorized' }));
        const result = await game.cashout(userId);
        if (result) ws.send(JSON.stringify({ type: 'cashout_confirmed', ...result }));
      }
    } catch (e) {
      ws.send(JSON.stringify({ type: 'error', message: e.message }));
    }
  });

  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
  console.log(`[server] Crash API listening on port ${PORT}`);
  try {
    await game.init();
    console.log('[server] Game loop started');
  } catch (e) {
    console.error('[server] Game init failed:', e.message);
    process.exit(1);
  }
});
