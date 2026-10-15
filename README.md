# Obsidian Harness

업무 노트와 지정 GitHub 저장소에서 근거를 찾고, 일간 업무 정리 **변경안**을 만든 뒤 승인한 구역만 반영하는 Obsidian 데스크톱 플러그인 MVP입니다. 첨부 PRD는 [docs/PRD-v0.1.md](docs/PRD-v0.1.md)에 그대로 보관했습니다.

현재 PC의 개인 Vault에 설치하거나 AI 계정에 로그인하지 않았습니다. 업무용 PC의 **시험 Vault**로 옮겨 검증할 수 있도록 소스, 테스트, 설치 파일을 한 Git 저장소에 담았습니다. PRD의 G4 출시 인증(실제 플랫폼·모델·성능·10근무일 파일럿)은 아직 완료하지 않았습니다.

## 설치

개발자 빌드에는 Node.js 22 이상이 필요합니다. 설치된 플러그인 사용에는 별도 Node 설치가 필요 없습니다.

```sh
npm ci --ignore-scripts
npm run package
```

1. `release/obsidian-harness-0.1.0.zip`을 업무용 PC로 옮겨 풉니다.
2. `obsidian-harness` 폴더를 시험 Vault의 `.obsidian/plugins/` 안에 복사합니다.
3. Obsidian을 다시 열고 **설정 → 커뮤니티 플러그인 → Obsidian Harness**를 켭니다.
4. Harness 설정에서 표시된 **Vault 밖 운영 저장 위치**를 확인합니다.
5. 읽기 경로와 쓰기 경로를 따로 지정합니다. 예: 읽기 `Work`, 쓰기 `Daily`, Daily 경로 `Daily/{date}.md`.
6. 생성 모델을 설정하고 예시 문자열로 연결 시험을 수행합니다. 해당 모델의 전송 허용 경로와 사용자 입력 전송을 별도로 지정합니다.
7. 임베딩 모델을 설정·시험하고 전송 범위를 정한 뒤 **범위 확인 후 임베딩**을 누릅니다.
8. 오른쪽 Harness의 검색/도우미에서 시험합니다. Daily 변경안을 검토하고 대상 노트를 모든 편집 창에서 닫은 후 승인합니다.

최소 API 기준은 Obsidian 1.11.4(SecretStorage)이며, 빌드 타입은 1.14.4로 고정했습니다. 실제 최소 앱 버전과 Windows/macOS UI 호환성은 [업무 PC 검증표](docs/workplace-validation.md)에서 확인해야 합니다. 원본 노트는 초기 설치만으로 읽거나 수정하지 않습니다.

## AI 연결

| 방식 | 설정 | 인증 |
|---|---|---|
| Ollama native | `http://127.0.0.1:11434`, 설치된 생성/임베딩 모델 ID | 키가 없으면 비밀값 이름을 비워 둠 |
| Ollama OpenAI 호환 | `http://127.0.0.1:11434/v1` | 같은 방식 |
| 사내 OpenAI 호환 | `https://사내주소/v1` | Obsidian SecretStorage에 저장한 키의 이름 |
| ChatGPT 로그인 | 제공자 선택 → 브라우저 로그인 → 허용 모델 목록 선택 | 공식 OAuth/PKCE, API 키 불필요 |

- ChatGPT는 공식 Sign in with ChatGPT의 Responses 스트리밍 API를 사용합니다. 계정·요금제·조직 정책에서 사용을 허용해야 합니다. 기존 Codex/브라우저 자격증명을 읽거나 비공개 ChatGPT API를 사용하지 않습니다.
- ChatGPT 로그인은 **생성 전용**입니다. 임베딩은 Ollama/사내 서버로 별도 설정합니다.
- 사내 서버와 LAN도 외부 목적지로 취급합니다. 루프백 HTTP는 허용하고, 사내 사설망 HTTP는 설정에서 명시적으로 허용해야 합니다. TLS 검증을 끄는 옵션은 없습니다.
- `/chat/completions`와 `/embeddings`, Ollama `/api/chat`와 `/api/embed`를 지원합니다. 모델 자체의 JSON Schema/JSON Object 지원 여부는 연결 시험으로 확인합니다. 모델 도구 호출이나 임의 코드 실행은 제공하지 않습니다.
- 생성 모델만 있으면 일간 정리 초안을 만들 수 있습니다. RAG 답변에는 준비된 하이브리드 검색이 필요합니다. 모델이 없어도 로컬 키워드 검색은 작동합니다.
- 생성·임베딩·직접 입력 전송은 목적지와 모델별로 허용합니다. 읽기 허용만으로 모델 전송을 허용하지 않습니다.

자세한 공식 근거와 제한은 [모델 연결 안내](docs/providers.md)에 있습니다.

## MVP 기능

- 도우미 / 검색 / 실행 / 승인함 패널, 명령 팔레트, 즉시 중단 요청.
- 한국어 부분 문자열·코드 식별자 검색, 벡터/RRF, 프로젝트·경로·태그·출처·기간 필터.
- 근거 ID와 구조화 출력 검증, 최대 1회 교정, 사실·해석·다음 행동 구분.
- 사용자 확인 기억, 기본 `daily-work-review`, 동일 입출력 계약을 사용하는 선언형 로컬 Skill 등록.
- 단일 파일 ChangeSet, 원문·내용·정책 해시에 결합된 승인, 24시간 만료, 적용 의도 저널, 재시작 복구, 별도 승인을 요구하는 역변경.
- 매일/평일 예약, 시간대와 실행 기기 지정, 최신 24시간 1회 보충, 단일 실행 큐.
- GitHub/Enterprise의 지정 저장소 Issue·PR·대화 댓글 읽기, 페이지별 재개, 접근 철회 차단.

기존 Daily Note는 아래 표식 사이만 바뀝니다. 표식이 없으면 승인 후 최초로 추가합니다. 중복/불완전한 표식은 차단합니다. 다른 본문, frontmatter, Dataview, 체크박스를 자동 재작성하지 않습니다.

```md
<!-- harness:daily-work-review:start -->
승인된 업무 정리
<!-- harness:daily-work-review:end -->
```

## 저장·복구

- 일반 설정: `<vault>/.obsidian/plugins/obsidian-harness/data.json`. 비밀값 이름만 저장합니다.
- 인증: Obsidian SecretStorage. 자체 암호화나 다른 플러그인과의 강제 격리를 주장하지 않습니다.
- 운영 상태: macOS `~/Library/Application Support/ObsidianHarness/<vault-hash>/`, Windows `%LOCALAPPDATA%/ObsidianHarness/<vault-hash>/`.
- 상태는 기기 로컬 잠금과 원자적 JSON 스냅샷/정상 백업으로 관리합니다. Vault 원본과 상태 파일 사이의 분산 트랜잭션을 가정하지 않습니다.
- 원문·벡터 색인은 로컬 상태에 포함됩니다. 초안·역변경 원문은 기본 7일, 실행 메타데이터는 90일 보존하며 설정에서 조정합니다. OS 디스크 암호화와 조직 보관 정책을 적용하세요.
- 손상된 상태를 자동 삭제하지 않고 읽기 전용으로 시작합니다. 백업 복구 절차는 [운영 안내](docs/operations.md)를 따르세요.

## 개발

```sh
npm run dev           # 번들 감시 (최초 CSS/manifest 복사; 이 두 파일 변경 후 재시작)
npm run typecheck
npm test
npm run build
npm run package       # 검증 + 설치 디렉토리 + ZIP + SHA256SUMS
npm run benchmark     # 합성 자료 / 모의 벡터의 재현 가능한 검색 측정
npm run skills:export # 기본 Skill manifest 재생성
```

```text
apps/obsidian-plugin  설정·패널·실행 조립
packages/contracts   공통 타입 (Obsidian 비의존)
packages/core        정책·승인·도구·예산
packages/agent       Skill·기억·출력·맥락 검증
packages/providers   ChatGPT OAuth, 생성·임베딩 HTTP
packages/obsidian    공개 Vault API Adapter
packages/search      색인·검색·근거
packages/tasks       시간대·중복·큐
packages/connect     GitHub 읽기
packages/storage     로컬 상태·보존·복구
skills/              사용자 Skill 시작 예제
tests/               정책·통합·장애 주입 시험
docs/                PRD·구현 대응표·업무 PC 검증
```

저장소는 `node_modules`, 빌드/배포물, `.env`, 로컬 상태, 키를 Git에서 제외합니다. 원격 저장소는 아직 연결하지 않았습니다. 사용자가 정한 원격에 올리려면:

```sh
git remote add origin <사용자가-만든-저장소-URL>
git push -u origin main
```

[검증 결과](docs/validation.md) · [PRD 요구사항 대응](docs/requirements.md) · [업무 PC 검증표](docs/workplace-validation.md) · [보안 경계](docs/security.md)
