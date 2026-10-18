# 로컬 검증 환경

Windows와 Java 21에서 실행한다. 실제 PostgreSQL 17.11 서버와 Redis 7.4.3 서버를 프로젝트 .runtime 디렉터리에 두고, loopback 전용 포트 55432와 56379를 사용한다. 인메모리 대체 DB나 가짜 Redis 응답을 사용하지 않는다.

PostgreSQL은 Zonky의 테스트용 PostgreSQL 바이너리 묶음이며, Redis는 공식 Redis 소스에서 빌드한 redis-windows의 Windows 개발용 포트다. Linux Docker Compose 구성은 PostgreSQL 17과 Redis 7.4를 사용하도록 제공하며 Windows 로컬 실행 결과와 구분한다.

다운로드 파일은 SHA256을 고정해 검사한다. 로컬 PostgreSQL은 준비된 테스트 계정만 사용하는 loopback 개발 전용 trust 인증이다. 운영 배포 설정은 아니다.

현재 Docker Desktop은 dockerInference 통신 경로의 Windows 파일 접근 오류로 엔진을 시작하지 못했다. 기존 데이터 볼륨은 수정하지 않았다. 확인 과정에서 임시 변경한 통신 디렉터리는 원래 위치로 복원했고 실패한 재시도의 통신 파일은 별도 이름으로 보존했다. 프로젝트 검증은 위의 실제 Windows 서버로 수행한다.

인증정보가 포함될 수 있는 전체 HAR와 Playwright 트레이스는 저장하지 않는다. 브라우저 실제 재실행 시험에만 임시 영속 프로필을 사용하고 종료 후 해당 프로필을 제거한다. 검증 보고서는 비밀값 대신 상태·참조·변경 여부를 기록한다.

출처

- https://github.com/zonkyio/embedded-postgres-binaries
- https://github.com/redis-windows/redis-windows/releases/tag/7.4.3
