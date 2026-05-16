import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

export async function verifyUser(token) {
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) return null;
  return data.user.id;
}

export async function getGameId(slug = 'crash') {
  const { data } = await supabase
    .from('games').select('id').eq('slug', slug).maybeSingle();
  return data?.id ?? null;
}

export async function getHistory(gameId, limit = 20) {
  const { data } = await supabase
    .from('game_rounds')
    .select('id, result, created_at, ended_at')
    .eq('game_id', gameId)
    .eq('status', 'closed')
    .order('created_at', { ascending: false })
    .limit(limit);
  return data ?? [];
}

export async function createRound(gameId, serverSeed, serverSeedHash) {
  const { data, error } = await supabase
    .from('game_rounds')
    .insert({
      game_id: gameId,
      server_seed: serverSeed,
      server_seed_hash: serverSeedHash,
      status: 'open',
    })
    .select().single();
  if (error) throw new Error(error.message);
  return data;
}

export async function updateRound(roundId, patch) {
  const { error } = await supabase
    .from('game_rounds').update(patch).eq('id', roundId);
  if (error) console.error('[db] updateRound', error.message);
}

export async function deductBalance(userId, roundId, amount, currency) {
  const { data, error } = await supabase.rpc('apply_balance_change_v2', {
    _user_id: userId,
    _type: 'bet',
    _amount: -amount,
    _currency: currency,
    _bucket: 'real',
    _reference_type: 'game_round',
    _reference_id: roundId,
    _idempotency_key: `crash_bet:${roundId}:${userId}`,
  });
  if (error) throw new Error(error.message);
  return data;
}

export async function insertBet(userId, roundId, amount, currency, autoCashout) {
  const { data, error } = await supabase
    .from('bets')
    .insert({
      user_id: userId,
      round_id: roundId,
      amount,
      currency,
      status: 'pending',
      details: { auto_cashout: autoCashout ?? null, source: 'crash-api' },
    })
    .select().single();
  if (error) throw new Error(error.message);
  return data;
}

export async function settleBet(betId, userId, roundId, payout, multiplier, currency) {
  await supabase.from('bets').update({
    status: payout > 0 ? 'won' : 'lost',
    payout,
    multiplier,
  }).eq('id', betId);

  if (payout > 0) {
    await supabase.rpc('apply_balance_change_v2', {
      _user_id: userId,
      _type: 'payout',
      _amount: payout,
      _currency: currency,
      _bucket: 'real',
      _reference_type: 'game_round',
      _reference_id: roundId,
      _idempotency_key: `crash_payout:${betId}`,
    });
  }
}

export default supabase;
