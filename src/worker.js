import { wilderStates, rsiOf, rsiAtPrice, priceForRsi } from "./rsi.js";
import { weekly, intraday } from "./yahoo.js";
import * as kis from "./kis.js";

const DEFAULT_ITEMS = [
  { symbol: "TQQQ", threshold: 36 },
  { symbol: "SOXL", threshold: 36 },
];
const SYMBOL_RE = /^[A-Z0-9.\-^=]{1,12}$/;
const REARM_MARGIN = 1; // 기준 +1 위로 올라가야 다음 알림이 다시 준비된다
const MAX_ITEMS = 10;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });

async function getConfig(env) {
  const saved = (await env.KV.get("config", "json")) || {};
  return {
    items: Array.isArray(saved.items) && saved.items.length ? saved.items : DEFAULT_ITEMS,
    chatId: saved.chatId || env.TELEGRAM_CHAT_ID || null,
  };
}

const WEEK = 7 * 86400;
const NEW_WEEK_LEAD = 6 * 3600;

function sessionOf(meta, now) {
  const p = meta.currentTradingPeriod;
  if (!p) return "closed";
  if (now >= p.regular.start && now < p.regular.end) return "regular";
  if (now >= p.pre.start && now < p.pre.end) return "pre";
  if (now >= p.post.start && now < p.post.end) return "post";
  return "closed";
}

/** 한 종목의 현재 주봉 RSI와 차트용 추이를 계산한다. 프리·애프터마켓, (설정 시) 주간거래 가격도 반영한다. */
export async function analyze(symbol, threshold, withSeries, env = {}) {
  const [{ bars, meta }, minutes] = await Promise.all([weekly(symbol), intraday(symbol)]);
  if (!bars.length) throw new Error(`주봉 데이터 없음 (${symbol})`);

  // 정규장 마지막 체결보다 새로운 5분봉이 있으면 장전/장후 가격이다.
  const regularPrice = meta.regularMarketPrice ?? bars[bars.length - 1].c;
  const regularTime = meta.regularMarketTime ?? 0;
  const tailBar = minutes[minutes.length - 1];
  let extended = !!tailBar && tailBar.t > regularTime + 60;
  let price = extended ? tailBar.c : regularPrice;
  let priceTime = extended ? tailBar.t : regularTime;
  let session = sessionOf(meta, Date.now() / 1000);
  let source = "yahoo";

  // 프리~애프터마켓이 아닌 시간에는 주간거래 시세 중 더 새로운 것만 이어 붙인다.
  if (session === "closed") {
    const newer = (await kis.overnightBars(env, symbol, meta.exchangeName)).filter((b) => b.t > priceTime);
    if (newer.length) {
      minutes.push(...newer);
      const tip = newer[newer.length - 1];
      price = tip.c;
      priceTime = tip.t;
      extended = true;
      source = "kis";
      if (Date.now() / 1000 - tip.t < 30 * 60) session = "overnight";
    }
  }

  // 월요일 장전처럼 새 주가 시작됐는데 주봉이 아직 없으면 이번 주 봉을 만들어 붙인다.
  const lastWeek = bars[bars.length - 1];
  // (주간거래는 뉴욕 일요일 저녁에 새 주가 시작되므로 6시간 여유를 둔다)
  if (priceTime >= lastWeek.t + WEEK - NEW_WEEK_LEAD) bars.push({ t: lastWeek.t + WEEK, c: price });
  else lastWeek.c = price;

  const closes = bars.map((b) => b.c);
  const states = wilderStates(closes);
  const last = closes.length - 1;
  if (last < 1 || !states[last - 1]) throw new Error(`주봉 데이터 부족 (${symbol})`);
  const prev = states[last - 1];
  const prevClose = closes[last - 1];
  const out = {
    symbol,
    threshold,
    price,
    session,
    extended,
    source,
    // 장전/장후에는 직전 정규장 종가 대비 등락률
    changePct: extended ? (price / regularPrice - 1) * 100 : meta.regularMarketChangePercent ?? null,
    marketTime: priceTime || null,
    rsi: rsiAtPrice(prev, prevClose, price),
    prevWeekRsi: rsiOf(prev),
    prevWeekClose: prevClose,
    triggerPrice: priceForRsi(prev, prevClose, threshold),
  };
  if (!withSeries) return out;

  out.weekly = [];
  for (let i = Math.max(0, last - 51); i <= last; i++) {
    const v = rsiOf(states[i]);
    if (v != null) out.weekly.push({ t: bars[i].t, v, p: closes[i] });
  }
  // 5분봉 가격을 "그 시점의 주봉 종가"로 넣어 주봉 RSI의 장중 움직임을 만든다.
  out.intraday = [];
  let w = 0;
  for (const bar of minutes) {
    while (w + 1 < bars.length && bars[w + 1].t - NEW_WEEK_LEAD <= bar.t) w++;
    if (w < 1 || !states[w - 1]) continue;
    out.intraday.push({ t: bar.t, v: rsiAtPrice(states[w - 1], closes[w - 1], bar.c), p: bar.c });
  }
  // 마지막 점은 항상 현재가 기준 값으로 맞춘다.
  const live = { t: out.marketTime || Math.floor(Date.now() / 1000), v: out.rsi, p: price };
  const tail = out.intraday[out.intraday.length - 1];
  if (tail && tail.t >= live.t - 60) out.intraday[out.intraday.length - 1] = live;
  else if (tail) out.intraday.push(live);
  return out;
}

async function telegram(env, method, body) {
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN 시크릿이 설정되지 않았습니다.");
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(`텔레그램 오류: ${data.description || res.status}`);
  return data.result;
}

const usd = (n) => `$${n.toFixed(2)}`;

/** 크론: 기준 이하로 내려간 순간에만 한 번 알린다. */
export async function checkAlerts(env) {
  const config = await getConfig(env);
  const state = (await env.KV.get("state", "json")) || {};
  let changed = false;
  for (const { symbol, threshold } of config.items) {
    try {
      const a = await analyze(symbol, threshold, false, env);
      const wasBelow = !!state[symbol]?.below;
      if (a.rsi <= threshold && !wasBelow) {
        if (!config.chatId) continue; // 연결 전에는 상태를 바꾸지 않아, 연결 후 바로 알림이 간다
        await telegram(env, "sendMessage", {
          chat_id: config.chatId,
          text:
            `📉 ${symbol} 주봉 RSI ${a.rsi.toFixed(1)} — 기준 ${threshold} 이하\n` +
            `현재가 ${usd(a.price)}` +
            (a.changePct != null ? ` (${a.changePct >= 0 ? "+" : ""}${a.changePct.toFixed(2)}%)` : "") +
            (a.source === "kis" ? " · 주간거래" : a.extended ? (a.session === "pre" ? " · 프리마켓" : " · 애프터마켓") : "") +
            `\n지난주 RSI ${a.prevWeekRsi.toFixed(1)}`,
        });
        state[symbol] = { below: true, at: Date.now() };
        changed = true;
      } else if (wasBelow && a.rsi > threshold + REARM_MARGIN) {
        state[symbol] = { below: false, at: Date.now() };
        changed = true;
      }
    } catch (err) {
      console.error(`alert check failed for ${symbol}:`, err.message);
    }
  }
  if (changed) await env.KV.put("state", JSON.stringify(state));
}

function requirePin(request, env) {
  if (!env.APP_PIN) return "APP_PIN 시크릿을 먼저 설정해야 설정을 바꿀 수 있습니다.";
  if (request.headers.get("x-pin") !== env.APP_PIN) return "PIN이 올바르지 않습니다.";
  return null;
}

async function handleApi(request, env, path) {
  if (path === "/api/data" && request.method === "GET") {
    const config = await getConfig(env);
    const symbols = await Promise.all(
      config.items.map(({ symbol, threshold }) =>
        analyze(symbol, threshold, true, env).catch((err) => ({ symbol, threshold, error: err.message })),
      ),
    );
    return json({
      symbols,
      telegram: { hasToken: !!env.TELEGRAM_BOT_TOKEN, connected: !!config.chatId },
      overnight: { configured: kis.configured(env), error: kis.status.error },
      writable: !!env.APP_PIN,
      now: Date.now(),
    });
  }

  if (request.method !== "POST") return json({ error: "지원하지 않는 요청입니다." }, 405);
  const denied = requirePin(request, env);
  if (denied) return json({ error: denied }, 403);
  const config = await getConfig(env);

  if (path === "/api/config") {
    const body = await request.json().catch(() => null);
    const items = [];
    for (const it of body?.items || []) {
      const symbol = String(it.symbol || "").trim().toUpperCase();
      const threshold = Number(it.threshold);
      if (!SYMBOL_RE.test(symbol)) return json({ error: `종목 코드가 올바르지 않습니다: ${symbol}` }, 400);
      if (!(threshold > 0 && threshold < 100)) return json({ error: `${symbol}: 기준값은 0~100 사이여야 합니다.` }, 400);
      if (!items.some((x) => x.symbol === symbol)) items.push({ symbol, threshold });
    }
    if (!items.length || items.length > MAX_ITEMS) return json({ error: `종목은 1~${MAX_ITEMS}개여야 합니다.` }, 400);
    for (const it of items) {
      try {
        await analyze(it.symbol, it.threshold, false, env);
      } catch {
        return json({ error: `${it.symbol}: 시세를 찾을 수 없습니다.` }, 400);
      }
    }
    await env.KV.put("config", JSON.stringify({ items, chatId: config.chatId }));
    await env.KV.delete("state"); // 기준이 바뀌었으니 알림 상태를 초기화
    return json({ ok: true });
  }

  if (path === "/api/telegram/connect") {
    // 봇에게 마지막으로 메시지를 보낸 대화방을 알림 대상으로 등록한다.
    const updates = await telegram(env, "getUpdates", { limit: 20, allowed_updates: ["message"] });
    const chat = updates.map((u) => u.message?.chat).filter(Boolean).pop();
    if (!chat) return json({ error: "봇에게 보낸 메시지를 찾지 못했습니다. 텔레그램에서 봇에게 아무 메시지나 보낸 뒤 다시 눌러주세요." }, 400);
    await env.KV.put("config", JSON.stringify({ items: config.items, chatId: chat.id }));
    await telegram(env, "sendMessage", { chat_id: chat.id, text: "✅ RSI 알림이 연결되었습니다." });
    return json({ ok: true });
  }

  if (path === "/api/telegram/test") {
    if (!config.chatId) return json({ error: "먼저 텔레그램을 연결해주세요." }, 400);
    await telegram(env, "sendMessage", { chat_id: config.chatId, text: "🔔 RSI 알림 테스트 메시지입니다." });
    return json({ ok: true });
  }

  return json({ error: "없는 경로입니다." }, 404);
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith("/api/")) {
      try {
        return await handleApi(request, env, pathname);
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }
    return env.ASSETS.fetch(request);
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(checkAlerts(env));
  },
};
