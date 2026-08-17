/**
 * GET  /api/totals            -> paparan AWAM: {raised, donors} (real + dummy gabung)
 * GET  /api/totals?key=XXXX   -> paparan PERIBADI (kalau ADMIN_KEY sepadan):
 *                                pecahan penuh real vs dummy
 * POST /api/totals            -> tambah SATU dummy donor simulasi
 *
 * Derma SEBENAR (gateway) di-update terus dalam /api/return selepas checksum
 * sah — TIDAK melalui POST ini, supaya derma sebenar tak boleh dipalsukan.
 *
 * Untuk lihat angka sebenar sahaja (tanpa dummy), set env var Secret
 * "ADMIN_KEY" dalam Cloudflare Pages > Settings > Variables and secrets,
 * lepas tu buka: https://domain-anda.com/api/totals?key=NILAI_ADMIN_KEY_ANDA
 */

import { readTotals, addDummyDonation } from '../../utils/totals-store.js';

const MIN_DUMMY_AMOUNT = 5;
const MAX_DUMMY_AMOUNT = 2000;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

export async function onRequestGet({ request, env }) {
  const totals = await readTotals(env);
  const url = new URL(request.url);
  const key = url.searchParams.get('key');

  if (env.ADMIN_KEY && key && key === env.ADMIN_KEY) {
    // Paparan peribadi — pecahan penuh real vs dummy
    return json(totals);
  }

  // Paparan awam — cuma gabungan, macam sebelum ni
  return json({ raised: totals.raised, donors: totals.donors });
}

export async function onRequestPost({ request, env }) {
  if (!env.DONATIONS) return json({ error: 'KV not bound' }, 500);

  try {
    const body = await request.json();
    const amount = Number(body.amount);

    if (!Number.isFinite(amount) || amount < MIN_DUMMY_AMOUNT || amount > MAX_DUMMY_AMOUNT) {
      return json({ error: 'Invalid amount' }, 400);
    }

    const updated = await addDummyDonation(env, amount);
    return json({ raised: updated.raised, donors: updated.donors, updated: updated.updated });
  } catch (err) {
    return json({ error: 'Failed to update totals' }, 500);
  }
}
