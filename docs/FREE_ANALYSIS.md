# 무료 분석 연결

모든 자동 분석은 규칙 기반입니다. 코드에는 종량제 모델 API 호출 경로가 없고 Codex 대화형 검토는 CLI/CI 자동 실행과 분리됩니다.

## Google 읽기 전용 연동

연동하지 않으면 GSC, GA4, AdSense 결과는 `Not Configured`이며 요청을 보내지 않습니다. 연결하려면 Google Cloud 서비스 계정에 필요한 제품 API를 활성화하고, 각 제품에서 해당 속성에 읽기 권한을 부여합니다. Windows PowerShell 세션에 `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` (PEM; 줄바꿈은 `\n` 허용), `GSC_SITE_URL` (Search Console 속성 형식), `GA4_PROPERTY_ID` (숫자 속성 ID), `ADSENSE_ACCOUNT_ID` (계정 ID)을 설정합니다. 비밀키를 `.env`, 저장소, 보고서에 커밋하지 마세요.

사용 scope는 Search Console `webmasters.readonly`, GA4 `analytics.readonly`, AdSense `adsense.readonly`뿐입니다. 검색 성과와 GA4 보고서는 호출당 최대 4페이지, 페이지당 최대 500행으로 제한합니다. 날짜는 `ANALYTICS_START_DATE` 및 `ANALYTICS_END_DATE`에서 `YYYY-MM-DD`로 지정할 수 있습니다. API 오류는 Failed로 저장되며 유료 서비스나 모델 API로 fallback하지 않습니다.

현재 반환하는 분석은 GSC의 query/page/country, GA4의 country/pagePath 및 sessions/activeUsers/screenPageViews, AdSense의 DATE/AD_UNIT_NAME 및 ESTIMATED_EARNINGS/PAGE_VIEWS_RPM입니다. API 응답에서 제공되지 않는 측정치는 만들어내지 않습니다.

공식 API 문서: [Search Analytics query](https://developers.google.com/webmaster-tools/v1/searchanalytics/query), [GA4 runReport](https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/properties/runReport), [AdSense reports.generate](https://developers.google.com/adsense/management/reference/rest/v2/accounts.reports/generate).

## 경쟁 사이트

`configs/competitors.json`에만 공개 URL을 등록합니다. 등록 전에 이용약관을 직접 확인하고 `termsReviewedAt`에 확인 날짜를 남겨야 합니다. 분석기는 robots.txt를 먼저 확인하고 확인일 1년이 지났거나 robots.txt가 접근 불가한 사이트는 건너뜁니다. 도메인당 최대 3페이지, 요청 간 1.5초 이상으로 제한합니다. 기본 설정은 빈 목록이어서 실제 대상 없이 `Not Configured`입니다. 수집 대상 페이지를 확인하기 위한 공개 HTML 메타데이터·내비게이션 정보만 읽고 로그인/상태 변경/광고 상호작용은 하지 않습니다.

## 출처와 해석 경계

Content의 word count, 제목·메타데이터, 링크·FAQ 마커·목차·코드 블록은 기계적으로 확인한 사실입니다. 제목과 본문 의미의 일치, 기술적 정확성, 번역 의미, 기능의 사용자 가치 및 개발 난이도는 Codex가 결과 증거를 검토해야 하는 판단입니다. Growth 결과에는 검색량/방문자 추정치가 없습니다. Ads DOM 검사는 광고로 보이는 요소만 관찰하며 클릭 또는 노출을 만들지 않습니다.
