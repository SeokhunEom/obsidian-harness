# AI 연결

기본 제공자와 임베딩은 모두 비활성 상태다. 사용자가 서버·모델·자료 전송 범위를 지정하고 연결 시험을 실행해야 한다. 시험은 `{"ok":true}`를 요구하는 합성 문자열만 전송한다. 실제 업무용 PC의 모델 품질·계정 권한·프록시·Obsidian 호환성은 별도 검증 대상이다.

## 지원 방식

| 연결 | 생성 API | 임베딩 API | 인증 |
|---|---|---|---|
| Ollama | `/api/chat`, 비스트리밍 응답 | `/api/embed`, 잘림 금지 | 필요하면 SecretStorage에 저장한 Bearer 비밀값 참조 |
| 사내 OpenAI 호환 | 설정한 API base + `/chat/completions` | API base + `/embeddings` | 선택한 SecretStorage 이름의 Bearer 키. 키가 필요 없는 서버는 참조를 비운다. |
| Continue with ChatGPT | 공식 `/v1/responses`, SSE | 지원하지 않음 | 공식 SIWC 동적 등록·브라우저 OAuth·PKCE |

Ollama의 기본 base는 `http://127.0.0.1:11434`이다. 사내 OpenAI 호환 서버는 예를 들어 `https://ai.example.internal/v1`을 입력한다. base에 `/chat/completions` 또는 `/api/chat` 전체 경로를 넣지 않는다. 다른 base 경로가 필요한 프록시는 해당 API base를 입력한다.

생성과 임베딩은 각각 모델을 설정한다. ChatGPT 생성과 Ollama 임베딩을 함께 사용할 수 있다. ChatGPT 로그인으로 API 키 결제나 임베딩 사용 권한을 자동 제공한다고 가정하지 않는다.

## ChatGPT 로그인

2026-10-15 확인한 공식 문서 기준으로 로컬 개인 프로젝트와 오픈소스 앱은 `dynamic_agent_client`로 사용자별 등록을 시작할 수 있다. 기존 Codex 설치·브라우저 쿠키·다른 앱의 인증 파일은 읽지 않는다. 필요한 API 키나 고정 타사 OAuth client ID는 없다.

1. `Continue with ChatGPT`를 선택한다. 플러그인은 **이 기기에 저장된 UUIDv4**를 `ext_agent_host_id`로 사용한다.
2. `127.0.0.1`의 임시 포트에 `/auth/callback` 수신기를 연 뒤 기본 브라우저에서 OpenAI 인증 화면을 연다. 업무 PC의 방화벽이 loopback callback을 허용해야 한다.
3. 사용자는 계정·워크스페이스를 선택하고 ChatGPT 요금제 사용을 허용한다. 제공 여부는 계정과 조직 정책에 따라 달라진다.
4. `state`, PKCE, ID 토큰의 서명·issuer·audience·만료·nonce와 요금제 사용 scope를 검증한다. 토큰은 Obsidian SecretStorage 어댑터에만 저장한다. 설정에는 비밀값 자체를 넣지 않는다.
5. 계정별 모델 목록을 읽어 모델을 선택한다. 고정 모델명을 추측해서 기본값으로 넣지 않는다. 이후 연결 시험에서 구조화 출력을 검증한다.

같은 등록의 재로그인은 발급된 client ID를 재사용한다. 계정별 등록과 토큰은 분리된다. 로그아웃은 진행 중인 요청을 중단하고 갱신 세션을 원격 폐기한 뒤 로컬 토큰을 지운다. 원격 폐기가 확인되지 않았으면 UI가 이를 알리며, 사용자는 [ChatGPT 사용량 설정](https://chatgpt.com/settings/usage)에서 접근을 해제할 수 있다. 등록 식별자와 기기 host ID는 이후 재로그인을 위해 유지한다.

ChatGPT 요청은 공식 public Responses API에만 보낸다. `store:false`, `stream:true`, 명시적 입력 배열을 사용하며, `response.completed`를 받아야 성공이다. 일부 텍스트가 도착했어도 중단·불완전·사용량 오류이면 실패한다. API의 hosted 도구, 코드 실행, shell, MCP 도구를 모델에 제공하지 않는다.

SIWC preview는 `max_output_tokens`를 허용하지 않는다. 따라서 ChatGPT 경로는 요청 시간·응답 byte 상한을 적용하고, 반환된 사용량이 출력 예산을 초과하면 결과를 거절한다. **서버가 생성하기 전에 정확한 토큰 수나 청구를 차단하는 기능은 아니다.** Ollama와 사내 chat/completions에는 각 API의 출력 한도 필드를 전송한다. 비용 정보가 없는 경우 0원으로 추정하지 않는다.

실행 화면의 입력·출력 예산은 실제 청구 토큰 수와 다르다. 입력은 UTF-8 byte 수에 메시지·스키마 여유량을 더한 보수적 단위로 제한하고, 출력은 서버가 보고한 사용량과 UTF-8 byte 수 중 큰 값을 합산한다. 회사 서버가 사용량을 0 또는 지나치게 작게 보고해도 본문 크기만큼 예산을 소비한다. JSON 형식이 잘못되어 교정 대상으로 거절된 출력도 같은 기준을 적용한다. 한글은 한 글자가 여러 byte이므로 실제 토큰 사용량보다 빨리 한도에 도달할 수 있다. 이는 호출을 제한하기 위한 보수적 예산이며 실제 청구액·토큰 사용량의 정확한 측정이나 서버 생성 전 비용 차단을 보장하지 않는다.

## 전송과 HTTP 경계

- `localhost`, `127.0.0.0/8`, `::1`만 로컬 제공자로 분류한다. 사내 LAN 모델도 전송 정책상 `external`이다. 사내 서버로 보내려면 해당 자료와 정확한 목적지의 전송 허용이 필요하다.
- 일반 URL은 HTTPS를 사용한다. HTTP는 loopback 또는 사용자가 `allowPrivateHttp`를 허용한 사설 IP 목적지에서만 사용할 수 있다. 사내 DNS 이름은 실제로 해석된 주소가 모두 사설/loopback인지 검사한다.
- DNS 결과를 요청에 고정하며, localhost 분류가 외부 주소로 변하는 것을 허용하지 않는다. 리다이렉트는 따라가지 않는다. 최종 서버 URL을 직접 설정한다.
- URL 내부 사용자명·비밀번호·쿼리·프래그먼트는 허용하지 않는다. 모델 응답의 임의 URL을 요청하는 코드가 없다.
- 목적지 fingerprint는 제공자 ID(생성/임베딩), kind, 정규화 API base, 모델을 포함한다. 이 값이 바뀌면 기존 전송 승인을 재사용하면 안 된다.
- Node 기본 인증서 검증을 사용한다. TLS 검증을 끄는 옵션은 제공하지 않는다. 회사 CA/프록시를 사용하는 환경은 조직 표준에 맞춰 별도 검증한다.
- 오류에는 원격 응답 본문·인증 헤더·프롬프트·토큰을 포함하지 않는다. OAuth authorization URL은 ID token hint를 포함할 수 있어 기록하면 안 된다.

자동 재시도나 다른 제공자로의 우회는 어댑터에서 수행하지 않는다. 재시도 여부와 예산은 Core가 결정한다. Core는 일시적 실패에 2초·8초 대기를 적용하며 서버의 Retry-After가 더 길면 이를 따른다. 모든 대기는 전체 실행 시간과 취소 신호에 묶인다. JSON 형식 또는 근거 검증 실패는 한 번만 교정하며 실패한 출력의 확인된 사용량도 예산에 합산한다. 취소 신호는 활성 Node HTTP 요청을 즉시 파괴한다. 호출자는 제공자를 교체하거나 권한을 철회할 때 활성 실행도 취소해야 한다.

## 구조화 출력과 검증

설정은 `json-schema`, `json-object`, `text` 중 서버 지원에 맞춰 선택한다. `text`에서도 JSON 출력 계약을 지시하고 최종 결과를 파싱한다. 이 설정을 선택했다고 서버 기능 지원이 입증되는 것은 아니다. 연결 시험은 실제 출력이 `{ "ok": true }` 계약을 지켰는지 확인한다. 지원하지 않는 API 옵션은 실패로 표시하고 자동으로 형식이나 서버를 변경하지 않는다.

어댑터는 완료 상태·JSON 객체 형식·출력 한도·예상하지 않은 도구 호출을 검사한다. 업무 정리의 전체 schema와 출처 검증은 Core가 수행한다. 임베딩은 입력 개수·인덱스·벡터 길이·유한 숫자를 검증하고 서버가 행을 재정렬해도 원래 입력 순서를 복원한다.

## 자동 검증과 실제 검증의 구분

`tests/providers.test.ts`는 로컬 HTTP 수신기와 합성 OAuth 응답/서명 키만 사용한다. 실제 OpenAI·Ollama·사내 서버로 모델 요청을 보내지 않으며, 업무 자료나 현재 사용자의 인증을 읽지 않는다. 테스트는 OAuth callback의 state, PKCE 전달, nonce와 서명 검증, scope 검사, 토큰 회전 직렬화, 로그아웃 실패 표기, Responses 완료 요구, 네트워크 제한, 임베딩 무결성을 검증한다.

업무 PC에서는 별도의 테스트 Vault로 다음을 확인한다: 로그인과 loopback callback, 계정별 모델 목록, JSON schema 지원, 명시적 취소, 정확한 회사 endpoint/CA, 작은 임베딩 배치, scope 변경 후 전송 차단, 실제 사용량·응답 시간. ChatGPT 관련 공식 문서가 preview이므로 API 변화가 있으면 아래 문서를 다시 확인한다.

## 공식 근거

- [Sign in with ChatGPT 소개](https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt)
- [동적 등록·PKCE·ID token 검증](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- [계정·토큰 갱신·로그아웃](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)
- [모델 목록과 Responses SSE](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [SIWC preview 제한](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
- [Ollama Chat](https://docs.ollama.com/api/chat), [Ollama Embed](https://docs.ollama.com/api/embed)
