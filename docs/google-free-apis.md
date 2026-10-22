# Google 데이터 API 로컬 연결

API 연결은 기본 비활성화입니다. 이 프로젝트는 사용자를 대신해 로그인하거나 동의하지 않으며, 운영 VPS에는 인증정보를 복사하지 않습니다. GitHub Actions에서도 GSC, GA4, AdSense가 모두 비활성화됩니다.

## 비용 및 쿼터 정책

- Google은 Search Console API를 무료라고 명시하지만 사용량 제한이 있습니다. 이 구현은 일일·실행별 호출 수를 제한하고 429에서 재시도하지 않습니다. [공식 가격 안내](https://developers.google.com/webmaster-tools/pricing) · [사용량 제한](https://developers.google.com/webmaster-tools/limits)
- GA4 Data API는 Cloud 프로젝트와 쿼터를 요구합니다. 응답의 property quota를 확인하고 잔여량이 낮으면 중단합니다. 추가로 `GOOGLE_CLOUD_BILLING_DISABLED=true` 및 `GA4_ZERO_COST_CONFIRMED=true`가 모두 명시되지 않으면 API 요청을 하지 않습니다. Google 문서는 이 API의 quota를 설명하지만, Cloud project에서 다른 유료 제품이 켜져도 비용이 없다는 보장은 하지 않습니다. [공식 쿼터 안내](https://developers.google.com/analytics/devguides/reporting/data/v1/quotas)
- AdSense Management API의 비용이 없다고 이 프로젝트가 보증하지 않습니다. 기본 비활성화이며 `GOOGLE_CLOUD_BILLING_DISABLED=true`, `ADSENSE_API_ENABLED=true`, `ADSENSE_ZERO_COST_CONFIRMED=true`가 모두 필요합니다. Google Cloud에서 비용 조건을 확인할 수 없으면 설정을 계속 `false`로 두세요.
- `PAID_AI_API_ENABLED=false`, `AI_API_BUDGET_USD=0`, `AI_AUTO_EXECUTION=false`는 코드와 CI에서 강제됩니다. 유료 AI API 자동 호출은 없습니다.

## Windows에서 직접 OAuth 연결

1. Google Cloud Console에서 로컬용 프로젝트를 선택하거나 만듭니다. Search Console API와 필요한 경우 Google Analytics Data API만 활성화하세요. 결제 계정이나 유료 서비스 활성화가 요구되면 진행하지 말고 해당 제공자를 미연결 상태로 두세요.
2. OAuth 동의 화면을 설정하고 OAuth client 유형에서 **Desktop app**을 선택합니다. Client ID와 secret을 로컬 `.env`에만 기록합니다. 승인할 Google 계정은 Search Console 속성의 읽기 권한과 GA4 속성의 Viewer 권한을 이미 보유해야 합니다. GA4를 연결할 경우 Cloud Console에서 billing이 꺼져 있는지 확인하고 `GOOGLE_CLOUD_BILLING_DISABLED=true`, `GA4_ZERO_COST_CONFIRMED=true`를 함께 지정합니다. 확인하지 못하면 GSC만 연결하세요.
3. 기본으로 GSC와 GA4 읽기 전용 scope만 요청합니다. PowerShell에서 아래 명령을 직접 실행하고, 터미널에 출력된 Google URL을 사용자가 열어 scope를 확인하고 승인합니다. 이 에이전트는 브라우저를 열거나 동의를 자동 승인하지 않습니다.

   ```powershell
   pnpm agent:google:connect --providers=gsc,ga4
   ```

   AdSense scope는 별도 비용 검토 후 명시적으로 요청할 수 있습니다. 실행에도 `GOOGLE_CLOUD_BILLING_DISABLED=true`와 `ADSENSE_ZERO_COST_CONFIRMED=true`가 함께 필요합니다.

   ```powershell
   pnpm agent:google:connect --providers=adsense
   ```

4. 동의가 끝나면 OAuth refresh token을 Windows DPAPI로 암호화해 `data/google-oauth.dpapi`에 저장합니다. 파일은 현재 Windows 사용자 프로필에서만 복호화됩니다. Actions나 VPS로 옮기지 마세요. 토큰 값은 로그와 보고서에 출력하지 않습니다.
5. OAuth Desktop client와 대상 식별자, 명시적 opt-in을 로컬 `.env`에 설정합니다. `.env`는 Git에 커밋하지 마세요. 이 저장소 CLI는 `.env`를 자동으로 읽으며, 이미 프로세스에 설정된 환경변수가 우선합니다.

   ```dotenv
   GOOGLE_LOCAL_OAUTH_FILE=data/google-oauth.dpapi
   GOOGLE_OAUTH_CLIENT_ID=your-desktop-client-id
   GOOGLE_OAUTH_CLIENT_SECRET=your-desktop-client-secret
   GSC_SITE_URL=sc-domain:example.com
   GSC_API_ENABLED=true
   GA4_PROPERTY_ID=123456789
   GA4_API_ENABLED=true
   GA4_ZERO_COST_CONFIRMED=true
   GOOGLE_CLOUD_BILLING_DISABLED=true
   ADSENSE_ACCOUNT_ID=accounts/pub-1234567890
   ADSENSE_API_ENABLED=false
   ADSENSE_ZERO_COST_CONFIRMED=false
   ```

6. `pnpm agent analytics --service=all` 또는 `pnpm agent ads --service=all`을 직접 실행합니다. 오류·쿼터 초과는 Failed/Skipped로 기록하고 재시도하지 않습니다. API 원본 응답·집계·캐시는 `data/woori-agent.sqlite`의 `agent_data`, `analytics_daily`, `api_cache`, `api_usage`에 저장됩니다.
7. 연결을 끊으려면 제공자별 API 설정을 `false`로 변경하고 Google 계정의 앱 연결에서 동의를 취소하세요. 필요하면 DPAPI 파일과 SQLite 분석 데이터/캐시를 사용자가 직접 지웁니다.

## 대체 인증: 서비스 계정

조직 정책에서 허용할 때만 로컬 전용 서비스 계정으로 사용할 수 있습니다. 서비스 계정 이메일을 Search Console에는 읽기 사용자로, GA4에는 Viewer로 추가하는 작업은 사용자가 직접 해야 합니다. 키 JSON을 프로젝트 안에 평문으로 두지 말고 PowerShell에서 현재 Windows 계정의 DPAPI로 보호하세요.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\protect-google-credentials.ps1 C:\secure\google-service-account.json
```

런타임 환경변수 `GOOGLE_CREDENTIALS_DPAPI_FILE=data/google-credentials.dpapi`를 사용합니다. 원본 키 파일을 삭제할지는 암호화 파일을 확인한 뒤 사용자가 결정합니다.

## 연결 상태와 저장

`Not Configured`는 opt-in, 인증, 계정 식별자 또는 비용 확인이 빠져 API를 호출하지 않은 상태입니다. 성공한 공식 API 응답이 있을 때만 `Completed`가 됩니다. OAuth 동의는 사용자가 직접 시작해야 하며 GitHub Actions 무인 인증은 준비하지 않았습니다. API 결과에는 조회 기간·출처·수집 시각을 저장합니다.
