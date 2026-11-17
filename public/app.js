const POLL_MS = 15_000;
const SVG = "http://www.w3.org/2000/svg";
const $ = (id) => document.getElementById(id);
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};

let data = null;
const views = new Map(); // 종목별 선택한 차트 탭

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  node.append(...children.filter((c) => c != null));
  return node;
}
function svg(tag, attrs = {}, text) {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text != null) node.textContent = text;
  return node;
}

const usd = (n) => `$${n.toFixed(2)}`;
const pct = (n) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
const etDay = new Intl.DateTimeFormat("ko-KR", { timeZone: "America/New_York", weekday: "short" });
const etDate = new Intl.DateTimeFormat("ko-KR", { timeZone: "America/New_York", month: "numeric", day: "numeric" });
const etDateKey = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" });
const etMonth = new Intl.DateTimeFormat("ko-KR", { timeZone: "America/New_York", month: "short" });
const kstTime = new Intl.DateTimeFormat("ko-KR", { month: "numeric", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false });

/* ---------- 차트 ---------- */

function drawChart(host, points, threshold, mode) {
  host.replaceChildren();
  const W = host.clientWidth || 320;
  const H = 170;
  const m = { l: 6, r: 34, t: 10, b: 20 };
  host.setAttribute("viewBox", `0 0 ${W} ${H}`);
  if (points.length < 2) {
    host.append(svg("text", { x: W / 2, y: H / 2, "text-anchor": "middle" }, "표시할 데이터가 아직 없습니다"));
    return;
  }
  const values = points.map((p) => p.v);
  let lo = Math.min(...values, threshold);
  let hi = Math.max(...values, threshold);
  const pad = Math.max((hi - lo) * 0.12, 0.5);
  lo = Math.max(0, lo - pad);
  hi = Math.min(100, hi + pad);
  const x = (i) => m.l + (i / (points.length - 1)) * (W - m.l - m.r);
  const y = (v) => m.t + ((hi - v) / (hi - lo)) * (H - m.t - m.b);

  // 가로 눈금
  const step = [1, 2, 5, 10, 20].find((s) => (hi - lo) / s <= 4) || 25;
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
    if (Math.abs(y(v) - y(threshold)) < 11) continue; // 기준선 라벨과 겹치지 않게
    host.append(svg("line", { class: "grid", x1: m.l, x2: W - m.r, y1: y(v), y2: y(v) }));
    host.append(svg("text", { x: W - m.r + 6, y: y(v) + 4 }, String(v)));
  }

  // 세로 축 라벨: 장중 보기는 요일, 1년 보기는 월
  let lastLabelX = -99;
  let prevKey = null;
  points.forEach((p, i) => {
    const d = new Date(p.t * 1000);
    const key = mode === "intraday" ? etDateKey.format(d) : etDateKey.format(d).slice(0, 7);
    if (key !== prevKey && (mode === "intraday" || prevKey !== null) && x(i) - lastLabelX > (mode === "intraday" ? 66 : 34) && x(i) < W - m.r - 16) {
      host.append(svg("text", { x: x(i), y: H - 5 }, mode === "intraday" ? `${etDay.format(d)} ${d && etDate.format(d).replace(/\s/g, "")}` : etMonth.format(d)));
      lastLabelX = x(i);
    }
    prevKey = key;
  });

  // 알림 기준선
  host.append(svg("line", { class: "thr", x1: m.l, x2: W - m.r, y1: y(threshold), y2: y(threshold) }));
  host.append(svg("text", { class: "thr-label", x: W - m.r + 6, y: y(threshold) + 4 }, String(threshold)));

  host.append(svg("path", { class: "line", d: points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(2)},${y(p.v).toFixed(2)}`).join("") }));
  const last = points.length - 1;
  const cross = svg("line", { class: "cross", y1: m.t, y2: H - m.b, visibility: "hidden" });
  const dot = svg("circle", { class: "dot", r: 4.5, cx: x(last), cy: y(points[last].v) });
  host.append(cross, dot);

  // 손가락/마우스를 따라가는 십자선과 값 표시
  const tip = $("tip");
  const show = (ev) => {
    const box = host.getBoundingClientRect();
    const ratio = (ev.clientX - box.left - m.l) / (box.width - m.l - m.r);
    const i = Math.max(0, Math.min(last, Math.round(ratio * last)));
    const p = points[i];
    cross.setAttribute("x1", x(i));
    cross.setAttribute("x2", x(i));
    cross.setAttribute("visibility", "visible");
    dot.setAttribute("cx", x(i));
    dot.setAttribute("cy", y(p.v));
    const when = mode === "intraday" ? kstTime.format(new Date(p.t * 1000)) : `${etDate.format(new Date(p.t * 1000))} 주`;
    tip.replaceChildren(el("b", {}, `RSI ${p.v.toFixed(2)}`), el("br"), `${usd(p.p)} · ${when}`);
    tip.hidden = false;
    const tw = tip.offsetWidth;
    tip.style.left = `${Math.max(8, Math.min(window.innerWidth - tw - 8, box.left + x(i) - tw / 2))}px`;
    tip.style.top = `${Math.max(8, box.top - tip.offsetHeight - 4)}px`;
  };
  const hide = () => {
    tip.hidden = true;
    cross.setAttribute("visibility", "hidden");
    dot.setAttribute("cx", x(last));
    dot.setAttribute("cy", y(points[last].v));
  };
  host.onpointerdown = host.onpointermove = show;
  host.onpointerleave = host.onpointerup = host.onpointercancel = hide;
}

/* ---------- 카드 ---------- */

function card(s) {
  if (s.error) {
    return el("article", { class: "card" }, el("div", { class: "sym" }, s.symbol), el("p", { class: "err-box" }, s.error));
  }
  const below = s.rsi <= s.threshold;
  const gap = s.rsi - s.threshold;
  const view = views.get(s.symbol) || "intraday";
  const chart = svg("svg", { class: "chart", role: "img", "aria-label": `${s.symbol} 주봉 RSI 추이` });
  const render = () => drawChart(chart, views.get(s.symbol) === "weekly" ? s.weekly : s.intraday, s.threshold, views.get(s.symbol) || "intraday");
  const tab = (id, label) =>
    el("button", {
      type: "button",
      "aria-pressed": String(view === id),
      onclick: (ev) => {
        views.set(s.symbol, id);
        store.set("views", JSON.stringify([...views]));
        for (const b of ev.target.parentNode.children) b.setAttribute("aria-pressed", String(b === ev.target));
        render();
      },
    }, label);
  const toTrigger = s.triggerPrice != null ? (s.triggerPrice / s.price - 1) * 100 : null;
  const dayClass = s.changePct >= 0 ? "up" : "down";
  const sessionLabel = { pre: "프리마켓", post: "애프터마켓", overnight: "주간거래", regular: null }[s.session]
    ?? (s.source === "kis" ? "주간거래 마감" : s.extended ? "애프터마켓 마감" : "장 마감");

  const node = el("article", { class: `card${below ? " below" : ""}` },
    el("div", { class: "top" },
      el("span", { class: "sym" }, s.symbol),
      el("span", { class: "price" }, sessionLabel ? el("span", { class: "session" }, sessionLabel) : null, `${usd(s.price)} `, s.changePct != null ? el("span", { class: dayClass }, pct(s.changePct)) : null),
    ),
    el("div", { class: "hero" },
      el("span", { class: "rsi" }, s.rsi.toFixed(2)),
      el("span", { class: `badge${below ? " below" : ""}` }, below ? `▼ 기준 ${s.threshold} 이하` : `기준 ${s.threshold}까지 ${gap.toFixed(2)}`),
    ),
    el("dl", { class: "facts" },
      el("div", { class: "fact" },
        el("dt", {}, `RSI ${s.threshold}이 되는 가격`),
        el("dd", {}, s.triggerPrice != null ? `${usd(s.triggerPrice)} ` : "–", toTrigger != null ? el("small", {}, pct(toTrigger)) : null),
      ),
      el("div", { class: "fact" },
        el("dt", {}, "지난주 마감 RSI"),
        el("dd", {}, `${s.prevWeekRsi.toFixed(2)} `, el("small", {}, usd(s.prevWeekClose))),
      ),
    ),
    el("div", { class: "tabs", role: "group", "aria-label": "차트 기간" }, tab("intraday", "최근 5일"), tab("weekly", "1년")),
    chart,
  );
  node._render = render;
  return node;
}

// 맨 위 한 줄 요약: 종목별 현재 RSI와 기준까지 남은 거리. 브라우저 탭 제목에도 같은 내용을 넣는다.
function renderSummary() {
  const ok = data.symbols.filter((s) => !s.error);
  $("summary").replaceChildren(...ok.map((s) => {
    const below = s.rsi <= s.threshold;
    return el("span", { class: below ? "below" : "" },
      el("span", { class: "s-sym" }, s.symbol),
      el("span", { class: "s-rsi" }, s.rsi.toFixed(2)),
      el("span", { class: "s-gap" }, below ? `▼ ${s.threshold} 이하` : `기준까지 ${(s.rsi - s.threshold).toFixed(2)}`),
    );
  }));
  if (ok.length) document.title = ok.map((s) => `${s.symbol} ${s.rsi.toFixed(2)}`).join(" · ");
}

function renderCards() {
  const host = $("cards");
  const nodes = data.symbols.map(card);
  host.replaceChildren(...nodes);
  nodes.forEach((n) => n._render?.());
}

/* ---------- 데이터 ---------- */

async function refresh() {
  const status = $("status");
  try {
    const res = await fetch("/api/data");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
    renderSummary();
    if (!$("tip").hidden) return; // 차트를 만지는 중이면 다음 주기에 갱신
    renderCards();
    renderSettings(false);
    const t = Math.max(...data.symbols.map((s) => s.marketTime || 0));
    status.className = "status";
    status.textContent = t ? `시세 기준 ${kstTime.format(new Date(t * 1000))}` : "";
  } catch (err) {
    status.className = "status err";
    status.textContent = `갱신 실패 · ${err.message}`;
  }
}

/* ---------- 설정 ---------- */

let itemsDirty = false;

function itemRow(symbol = "", threshold = 36) {
  const row = el("div", { class: "item" },
    el("input", { name: "symbol", value: symbol, placeholder: "종목 (예: TQQQ)", autocapitalize: "characters", autocomplete: "off", "aria-label": "종목 코드" }),
    el("input", { name: "threshold", value: threshold, type: "number", inputmode: "decimal", min: 1, max: 99, step: "0.5", "aria-label": "알림 기준 RSI" }),
    el("button", { type: "button", class: "del", "aria-label": "종목 삭제", onclick: () => { row.remove(); itemsDirty = true; } }, "✕"),
  );
  row.addEventListener("input", () => { itemsDirty = true; });
  return row;
}

function renderSettings(force) {
  if (!data) return;
  if (force || !itemsDirty) {
    $("items").replaceChildren(...data.symbols.map((s) => itemRow(s.symbol, s.threshold)));
    itemsDirty = false;
  }
  const on = data.overnight || {};
  $("on-state").textContent = !on.configured
    ? "주간거래 시세: 사용 안 함 (한국투자증권 키 미설정)"
    : on.error ? `주간거래 시세: 오류 — ${on.error}` : "주간거래 시세: 연결됨 (한국투자증권)";
  const tg = data.telegram;
  $("tg-state").textContent = !tg.hasToken
    ? "상태: 봇 토큰(TELEGRAM_BOT_TOKEN)이 아직 설정되지 않았습니다."
    : tg.connected ? "상태: 연결됨 — 기준 이하로 내려가면 알림이 옵니다." : "상태: 아직 연결되지 않았습니다.";
}

function say(text, isError) {
  const msg = $("msg");
  msg.textContent = text;
  msg.className = `msg${isError ? " err" : ""}`;
}

async function post(path, body, button) {
  const pin = $("pin").value.trim();
  if (!pin) return say("PIN을 입력해주세요.", true);
  store.set("pin", pin);
  button.disabled = true;
  try {
    const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json", "x-pin": pin }, body: JSON.stringify(body || {}) });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.error || `HTTP ${res.status}`);
    return true;
  } catch (err) {
    say(err.message, true);
    return false;
  } finally {
    button.disabled = false;
  }
}

$("add").onclick = () => { $("items").append(itemRow()); itemsDirty = true; };
$("save").onclick = async (ev) => {
  const items = [...$("items").children].map((row) => ({
    symbol: row.querySelector("[name=symbol]").value.trim().toUpperCase(),
    threshold: Number(row.querySelector("[name=threshold]").value),
  })).filter((it) => it.symbol);
  if (await post("/api/config", { items }, ev.target)) {
    itemsDirty = false;
    say("저장했습니다.");
    await refresh();
  }
};
$("tg-connect").onclick = async (ev) => {
  if (await post("/api/telegram/connect", null, ev.target)) { say("연결했습니다. 텔레그램에서 확인 메시지를 확인하세요."); await refresh(); }
};
$("tg-test").onclick = async (ev) => {
  if (await post("/api/telegram/test", null, ev.target)) say("테스트 알림을 보냈습니다.");
};

/* ---------- 시작 ---------- */

try { for (const [k, v] of JSON.parse(store.get("views") || "[]")) views.set(k, v); } catch {}
$("pin").value = store.get("pin") || "";

let timer = null;
function schedule() {
  clearInterval(timer);
  if (document.visibilityState === "visible") {
    refresh();
    timer = setInterval(refresh, POLL_MS);
  }
}
document.addEventListener("visibilitychange", schedule);
let resizeTimer = null;
window.addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => data && renderCards(), 150); });
schedule();
