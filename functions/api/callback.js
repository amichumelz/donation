/**
 * POST /api/callback
 * Server-to-server: gateway lapor keputusan pembayaran ke sini.
 * INI sumber kebenaran. Redirect ke browser boleh dipalsukan; ini tidak.
 *
 * Bayarcash v3 hantar JSON + checksum HMAC-SHA256.
 * toyyibPay hantar form-urlencoded tanpa checksum.
 *
 * Status Bayarcash: 0=New 1=Pending 2=Failed 3=Success 4=Cancelled
 * Status toyyibPay: 1=Success 2=Pending 3=Failed   ← perhatikan, TERBALIK!
 */

async function hmacHex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Banding dua string tanpa bocorkan masa (timing-safe) */
function safeEqual(a = '', b = '') {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const BAYARCASH_STATUS = { 0: 'new', 1: 'pending', 2: 'failed', 3: 'success', 4: 'cancelled' };
const TOYYIBPAY_STATUS = { 1: 'success', 2: 'pending', 3: 'failed', 4: 'pending' };

export async function onRequestPost({ request, env }) {
  const provider = (env.PAYMENT_PROVIDER || 'bayarcash').toLowerCase();
  const contentType = request.headers.get('content-type') || '';

  let data = {};
  if (contentType.includes('application/json')) {
    data = await request.json().catch(() => ({}));
  } else {
    const form = await request.formData().catch(() => null);
    if (form) for (const [k, v] of form.entries()) data[k] = String(v);
  }

  let orderNumber, status, gatewayRef, amountPaid, verified = false;

  if (provider === 'toyyibpay') {
    orderNumber = data.order_id || '';
    status = TOYYIBPAY_STATUS[Number(data.status)] || 'unknown';
    const billCode = data.billcode || '';
    gatewayRef = billCode || data.refno || null;
    amountPaid = data.amount ? Number(data.amount) / 100 : null;
    /* Jangan percaya POST ini bulat-bulat — sesiapa boleh hantar status palsu.
       Kita tanya semula toyyibPay tentang bill ini. Jawapan dari API mereka
       adalah sumber kebenaran, bukan apa yang dihantar ke endpoint kita. */
    const base = env.PAYMENT_ENV === 'live' ? 'https://toyyibpay.com' : 'https://dev.toyyibpay.com';
    try {
      const check = await fetch(`${base}/index.php/api/getBillTransactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ billCode: billCode }),
      });
      const rows = await check.json();
      const row = Array.isArray(rows) ? rows.find((r) => r.billExternalReferenceNo === orderNumber) || rows[0] : null;
      if (row) {
        verified = true;
        status = TOYYIBPAY_STATUS[Number(row.billpaymentStatus)] || 'unknown';
        amountPaid = row.billpaymentAmount ? Number(row.billpaymentAmount) : amountPaid;
        gatewayRef = row.billpaymentInvoiceNo || gatewayRef;
      } else {
        console.warn('callback: bill tidak dijumpai di toyyibPay', billCode);
      }
    } catch (err) {
      console.error('callback: gagal sahkan dengan toyyibPay', err.message);
    }
  } else {
    // ── Bayarcash: sahkan checksum sebelum percaya apa-apa ──
    const payload = {
      record_type: data.record_type,
      transaction_id: data.transaction_id,
      exchange_reference_number: data.exchange_reference_number,
      exchange_transaction_id: data.exchange_transaction_id,
      order_number: data.order_number,
      currency: data.currency,
      amount: data.amount,
      payer_name: data.payer_name,
      payer_email: data.payer_email,
      payer_bank_name: data.payer_bank_name,
      status: data.status,
      status_description: data.status_description,
      datetime: data.datetime,
    };
    const message = Object.keys(payload).sort().map((k) => payload[k]).join('|');
    const expected = await hmacHex(env.BAYARCASH_SECRET_KEY || '', message);
    verified = safeEqual(expected, String(data.checksum || ''));

    orderNumber = data.order_number || '';
    status = BAYARCASH_STATUS[Number(data.status)] || 'unknown';
    gatewayRef = data.transaction_id || null;
    amountPaid = data.amount ? Number(data.amount) : null;
  }

  if (!verified) {
    console.warn('callback checksum MISMATCH', provider, orderNumber);
    return new Response('Invalid checksum', { status: 400 });
  }

  if (env.DONATIONS && orderNumber) {
    const existing = await env.DONATIONS.get(`order:${orderNumber}`, 'json');
    const record = {
      ...(existing || {}),
      orderNumber, status, gatewayRef, amountPaid,
      paidAt: data.datetime || new Date().toISOString(),
    };

    // kira jumlah terkumpul sekali sahaja setiap order
    if (status === 'success' && !existing?.counted) {
      const raw = await env.DONATIONS.get('stats:total');
      const stats = raw ? JSON.parse(raw) : { raised: 0, donors: 0 };
      stats.raised += amountPaid || 0;
      stats.donors += 1;
      await env.DONATIONS.put('stats:total', JSON.stringify(stats));
      record.counted = true;
    }

    await env.DONATIONS.put(`order:${orderNumber}`, JSON.stringify(record));
  }

  console.log('callback', provider, orderNumber, status);

  // Gateway cuma perlukan 200 OK. Bayarcash retry 5 kali setiap 5 minit kalau gagal.
  return new Response('OK', { status: 200 });
}
