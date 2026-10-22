# 경쟁 사이트 비교 입력 및 수집 정책

`configs/competitors.json`에는 여섯 후보가 등록되어 있습니다. 기본값은 모두 `enabled: false`, `manualFeatures: []`이며 외부 페이지를 자동 수집하지 않습니다.

## 수동 비교

공개 사이트를 직접 검토한 뒤 해당 항목에 `manualFeatures`를 추가합니다. 확인한 공개 URL과 날짜를 `manualSource`, `manualReviewedAt`에 기록합니다.

```json
{
  "id": "calculator-net",
  "name": "Calculator.net",
  "baseUrl": "https://www.calculator.net/",
  "serviceIds": ["calculator"],
  "enabled": false,
  "termsReviewedAt": "",
  "manualFeatures": ["calculator categories", "formula explanation"],
  "manualSource": "https://www.calculator.net/ (manual review)",
  "manualReviewedAt": "2026-10-22"
}
```

그 뒤 `pnpm agent competitor --service=calculator`를 실행합니다. 수동 목록과 Woori 발견 경로 수를 저장하며, 경로 수를 기능 수나 경쟁력 점수로 해석하지 않습니다. 자동 의미 판단과 동등성 판정은 Codex 검토용으로 남습니다.

## 제한된 자동 수집

자동 수집을 사용하려면 직접 이용약관을 확인하고 최근 확인일을 `termsReviewedAt`에 입력한 뒤 `enabled: true`로 설정해야 합니다. 실행 시 매번 robots.txt를 읽고 허용된 HTTPS 공개 HTML만 최대 `maxPagesPerDomain` 범위에서 요청합니다. robots를 읽지 못하거나 대상 경로가 차단되면 해당 페이지는 Skipped로 기록하며 우회하지 않습니다. robots 허용은 이용약관 동의를 대체하지 않습니다.

요청 간격은 최소 1초이며, 인증·로그인 페이지와 광고 상호작용은 수행하지 않습니다. 방문자 수, 검색량, 광고 매출은 수집하거나 추정하지 않습니다.
