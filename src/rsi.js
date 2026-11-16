// 주봉 RSI 계산 (Wilder 평활, TradingView 등 일반 차트와 같은 방식)

export const PERIOD = 14;

/**
 * closes[i]까지 반영한 평균 상승/하락 상태를 인덱스별로 돌려준다.
 * 데이터가 부족한 앞부분은 null.
 */
export function wilderStates(closes, period = PERIOD) {
  const states = new Array(closes.length).fill(null);
  if (closes.length <= period) return states;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gain += d;
    else loss -= d;
  }
  let ag = gain / period;
  let al = loss / period;
  states[period] = { ag, al };
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (period - 1) + Math.max(d, 0)) / period;
    al = (al * (period - 1) + Math.max(-d, 0)) / period;
    states[i] = { ag, al };
  }
  return states;
}

export function rsiOf(state) {
  if (!state) return null;
  if (state.al === 0) return state.ag === 0 ? 50 : 100;
  return 100 - 100 / (1 + state.ag / state.al);
}

/** 직전 주까지의 상태(prev)와 직전 주 종가에서, 이번 주 가격이 price일 때의 RSI */
export function rsiAtPrice(prev, prevClose, price, period = PERIOD) {
  if (!prev) return null;
  const d = price - prevClose;
  return rsiOf({
    ag: (prev.ag * (period - 1) + Math.max(d, 0)) / period,
    al: (prev.al * (period - 1) + Math.max(-d, 0)) / period,
  });
}

/** 이번 주 RSI가 정확히 target이 되는 가격 (rsiAtPrice의 역함수) */
export function priceForRsi(prev, prevClose, target, period = PERIOD) {
  if (!prev || !(target > 0 && target < 100)) return null;
  const ratio = target / (100 - target); // 목표 ag/al
  const n = period - 1;
  // 가격이 내려서 도달하는 경우
  const loss = (period * ((prev.ag * n) / period)) / ratio - prev.al * n;
  if (loss >= 0) {
    const p = prevClose - loss;
    return p > 0 ? p : null;
  }
  // 가격이 올라야 도달하는 경우
  const gain = period * ((prev.al * n) / period) * ratio - prev.ag * n;
  return prevClose + gain;
}
