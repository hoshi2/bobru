/*
 * ぼぶる 中継（Cloudflare Workers + KV の参照実装）
 *
 * 役割は3つだけ。
 *   1. VPS のエージェントから約定を受け取って貯める          POST /api/deals
 *   2. ぼぶる（iPhone / PC）へ約定を渡す                     GET  /api/deals
 *   3. 市場データ業者の素の足を、キーを隠したまま中継する      GET  /api/ohlc
 *
 * ここが持つ秘密は「エージェントとの共有鍵」と「業者のAPIキー」だけ。
 * MT5 のログイン情報はここには来ないし、置く場所も無い。
 *
 * 置くもの（wrangler secret put）
 *   AGENT_SECRET    エージェントと共有する署名鍵（BOBRU_RELAY_SECRET と同じ値）
 *   READ_TOKEN      ぼぶるが読み出すためのトークン
 *   MARKET_API_KEY  市場データ業者のAPIキー（/api/ohlc を使うときだけ）
 * 変数（wrangler.toml の [vars]）
 *   ALLOW_ORIGIN    ぼぶるを置いてある URL（例 https://hoshi2.github.io）
 *   MARKET_BASE     業者のエンドポイント（既定は Twelve Data）
 * KV
 *   STORE           約定の保管場所
 */

const MAX_DEALS = 5000;          // 貯めすぎない（古いものから落とす）
const SIG_WINDOW = 300;          // 署名の有効時間（秒）

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }), env);

    try {
      if (url.pathname === "/api/deals" && request.method === "POST")
        return cors(await postDeals(request, env), env);
      if (url.pathname === "/api/deals" && request.method === "GET")
        return cors(await getDeals(request, env, url), env);
      if (url.pathname === "/api/ohlc" && request.method === "GET")
        return cors(await getOhlc(request, env, url), env);
      return cors(json({ error: "not found" }, 404), env);
    } catch (e) {
      return cors(json({ error: String(e && e.message || e) }, 500), env);
    }
  },
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
function cors(res, env) {
  const h = new Headers(res.headers);
  h.set("access-control-allow-origin", env.ALLOW_ORIGIN || "*");
  h.set("access-control-allow-methods", "GET,POST,OPTIONS");
  h.set("access-control-allow-headers", "authorization,content-type,x-bobru-timestamp,x-bobru-signature");
  h.set("access-control-max-age", "86400");
  h.set("vary", "origin");
  return new Response(res.body, { status: res.status, headers: h });
}
// 長さで漏れないよう、必ず全部を比べる
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
function bearer(request) {
  const h = request.headers.get("authorization") || "";
  return h.startsWith("Bearer ") ? h.slice(7).trim() : "";
}
function requireRead(request, env) {
  if (!env.READ_TOKEN) throw new Error("READ_TOKEN が設定されていません");
  if (!timingSafeEqual(bearer(request), env.READ_TOKEN)) return json({ error: "unauthorized" }, 401);
  return null;
}
async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* ---------- 1. エージェントからの受け取り ---------- */
async function postDeals(request, env) {
  if (!env.AGENT_SECRET) return json({ error: "AGENT_SECRET が設定されていません" }, 500);
  const ts = request.headers.get("x-bobru-timestamp") || "";
  const sig = request.headers.get("x-bobru-signature") || "";
  const skew = Math.abs(Math.floor(Date.now() / 1000) - Number(ts));
  if (!ts || !Number.isFinite(skew) || skew > SIG_WINDOW) return json({ error: "stale timestamp" }, 401);

  const body = await request.text();
  const want = await hmacHex(env.AGENT_SECRET, ts + "." + body);
  if (!timingSafeEqual(sig, want)) return json({ error: "bad signature" }, 401);

  let payload;
  try { payload = JSON.parse(body); } catch { return json({ error: "bad json" }, 400); }

  const state = (await env.STORE.get("state", "json")) || { deals: {}, positions: [], account: null };
  let added = 0;
  for (const d of (payload.deals || [])) {
    if (!d || d.ticket === undefined || d.ticket === null) continue;
    const k = String(d.ticket);
    if (!state.deals[k]) added++;
    state.deals[k] = d;                       // 同じ ticket は上書き（増やさない）
  }
  // 古いものから落として上限に収める
  const keys = Object.keys(state.deals).sort((a, b) => Number(a) - Number(b));
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_DEALS))) delete state.deals[k];

  state.positions = payload.positions || [];
  state.account = payload.account || state.account;
  state.updatedAt = new Date().toISOString();
  await env.STORE.put("state", JSON.stringify(state));
  return json({ ok: true, added, total: Object.keys(state.deals).length });
}

/* ---------- 2. ぼぶるへの受け渡し ---------- */
async function getDeals(request, env, url) {
  const bad = requireRead(request, env);
  if (bad) return bad;

  const state = (await env.STORE.get("state", "json")) || { deals: {}, positions: [], account: null };
  const since = url.searchParams.get("since");
  const sinceTicket = url.searchParams.get("sinceTicket");
  let deals = Object.values(state.deals);
  // since は「その時刻以降」。境界の1本を落とさないよう少し手前から返す
  if (since) deals = deals.filter((d) => !d.time || d.time >= since);
  if (sinceTicket) deals = deals.filter((d) => Number(d.ticket) > Number(sinceTicket) || (d.time && since && d.time >= since));
  deals.sort((a, b) => String(a.time || "").localeCompare(String(b.time || "")));

  return json({
    source: "中継", asOf: state.updatedAt || new Date().toISOString(),
    account: state.account, deals, positions: state.positions || [], notes: [],
  });
}

/* ---------- 3. 市場データの中継（素の足だけを返す） ----------
 * 指標の計算はぼぶる側でやる。ここは業者のキーを隠すためだけに居る。
 * 既定は Twelve Data。別の業者にするならこの関数だけ書き換える。
 */
const TF_MAP = { "1day": "1day", "4h": "4h", "1h": "1h", "15min": "15min" };
const SIZE = { "1day": 300, "4h": 400, "1h": 400, "15min": 200 };

async function getOhlc(request, env, url) {
  const bad = requireRead(request, env);
  if (bad) return bad;
  if (!env.MARKET_API_KEY) return json({ error: "MARKET_API_KEY が設定されていません" }, 500);

  const symbol = (url.searchParams.get("symbol") || "XAUUSD").toUpperCase();
  const base = env.MARKET_BASE || "https://api.twelvedata.com";
  const vendor = symbol === "XAUUSD" ? "XAU/USD" : symbol;
  const notes = [];

  const series = {};
  for (const tf of Object.keys(TF_MAP)) {
    try {
      const r = await fetch(`${base}/time_series?symbol=${encodeURIComponent(vendor)}` +
        `&interval=${TF_MAP[tf]}&outputsize=${SIZE[tf]}&timezone=UTC&apikey=${env.MARKET_API_KEY}`);
      const j = await r.json();
      if (!j || !Array.isArray(j.values)) { notes.push(`${tf} は取得できませんでした。`); continue; }
      // 業者は新しい順に返すので、古い順へ直して素の足として渡す
      series[tf] = j.values.slice().reverse().map((v) => ({
        t: String(v.datetime).replace(" ", "T") + (String(v.datetime).length <= 10 ? "T00:00:00Z" : "Z"),
        o: Number(v.open), h: Number(v.high), l: Number(v.low), c: Number(v.close),
      })).filter((b) => Number.isFinite(b.c));
    } catch (e) {
      notes.push(`${tf} の取得で失敗しました: ${String(e && e.message || e)}`);
    }
  }

  const quotes = {};
  for (const [key, vsym] of [["USDJPY", "USD/JPY"], ["DXY", "DXY"], ["US10Y", "US10Y"]]) {
    try {
      const r = await fetch(`${base}/quote?symbol=${encodeURIComponent(vsym)}&apikey=${env.MARKET_API_KEY}`);
      const j = await r.json();
      if (j && j.close !== undefined) quotes[key] = { last: Number(j.close), chg: Number(j.change) };
      else notes.push(`${key} は取得できませんでした。`);
    } catch {
      notes.push(`${key} の取得で失敗しました。`);
    }
  }

  return json({
    source: "中継（" + new URL(base).host + "）",
    asOf: new Date().toISOString(),
    series: { [symbol]: series },
    quotes, notes,
  });
}
