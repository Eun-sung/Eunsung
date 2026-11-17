// 한국투자증권 Open API: 미국 주식 주간거래(뉴욕 20:00~04:00) 5분봉.
// KIS_APP_KEY / KIS_APP_SECRET 시크릿이 있을 때만 쓰인다.

const BASE = "https://openapi.koreainvestment.com:9443";
const TTL_MS = 15_000;

let memToken = null; // { token, exp }
let tokenPromise = null;
const barCache = new Map();
const excdCache = new Map();
export const status = { error: null, at: 0 };

export const configured = (env) => !!(env.KIS_APP_KEY && env.KIS_APP_SECRET);

async function issueToken(env) {
  const saved = await env.KV.get("kis_token", "json");
  if (saved && saved.exp > Date.now() + 60_000) return saved;
  const res = await fetch(`${BASE}/oauth2/tokenP`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ grant_type: "client_credentials", appkey: env.KIS_APP_KEY, appsecret: env.KIS_APP_SECRET }),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.access_token) throw new Error(`토큰 발급 실패: ${data.error_description || data.msg1 || `HTTP ${res.status}`}`);
  // 토큰은 하루짜리이고 재발급 횟수 제한이 있어 KV에 보관한다. 만료 1시간 전에 새로 받는다.
  const fresh = { token: data.access_token, exp: Date.now() + (Number(data.expires_in) || 86400) * 1000 - 3600_000 };
  await env.KV.put("kis_token", JSON.stringify(fresh));
  return fresh;
}

async function getToken(env) {
  if (memToken && memToken.exp > Date.now() + 60_000) return memToken.token;
  tokenPromise ||= issueToken(env).finally(() => { tokenPromise = null; });
  memToken = await tokenPromise;
  return memToken.token;
}

/** 한국 시간 "YYYYMMDD" + "HHMMSS" → 유닉스 초 */
function kstToUnix(ymd, hms) {
  const n = (s, a, b) => Number(s.slice(a, b));
  return Date.UTC(n(ymd, 0, 4), n(ymd, 4, 6) - 1, n(ymd, 6, 8), n(hms, 0, 2) - 9, n(hms, 2, 4), n(hms, 4, 6)) / 1000;
}

async function minuteBars(env, excd, symbol) {
  const token = await getToken(env);
  const q = new URLSearchParams({ AUTH: "", EXCD: excd, SYMB: symbol, NMIN: "5", PINC: "0", NEXT: "", NREC: "120", FILL: "", KEYB: "" });
  const res = await fetch(`${BASE}/uapi/overseas-price/v1/quotations/inquire-time-itemchartprice?${q}`, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      authorization: `Bearer ${token}`,
      appkey: env.KIS_APP_KEY,
      appsecret: env.KIS_APP_SECRET,
      tr_id: "HHDFS76950200",
      custtype: "P",
    },
  });
  const data = await res.json().catch(() => ({}));
  if (data.rt_cd !== "0") {
    if (res.status === 401 || /token|토큰/i.test(data.msg1 || "")) { memToken = null; await env.KV.delete("kis_token"); }
    throw new Error(`시세 조회 실패: ${data.msg1 || `HTTP ${res.status}`}`);
  }
  const out = [];
  for (const row of data.output2 || []) {
    const c = Number(row.last);
    if (c > 0 && row.kymd && row.khms) out.push({ t: kstToUnix(row.kymd, row.khms), c });
  }
  return out.sort((a, b) => a.t - b.t);
}

// Yahoo 거래소 이름 → 한국투자증권 주간거래 코드 (나스닥/뉴욕/아멕스)
function candidates(exchangeName) {
  if (/^N[MGC][SM]$/.test(exchangeName || "")) return ["BAQ", "BAA", "BAY"];
  if (exchangeName === "NYQ") return ["BAY", "BAA", "BAQ"];
  return ["BAA", "BAY", "BAQ"];
}

/** 주간거래 5분봉(시간순). 설정이 없거나 실패하면 빈 배열 — 앱은 기존 시세로 계속 동작한다. */
export async function overnightBars(env, symbol, exchangeName) {
  if (!configured(env)) return [];
  const hit = barCache.get(symbol);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.bars;
  try {
    let bars = [];
    for (const excd of excdCache.has(symbol) ? [excdCache.get(symbol)] : candidates(exchangeName)) {
      bars = await minuteBars(env, excd, symbol);
      if (bars.length) { excdCache.set(symbol, excd); break; }
    }
    status.error = null;
    status.at = Date.now();
    barCache.set(symbol, { at: Date.now(), bars });
    return bars;
  } catch (err) {
    status.error = err.message;
    status.at = Date.now();
    console.error(`KIS ${symbol}:`, err.message);
    return [];
  }
}
