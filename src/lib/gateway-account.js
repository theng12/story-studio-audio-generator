// Account-worker schema 1 for the audio worker.
//
// Audio has no observed credit source, so a balance is always null (unknown)
// and must never be rendered as 0. `nzlxg` is Flow's credit RPC and can never
// authorize a fish.audio or ElevenLabs job: the Gateway binds the account to
// the job's provider. A real Fish/ElevenLabs balance capture replaces this.
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/;
const SLUG = /^[a-z0-9][a-z0-9._-]{0,63}$/;

// Unknown is shown as unknown; there is no numeric default.
export function balanceLabel(account) {
  const balance = account?.balance;
  return balance && typeof balance.value === 'number' && Number.isFinite(balance.value) && balance.value >= 0
    ? `${balance.value} ${balance.unit}`
    : 'Unknown';
}

export function audioAccount({ provider, accountId, source, observedAt, signedIn, inventoryLive }) {
  if (!SLUG.test(String(provider || '')) || !ID.test(String(accountId || '')) || !SLUG.test(String(source || ''))) return null;
  return {
    schema: 1, provider, accountId, source, observedAt,
    connection: 'connected',
    signIn: signedIn === true ? 'signed_in' : 'signed_out',
    readiness: signedIn === true && inventoryLive === true ? 'ready' : 'unknown',
    balance: null, resetAt: null, plan: null, creditBuckets: null,
  };
}

// One observation for a claim or a telemetry call: the account plus the worker
// state the Gateway validates alongside it. Returns null when no account was
// observed, which is the signal not to claim at all.
export function audioObservation({ provider, accountId, signedIn, inventoryLive, source,
  observedAt = new Date().toISOString(), paused, controlRevision = null, pacing, nextEligibleAt = null }) {
  const account = audioAccount({ provider, accountId, source, observedAt, signedIn, inventoryLive });
  if (!account) return null;
  const state = {
    source, observedAt,
    connection: account.connection, signIn: account.signIn, readiness: account.readiness,
    activity: paused === true ? 'waiting' : 'idle',
    enabled: true,
    paused: paused === true,
    attention: false,
    controlRevision,
    nextEligibleAt: nextEligibleAt || observedAt,
    ...(pacing ? { pacing } : {}),
  };
  return { account: { ...account, ...state }, telemetry: { state } };
}
