/**
 * Example DApp backend — Express reference implementation of the Antarctic
 * Wallet B2B intents flow. Use this as a starting point for your own server.
 *
 * Responsibilities:
 *   - Hold the api_secret server-side so the browser cannot reach it.
 *   - Sign every B2B request with HMAC-SHA256 over `{ts}.{METHOD}.{path}.{sha256(body)}`.
 *   - Expose a small REST API the mini-app can call from the browser.
 *   - Optionally serve the demo mini-apps as static files.
 *
 * Endpoints:
 *   POST /api/intents → forwards body to AW `/api/apps/v1/intents`
 *   GET  /health      → liveness probe
 *
 * Required env (see .env.example):
 *   AW_API_BASE, AW_API_KEY, AW_API_SECRET
 *   PORT (default 3351)
 *   ALLOWED_ORIGIN (default *)
 *   STATIC_DIR (optional — serve files from this folder for non-API paths)
 */
import express from 'express';
import { createHash, createHmac } from 'node:crypto';

const PORT = Number.parseInt(process.env.PORT ?? '3351', 10);
const AW_API_BASE = process.env.AW_API_BASE ?? '';
const AW_API_KEY = process.env.AW_API_KEY ?? '';
const AW_API_SECRET = process.env.AW_API_SECRET ?? '';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN ?? '*';
const STATIC_DIR = process.env.STATIC_DIR ?? '';

const VALID_TYPES = new Set(['pay', 'receive', 'scopes']);

if (!AW_API_BASE || !AW_API_KEY || !AW_API_SECRET) {
  console.warn(
    '[boot] Missing AW_API_BASE / AW_API_KEY / AW_API_SECRET — /api/intents will return 500 until they are set.',
  );
}

const sha256Hex = (msg) => createHash('sha256').update(msg, 'utf8').digest('hex');
const hmacSha256Hex = (secret, msg) =>
  createHmac('sha256', secret).update(msg, 'utf8').digest('hex');

/**
 * Validates and shapes the request the browser sends us into the exact body
 * the AW B2B endpoint expects. `apiKey` / `apiSecret` / `apiBase` are
 * extracted out — they configure the upstream call but are NOT forwarded.
 */
function buildIntentPayload(input) {
  const { type, telegramUserId, amount, scopes } = input ?? {};
  if (!VALID_TYPES.has(type)) throw new Error('INVALID_TYPE');
  const telegramUserIdNum = Number(telegramUserId);
  if (!Number.isInteger(telegramUserIdNum) || telegramUserIdNum <= 0) {
    throw new Error('INVALID_TELEGRAM_USER_ID');
  }
  if (type === 'scopes') {
    const list = Array.isArray(scopes)
      ? scopes.filter((s) => typeof s === 'string' && s.length > 0)
      : [];
    if (list.length === 0) throw new Error('SCOPES_REQUIRED');
    return { type, telegram_user_id: telegramUserIdNum, data: { scopes: list } };
  }
  if (typeof amount !== 'string' || amount.trim() === '') throw new Error('AMOUNT_REQUIRED');
  return { type, telegram_user_id: telegramUserIdNum, data: { amount } };
}

/** Signs and POSTs the B2B intent request to AW using the supplied creds. */
async function forwardIntent(payload, creds) {
  const path = '/api/apps/v1/intents';
  const method = 'POST';
  const raw = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = hmacSha256Hex(
    creds.apiSecret,
    `${timestamp}.${method}.${path}.${sha256Hex(raw)}`,
  );
  const url = `${creds.apiBase.replace(/\/$/, '')}${path}`;
  console.log('[forward]', method, url, 'body=', raw);
  const upstream = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Sdk-App-Key': creds.apiKey,
      'X-Sdk-App-Timestamp': timestamp,
      'X-Sdk-App-Signature': signature,
    },
    body: raw,
  });
  const body = await upstream.text();
  console.log('[forward] upstream status=', upstream.status, 'body=', body.slice(0, 200));
  return { status: upstream.status, body };
}

const app = express();

// CORS for the mini-app served from a different origin.
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

app.get('/health', (_req, res) => res.json({ ok: true }));

app.post('/api/intents', express.json({ limit: '64kb' }), async (req, res) => {
  // DEMO ONLY: this server accepts apiKey/apiSecret directly from the request
  // body so integrators can experiment without setting them in env. NEVER do
  // this in real apps — your secret stays only on YOUR backend.
  const apiBase = (req.body?.apiBase || AW_API_BASE || '').toString();
  const apiKey = (req.body?.apiKey || AW_API_KEY || '').toString();
  const apiSecret = (req.body?.apiSecret || AW_API_SECRET || '').toString();
  if (!apiBase || !apiKey || !apiSecret) {
    return res.status(400).json({
      error: 'MISSING_CREDENTIALS',
      hint: 'Pass apiBase + apiKey + apiSecret in the request body, or configure them server-side via env.',
    });
  }
  let payload;
  try {
    payload = buildIntentPayload(req.body);
  } catch (error) {
    return res.status(422).json({ error: error.message });
  }
  try {
    const upstream = await forwardIntent(payload, { apiBase, apiKey, apiSecret });
    res
      .status(upstream.status)
      .set('X-Demo-Warning', 'apiKey/apiSecret accepted from request body - DEMO ONLY, never expose your secret in browsers')
      .type('application/json')
      .send(upstream.body);
  } catch (error) {
    console.error('[intents] upstream error', error);
    res.status(502).json({ error: 'UPSTREAM_FAILURE' });
  }
});

if (STATIC_DIR) {
  app.use(express.static(STATIC_DIR, { extensions: ['html'] }));
}

app.use((_req, res) => res.status(404).json({ error: 'NOT_FOUND' }));

app.listen(PORT, () => {
  console.log(
    `[boot] listening on :${PORT}${STATIC_DIR ? ` (static from ${STATIC_DIR})` : ''}`,
  );
});
