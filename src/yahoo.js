// Yahoo Finance 차트 API (키 불필요). 짧게 캐시해서 과도한 호출을 막는다.

const cache = new Map();
const TTL_MS = 15_000;

async function chart(symbol, interval, range, extra = "") {
  const key = `${symbol}|${interval}|${range}|${extra}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}${extra}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; rsi-watch)", Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`시세 조회 실패 (${symbol}, HTTP ${res.status})`);
  const json = await res.json();
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error(`시세 데이터 없음 (${symbol})`);
  cache.set(key, { at: Date.now(), data: result });
  return result;
}

const WEEK = 7 * 86400;

function bars(result, keepLastNull = false) {
  const ts = result.timestamp || [];
  const closes = result.indicators?.quote?.[0]?.close || [];
  const out = [];
  for (let i = 0; i < ts.length; i++) {
    if (typeof closes[i] === "number") out.push({ t: ts[i], c: closes[i] });
    else if (keepLastNull && i === ts.length - 1) out.push({ t: ts[i], c: null });
  }
  return out;
}

/** 주봉. 마지막 봉은 진행 중인 이번 주이며 종가 자리에 정규장 현재가가 들어간다. */
export async function weekly(symbol) {
  const result = await chart(symbol, "1wk", "5y");
  // 이번 주 봉은 장 마감 뒤 종가가 비어서 오기도 한다. 버리면 지난주 봉을 이번 주로 착각하게 되므로 남겨둔다.
  const list = bars(result, true);
  // 같은 주에 실시간 봉이 한 번 더 붙어 오는 경우 하나로 합친다.
  while (list.length >= 2 && list[list.length - 1].t - list[list.length - 2].t < 5 * 86400) {
    const live = list.pop();
    if (live.c != null) list[list.length - 1].c = live.c;
  }
  const meta = result.meta || {};
  const price = meta.regularMarketPrice;
  const time = meta.regularMarketTime ?? 0;
  const last = list[list.length - 1];
  if (last && typeof price === "number") {
    if (time >= last.t + WEEK) list.push({ t: last.t + WEEK, c: price }); // 이번 주 봉이 아직 없음
    else if (time >= last.t) last.c = price; // 마지막 봉이 이번 주
  }
  if (list.length && list[list.length - 1].c == null) list.pop();
  return { bars: list, meta };
}

/** 최근 5거래일 5분봉 (프리마켓·애프터마켓 포함) */
export async function intraday(symbol) {
  return bars(await chart(symbol, "5m", "5d", "&includePrePost=true"));
}
