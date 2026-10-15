# Search, Tasks, GitHub 구현 계약

이 문서는 MVP 구현과 로컬 mock 검증 범위를 기록한다. 실제 업무 Vault, GitHub Enterprise, 생성·임베딩 모델 연결 성능은 업무용 PC에서 별도로 검증한다.

## Search

`SearchIndex(state, dependencies)`는 외부 운영 저장소의 `IndexState`를 변경하고 `save` 콜백으로 체크포인트를 저장한다. `canRead`, `canEmbed`, `canEmbedQuery`는 매번 현재 정책을 조회해야 한다. 생성 모델 전송 권한은 이 모듈이 승인하지 않으며, Core가 별도로 검사한다. 기본 정책 콜백은 읽기를 거절한다.

- `upsert`, `rename`, `remove`, `reconcile`: 원문별 증분 갱신. rename은 기존 문서 ID를 유지하고, 앱 종료 중 이동은 삭제+신규로 처리한다.
- `pause`, `resume`, `rebuild`, `embedPending`: 조각별 임베딩 완료를 저장한다. 임베딩 호출은 명시적 실행이며 자동 모델 다운로드는 없다.
- `invalidatePolicy`: 철회된 원문과 파생 벡터를 제거한다. 모델 키는 모델 ID/리비전을 포함해야 하며 차원·cosine 정규화 식별자와 결합한다. 키가 바뀌면 기존 벡터를 제거하고 완성 전 키워드 전용으로 전환한다.
- `search(query, filter, options)`: 경로(`.`는 전체 허용 범위), 프로젝트, 태그, 출처, 원문 수정 시각 필터를 적용한다. `verify(document)`로 최신 원문 버전을 재확인하고 실패한 문서는 검색 후보에서 제거한다. 연결부에서 verify 콜백을 반드시 공급한다.

조각은 Markdown 제목·문단을 우선하고, UTF-8 바이트 수를 보수적 토큰 상한으로 사용하여 최대 1,000 이하로 나눈다. 일반 영어 토큰보다 작게 분할되는 의도적인 보수적 구현이다. 코드 블록이 상한을 넘으면 분할하고 원문 행 위치를 남긴다. 문서 ID+내용 해시+중복 순번이 조각 ID를 만들며, 변경되지 않은 조각의 벡터는 재사용한다. 원문 버전은 `hash`, 원문 위치는 `path`+`locator`로 보존한다.

키워드는 NFKC 정규화, 구두점 포함 식별자 exact substring, 한국어 부분 문자열+2-gram을 사용한다. 벡터는 cosine이고 각 후보 상위 30개를 Reciprocal Rank Fusion(`k=60`)으로 합친다. 결과 최대 10개, 문서당 최대 3개, `context(result)` 최대 8개이다. 임베딩 권한·완성·요청에 문제가 있으면 상태를 `keyword-only`로 명시한다. 변경된 정책과 버전은 모델 호출 직전 Core에서도 재확인해야 한다.

## Tasks

`nextOccurrence(job, afterMs)`는 다음 발생의 UTC 예정 시각과 예정된 현지 날짜를 반환한다. `collectDueOccurrences`는 순수 계산 함수다. 호출자는 반환된 occurrence와 Run을 함께 저장한 뒤 `job.lastCheckedAt`을 진행해야 한다. 실패 시 날짜를 먼저 진행하면 예약이 유실된다.

기본 시간대는 `Asia/Seoul`이고 매일/평일만 지원한다. `Intl.DateTimeFormat`으로 시간대를 계산한다. DST 중복 시각은 첫 번째 UTC 발생만 사용하고, 없는 시각은 같은 현지 날짜의 다음 유효 분으로 이동한다. 뉴욕의 봄·가을 전환을 테스트했다. 전체 날짜가 건너뛰는 과거 시간대 변경은 그 날짜를 생략하며, 업무 환경에서 사용할 추가 시간대의 현행 규칙은 별도 시험 대상이다.

보충은 24시간 내 최신 1개만 실행하고 나머지는 `skipped`와 이유를 반환한다. 이미 저장된 `jobId|scheduledFor|version`은 중복 생성하지 않는다. 실행 기기가 다르거나 비활성 Job이면 발생을 만들지 않는다. 동일 Job이 진행 중이면 skipped 처리한다. 앱이 닫히거나 절전 중이면 실행하지 않는다. 분산 잠금은 제공하지 않는다.

`SingleRunQueue`는 1개 활성 실행과 최대 10개 대기를 허용한다. 취소는 즉시 AbortSignal을 발생시키며 대기 항목은 제거한다. 현재 작업이 취소 신호를 처리하고 끝날 때까지 다음 작업을 실행하지 않아 동시 실행을 막는다. 승인 대기는 큐 밖에서 관리한다. 네트워크 Adapter가 취소 신호와 시간 제한을 지켜야 한다.

## GitHub

`GithubConnector(config, dependencies)`는 명시적 HTTPS API 주소와 `owner/repo` 목록만 사용한다. 기본 공개 API는 `https://api.github.com`, Enterprise 예시는 `https://git.example.com/api/v3`이다. 인증정보를 URL에 넣을 수 없고 리다이렉트는 거절한다. 읽기 전용 GET 이외 API는 구현하지 않는다.

`sync(state)`는 열린 Issue/PR, 최근 30일 변경된 항목, 해당 Issue/PR의 대화 댓글을 읽는다. PR inline review 댓글과 코드 diff는 현재 MVP 수집 범위에서 제외한다. 저장소당 상한은 댓글 포함 1,000개이며 상한 도달은 `partial`이다. 목록 페이지 100개 단위로 저장하고 실패하면 완료한 페이지 이후부터 재개한다. API가 반환한 임의 URL이나 Link URL을 요청에 사용하지 않고, 안전한 고정 엔드포인트에서 페이지 번호만 증가한다. 정상 완료 시 이번 범위에 없는 오래된 캐시를 정리한다. 401/403/404/410은 보수적으로 저장소 접근 철회로 간주해 캐시를 차단·제거한다.

`revalidate(document)`는 AI 맥락 또는 승인에 사용하기 직전 원문을 다시 읽고 갱신한 SourceDocument를 반환한다. `null`이면 호출자는 저장소 전체를 차단해야 한다. `onRevoke(repo)` 콜백으로 운영 저장소와 검색 인덱스 철회를 연결한다. 일시적 네트워크 장애는 실패로 반환하며 임의로 캐시가 최신이라고 표시하지 않는다.

`Retry-After`/rate-limit 응답은 저장된 재시도 시각 이전에 재요청하지 않는다. 자동 무한 재시도는 없다. 응답은 최대 8MiB, 요청은 기본 30초(최대 60초)로 제한한다. 토큰은 `getToken` 콜백으로만 받아 헤더에 사용하고 저장·오류 메시지에 포함하지 않는다. Obsidian Electron의 CORS 차이는 주입한 Node HTTP transport로 처리할 수 있다.

최소 권한 후보는 Metadata/Issues/Pull requests 읽기다. 실제 사내 서버 버전 및 조직의 PAT 승인 정책은 연결 시험과 업무 환경 검증에서 확인한다.

공식 근거:

- [GitHub Issue/PR 공용 목록 API](https://docs.github.com/en/rest/issues/issues)
- [Issue/PR 대화 댓글 API](https://docs.github.com/en/rest/issues/comments)
- [REST API 호출 제한 권고](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api)
- [GitHub Enterprise REST API 주소](https://docs.github.com/en/enterprise-server@3.18/rest/quickstart)

## 로컬 검증

`npx vitest run tests/search.test.ts tests/tasks.test.ts tests/tasks-runtime.test.ts tests/github.test.ts`: 27개 테스트 통과. 검색 권한 철회·모델 변경·증분 재사용·identifier/한국어 필터·문서 다양성·최신 버전 검사, 서울/뉴욕 일정·영속 중복 키·큐 제한·취소, 발생+Run 원자적 저장과 영속 실패 롤백, GitHub 원문 재검증과 캐시 철회, GitHub mock 동기화·페이지 재개·범위 제한·속도 제한·삭제/인증 철회·Enterprise 목적지를 검증했다. 실제 서비스에는 요청하지 않았다.

추가 실행 흐름 검증: `tests/workflow.test.ts`의 12개 테스트는 실제 Runtime/Core/ChangeManager를 실행하고 Vault와 모델 I/O만 mock한다. 근거 부족 시 모델 미호출, 승인 전 원본 보존, 승인 후 단일 구역 적용, 원문/대상 충돌, 전송 철회, 잘못된 JSON의 최대 1회 교정, 취소 후 호출 금지, 허위 근거 ID 거절, GitHub 원문 재검증 후 승인, 오래된 기억 배제, 기억 출처의 승인 결합을 검증한다. 관련 5개 파일 총 39개 테스트와 전체 TypeScript 검사가 통과했다. 이는 실제 Obsidian 창이나 사내 서비스에서의 검증을 대체하지 않는다.
