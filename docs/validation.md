# MVP 검증 결과

검증일: **2026-10-15 (Asia/Seoul)**. 개발 환경: macOS ARM64, Node.js **v26.10.0**, npm **11.19.1**. Obsidian 타입 **1.14.4**, manifest 최소 API 버전 **1.11.4**. 실제 Obsidian 실행 버전은 이 PC에서 시험하지 않았다.

| 검증 | 결과 | 범위 |
|---|---|---|
| `npm run format:check` | PASS | TypeScript·스크립트·설정·스타일 형식 |
| `npm run typecheck` | PASS | strict TypeScript 전체 소스·시험 |
| `npm test` | **182/182 PASS · 14 files** | 정책·경로·모델·OAuth·검색·예약·기억·Skill·승인·복구·전체 Workflow의 모의/합성 시험 |
| `npm run build` | PASS | 데스크톱 CommonJS 플러그인 번들 |
| `npm run smoke` | PASS | 번들 로드, default Plugin export, 허용된 런타임 import, manifest·CSS 확인 |
| `npm run package` | PASS | 검사 전체 + 설치 디렉토리 + ZIP + SHA256SUMS |
| ZIP 검증 | PASS | 예상 4개 엔트리, 내부 SHA-256, 설치 디렉토리와 바이트 일치 |
| `npm audit` | **0 vulnerabilities** | 실행일 lockfile 기준 prod/dev 전체. 향후 취약점 부재 보장은 아님 |
| 첨부 PRD | PASS | 첨부 원본과 `docs/PRD-v0.1.md` 바이트 일치 |

## 확인한 주요 동작

- 기본 설정에서 읽기·쓰기·모델·전송·예약 비활성, 새 기기 운영 저장 위치 재확인.
- 범위 밖 자료·경로 탈출·심볼릭 링크 차단, 생성/임베딩 목적지 및 자료별 전송 분리.
- 승인 대기 전후 원문 불변, 명시적 승인 후 단일 관리 구역 적용, 해시·정책·만료·열린 편집기 충돌 차단.
- 쓰기 전/후 중단 복구, 중복 적용 방지, 현재 파일 버전이 일치하는 역변경만 제안.
- 같은 예약 발생과 Run의 동시 영속화, 24시간 최신 보충, DST와 기기 게이트, 생성 당시 예약 자료 범위 유지.
- 가짜/누락 근거와 잘못된 JSON 차단, 교정 1회, 호출·보수적 토큰·시간 예산과 취소.
- OAuth PKCE/state/nonce/JWT 검증, 토큰 갱신 직렬화, 계정 전환·로그아웃 중 늦은 응답 차단. 합성 토큰과 로컬 모의 서버만 사용했다.
- GitHub 페이지 재개·429/권한 철회·원문 재검증, 삭제/철회 원문과 기억을 맥락에서 제외.

실제 인증정보, 개인 Vault 원문, 사내 endpoint를 시험에 사용하지 않았다. ObsidianVaultPort 통합은 임시 디렉토리와 모의 공개 Vault API를 사용했다. 전체 Workflow 시험도 실제 모델 호출 대신 결정적인 응답을 주입했다. 위 PASS를 실제 모델의 업무 사실 정확도 또는 Obsidian E2E 통과로 해석하지 않는다.

## 검색 엔진 측정

[합성 벤치마크](benchmark-results.md): 문서 5,000개, 조각 40,000개, 원문 4.81MB. 최적화 후 키워드 P95 **47.94ms**, 8차원 모의 벡터 하이브리드 P95 **57.34ms**(각 30표본). 실제 임베딩·영속 저장·UI·100MB 자료의 성능 측정이 아니다.

## 업무 PC에서 남은 검증

[업무 PC 검증표](workplace-validation.md)의 AT-01~18을 시험 Vault에서 실행한다. 실제 ChatGPT 계정/요금제, Ollama 모델, 사내 chat/completions·embeddings 및 CA/프록시, 회사 GitHub 권한, Windows/macOS Obsidian의 UI·키보드·테마·파일 저장 동작을 확인해야 한다. 회사 자료 반출 정책을 확인한 범위만 연동한다.

실제 30개 검색 질의의 Recall@5, 20개 답변 근거 충실도, 무근거 10개 질의, 10근무일 파일럿, 앱 p95/메모리 목표는 **미검증**이다. 이 전달물은 업무용 PC에서 검증할 **MVP 구현본**이며, PRD G4 출시 완료나 모든 P0 수용 기준의 실환경 통과를 선언하지 않는다.

## 설치 산출물

- `release/obsidian-harness-0.1.0.zip`
- `release/obsidian-harness/{main.js,manifest.json,styles.css}`
- `release/SHA256SUMS`

배포물은 Git에 포함하지 않으며 `npm ci --ignore-scripts && npm run package`로 재생성한다. 설치에는 세 플러그인 파일만 필요하다. 런타임 상태나 API/OAuth 비밀값을 ZIP에 포함하지 않는다. 원격 CI는 구성만 했으며 실제 GitHub 실행 결과는 아직 없다.
