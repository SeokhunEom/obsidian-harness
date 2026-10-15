# PRD 요구사항 추적표

기준 문서는 [PRD v0.1](PRD-v0.1.md)이다. 이 저장소의 결과물은 **업무용 PC에서 검증할 수 있도록 구현한 MVP**이며, PRD의 모든 P0 수용 기준을 충족한 v0.1 인증이나 G4 완료를 뜻하지 않는다. 자동 시험은 격리된 Vault Port, 모의 모델·OAuth·GitHub 응답, 임시 파일 시스템으로 수행한다. 실제 Obsidian UI, 실제 계정과 모델, 회사의 네트워크·보안 정책에서 수행한 E2E는 별도 증거가 필요하다.

이 표는 PRD의 P0 ID 61개를 모두 포함한다. `구현·자동`은 관련 코드와 자동 회귀 시험이 있다는 뜻이며 해당 행의 전체 수용 기준이 실환경에서 통과했다는 뜻이 아니다. `부분·자동`은 명시적인 축소 또는 남은 수용 기준이 있다. `구현·수동대기`는 코드 경로가 있지만 실제 UI 검증이 필요하다. `미측정`은 실제 Obsidian/업무 모델의 성능·품질 목표를 측정하지 않았다는 뜻이다. 검색 엔진 단독 합성 측정은 [벤치마크](benchmark-results.md)에 별도 기록했다. 마지막 열의 검증을 수행한 뒤 결과, 정확한 버전, 증거 위치를 추가한다.

재현 명령은 저장소 루트의 `npm ci`, `npm run check`, `npm run package`이다. 최종 실행 결과와 시험 수는 전달 시점의 검증 기록을 따른다. 아래 파일 링크는 시험의 존재와 범위를 설명하며, 명령을 실행하지 않고 성공했다고 추정하는 근거가 아니다.

## UX · 4개

| ID | 현재 상태 | 구현과 자동 시험 근거 | 남은 확인 또는 한계 |
|---|---|---|---|
| UX-01 | 구현·자동 | [view.ts](../apps/obsidian-plugin/view.ts), [runtime.ts](../apps/obsidian-plugin/runtime.ts); [workflow.test.ts](../tests/workflow.test.ts)의 승인 전 불변·적용 후 상태 | 실제 UI에서 `WAITING_APPROVAL`과 적용 완료 문구 구별, 실패 후 표시 확인 |
| UX-02 | 구현·자동 | RunGuard·AbortController·큐 취소; [core-tools](../tests/core-tools.test.ts), [workflow](../tests/workflow.test.ts), [providers](../tests/providers.test.ts), [tasks](../tests/tasks.test.ts) | 중단 표시 1초 이내 목표, 실제 네트워크·UI 지연 미측정. 이미 서버가 받은 요청의 취소·과금 철회는 보장하지 않음 |
| UX-03 | 구현·수동대기 | [view.ts](../apps/obsidian-plugin/view.ts)의 버튼·라벨·탭, [styles.css](../styles.css) | Windows/macOS 키보드 접근, 포커스 순서, 라이트/다크, 줌, 스크린리더 미검증 |
| UX-04 | 구현·자동 | PolicyError·ProviderError 코드, UI 해결 안내; [providers](../tests/providers.test.ts), [core-changes](../tests/core-changes.test.ts) | 실제 인증 만료·기업 프록시 오류·설정 미완료의 사용자 안내 확인 |

## Core · 6개

| ID | 현재 상태 | 구현과 자동 시험 근거 | 남은 확인 또는 한계 |
|---|---|---|---|
| CORE-01 | 구현·자동 | [contracts](../packages/contracts/index.ts) Run, [runtime](../apps/obsidian-plugin/runtime.ts); [workflow](../tests/workflow.test.ts), [tasks-runtime](../tests/tasks-runtime.test.ts) | 실제 UI에서 수동·예약·재시도 및 parentRunId 추적 확인 |
| CORE-02 | 구현·자동 | [tools.ts](../packages/core/tools.ts) strict 입력/출력 스키마; [core-tools](../tests/core-tools.test.ts) | 모델이 자유롭게 도구를 선택하는 루프가 아닌 고정 Workflow. 필요한 도구만 등록 |
| CORE-03 | 구현·자동 | [policy.ts](../packages/core/policy.ts), 전송·검색·쓰기 직전 정책 검사; [core-policy](../tests/core-policy.test.ts), [search](../tests/search.test.ts), [tasks-runtime](../tests/tasks-runtime.test.ts) | 실앱의 실행 중 설정 변경·동시 편집 이벤트 확인 |
| CORE-04 | 구현·자동 | [changes.ts](../packages/core/changes.ts) hash·policyVersion·sourceRefs·만료 결합; [core-changes](../tests/core-changes.test.ts), [workflow](../tests/workflow.test.ts) | 실제 승인 모달과 UI 수정 흐름 E2E 미검증 |
| CORE-05 | 구현·자동 | [budget.ts](../packages/core/budget.ts), Provider 제한; [core-tools](../tests/core-tools.test.ts), [providers-runtime](../tests/providers-runtime.test.ts), [agent](../tests/agent.test.ts) | 입력은 보수적 바이트 기반 추정이며 실제 토크나이저·청구 금액 계측이 아님. 실모델의 컨텍스트 한도와 출력 제한 확인 |
| CORE-06 | 구현·자동 | [changes.ts](../packages/core/changes.ts) prepared intent → 파일 → 결과; [core-changes](../tests/core-changes.test.ts), [storage-state](../tests/storage-state.test.ts) | 모의 장애 주입 통과 범위와 실제 Obsidian/OS 강제 종료를 구분. 후자는 AT-09 대기 |

## Obsidian · 6개

| ID | 현재 상태 | 구현과 자동 시험 근거 | 남은 확인 또는 한계 |
|---|---|---|---|
| OBS-01 | 구현·자동 | [Vault Adapter](../packages/obsidian/index.ts), 제외 정책; [core-policy](../tests/core-policy.test.ts), [core-vault](../tests/core-vault.test.ts) | 실제 Vault의 숨김 폴더·심볼릭 링크·Windows junction 동작 확인 |
| OBS-02 | 부분·자동 | 관리 구역 밖 바이트 보존; [core-changes](../tests/core-changes.test.ts)의 CRLF·frontmatter·Dataview 보존 | `project`와 `tags`를 구조화 매핑하고 그 외 속성은 원문에 보존. 모든 개인 속성의 설정형 매핑·감지 UI는 제공하지 않음 |
| OBS-03 | 구현·자동 | Daily 관리 구역 교체/최초 삽입, 새 초안 경로 충돌 거부; [core-changes](../tests/core-changes.test.ts), [workflow](../tests/workflow.test.ts) | 실제 Vault API에서 파일 생성·닫힌 노트 적용 E2E 대기 |
| OBS-04 | 구현·자동 | [Vault Adapter](../packages/obsidian/index.ts)의 열린 markdown 창 차단·process 콜백 내부 해시; [core-vault](../tests/core-vault.test.ts) | 편집 버퍼 안전성을 추정하지 않고 열린 대상은 모두 차단. 분할·팝아웃 창 확인 필요 |
| OBS-05 | 구현·자동 | [main.ts](../apps/obsidian-plugin/main.ts) create/modify/delete/rename 연결; [search](../tests/search.test.ts), [workflow](../tests/workflow.test.ts) | 이벤트 이후 허용 Vault를 다시 읽어 reconciliation. 대규모 이벤트 처리 시간 미측정 |
| OBS-06 | 구현·자동 | 현재 hash 일치 조건으로 역변경안 생성, 별도 승인; [core-changes](../tests/core-changes.test.ts) | 생성한 파일을 삭제하는 rollback은 지원하지 않음. 기존 파일 역변경 UI 확인 필요 |

## Agent · 5개

| ID | 현재 상태 | 구현과 자동 시험 근거 | 남은 확인 또는 한계 |
|---|---|---|---|
| AGT-01 | 구현·자동 | [providers](../packages/providers/index.ts) ChatGPT 로그인·OpenAI 호환·Ollama Adapter; [providers](../tests/providers.test.ts) | 실제 ChatGPT 계정/모델 entitlement, Ollama, 회사 chat/completions 연결은 미검증 |
| AGT-02 | 부분·자동 | 예시 문자열 연결 시험·JSON/완료 상태·예상 외 tool call 거절; [providers](../tests/providers.test.ts) | 자유 도구 호출 기능은 제공하지 않음. 모델별 JSON Schema/JSON Object/텍스트 지원은 실제 시험 후 선택 |
| AGT-03 | 구현·자동 | [agent](../packages/agent/index.ts) 명시적 제외 ID·출력 예약·출처 유지; [agent](../tests/agent.test.ts), [workflow](../tests/workflow.test.ts) | 모델별 실제 tokenizer와 사내 서버 컨텍스트 한도 확인. 전송량 추정은 비용 보장이 아님 |
| AGT-04 | 부분·자동 | 사실/해석/제안 분리, 존재하는 출처 ID 요구; [agent](../tests/agent.test.ts), [workflow](../tests/workflow.test.ts) | 인용 ID의 존재는 주장의 의미적 참을 증명하지 않음. 근거 충실도 95%는 사람 평가 대기 |
| AGT-05 | 구현·자동 | strict JSON 검증 및 교정 1회; [providers-runtime](../tests/providers-runtime.test.ts), [workflow](../tests/workflow.test.ts) | 실제 모델의 긴/잘린/비JSON 출력 시 사용자 경험과 유용성 평가 필요 |

## Memory · 4개

| ID | 현재 상태 | 구현과 자동 시험 근거 | 남은 확인 또는 한계 |
|---|---|---|---|
| MEM-01 | 구현·자동 | confirmed만 선택; [agent](../tests/agent.test.ts), [MemoryModal](../apps/obsidian-plugin/setting-tab.ts) | 실제 UI 작성/확인 E2E 대기. 자동 기억 추출·승격 없음 |
| MEM-02 | 구현·자동 | scope·sourceRefs·reviewedAt·expiresAt; [agent](../tests/agent.test.ts) | 실제 프로젝트별 적용·출처 이동·만료 UI 확인 |
| MEM-03 | 구현·수동대기 | [설정 UI](../apps/obsidian-plugin/setting-tab.ts) 수정·중지·삭제 및 저장; 선택 로직은 [agent](../tests/agent.test.ts) | 중지/삭제 직후 새 Run과 상태 백업 정리 확인. OS 백업까지 지우는 기능은 아님 |
| MEM-04 | 부분·자동 | 정책/만료/원본 hash 재검사·낡은 기억 비활성; [agent](../tests/agent.test.ts), [workflow](../tests/workflow.test.ts) | 상충 사실의 자동 의미 탐지·병합 없음. 두 확인된 기억의 모순은 사용자 검토 대상 |

## Skill · 4개

| ID | 현재 상태 | 구현과 자동 시험 근거 | 남은 확인 또는 한계 |
|---|---|---|---|
| SKL-01 | 부분·자동 | [agent](../packages/agent/index.ts) strict manifest·도구·입출력 스키마 검증; [agent](../tests/agent.test.ts) | 사용자 Skill은 같은 일간 업무 정리 입력/출력 계약만 사용. 범용 새 Workflow 등록 엔진이 아님 |
| SKL-02 | 구현·자동 | Skill 내용 hash·Run snapshot; [agent](../tests/agent.test.ts), [tasks-runtime](../tests/tasks-runtime.test.ts) | 파일 검토와 활성화 사이 교체, 재시작 후 파일 변경을 실제 UI에서 확인 |
| SKL-03 | 구현·자동 | 선언된 도구가 정책 grant를 만들지 않음; [core-tools](../tests/core-tools.test.ts), [agent](../tests/agent.test.ts), [core-policy](../tests/core-policy.test.ts) | 악성 지침에 대한 실제 모델 출력은 AT-12/17에서 별도 평가 |
| SKL-04 | 구현·자동 | 지침/스키마만 로드, 임의 코드/셸 필드 거부; [agent](../tests/agent.test.ts) | 내부 제약이며 다른 Obsidian 플러그인이나 OS 프로세스를 격리하는 샌드박스는 아님 |

## Index · 5개

| ID | 현재 상태 | 구현과 자동 시험 근거 | 남은 확인 또는 한계 |
|---|---|---|---|
| IDX-01 | 구현·자동 | 읽기와 embedding grant 분리, 요청 전후 재검사; [search](../tests/search.test.ts), [core-policy](../tests/core-policy.test.ts) | 실제 모델 요청에 금지 canary가 없는지 AT-11에서 확인 |
| IDX-02 | 부분·자동 | 문서/내용 기반 chunk ID·hash·위치; [search](../tests/search.test.ts) | 저장된 행 번호로 원문을 여는 UI가 구현됨. 원문 변경 이후 위치 일치와 실제 스크롤은 실앱 확인 필요 |
| IDX-03 | 부분·자동 | 변경 hash 비교·동일 조각 벡터 재사용·삭제 제거; [search](../tests/search.test.ts) | 입력 수집은 이벤트마다 전체 허용 Vault를 재검사. 완전한 파일 단위 읽기 최적화가 아니며 p95 목표 대기 |
| IDX-04 | 구현·수동대기 | [설정 UI](../apps/obsidian-plugin/setting-tab.ts)의 문서·조각·pending·failed·lastSuccess | 실패 항목별 상세 진단은 제한적. 실제 재시도·진행 표시 확인 |
| IDX-05 | 구현·자동 | pause/resume/rebuild와 각 벡터 저장 checkpoint; [search](../tests/search.test.ts) | 자료 벡터화는 명시적 시작/재개 버튼을 눌러야 함. 실앱 재시작 후 이어가기 확인 |

## Search · 5개

| ID | 현재 상태 | 구현과 자동 시험 근거 | 남은 확인 또는 한계 |
|---|---|---|---|
| SRCH-01 | 부분·자동 | 키워드·cosine·RRF·필터; [search](../tests/search.test.ts) | 실제 embedding 하이브리드와 한국어/영문/코드 30문항 Recall@5 80% 미평가 |
| SRCH-02 | 구현·자동 | 경로·project·tags·kind·기간 필터; [search](../tests/search.test.ts) | 실제 UI 필터와 권한 변경 중 결과 비노출 확인 |
| SRCH-03 | 구현·수동대기 | Evidence의 제목·발췌·URI·시각·locator, [view.ts](../apps/obsidian-plugin/view.ts) | 실제 원문 링크/표시 시각·시간대 확인 |
| SRCH-04 | 부분·자동 | 근거 없으면 모델 미호출, 출처 없는 사실 거절; [workflow](../tests/workflow.test.ts), [agent](../tests/agent.test.ts) | 관련 없지만 검색에 걸린 근거의 의미 판단과 무근거 질의 10개 유보율은 사람 평가 필요 |
| SRCH-05 | 구현·자동 | Vault hash 및 GitHub revalidation; [search](../tests/search.test.ts), [github](../tests/github.test.ts), [tasks-runtime](../tests/tasks-runtime.test.ts) | 실서비스 장애·접근 철회·오래된 댓글의 상태 표시 확인 |

## Tasks · 5개

| ID | 현재 상태 | 구현과 자동 시험 근거 | 남은 확인 또는 한계 |
|---|---|---|---|
| TSK-01 | 구현·자동 | [tasks](../packages/tasks/index.ts), 비활성 Job 생성/명시적 활성화 UI; [tasks](../tests/tasks.test.ts) | 실제 Obsidian이 열린 상태에서 예약·시간대·다음 발생 표시 확인 |
| TSK-02 | 구현·자동 | occurrence key·단일 큐·Run과 발생 기록 함께 저장; [tasks](../tests/tasks.test.ts), [tasks-runtime](../tests/tasks-runtime.test.ts) | 같은 로컬 상태 저장소 범위. 단절된 두 PC의 전역 exactly-once를 보장하지 않음 |
| TSK-03 | 구현·자동 | 24시간 내 최신 발생 1회와 scheduled local date; [tasks](../tests/tasks.test.ts) | 실제 절전/앱 종료·재개·DST는 AT-08에서 확인 |
| TSK-04 | 구현·자동 | 일시 오류/Retry-After/교정/인증/정책 실패 구분; [providers-runtime](../tests/providers-runtime.test.ts), [github](../tests/github.test.ts) | 실제 서버의 429·프록시·인증 만료 응답 호환 확인 |
| TSK-05 | 구현·자동 | Job.deviceId와 기기 로컬 운영 저장소; [tasks](../tests/tasks.test.ts) | 두 PC의 별도 설정·실행 주체 전환을 수동 확인. 상주 Runner 없음 |

## Connect · 5개

| ID | 현재 상태 | 구현과 자동 시험 근거 | 남은 확인 또는 한계 |
|---|---|---|---|
| CON-01 | 구현·자동 | 지정 저장소·GitHub API base·SecretStorage 참조·probe; [github](../tests/github.test.ts) | 실제 GitHub/Enterprise 조직 승인·최소 토큰 권한 확인 |
| CON-02 | 구현·자동 | [connect](../packages/connect/index.ts) GET 경로 제한; [github](../tests/github.test.ts) | Issue·PR 본문 및 대화 댓글만 수집. PR diff와 인라인 코드 리뷰 댓글 수집은 후속 범위 |
| CON-03 | 구현·자동 | 페이지 cursor·partial·Retry-After·항목 상한; [github](../tests/github.test.ts) | 실제 대형 저장소·429·망 중단 후 재개 검증 |
| CON-04 | 구현·자동 | 외부 ID·hash·갱신 시각·마지막 성공 유지; [github](../tests/github.test.ts) | 실제 수정/종료된 Issue와 PR의 버전 변화 확인 |
| CON-05 | 구현·자동 | 권한 철회 시 캐시 삭제·차단·재검사; [github](../tests/github.test.ts), [tasks-runtime](../tests/tasks-runtime.test.ts) | 실제 연결 해제 후 UI 캐시와 백업 데이터 정리 확인 |

## Security · 6개

| ID | 현재 상태 | 구현과 자동 시험 근거 | 남은 확인 또는 한계 |
|---|---|---|---|
| SEC-01 | 구현·자동 | [policy](../packages/core/policy.ts), 모델/목적지 fingerprint; [core-policy](../tests/core-policy.test.ts), [workflow](../tests/workflow.test.ts) | 실제 생성·임베딩 요청 payload 점검 |
| SEC-02 | 구현·자동 | 기억 원본 정책 상속과 ChangeSet 근거 union; [agent](../tests/agent.test.ts), [workflow](../tests/workflow.test.ts) | 실제 혼합 자료와 기억의 전송/승인 철회 검증 |
| SEC-03 | 구현·자동 | 원문/기억을 untrusted JSON으로 구성, 모델 도구 미제공; [agent](../tests/agent.test.ts), [providers](../tests/providers.test.ts) | 의미적 prompt injection 저항성이 모든 모델에서 입증된 것은 아님. 실제 악성 원문 평가 필요 |
| SEC-04 | 구현·자동 | 정규 경로·symlink 검사·고정 endpoint·redirect 거부; [core-policy](../tests/core-policy.test.ts), [core-vault](../tests/core-vault.test.ts), [providers](../tests/providers.test.ts) | Windows junction·기업 DNS/프록시·실제 파일 시스템 경쟁 조건 검증. OS 보안 샌드박스 아님 |
| SEC-05 | 구현·자동 | SecretStorage 참조, 원격 오류 본문 비노출·로그 제한; [providers](../tests/providers.test.ts), [github](../tests/github.test.ts) | 실제 SecretStorage/로그/크래시 리포트 확인. 운영 snapshot과 검색 본문은 평문 가능 |
| SEC-06 | 구현·자동 | 정책 버전 증가·취소·index 무효화·운영 정리; [search](../tests/search.test.ts), [core-changes](../tests/core-changes.test.ts), [tasks-runtime](../tests/tasks-runtime.test.ts) | UI의 이전 검색·실행 결과와 보존 backup까지 철회 처리 수동 확인. OS 백업 삭제 보장 없음 |

## Nonfunctional · 6개

| ID | 현재 상태 | 구현과 자동 시험 근거 | 남은 확인 또는 한계 |
|---|---|---|---|
| NFR-01 | 미측정 | 레이아웃 준비 후 시작하는 [main.ts](../apps/obsidian-plugin/main.ts) | 초기화 p95 1초 목표 미측정 |
| NFR-02 | 미측정 | [search](../packages/search/index.ts)의 검색 알고리즘·기능 시험 | 5,000개/100MB/40,000조각에서 키워드 p95 0.5초·하이브리드 p95 2초 미측정 |
| NFR-03 | 미측정 | 파일 이벤트 debounce·상태 시각 기록 | 저장→키워드 p95 2초 미측정. 전체 Vault 재조회·JSON 저장 비용 포함 필요 |
| NFR-04 | 미측정 | 일감 직렬화·자료 조각/모델 요청 상한 | 유휴 추가 메모리 500MB 목표 미측정. 전체 JSON/원문/벡터가 메모리에 존재 |
| NFR-05 | 부분·자동 | [storage](../packages/storage/index.ts) fsync·rename·backup·lock·읽기 전용 복구; [storage-state](../tests/storage-state.test.ts), [core-changes](../tests/core-changes.test.ts) | 단일 JSON snapshot 방식이며 범용 트랜잭션 DB/분산 트랜잭션이 아님. 실앱/양 OS crash 검증 필요 |
| NFR-06 | 구현·자동 | 모델 없는 키워드 검색·기록 및 상태 UI; [search](../tests/search.test.ts), [workflow](../tests/workflow.test.ts) | 실제 오프라인 및 손상 읽기 전용 상태에서 조회/설정 UX 확인 |

## 현재 범위와 출시 판단

자료 임베딩은 사용자가 설정에서 명시적으로 시작하며, Query embedding도 별도의 사용자 입력 전송 권한을 요구한다. 생성 모델이 미설정되거나 근거가 부족하면 읽기/검색 상태와 이유를 표시한다. ChatGPT 로그인은 생성 경로이며 embedding은 Ollama 또는 사내 서버에 따로 설정한다. 계정 로그인과 자료 전송 승인은 독립적이다.

문서/벡터의 변경 여부는 증분 판별하지만, Obsidian 파일 이벤트와 검색 갱신 경로가 허용된 Vault를 다시 읽는다. 상태 저장도 JSON 전체 snapshot을 다시 쓰므로 대용량 동작·내구성·메모리는 실제 벤치마크 전까지 보장하지 않는다. 검색 품질, 사실의 의미적 정확성, 10근무일 효용은 자동 시험으로 대체하지 않는다.

현재 전달 상태는 **MVP 구현 및 로컬 회귀 검증 단계**다. G0의 양 OS 실제 설치·crash 확인, G3의 실모델 하이브리드 E2E, G4의 전체 P0 증거·성능·10근무일 파일럿을 완료한 것으로 표기하지 않는다. 다음 검증은 [업무 환경 검증 절차](workplace-validation.md)에 기록한다. 금지 자료 전송, 승인 우회, 원문 손실, 중복 적용이 한 번이라도 재현되면 파일럿 진행을 중단하고 수정·회귀 검증 후 재개한다.
