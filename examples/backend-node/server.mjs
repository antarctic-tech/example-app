/**
 * Бэкенд вашей мини-апки, не API Antarctic Wallet (AW).
 *
 * После чтения файла сверху вниз должно быть ясно:
 *   1. Секреты живут в env (AW_API_KEY / AW_API_SECRET / AW_API_BASE).
 *   2. Кто пользователь — из проверенного idToken, не из тела запроса клиента.
 *   3. Интент = HMAC POST в AW /api/apps/v1/intents.
 *   4. После operationId мини-апка зовёт только sdk.operations.requestConfirmation.
 *
 * Эндпоинты:
 *   POST /api/auth/session  { idToken }              → { userId, tgId? }
 *   POST /api/intents       { idToken, type, ... }   → { operationId }
 *   POST /api/webhooks      AW → этот сервер (подписанный)
 *   GET  /health
 */
import express from "express";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";

const here = dirname(fileURLToPath(import.meta.url));

const PORT = Number.parseInt(process.env.PORT ?? "3000", 10);
const AW_API_BASE = (process.env.AW_API_BASE ?? "").replace(/\/$/, "");
const AW_API_KEY = process.env.AW_API_KEY ?? "";
const AW_API_SECRET = process.env.AW_API_SECRET ?? "";
const AW_WEBHOOK_SECRET = process.env.AW_WEBHOOK_SECRET ?? "";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN ?? "*";
const defaultPublicDir = resolve(here, "public");
const STATIC_DIR =
  process.env.STATIC_DIR ||
  (existsSync(defaultPublicDir) ? defaultPublicDir : "");

const AW_ISSUER = "aw";
const AW_INTENTS_PATH = "/api/apps/v1/intents";
const VALID_TYPES = new Set(["pay", "receive", "scopes"]);
/** Вебхук с дрейфом часов > 5 мин отклоняем — так же, как AW отклоняет STALE_REQUEST. */
const WEBHOOK_MAX_SKEW_SEC = 300;

let jwks = null;
if (AW_API_BASE) {
  try {
    jwks = createRemoteJWKSet(new URL("/api/v2/sdk/jwks", AW_API_BASE));
  } catch (error) {
    console.warn(
      "[boot] Invalid AW_API_BASE — JWKS disabled:",
      error?.message ?? error,
    );
  }
}

if (!AW_API_BASE || !AW_API_KEY || !AW_API_SECRET) {
  console.warn(
    "[boot] Missing AW_API_BASE / AW_API_KEY / AW_API_SECRET — /api/intents will return 500 until they are set.",
  );
}

const sha256Hex = (msg) => createHash("sha256").update(msg).digest("hex");
const hmacSha256Hex = (secret, msg) =>
  createHmac("sha256", secret).update(msg).digest("hex");

/** Сравнение подписей без утечки по времени ответа. */
function equalHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function httpError(status, code, extra) {
  const error = new Error(code);
  error.status = status;
  error.code = code;
  if (extra) Object.assign(error, extra);
  return error;
}

function parsePositiveInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * AW отвечает по-разному: data.operationId или data.operation_id.
 * Нормализуем к одной строке.
 */
function readOperationId(parsed) {
  if (!parsed || typeof parsed !== "object") return null;
  const nested =
    parsed.data && typeof parsed.data === "object" ? parsed.data : null;
  const id =
    nested?.operationId ??
    nested?.operation_id ??
    parsed.operationId ??
    parsed.operation_id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/**
 * Проверка JWT кошелька по JWKS.
 * Личность = payload.sub (числовой user_id для интентов).
 * userContext и userId из клиента не берём — их можно подменить (IDOR).
 */
async function verifyIdToken(idToken) {
  if (!jwks) {
    throw httpError(500, "JWKS_NOT_CONFIGURED", {
      hint: "Set AW_API_BASE in env — JWKS URL is derived as /api/v2/sdk/jwks on that host.",
    });
  }
  if (typeof idToken !== "string" || idToken.length === 0) {
    throw httpError(400, "ID_TOKEN_REQUIRED");
  }
  try {
    const { payload } = await jwtVerify(idToken, jwks, {
      issuer: AW_ISSUER,
      // В проде добавьте audience: ваш appId.
    });
    const userId = payload.sub == null ? "" : String(payload.sub);
    if (!userId) {
      throw httpError(401, "INVALID_ID_TOKEN", { reason: "missing_sub" });
    }
    return {
      userId,
      awUserId: parsePositiveInt(payload.sub),
      tgId: parsePositiveInt(payload.tg_id),
      exp: payload.exp,
    };
  } catch (error) {
    if (error.status) throw error;
    throw httpError(401, "INVALID_ID_TOKEN", {
      reason: error.code ?? error.message ?? "verify_failed",
      claim: error.claim,
    });
  }
}

/**
 * Тело B2B-запроса в AW.
 * user_id всегда из проверенного sub, никогда из req.body.
 * reference_id — id вашего заказа; в проде берите из своей БД, не от клиента.
 */
function buildIntentPayload({ type, userId, amount, scopes, referenceId }) {
  if (!VALID_TYPES.has(type)) throw httpError(422, "INVALID_TYPE");
  const payload = { type, user_id: userId };
  if (referenceId) payload.reference_id = referenceId;
  if (type === "scopes") {
    const list = Array.isArray(scopes)
      ? scopes.filter((s) => typeof s === "string" && s.length > 0)
      : [];
    if (list.length === 0) throw httpError(422, "SCOPES_REQUIRED");
    payload.data = { scopes: list };
    return payload;
  }
  if (typeof amount !== "string" || amount.trim() === "") {
    throw httpError(422, "AMOUNT_REQUIRED");
  }
  payload.data = { amount };
  return payload;
}

/**
 * Подписать HMAC и отправить интент в AW.
 * Ключи только из env, браузер их не видит.
 *
 * Подпись: hex(HMAC-SHA256(secret, "{ts}.POST.{path}.{sha256(body)}"))
 */
async function forwardIntent(payload) {
  const method = "POST";
  const raw = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = hmacSha256Hex(
    AW_API_SECRET,
    `${timestamp}.${method}.${AW_INTENTS_PATH}.${sha256Hex(raw)}`,
  );
  const url = `${AW_API_BASE}${AW_INTENTS_PATH}`;
  const upstream = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Sdk-App-Key": AW_API_KEY,
      "X-Sdk-App-Timestamp": timestamp,
      "X-Sdk-App-Signature": signature,
    },
    body: raw,
  });

  const body = await upstream.text();
  return { status: upstream.status, body };
}

/**
 * Проверка вебхука AW: hex(HMAC-SHA256(webhook_secret, "{ts}.{sha256(rawBody)}")).
 * Считаем по сырому телу — JSON.parse ломает подпись.
 */
function verifyWebhookSignature(rawBody, timestamp, signature, secret) {
  const ts = Number(timestamp);
  if (!Number.isInteger(ts)) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - ts) > WEBHOOK_MAX_SKEW_SEC) {
    return false;
  }
  const expected = hmacSha256Hex(secret, `${timestamp}.${sha256Hex(rawBody)}`);
  return equalHex(expected, signature);
}

function sendError(res, error) {
  const status = error.status ?? 500;
  const payload = { error: error.code ?? error.message ?? "INTERNAL_ERROR" };
  if (error.hint) payload.hint = error.hint;
  if (error.reason) payload.reason = error.reason;
  if (error.claim) payload.claim = error.claim;
  return res.status(status).json(payload);
}

const app = express();

app.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

app.get("/health", (_req, res) => res.json({ ok: true }));

/**
 * Как ваш сервер проверяет JWT кошелька.
 * Сессию ключуйте по userId (sub), не по userContext.
 */
app.post(
  "/api/auth/session",
  express.json({ limit: "8kb" }),
  async (req, res) => {
    try {
      const { userId, tgId, exp } = await verifyIdToken(req.body?.idToken);
      return res.json({ ok: true, userId, tgId, expiresAt: exp });
    } catch (error) {
      console.error(
        "[auth] id_token verify failed:",
        error.reason ?? error.code ?? error.message,
      );
      return sendError(res, error);
    }
  },
);

/**
 * Как ваш сервер создаёт интент.
 * Браузер шлёт idToken + type + amount.
 * Секреты и user_id из клиента не принимаем — даже если прислали, игнорируем.
 */
app.post("/api/intents", express.json({ limit: "16kb" }), async (req, res) => {
  if (!AW_API_BASE || !AW_API_KEY || !AW_API_SECRET) {
    return res.status(500).json({
      error: "MISSING_CREDENTIALS",
      hint: "Set AW_API_BASE, AW_API_KEY, AW_API_SECRET in env. Never send them from the browser.",
    });
  }
  try {
    const identity = await verifyIdToken(req.body?.idToken);
    if (identity.awUserId == null) {
      throw httpError(422, "USER_ID_REQUIRED", {
        hint: "Verified idToken sub is not a positive integer user_id.",
      });
    }
    const payload = buildIntentPayload({
      type: req.body?.type,
      amount: req.body?.amount,
      scopes: req.body?.scopes,
      userId: identity.awUserId,
      // В проде: reference_id из вашей строки заказа, не из клиента.
    });
    const upstream = await forwardIntent(payload);
    let parsed = null;
    try {
      parsed = JSON.parse(upstream.body);
    } catch {
      parsed = null;
    }
    if (upstream.status < 200 || upstream.status >= 300) {
      console.error("[intents] upstream", upstream.status);
      return res.status(upstream.status).json({
        error: parsed?.message ?? "UPSTREAM_ERROR",
        detail:
          parsed?.errors ??
          parsed?.error ??
          parsed ??
          upstream.body.slice(0, 300),
      });
    }
    const operationId = readOperationId(parsed);
    if (!operationId) return res.status(502).json({ error: "NO_OPERATION_ID" });
    return res.json({ operationId });
  } catch (error) {
    if (error.status) return sendError(res, error);
    console.error("[intents] upstream error", error);
    return res.status(502).json({ error: "UPSTREAM_FAILURE" });
  }
});

/**
 * AW → ваш сервер после approve/reject в кошельке.
 * webhook_url задаётся на SdkApp в кабинете.
 * В проде: обновить заказ по data.operation_id + event (идемпотентно).
 * express.raw — нужен сырой body для HMAC, не распарсенный JSON.
 */
app.post(
  "/api/webhooks",
  express.raw({ type: "application/json", limit: "32kb" }),
  (req, res) => {
    if (!AW_WEBHOOK_SECRET) {
      return res.status(503).json({ error: "WEBHOOK_NOT_CONFIGURED" });
    }
    const timestamp = req.get("x-sdk-webhook-timestamp");
    const signature = req.get("x-sdk-webhook-signature");
    if (
      !verifyWebhookSignature(req.body, timestamp, signature, AW_WEBHOOK_SECRET)
    ) {
      return res.status(401).json({ error: "INVALID_WEBHOOK_SIGNATURE" });
    }
    let event;
    try {
      event = JSON.parse(req.body.toString("utf8"));
    } catch {
      return res.status(400).json({ error: "INVALID_JSON" });
    }
    const operationId =
      event?.data?.operation_id ?? event?.data?.operationId ?? null;
    console.log("[webhook]", event?.event ?? "unknown", operationId);
    return res.status(200).json({ ok: true });
  },
);

if (STATIC_DIR) {
  app.use(express.static(STATIC_DIR, { extensions: ["html"] }));
}

app.use((_req, res) => res.status(404).json({ error: "NOT_FOUND" }));

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `[boot] listening on 0.0.0.0:${PORT}${STATIC_DIR ? ` (static from ${STATIC_DIR})` : ""}`,
  );
});
server.on("error", (error) => {
  console.error("[boot] listen failed", error);
  process.exit(1);
});
