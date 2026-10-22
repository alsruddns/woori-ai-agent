# Google 데이터 API 로컬 연결

API 연결은 기본 비활성화입니다. 이 프로젝트는 사용자를 대신해 로그인하거나 동의하지 않으며, 운영 VPS에는 인증정보를 복사하지 않습니다. GitHub Actions에서도 GSC, GA4, AdSense가 모두 비활성화됩니다.

## 비용 및 쿼터 정책

- Google은 Search Console API를 무료라고 명시하지만 사용량 제한이 있습니다. 이 구현은 일일·실행별 호출 수를 제한하고 429에서 재시도하지 않습니다. [공식 가격 안내](https://developers.google.com/webmaster-tools/pricing) · [사용량 제한](https://developers.google.com/webmaster-tools/limits)
- GA4 Data API는 Cloud 프로젝트와 쿼터를 요구합니다. 응답의 property quota를 확인하고 잔여량이 낮으면 중단합니다. 추가로 `GOOGLE_CLOUD_BILLING_DISABLED=true` 및 `GA4_ZERO_COST_CONFIRMED=true`가 모두 명시되지 않으면 API 요청을 하지 않습니다. Google 문서는 이 API의 quota를 설명하지만, Cloud project에서 다른 유료 제품이 켜져도 비용이 없다는 보장은 하지 않습니다. [공식 쿼터 안내](https://developers.google.com/analytics/devguides/reporting/data/v1/quotas)
- AdSense Management API의 비용이 없다고 이 프로젝트가 보증하지 않습니다. 기본 비활성화이며 `GOOGLE_CLOUD_BILLING_DISABLED=true`, `ADSENSE_API_ENABLED=true`, `ADSENSE_ZERO_COST_CONFIRMED=true`가 모두 필요합니다. Google Cloud에서 비용 조건을 확인할 수 없으면 설정을 계속 `false`로 두세요.
- `PAID_AI_API_ENABLED=false`, `AI_API_BUDGET_USD=0`, `AI_AUTO_EXECUTION=false`는 코드와 CI에서 강제됩니다. 유료 AI API 자동 호출은 없습니다.

## Windows에서 직접 OAuth 연결

1. Google Cloud Console에서 OAuth Desktop client용 프로젝트를 선택하거나 만듭니다. 결제 계정을 연결하지 말고, 결제 또는 유료 서비스가 요구되면 중단합니다. Google은 Search Console API 요청 자체를 무료라고 안내합니다(사용량 제한 적용). API 활성화 및 OAuth 설정 화면에서 결제 설정을 자동 변경하지 마세요.
2. OAuth 동의 화면과 **Desktop app** client를 설정하고 Client ID와 secret을 로컬 `.env`에만 기록합니다. 승인할 Google 계정은 원하는 Search Console 속성의 읽기 권한을 이미 보유해야 합니다.
3. GSC만 요청해 최소 `webmasters.readonly` scope로 사용자 동의를 받습니다. PowerShell에서 아래 명령을 직접 실행하고, 출력된 Google URL을 사용자가 열어 scope를 확인하고 승인합니다. 이 에이전트는 브라우저를 열거나 동의를 자동 승인하지 않습니다.

   ```powershell
   pnpm agent:google:connect --providers=gsc
   ```

4. 동의가 끝나면 OAuth refresh token을 Windows DPAPI로 암호화해 `data/google-oauth.dpapi`에 저장합니다. 파일은 현재 Windows 사용자 프로필에서만 복호화됩니다. Actions나 VPS로 옮기지 마세요. 토큰 값은 로그와 보고서에 출력하지 않습니다.
5. 로컬 `.env`에 OAuth client와 opt-in을 설정합니다. `GSC_SITE_URL`에 속성 주소를 임의로 입력하지 않습니다. `.env`는 Git에 커밋하지 마세요.

   ```dotenv
   GOOGLE_LOCAL_OAUTH_FILE=data/google-oauth.dpapi
   GOOGLE_OAUTH_CLIENT_ID=your-desktop-client-id
   GOOGLE_OAUTH_CLIENT_SECRET=your-desktop-client-secret
   GSC_API_ENABLED=true
   ```

6. Search Console API에서 사용 권한이 있는 실제 속성을 조회하고, 응답에 나온 `siteUrl`을 사용자가 선택합니다. Domain Property (`sc-domain:...`)와 URL-prefix Property를 모두 지원하며, woori.today와 관련된 실제 반환 속성만 선택할 수 있습니다.

   ```powershell
   pnpm agent gsc properties
   pnpm agent gsc select --site-url="https://www.woori.today/"
   pnpm agent gsc run --range=28d
   pnpm agent gsc run --range=28d --query-detail="ratio calculator"
   # 선택 가능: 7d, 28d, previous28d, custom
   pnpm agent gsc run --range=custom --start-date=2026-09-01 --end-date=2026-09-30
   ```

   예시 URL은 형식 설명일 뿐입니다. `select`에는 반드시 `properties` 응답에 실제로 반환된 문자열을 복사하세요. Search Analytics 보고서는 최대 8개의 순차 요청, 하루 최대 12개 GSC 요청(속성 조회 포함), 6시간 캐시를 사용합니다. 기본 차원 조회는 최대 25,000행 페이지와 startRow 페이지네이션을 사용하며, 상한에 도달하면 추가 요청 없이 미수집 행을 partial로 표시합니다. Google API는 페이지 이동을 지원하지만 전체 데이터 또는 익명화 검색어 복구를 보장하지 않으며 검색 유형별 일일 행 상한도 적용됩니다. Google은 Search Console 성과 데이터가 일반적으로 2–3일 후 제공되며, page/query 그룹에서 일부 데이터가 생략될 수 있다고 안내합니다. 보고서는 마지막 3일을 기본 제외하고 행 제한에 도달하면 부분 응답으로 표시합니다.

7. SQLite의 `gsc_properties`, `gsc_report_sets`, `gsc_report_rows`, `analytics_daily`, `agent_data`, `api_cache`, `api_usage`에 실제 응답 및 상태를 저장합니다. GitHub Actions는 OAuth 토큰을 받지 않으며 GSC 인증·수집을 실행하지 않습니다.
8. 연결을 끊으려면 `GSC_API_ENABLED=false`로 바꾸고 Google 계정에서 앱 동의를 취소하세요. 필요하면 DPAPI 파일과 SQLite 분석 데이터/캐시를 사용자가 직접 지웁니다.

## 대체 인증: 서비스 계정

조직 정책에서 허용할 때만 로컬 전용 서비스 계정으로 사용할 수 있습니다. 서비스 계정 이메일을 Search Console에는 읽기 사용자로, GA4에는 Viewer로 추가하는 작업은 사용자가 직접 해야 합니다. 키 JSON을 프로젝트 안에 평문으로 두지 말고 PowerShell에서 현재 Windows 계정의 DPAPI로 보호하세요.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\protect-google-credentials.ps1 C:\secure\google-service-account.json
```

런타임 환경변수 `GOOGLE_CREDENTIALS_DPAPI_FILE=data/google-credentials.dpapi`를 사용합니다. 원본 키 파일을 삭제할지는 암호화 파일을 확인한 뒤 사용자가 결정합니다.

## 연결 상태와 저장

`Not Configured`는 opt-in, 인증, 계정 식별자 또는 비용 확인이 빠져 API를 호출하지 않은 상태입니다. 성공한 공식 API 응답이 있을 때만 `Completed`가 됩니다. OAuth 동의는 사용자가 직접 시작해야 하며 GitHub Actions 무인 인증은 준비하지 않았습니다. API 결과에는 조회 기간·출처·수집 시각을 저장합니다.
