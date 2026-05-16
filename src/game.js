import { createHmac, randomBytes } from 'crypto';
import { createRound, updateRound, deductBalance, insertBet, settleBet, getGameId, getHistory } from './db.js';

const WAITING_MS  = 5000;   // betting window
const TICK_MS     = 100;    // multiplier update interval
const CRASHED_MS  = 3000;   // show crash result before next round

function newServerSeed() {
  return randomBytes(32).toString('hex');
}

function hashSeed(seed) {
  return createHmac('sha256', 'apexclub91-crash').update(seed).digest('hex');
}

function crashPoint(serverSeed) {
  const hash = createHmac('sha256', serverSeed).update('result').digest('hex');
  const h = parseInt(hash.slice(0, 8), 16);
  const e = 0xFFFFFFFF;
  if (h % 101 === 0) return 1.00;           // ~1% instant crash (house edge)
  return Math.max(1.00, Math.floor(100 * e / (e - h)) / 100);
}

function currentMultiplier(startTime) {
  const ms = Date.now() - startTime;
  return Math.floor(Math.pow(Math.E, 0.00006 * ms) * 100) / 100;
}

export class CrashGame {
  constructor(broadcast) {
    this.broadcast  = broadcast;
    this.gameId     = null;
    this.roundId    = null;
    this.state      = 'idle';      // idle | waiting | flying | crashed
    this.multiplier = 1.00;
    this.target     = 1.00;        // crash point for this round
    this.seedHash   = null;
    this.seed       = null;
    this.startTime  = null;
    this.ticker     = null;
    this.bets       = new Map();   // userId → { betId, amount, currency, autoCashout, cashedOut }
    this.history    = [];
  }

  async init() {
    this.gameId  = await getGameId('crash');
    if (!this.gameId) throw new Error('crash game not found in games table');
    this.history = await getHistory(this.gameId);
    console.log(`[game] init  gameId=${this.gameId}  history=${this.history.length} rounds`);
    this._startWaiting();
  }

  // ── phases ────────────────────────────────────────────────────────────────

  _startWaiting() {
    this.state      = 'waiting';
    this.multiplier = 1.00;
    this.bets.clear();
    this.seed       = newServerSeed();
    this.seedHash   = hashSeed(this.seed);
    this.target     = crashPoint(this.seed);
    this.roundId    = null;

    this.broadcast({ type: 'waiting', countdown: WAITING_MS, server_seed_hash: this.seedHash });

    createRound(this.gameId, this.seed, this.seedHash)
      .then(r => { this.roundId = r.id; })
      .catch(e => console.error('[game] createRound', e.message));

    setTimeout(() => this._startFlying(), WAITING_MS);
  }

  _startFlying() {
    this.state     = 'flying';
    this.startTime = Date.now();

    if (this.roundId) {
      updateRound(this.roundId, { status: 'active', started_at: new Date().toISOString() })
        .catch(e => console.error('[game] updateRound active', e.message));
    }

    this.broadcast({ type: 'started', round_id: this.roundId, server_seed_hash: this.seedHash });

    this.ticker = setInterval(() => this._tick(), TICK_MS);
  }

  _tick() {
    this.multiplier = currentMultiplier(this.startTime);

    // Auto-cashouts
    for (const [uid, bet] of this.bets) {
      if (!bet.cashedOut && bet.autoCashout && this.multiplier >= bet.autoCashout) {
        this._cashout(uid).catch(e => console.error('[game] auto-cashout', e.message));
      }
    }

    this.broadcast({ type: 'tick', multiplier: this.multiplier });

    if (this.multiplier >= this.target) this._crash();
  }

  _crash() {
    clearInterval(this.ticker);
    this.ticker = null;
    this.state  = 'crashed';

    const cp = this.target;
    this.broadcast({ type: 'crashed', multiplier: cp, round_id: this.roundId, server_seed: this.seed });

    // Settle all open bets as losses
    for (const [uid, bet] of this.bets) {
      if (!bet.cashedOut) {
        settleBet(bet.betId, uid, this.roundId, 0, cp, bet.currency)
          .catch(e => console.error('[game] settleBet loss', e.message));
      }
    }

    if (this.roundId) {
      updateRound(this.roundId, {
        status: 'closed',
        ended_at: new Date().toISOString(),
        result: { crash_point: cp },
      }).catch(e => console.error('[game] updateRound closed', e.message));
    }

    this.history.unshift({ id: this.roundId, result: { crash_point: cp }, created_at: new Date().toISOString() });
    if (this.history.length > 50) this.history.pop();

    setTimeout(() => this._startWaiting(), CRASHED_MS);
  }

  // ── public actions ────────────────────────────────────────────────────────

  async placeBet(userId, amount, currency, autoCashout) {
    if (this.state !== 'waiting') throw new Error('Betting is closed for this round');
    if (this.bets.has(userId))    throw new Error('Already bet this round');
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('Invalid amount');

    // Wait for roundId if createRound hasn't resolved yet
    if (!this.roundId) {
      await new Promise(res => setTimeout(res, 500));
      if (!this.roundId) throw new Error('Round not ready, try again');
    }

    await deductBalance(userId, this.roundId, amount, currency);
    const bet = await insertBet(userId, this.gameId, this.roundId, amount, currency, autoCashout);

    this.bets.set(userId, { betId: bet.id, amount, currency, autoCashout: autoCashout ?? null, cashedOut: false });
    this.broadcast({ type: 'bet_placed', amount, currency });
    return bet;
  }

  async _cashout(userId) {
    const bet = this.bets.get(userId);
    if (!bet || bet.cashedOut) return null;
    if (this.state !== 'flying') throw new Error('Not in flying phase');

    const mult   = this.multiplier;
    const payout = Math.floor(bet.amount * mult * 100) / 100;
    bet.cashedOut = true;

    await settleBet(bet.betId, userId, this.roundId, payout, mult, bet.currency);
    this.broadcast({ type: 'cashout', multiplier: mult, payout });
    return { multiplier: mult, payout };
  }

  async cashout(userId) {
    return this._cashout(userId);
  }

  getState() {
    return {
      state:            this.state,
      multiplier:       this.multiplier,
      round_id:         this.roundId,
      server_seed_hash: this.seedHash,
      crash_point:      this.state === 'crashed' ? this.target : undefined,
    };
  }
}
