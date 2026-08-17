/**
 * GET /api/totals
 * Mengembalikan jumlah sumbangan terkumpul dan bilangan penderma yang disimpan di KV database.
 * Bermula daripada asas RM 8,000 dan 160 penderma (baseline) dan menambah sumbangan baharu yang berjaya.
 */
export async function onRequestGet({ env }) {
  let raised = 8000;
  let donors = 160;

  if (env.DONATIONS) {
    const raw = await env.DONATIONS.get('stats:total');
    if (raw) {
      try {
        const stats = JSON.parse(raw);
        raised += Number(stats.raised || 0);
        donors += Number(stats.donors || 0);
      } catch (e) {
        console.error('totals api: gagal menghurai json stats', e);
      }
    }
  }

  return new Response(JSON.stringify({ raised, donors }), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    },
  });
}
