# 로그인과 로그인 유지 실험실

로그인·세션 만료·로그인 유지·기기별 로그아웃을 실제 Spring Boot 서버, Redis, PostgreSQL로 실행하고 처리 기록과 데이터를 함께 확인하는 독립 프로젝트입니다.

[포트폴리오 체험 화면](https://seonyoungyoo16.github.io/portfolio/#project/login)에서 처리 순서와 실제 소스를 살펴볼 수 있습니다. GitHub Pages의 체험은 브라우저 시뮬레이션이며, 아래 실행 방법으로 여는 독립 실험실은 실제 백엔드와 저장소에 요청합니다. [실제 검증 결과](docs/verification/RESULTS.md)

기존 게시판·채팅 프로젝트는 변경하지 않습니다. 이 프로젝트의 기본 주소는 https://localhost:8460 입니다.

## 실행

Windows에서 Java 21, Node.js 24, Git의 OpenSSL 또는 openssl 명령, 인터넷 연결을 준비합니다.

PowerShell에서 프로젝트 디렉터리로 이동한 뒤 다음 명령을 실행합니다.

    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-local.ps1

처음 실행하면 의존성·Maven·개발용 PostgreSQL과 Redis 바이너리를 준비하고 빌드합니다. 로컬 서버는 loopback 주소에만 바인딩합니다. HTTPS 개발 인증서는 .runtime에 생성합니다. 브라우저에서 자체 서명 인증서 안내가 나타나면 로컬 실습 주소임을 확인한 뒤 접속합니다. 자동 브라우저 검증은 이 로컬 인증서에 대해서만 오류 검사를 생략합니다.

준비된 실습 계정은 demo@lab.test, 비밀번호는 Lab!2026Pass 입니다. 다른 사용자 확인에는 other@lab.test와 같은 비밀번호를 사용합니다. 화면의 ‘실습 계정 입력’으로 입력할 수 있습니다. 실제 서비스 계정이 아닙니다.

서버와 저장소를 모두 종료할 때:

    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\stop-local.ps1

앱만 종료하고 저장소를 유지할 때는 -KeepInfra를 추가합니다. 데이터 디렉터리와 볼륨은 삭제하지 않습니다.

## Docker로 저장소 실행

Docker 엔진이 정상인 환경에서는 start-local.ps1 -Docker로 PostgreSQL 17·Redis 7.4 컨테이너를 사용합니다. 먼저 포트를 사용하는 portable 실행을 종료합니다. 종료도 stop-local.ps1 -Docker를 사용합니다.

Windows 로컬에서는 실제 PostgreSQL 17.11과 Redis 7.4.3 프로세스로 검증합니다. Redis는 공식 소스로 빌드한 Windows 개발용 포트입니다. Linux 컨테이너 실행 결과와 구분합니다. 환경과 바이너리 출처는 docs/verification/ENVIRONMENT.md를 참고합니다.

## 화면 사용

1. 로그인 유지 선택 여부와 기기 이름을 정하고 로그인합니다.
2. ‘보호 API 조회’와 알림 변경으로 서버 인증·실제 DB 저장을 확인합니다.
3. 가운데 흐름에서 처리 단계를 선택하거나 재생합니다. ‘실제 처리 소스’는 빌드한 파일의 해시·행에 연결됩니다.
4. 오른쪽 DB·Redis 관찰과 하단 HTTP 실행 기록을 확인합니다. 관찰 경로는 인증 세션의 활동 시간을 갱신하지 않습니다.
5. ‘기기 관리’에서 다른 기기를 해제하거나 모든 기기에서 로그아웃합니다. 최근 비밀번호 확인이 필요하면 모달이 열립니다.
6. 실험 제어에서 단축 만료, 유지 복원, 서버 B 요청, 저장소 연결 장애, 실제 Redis 재시작, 중간 실패, 응답 유실을 재현합니다.
7. ‘브라우저 전체 검증 실행’으로 실제 백엔드에 대한 회귀 검증을 실행하고 결과를 확인합니다.

서로 다른 사용자·기기는 별도 브라우저 프로필이나 시크릿 창으로 엽니다. 같은 프로필의 탭은 쿠키를 공유합니다. 단축 만료 실험은 별도 run의 데이터로 열리며, 같은 프로필에서는 현재 실험의 쿠키가 사용됩니다.

실험 제어는 로컬 개발 환경 전용입니다. 연결 차단은 실제 서버가 Redis·DB에 접근하는 TCP 경로에 적용하고, 중간 실패는 명시한 처리 지점에 주입합니다. 실제 프로세스 재시작과 이 두 방식을 실행 기록에서 구분합니다.

## 정책과 저장 책임

기본 정책은 유휴 30분, 세션 절대 8시간, 로그인 유지 14일, 민감한 기기 관리 전 최근 비밀번호 확인 5분입니다. 로그인 유지 기간은 복원 때 늘어나지 않습니다. 짧은 실험은 10초·30초·60초, 빠른 자동 회귀는 실제 경과 시간 기준 3초·9초·18초를 사용합니다.

Spring Session RedisSessionRepository를 명시적으로 호출합니다. 자동 서블릿 세션 필터 대신 현재 세션 조회·저장 시점을 직접 정해 관찰 요청과 인증 활동을 분리합니다. Spring Security는 요청별 인증 문맥, 인가, CSRF와 비밀번호 해시 검증에 사용합니다.

DB에는 사용자, 인증 묶음, 발급 상태, 유지 토큰 해시, 폐기·정리 작업·감사 기록을 둡니다. 보호 요청마다 주 DB에서 폐기·상태·버전을 확인합니다. 즉시 폐기를 위해 매 요청의 DB 비용과 DB 장애 의존성을 감수한 구성입니다.

DB·Redis 발급은 PREPARING → Redis 저장 → ACTIVE 확정의 경계를 가집니다. DB 활성화 전 Redis에 남은 세션은 허용하지 않습니다. 로그아웃은 DB 폐기 커밋이 기준이며 Redis 정리는 재시도합니다. 세션이 이미 만료된 경우에도 유효한 유지 자격정보를 검증해 해당 인증 묶음을 폐기합니다.

유지 토큰 교체 후 응답이 유실되어 새 쿠키를 받지 못하면 비밀번호 재로그인이 필요합니다. 같은 토큰을 두 탭에서 동시에 복원하면 하나가 성공하고 다른 요청은 409를 받으며 성공 쿠키를 지우지 않습니다.

## 검증 명령

실행 중인 로컬 서버에서 먼저 브라우저 런타임을 준비합니다.

    npx playwright install chromium

실제 API·PostgreSQL·Redis를 확인하는 모든 백엔드 검증:

    npm run test:backend:all

설계의 브라우저 시나리오와 추가 만료 후 로그아웃 회귀:

    npm run test:browser

설계 ID 40개와 추가 O09를 검증합니다. 전체 테스트는 순차 실행합니다. 저장소 장애를 만드는 백엔드 검증과 브라우저 검증을 동시에 실행하지 않습니다.

일반 로그인 단계만 반복하려면 npm run test:stage1을 사용합니다. 소스 연결·반응형 화면 확인과 캡처는 npm run test:preview로 실행합니다.

검증은 응답·화면만 보지 않고 실제 DB 상태, Redis 키와 TTL, 옛 쿠키 재사용 거부를 확인합니다. 결과는 test-results/summary.json과 docs/verification에 남깁니다. 전체 HAR·인증정보 원문·영속 로그인 상태 파일은 보고서에 저장하지 않습니다. 브라우저 재실행 시험의 임시 프로필은 시험 종료 후 제거합니다.

## 구조

- backend: Spring Boot, 보안 설정, 명시적 Redis 세션 처리, DB 트랜잭션과 마이그레이션.
- frontend: 실제 서비스, 처리 흐름 재생, 기기 관리, 관찰과 검증 결과.
- scripts/gateway.mjs: 동일 출처 HTTPS, 앱 A·B 분배, 별도 관찰·실습 제어, 저장소 경로 장애.
- scripts/infra.mjs: 프로젝트 전용 Redis 프로세스 재시작.
- test: 실제 백엔드 검증과 Playwright 시나리오.
- docs/DESIGN.md: 구현 기준 설계 원본.
- docs/IMPLEMENTATION-PLAN.md: ALPEN 단계별 검증 기록.
- docs/verification: 실제 검증 결과와 환경.

앱 내부 포트는 A 8461, B 8462입니다. DB 직접 포트는 55432, 앱의 DB 경로는 55433이며 Redis 직접 포트는 56379, 앱의 Redis 경로는 56380입니다. 외부 요청은 HTTPS 8460으로 보냅니다.

공개 배포·운영 부하 검증은 이 로컬 프로젝트의 완료 증거와 별도입니다.
