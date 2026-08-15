/**
 * GET /api/health
 * Endpoint diagnostik — buka terus dalam browser.
 *
 * Ia TIDAK memaparkan nilai secret, hanya sama ada ia wujud atau tidak.
 * Selamat untuk dibuka, tapi padam fail ini bila semuanya dah berjalan.
 */

export async function onRequestGet({ request, env }) {
  const has = (k) => (env[k] ? 'SET (' + String(env[k]).length + ' aksara)' : 'MISSING');

  const info = {
    ok: true,
    message: 'Pages Functions berjalan pada laluan ini.',
    now: new Date().toISOString(),
    host: new URL(request.url).host,

    provider: env.PAYMENT_PROVIDER || '(tidak diset — lalai kepada bayarcash)',
    paymentEnv: env.PAYMENT_ENV || '(tidak diset — lalai kepada sandbox)',
    siteUrl: env.SITE_URL || '(tidak diset)',

    toyyibpay: {
      TOYYIBPAY_SECRET_KEY: has('TOYYIBPAY_SECRET_KEY'),
      TOYYIBPAY_CATEGORY: has('TOYYIBPAY_CATEGORY'),
    },
    bayarcash: {
      BAYARCASH_PAT: has('BAYARCASH_PAT'),
      BAYARCASH_SECRET_KEY: has('BAYARCASH_SECRET_KEY'),
      BAYARCASH_PORTAL_KEY: has('BAYARCASH_PORTAL_KEY'),
    },
    kvDonations: env.DONATIONS ? 'BOUND' : 'not bound (optional)',
  };

  // Uji sambungan keluar ke toyyibPay — kalau ini gagal, masalahnya rangkaian
  try {
    const base = env.PAYMENT_ENV === 'live' ? 'https://toyyibpay.com' : 'https://dev.toyyibpay.com';
    const res = await fetch(`${base}/index.php/api/getCategoryDetails`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        userSecretKey: env.TOYYIBPAY_SECRET_KEY || '',
        categoryCode: env.TOYYIBPAY_CATEGORY || '',
      }),
    });
    const text = await res.text();
    info.toyyibpayTest = {
      endpoint: base,
      httpStatus: res.status,
      response: text.slice(0, 300),
    };
  } catch (err) {
    info.toyyibpayTest = { error: String(err && err.message ? err.message : err) };
  }

  return new Response(JSON.stringify(info, null, 2), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
