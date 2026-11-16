import test from "node:test";
import assert from "node:assert/strict";
import { wilderStates, rsiOf, rsiAtPrice, priceForRsi } from "../src/rsi.js";

// Wilder의 원저(New Concepts in Technical Trading Systems)에서 널리 인용되는 예제 데이터
const closes = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28, 46.0, 46.03, 46.41, 46.22, 45.64];
const expected = { 14: 70.46, 15: 66.25, 16: 66.48, 17: 69.35, 18: 66.29, 19: 57.92 };

test("Wilder RSI가 기준 예제와 일치한다", () => {
  const states = wilderStates(closes);
  for (const [i, v] of Object.entries(expected)) {
    assert.ok(Math.abs(rsiOf(states[i]) - v) < 0.1, `index ${i}: ${rsiOf(states[i])} vs ${v}`);
  }
  assert.equal(states[13], null);
});

test("rsiAtPrice는 마지막 봉을 직접 계산한 값과 같다", () => {
  const states = wilderStates(closes);
  const n = closes.length - 1;
  assert.ok(Math.abs(rsiAtPrice(states[n - 1], closes[n - 1], closes[n]) - rsiOf(states[n])) < 1e-9);
});

test("priceForRsi는 rsiAtPrice의 역함수다 (하락/상승 양쪽)", () => {
  const states = wilderStates(closes);
  const n = closes.length - 1;
  for (const target of [20, 36, 50, 65, 80]) {
    const p = priceForRsi(states[n - 1], closes[n - 1], target);
    assert.ok(Math.abs(rsiAtPrice(states[n - 1], closes[n - 1], p) - target) < 1e-6, `target ${target}`);
  }
});
