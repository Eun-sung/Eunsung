# RSI 워치

미국 주식(기본: TQQQ, SOXL)의 **주봉 RSI(14)** 를 아이폰에서 실시간으로 보고, 기준값(기본 36) 이하로 내려가면 텔레그램으로 알림을 받는 개인용 웹앱입니다. Cloudflare Workers 무료 플랜 하나로 동작합니다.

- 화면: 현재 주봉 RSI, 기준까지 남은 거리, "RSI가 기준이 되는 가격", 최근 5일(5분 단위)·1년 추이 차트. 열어두면 15초마다 갱신됩니다.
- 알림: 미국 정규장 시간에 5분마다 확인해, 기준 이하로 내려간 순간 한 번 보냅니다. 기준 +1 위로 회복된 뒤 다시 내려가면 또 보냅니다.
- 시세: Yahoo Finance 차트 API(키 불필요, 비공식). 이번 주 봉의 종가 자리에 현재가를 넣어 계산합니다(Wilder 평활).

## 배포

1. **텔레그램 봇 만들기** — 텔레그램에서 `@BotFather`에게 `/newbot`을 보내고 받은 토큰을 적어둡니다.
2. **Cloudflare에 배포** — 둘 중 하나:
   - 대시보드: Workers & Pages → Create → 이 GitHub 저장소를 가져오기(코드가 있는 브랜치 선택) → 배포
   - 터미널: `npm install` 후 `npx wrangler deploy`
3. **시크릿 2개 등록** (Worker → Settings → Variables and Secrets, 또는 `npx wrangler secret put <이름>`)
   - `TELEGRAM_BOT_TOKEN`: 1번에서 받은 토큰
   - `APP_PIN`: 설정을 바꿀 때 쓸 비밀번호(직접 정함)
4. **알림 연결** — 텔레그램에서 내 봇에게 아무 메시지나 보낸 뒤, 앱의 설정 → PIN 입력 → ‘연결’. 확인 메시지가 오면 끝입니다.
5. **아이폰에 설치** — Safari에서 배포된 주소를 열고 공유 → ‘홈 화면에 추가’.

종목과 기준값은 앱의 설정에서 바꿉니다(최대 10종목).

## 개발

```bash
npm install
npm test        # RSI 계산 검증
npm run dev     # http://localhost:8787 (로컬 PIN: 1234)
```
