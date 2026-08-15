/**
 * POST /api/create-bill
 * Cipta payment intent (Bayarcash) atau bill (toyyibPay),
 * pulangkan URL pembayaran untuk browser redirect.
 *
 * Tukar gateway dengan SATU environment variable:
 *   PAYMENT_PROVIDER = "bayarcash"  (default)  atau  "toyyibpay"
 *
 * ── Bayarcash ────────────────────────────────────────────────
 *   BAYARCASH_PAT          (Secret)    Personal Access Token
 *   BAYARCASH_SECRET_KEY   (Secret)    API Secret Key — untuk checksum
 *   BAYARCASH_PORTAL_KEY   (Secret)    Portal Key
 *   BAYARCASH_CHANNEL      (Plaintext) 1=FPX, 5=DuitNow OB/Wallet, 6=DuitNow QR
 *
 * ── toyyibPay ────────────────────────────────────────────────
 *   TOYYIBPAY_SECRET_KEY   (Secret)
 *   TOYYIBPAY_CATEGORY     (Secret)
 *
 * ── Kedua-dua ────────────────────────────────────────────────
 *   PAYMENT_ENV            (Plaintext) "sandbox" (default) atau "live"
 *   SITE_URL               (Plaintext) cth. https://amalsatuhati.pages.dev
 *   DONATIONS              (KV binding, optional)
 */

const MIN = 1, MAX = 30000;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

/** HMAC-SHA256 -> hex. Sama hasil dengan hash_hmac('sha256', $msg, $key) dalam PHP. */
async function hmacHex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Bayarcash: susun key ikut abjad, cantum nilai dengan '|', HMAC guna secret key. */
async function bayarcashChecksum(secret, payload) {
  const message = Object.keys(payload).sort().map((k) => payload[k]).join('|');
  return hmacHex(secret, message);
}

/** 0123456789 -> 60123456789 (Bayarcash terima nombor Malaysia sahaja) */
function normalizePhone(raw) {
  let p = String(raw || '').replace(/\D/g, '');
  if (p.startsWith('0')) p = '60' + p.slice(1);
  else if (!p.startsWith('60')) p = '60' + p;
  return p;
}

export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid request body.' }, 400);
  }

  // ── validasi di server (jangan sekali-kali percaya input dari browser) ──
  const amount = Number(body.amount);
  const name = String(body.name || '').trim().slice(0, 60);
  const email = String(body.email || '').trim().slice(0, 80);
  const phone = normalizePhone(body.phone);
  const campaign = String(body.campaign || 'Best Use').trim().slice(0, 40);
  const method = body.method === 'qr' ? 'qr' : 'fpx';   // hanya dua saluran disokong

  if (!Number.isFinite(amount) || amount < MIN || amount > MAX)
    return json({ error: `Amount must be between RM${MIN} and RM${MAX}.` }, 400);
  if (name.length < 2) return json({ error: 'Name is required.' }, 400);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
    return json({ error: 'Valid email is required.' }, 400);
  if (phone.length < 10) return json({ error: 'Valid Malaysian phone number is required.' }, 400);

  const siteUrl = (env.SITE_URL || new URL(request.url).origin).replace(/\/$/, '');
  const orderNumber =
    'ASH' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase();
  const sandbox = env.PAYMENT_ENV !== 'live';
  const provider = (env.PAYMENT_PROVIDER || 'bayarcash').toLowerCase();

  try {
    const args = { env, sandbox, siteUrl, orderNumber, amount, name, email, phone, campaign, method };
    const result =
      provider === 'toyyibpay'
        ? await createToyyibpayBill(args)
        : await createBayarcashIntent(args);

    if (env.DONATIONS) {
      await env.DONATIONS.put(
        `order:${orderNumber}`,
        JSON.stringify({
          orderNumber, amount, name, email, phone, campaign, provider,
          gatewayRef: result.gatewayRef, status: 'pending',
          createdAt: new Date().toISOString(),
        }),
        { expirationTtl: 60 * 60 * 24 * 90 }
      );
    }

    return json({ paymentUrl: result.paymentUrl, reference: orderNumber });
  } catch (err) {
    console.error('create-bill failed', provider, err.message);
    return json({ error: err.message || 'Payment gateway error.' }, 502);
  }
}

/* ─────────────────────────── BAYARCASH ─────────────────────────── */
async function createBayarcashIntent({ env, sandbox, siteUrl, orderNumber, amount, name, email, phone, campaign }) {
  if (!env.BAYARCASH_PAT || !env.BAYARCASH_PORTAL_KEY || !env.BAYARCASH_SECRET_KEY)
    throw new Error('Bayarcash is not configured yet.');

  const base = sandbox
    ? 'https://api.console.bayarcash-sandbox.com/v3'
    : 'https://api.console.bayar.cash/v3';

  // amount mesti string 2 titik perpuluhan — dan nilai YANG SAMA diguna untuk checksum
  const amountStr = amount.toFixed(2);
  const channel = Number(env.BAYARCASH_CHANNEL || 1); // 1 = FPX

  const checksum = await bayarcashChecksum(env.BAYARCASH_SECRET_KEY, {
    payment_channel: channel,
    order_number: orderNumber,
    amount: amountStr,
    payer_name: name,
    payer_email: email,
  });

  const res = await fetch(`${base}/payment-intents`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.BAYARCASH_PAT}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      payment_channel: channel,
      portal_key: env.BAYARCASH_PORTAL_KEY,
      order_number: orderNumber,
      amount: amountStr,
      payer_name: name,
      payer_email: email,
      payer_telephone_number: phone,
      return_url: `${siteUrl}/api/return`,     // GET  — browser dibawa balik ke sini
      callback_url: `${siteUrl}/api/callback`, // POST — server-to-server (v3 sahaja)
      metadata: campaign,
      checksum,
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.url)
    throw new Error(data.message || data.error || `Bayarcash rejected the request (${res.status}).`);

  return { paymentUrl: data.url, gatewayRef: data.id || null };
}

/* ─────────────────────────── TOYYIBPAY ─────────────────────────── */
async function createToyyibpayBill({ env, sandbox, siteUrl, orderNumber, amount, name, email, phone, campaign, method }) {
  if (!env.TOYYIBPAY_SECRET_KEY || !env.TOYYIBPAY_CATEGORY)
    throw new Error('toyyibPay is not configured yet.');

  const base = sandbox ? 'https://dev.toyyibpay.com' : 'https://toyyibpay.com';
  const billName = ('Derma ' + campaign).replace(/[^a-zA-Z0-9 _]/g, '').slice(0, 30);

  // billDescription: huruf/nombor/space/underscore sahaja, max 100 aksara
  const billDescription = `Sumbangan ${campaign} Pertubuhan Amal Satu Hati`
    .replace(/[^a-zA-Z0-9 _]/g, '')
    .slice(0, 100);

  const fields = {
    userSecretKey: env.TOYYIBPAY_SECRET_KEY,
    categoryCode: env.TOYYIBPAY_CATEGORY,
    billName,
    billDescription,
    billPriceSetting: '1',                        // harga tetap
    billPayorInfo: '1',                           // minta nama/emel/telefon
    billAmount: String(Math.round(amount * 100)), // dalam sen
    billReturnUrl: `${siteUrl}/api/return`,
    billCallbackUrl: `${siteUrl}/api/callback`,
    billExternalReferenceNo: orderNumber,
    billTo: name,
    billEmail: email,
    billPhone: phone,
    billSplitPayment: '0',
    billSplitPaymentArgs: '',
    billPaymentChannel: '0',                      // 0 = FPX sahaja (bukan kad)
    billContentEmail: 'Terima kasih atas sumbangan anda.',
    // "0" bermaksud caj FPX ditanggung PENDERMA.
    // Kalau dibiarkan kosong, caj jatuh pada pemilik bill (kita).
    billChargeToCustomer: '0',
    billExpiryDays: '3',
  };

  // DuitNow QR — akaun toyyibPay mesti ada DuitNow QR diaktifkan dahulu
  if (method === 'qr') {
    fields.enableDuitNowQR = '1';
    fields.chargeDuitNowQR = '1';   // 1 = caj ditanggung penderma
  }

  const form = new URLSearchParams(fields);

  const res = await fetch(`${base}/index.php/api/createBill`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form,
  });
  const data = await res.json().catch(() => null);
  const billCode = Array.isArray(data) && data[0] && data[0].BillCode;
  if (!billCode)
    throw new Error((Array.isArray(data) ? data[0]?.msg : data?.msg) || 'Bill creation failed.');

  return { paymentUrl: `${base}/${billCode}`, gatewayRef: billCode };
}
