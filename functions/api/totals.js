/**
 * GET /api/totals
 * Baca jumlah derma terkumpul & bilangan penderma dari KV "DONATIONS".
 * Nilai sebenar di-update oleh /api/return (selepas checksum gateway sah),
 * bukan dari browser — supaya tak boleh dipalsukan.
 */

const TOTALS_KEY = 'totals';
const DEFAULT_TOTALS = { raised: 8000, donors: 160 }; // sepadan fallback di index.html

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

export async function onRequestGet({ env }) {
  if (!env.DONATIONS) return json(DEFAULT_TOTALS);
  try {
    const stored = await env.DONATIONS.get(TOTALS_KEY, 'json');
    return json(stored || DEFAULT_TOTALS);
  } catch (err) {
    return json(DEFAULT_TOTALS);
  }
}
