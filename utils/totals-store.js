const TOTALS_KEY = 'totals';
const DEFAULT_TOTALS = {
  raised: 8000,
  donors: 160,
  realRaised: 0,
  realDonors: 0,
  dummyRaised: 0,
  dummyDonors: 0,
};

/**
 * Membaca data kutipan keseluruhan (real + dummy) dari Cloudflare KV.
 */
export async function readTotals(env) {
  if (!env.DONATIONS) return DEFAULT_TOTALS;
  try {
    const stored = await env.DONATIONS.get(TOTALS_KEY, 'json');
    if (!stored) return DEFAULT_TOTALS;

    return {
      raised: Number(stored.raised ?? DEFAULT_TOTALS.raised),
      donors: Number(stored.donors ?? DEFAULT_TOTALS.donors),
      realRaised: Number(stored.realRaised ?? DEFAULT_TOTALS.realRaised),
      realDonors: Number(stored.realDonors ?? DEFAULT_TOTALS.realDonors),
      dummyRaised: Number(stored.dummyRaised ?? DEFAULT_TOTALS.dummyRaised),
      dummyDonors: Number(stored.dummyDonors ?? DEFAULT_TOTALS.dummyDonors),
    };
  } catch (err) {
    console.error('readTotals error:', err);
    return DEFAULT_TOTALS;
  }
}

/**
 * Menambah sumbangan layang (dummy donor simulation) ke dalam database KV.
 * Dilengkapi dengan throttling (min 5 saat jarak transaksi) untuk kestabilan.
 */
export async function addDummyDonation(env, amount) {
  if (!env.DONATIONS) return { ...DEFAULT_TOTALS, updated: false };

  try {
    const now = Date.now();
    const lastUpdateRaw = await env.DONATIONS.get('totals:last_dummy_time');
    const lastUpdate = lastUpdateRaw ? Number(lastUpdateRaw) : 0;

    // Hadkan simpanan dummy kepada 5 saat sekali maksima
    if (now - lastUpdate < 5000) {
      const current = await readTotals(env);
      return { ...current, updated: false };
    }

    // Set masa terkini update dummy
    await env.DONATIONS.put('totals:last_dummy_time', String(now));

    const stored = await readTotals(env);
    const updated = {
      raised: Number((stored.raised + amount).toFixed(2)),
      donors: stored.donors + 1,
      realRaised: stored.realRaised,
      realDonors: stored.realDonors,
      dummyRaised: Number((stored.dummyRaised + amount).toFixed(2)),
      dummyDonors: stored.dummyDonors + 1,
    };

    await env.DONATIONS.put(TOTALS_KEY, JSON.stringify(updated));
    return { ...updated, updated: true };
  } catch (err) {
    console.error('addDummyDonation error:', err);
    const current = await readTotals(env);
    return { ...current, updated: false };
  }
}
