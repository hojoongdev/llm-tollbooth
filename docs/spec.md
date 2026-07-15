# LLM Tollbooth — 프로젝트 기획서

> 프로젝트명: **LLM Tollbooth** (레포명 `llm-tollbooth`) — 모든 LLM 호출이 지나가는 톨게이트. 지나갈 때마다 비용이 기록되고, 한도를 넘으면 차단된다.
> 이 문서는 Claude Code가 전체 시스템을 단계별로 구현할 때 참조하는 단일 기준 문서다.
> 목표: 로컬과 실제 서버에서 동일하게 동작하는, 셀프호스팅 LLM 게이트웨이 + 관측/제어/워크플로우 플랫폼.

---

## 1. 한 줄 정의

앱과 LLM 제공사 사이에 앉아, 모든 호출의 **비용·토큰·지연·품질을 실시간 추적**하고, **예산 상한·캐싱·레이트리밋으로 제어**하며, **사용자 정의 워크플로우(조건 → 이메일/웹훅/차단)** 를 실행하는 셀프호스팅 게이트웨이.

## 2. 왜 만드는가 (배경)

여러 LLM(상용 + 자체 호스팅)을 운영하면 비용이 어디서 새는지, 지연이 언제 튀는지, 품질이 언제 떨어지는지 보이지 않는다. 실무(엔터프라이즈 AP 검증 플랫폼, 멀티 티어 모델 운영)에서 겪은 문제를 범용 도구로 일반화한 것.

대상 사용자: LLM API를 쓰는 개발자/팀. 자기 서버(또는 로컬)에 docker compose로 띄워서 사용.

## 3. 핵심 동작 방식

### 3.1 게이트웨이(프록시) 모드 — 메인

```
사용자 앱 ──(OpenAI 호환 API + API 키)──▶ Gateway ──▶ 실제 LLM (OpenAI/Anthropic/자체호스팅)
                                            │
                                            ├─ (비동기) 이벤트를 Kafka에 발행 — 응답 경로를 막지 않음
                                            ▼
                                     Kafka → Workers → Cassandra / MongoDB → Dashboard
```

- 게이트웨이는 **OpenAI 호환 엔드포인트**(`POST /v1/chat/completions` 등)를 노출한다. 기존 앱은 base URL과 API 키만 바꾸면 붙는다.
- 게이트웨이는 critical path 위에 있으므로: 기록은 **비동기**(fire-and-forget으로 Kafka 발행), 요청/응답 지연에 영향 최소화가 최우선 설계 원칙.
- provider 라우팅: 요청의 `model` 값 또는 API 키 설정에 따라 실제 provider(OpenAI, Anthropic, 자체 호스팅 vLLM 등)로 변환·전달.

### 3.2 데이터 흐름 요약

1. 앱이 게이트웨이 호출 (API 키 인증)
2. 게이트웨이: 키 검증 → 예산/레이트리밋 체크 → 캐시 조회 → (미스 시) 실제 LLM 호출 → 응답 반환
3. 동시에 이벤트(모델, 토큰, 비용, 지연, 상태 등)를 Kafka `llm.events` 토픽에 발행
4. Ingest Worker가 소비 → Cassandra(시계열 지표) + MongoDB(요청/응답 전문 문서) 저장
5. Rule Worker가 같은 이벤트 스트림을 소비 → 사용자 정의 규칙 평가 → 액션 실행(이메일/웹훅/차단 플래그)
6. Eval Worker가 (설정된 샘플링 비율로) 응답을 평가용 LLM에 보내 품질 점수화 → 저장
7. Dashboard가 Cassandra + MongoDB를 조회해 시각화

## 4. 기능 명세

각 기능에 [P1]~[P6] 표기 = 구현 단계(§10 빌드 로드맵과 대응). MVP는 P1~P4.

### 그룹 A — 관측 (Observability)

- [P2] 요청 단위 기록: model, provider, prompt/completion/total tokens, cost(USD), latency(ms), TTFB, status(success/error/cached/blocked), error type
- [P2] 비용 계산: MongoDB의 `provider_pricing` 컬렉션(모델별 입력/출력 백만토큰당 단가)을 기준으로 토큰 × 단가 계산. 단가표는 시드 데이터로 제공 + 콘솔에서 편집 가능
- [P2] 대시보드 뷰: 시간대별 비용/토큰/지연/에러율 추이, 모델별·API키별·프로젝트별 분해, 기간 필터(1h/24h/7d/30d)
- [P2] 요청 상세 로그: 개별 요청 클릭 → 프롬프트/응답 전문, 메타데이터, 평가 결과 열람 (MongoDB 조회)
- [P4] 지연 분포(p50/p95/p99), 캐시 히트율, 예산 소진율 게이지

### 그룹 B — 게이트웨이 제어

- [P3] API 키 발급/폐기/이름 지정 (콘솔에서 관리)
- [P3] 예산 상한: 프로젝트/키 단위로 일·월 한도 설정. 초과 시 429 또는 차단 응답 + 이벤트 기록(`status=blocked`)
- [P3] 레이트 리밋: 키 단위 분당/시간당 요청 수 제한
- [P3] 응답 캐싱: 동일 (model + 정규화된 messages) 해시 키로 캐시 조회. TTL 설정 가능. 캐시 히트 시 LLM 호출 없이 반환, `cache_hit=true`로 기록. 저장소는 MongoDB(단순) 또는 인메모리 — P3에서는 MongoDB 컬렉션으로 단순 구현
- [P5] 모델 폴백: primary provider 오류/타임아웃 시 대체 모델로 재시도 (키/프로젝트 설정)
- [P3] 멀티 provider: OpenAI, Anthropic, OpenAI 호환 자체 호스팅(vLLM 등) 최소 3종. provider별 요청/응답 포맷 변환 어댑터 구조로 확장 가능하게
- [P5] 스트리밍(SSE) 프록시 지원: 스트림 패스스루 + 종료 시 usage 집계. (토큰 집계가 복잡하므로 P5로 분리. P1~P4는 non-streaming만)

### 그룹 C — 워크플로우 & 알림 (핵심 차별 기능)

사용자가 콘솔에서 **규칙(Rule)** 을 조립한다. 규칙 = 조건(Condition) + 액션(Action) + 대상 범위(scope) + 쿨다운.

- [P4] 조건 타입:
  - metric threshold: 윈도우(예: 최근 1h) 내 합계/평균이 임계값 초과 — 대상 metric: cost, tokens, latency_p95, error_rate, request_count
  - budget percent: 예산의 N% 도달
  - quality drop: 평균 품질 점수가 임계값 미만 [P5, Eval 이후]
  - keyword match: 응답/프롬프트에 특정 키워드 등장 (샘플링 기반)
- [P4] 액션 타입:
  - email 발송 (SMTP 설정은 .env로; 로컬 개발은 MailHog 컨테이너로 수신 확인)
  - webhook 호출 (Slack/Discord/일반 URL, JSON payload)
  - block: 해당 키/프로젝트를 차단 상태로 전환 (게이트웨이가 이후 요청 거부)
  - tag: 매칭 이벤트에 라벨 부여 (대시보드 필터용)
- [P4] 규칙 평가 방식: Rule Worker가 Kafka 이벤트 스트림 소비 + Cassandra 윈도우 집계 조회로 조건 판정. 규칙별 쿨다운(예: 1회 발화 후 30분 무시)으로 알림 폭주 방지
- [P4] 콘솔 UI: 규칙 목록/생성/수정/활성화 토글, 발화 이력(언제 어떤 규칙이 어떤 액션을 실행했는지)

### 그룹 D — 품질 평가 (Evaluation)

- [P5] 평가용 LLM(설정 가능, 기본은 저비용 모델)이 응답을 채점: relevance(질문에 답했는가), hallucination risk, tone 등 1~5 점수 + 짧은 사유
- [P5] 전수 평가는 비용이 크므로 **샘플링 비율 설정**(기본 10%) + 특정 키/모델만 평가하는 필터
- [P5] 품질 추이 대시보드, 모델 간 품질 비교, 품질 하락 시 그룹 C 규칙 트리거 연동
- [P6] A/B 프롬프트 비교 뷰 (같은 기능 태그 내 프롬프트 버전별 품질/비용 비교)

### 그룹 E — 계정/멀티테넌시/운영

- [P3] AUTH_MODE 환경변수로 인증 강도 전환 (§6 참조)
- [P6] multi 모드: 이메일/비밀번호 가입, 프로젝트(테넌트) 생성, 프로젝트별 데이터 격리, 멤버 초대, 역할(owner/member)
- [P6] 주간 사용량 리포트 자동 생성 + 이메일 발송 (그룹 C 액션 재사용)

## 5. 시스템 아키텍처 & 기술 스택

### 컴포넌트

| 컴포넌트 | 역할 | 기술 |
|---|---|---|
| gateway | OpenAI 호환 프록시, 인증/예산/캐시/리밋, Kafka 발행 | Node.js + Fastify + TypeScript |
| workers | ingest / rules / eval 3개 컨슈머 프로세스 | Python 3.12 (kafka-python 또는 confluent-kafka, cassandra-driver, pymongo) |
| dashboard | 콘솔 UI + 조회 API | Next.js (App Router) + TypeScript |
| loadgen | 가짜 LLM 이벤트/트래픽 생성기 | Python CLI |
| infra | 전체 오케스트레이션 | Docker Compose |

- Kafka는 **KRaft 모드**(ZooKeeper 없이) 단일 브로커로 구성. 토픽 파티션 수는 기본 6 (병렬 소비 시연 목적).
- Cassandra 단일 노드. 초기 스키마는 `infra/cassandra/init.cql`로 컨테이너 기동 시 적용.
- MongoDB 단일 노드.
- 게이트웨이가 LLM을 직접 호출하지 못하는 환경(키 없음)을 위해 **mock provider**(고정 지연 + 가짜 usage를 반환하는 내장 가짜 LLM)를 반드시 포함 — 데모/테스트가 실제 API 키 없이 돌아가야 한다.

### 포트 (기본)

gateway 8080 · dashboard 3000 · Kafka 9092 · Cassandra 9042 · MongoDB 27017 · MailHog UI 8025

## 6. 인증 설계

두 종류의 인증을 분리한다.

1. **프로그램 인증 (게이트웨이 호출)** — 항상 API 키. `Authorization: Bearer <key>`. 키는 MongoDB `api_keys` 컬렉션에 해시 저장, 콘솔에서 발급. `AUTH_MODE=none`일 때는 부팅 시 자동 생성되는 기본 키 1개를 로그에 출력.
2. **사람 인증 (콘솔 접속)** — `AUTH_MODE` 환경변수로 전환:
   - `none`: 로그인 없음. 대시보드 바로 접근 (로컬 개발/데모 기본값)
   - `single`: .env의 ADMIN_EMAIL / ADMIN_PASSWORD 단일 계정 로그인 (1인 셀프호스팅)
   - `multi`: 가입/로그인/프로젝트/역할 전체 활성화 (서버 운영) [P6]

같은 코드베이스가 세 모드를 모두 지원해야 하며, 모드 분기는 미들웨어 한 곳에 격리한다.

## 7. 데이터 설계

### 7.1 Kafka

- 토픽 `llm.events` (파티션 6, key = project_id): 모든 게이트웨이 이벤트
- 토픽 `llm.eval.tasks`: 평가 대상 샘플 (eval worker 전용) [P5]
- 이벤트 스키마 (JSON):

```json
{
  "event_id": "uuid",
  "ts": "2026-07-10T12:00:00Z",
  "project_id": "default",
  "api_key_id": "key_abc",
  "provider": "openai",
  "model": "gpt-4o",
  "endpoint": "/v1/chat/completions",
  "prompt_tokens": 812,
  "completion_tokens": 214,
  "cost_usd": 0.00431,
  "latency_ms": 1240,
  "ttfb_ms": 310,
  "status": "success",
  "cache_hit": false,
  "error_type": null,
  "request_doc_id": "mongo_objectid",
  "feature_tag": "checkout-bot"
}
```

### 7.2 Cassandra (시계열 지표 — 쓰기 폭주 담당)

파티션 키 설계 원칙: (project_id, 분해 축, day bucket)으로 파티션 → 시간 정렬 클러스터링. 파티션 무한 성장 방지를 위해 day 단위 버킷.

```sql
CREATE TABLE metrics_by_model (
  project_id text, model text, day date,
  ts timestamp, event_id uuid,
  cost_usd double, prompt_tokens int, completion_tokens int,
  latency_ms int, status text, cache_hit boolean,
  PRIMARY KEY ((project_id, model, day), ts, event_id)
) WITH CLUSTERING ORDER BY (ts DESC);

CREATE TABLE metrics_by_key (
  project_id text, api_key_id text, day date,
  ts timestamp, event_id uuid,
  cost_usd double, total_tokens int, latency_ms int, status text,
  PRIMARY KEY ((project_id, api_key_id, day), ts, event_id)
) WITH CLUSTERING ORDER BY (ts DESC);

-- 대시보드 추이용 시간 단위 롤업 (ingest worker가 counter UPDATE)
CREATE TABLE rollup_hourly (
  project_id text, dim text,  -- 'model:gpt-4o' | 'key:abc' | 'all'
  day date, hour int,
  cost_micros counter,        -- counter는 정수 전용 → 달러는 100만분의 1 단위로
  requests counter, errors counter,
  prompt_tokens counter, completion_tokens counter,
  latency_sum_ms counter, cache_hits counter,
  lat_count counter,          -- 히스토그램이 센 요청 수 (= 히스토그램의 분모)
  lat_le_10 counter, ... lat_le_10000 counter,   -- 지연 히스토그램 [P4]
  quality_sum counter,        -- 평가 점수(1~5)의 합 × 100 [P5]
  quality_count counter,      -- 실제로 채점된 호출 수 (= 품질 평균의 분모) [P5]
  PRIMARY KEY ((project_id, dim, day), hour)
);
```

주의: 대시보드의 넓은 기간 조회는 raw 테이블이 아니라 `rollup_hourly`를 읽는다. 갱신은 **Cassandra counter**로 한다 — read-modify-write 없이 델타만 더하면 되기 때문이다. ingest worker는 배치(500건 또는 5초)를 메모리에서 (dim, hour) 버킷으로 먼저 접은 뒤 버킷당 UPDATE 한 번만 날린다. 500건이 카운터 왕복 1500번이 아니라 몇 번으로 접힌다.

`lat_le_*`는 Prometheus `le` 방식의 **누적** 히스토그램이다(각 버킷은 자기 상한 *이하*의 요청 수). 누적 버킷은 덧셈이 되므로 창 전체의 백분위를 구하는 일이 다른 카운터와 똑같은 열 단위 합산이 된다. 분모는 `requests`가 아니라 `lat_count`를 쓴다 — 히스토그램이 생기기 *전에* 쓰인 행들은 `requests`만 있고 버킷이 없어서, `requests`로 나누면 그 요청들이 전부 최상위 버킷을 넘긴 것처럼 보여 p99가 천장에 붙는다. 히스토그램은 자기 분모를 직접 들고 다녀야 한다.

`quality_*`는 **eval worker가** 같은 행에 쓴다(ingest worker가 아니라). 두 writer가 서로소 칼럼만 건드리고 counter 는 덧셈이라 조율이 필요 없다. 여기서도 분모는 `requests`가 아니라 `quality_count`다 — 평가는 **샘플링**이라 대부분의 요청은 채점되지 않으며, `requests`로 나누면 멀쩡한 시스템의 품질이 0에 가깝게 보인다. 점수는 정수 counter 에 담으려고 ×100 해서 넣는다(돈을 마이크로달러로 넣는 것과 같은 이유).

### 7.3 MongoDB (유연한 문서 담당)

| 컬렉션 | 내용 |
|---|---|
| `requests` | 프롬프트/응답 전문, 헤더 메타, 평가 결과 embed. 요청마다 구조 상이 |
| `rules` | 워크플로우 규칙 (condition/action 트리 — 타입별로 필드가 달라 문서형이 적합) |
| `api_keys` | 키 해시, 이름, 프로젝트, 예산/리밋 설정, 상태(active/blocked), fallback_model [P5] |
| `users` | 이메일 + scrypt 비밀번호 해시 (multi 모드 로그인) [P6] |
| `projects` | 테넌트. 모든 요청·키·규칙·지표가 이미 project_id 를 달고 있고(Cassandra 파티션 키가 P2부터 그걸로 시작), multi 모드가 그 id 를 실제 경계로 만든다 [P6] |
| `memberships` | 누가 어느 프로젝트에 어떤 역할(owner/member)로 속하나 — 요청마다 하는 "이 유저가 이 프로젝트에 있나" 조회가 인덱스 한 번이 되도록 별도 컬렉션 [P6] |
| `report_state` | 주간 리포트 발송 시각 (재시작해도 매일 리포트를 재발송하지 않도록) [P6] |
| `provider_pricing` | 모델별 단가표 (시드 + 편집 가능) |
| `cache_entries` | 응답 캐시 (hash key, response, TTL 인덱스) |
| `rule_firings` | 규칙 발화 이력 (언제, 어떤 규칙, 어떤 액션, 결과) |
| `settings` | 콘솔이 편집하고 워커가 주기적으로 다시 읽는 설정 (`_id: "eval"` = 샘플링 비율/평가 모델/필터) [P5] |

`requests`는 크기가 커질 수 있으므로 TTL 인덱스(기본 30일, 설정 가능)로 자동 정리.

## 8. 대시보드(콘솔) 화면 목록

1. Overview: 기간 필터 + 비용/요청수/에러율/평균지연 카드 + 추이 차트 + 모델별 분해
2. Requests: 요청 로그 테이블(필터: 모델/키/상태/기간) → 행 클릭 시 상세(프롬프트/응답/평가)
3. API Keys: 키 목록, 발급, 예산·리밋 설정, 차단 토글
4. Rules: 규칙 목록/빌더(조건·액션 폼), 발화 이력
5. Pricing: 단가표 편집
6. Settings: AUTH_MODE 안내, SMTP/웹훅 기본값, 샘플링 비율 [P5]
7. Quality: 품질 추이/모델 비교 [P5]

## 9. 배포 형태

- **로컬**: `git clone` → `.env` 작성(.env.example 제공) → `docker compose up` → dashboard localhost:3000, gateway localhost:8080. AUTH_MODE=none 기본.
- **서버**: 동일 compose를 VM에서 실행. AUTH_MODE=single 또는 multi. 리버스 프록시/TLS는 문서로 안내(Caddy 예시)하되 compose 필수 구성엔 포함하지 않음.
- **CI (GitHub Actions)**: push 시 lint + typecheck + 단위 테스트 + gateway/dashboard Docker 이미지 빌드. `main` 태그 시 이미지 push(optional). 워크플로우 파일 `.github/workflows/ci.yml` 포함.

## 10. 빌드 로드맵 (각 단계는 "돌아가는 상태"로 끝난다)

**P1 — 뼈대** 
Docker Compose로 Kafka/Cassandra/MongoDB/MailHog 기동. loadgen이 `llm.events`에 가짜 이벤트 발행, 최소 ingest worker가 소비해 콘솔 로그 출력. 
완료 기준: `docker compose up` 한 번에 전부 뜨고, loadgen 실행 시 worker 로그에 이벤트가 흐른다.

**P2 — 관측 파이프라인** 
ingest worker가 Cassandra(raw + rollup) / MongoDB(requests) 저장. dashboard Overview + Requests 화면. 
완료 기준: loadgen으로 흘린 데이터가 대시보드 차트와 요청 상세에 보인다.

**P3 — 게이트웨이** 
Fastify 게이트웨이: API 키 인증, mock provider + OpenAI/Anthropic 어댑터, 비용 계산, 캐싱, 예산 상한, 레이트 리밋, Kafka 발행. API Keys / Pricing 화면. 
완료 기준: curl로 게이트웨이에 chat completion을 보내면 (mock 또는 실제 키로) 응답이 오고, 그 호출이 대시보드에 기록되며, 예산 초과 시 차단된다.

**P4 — 워크플로우 & 알림** 
rules worker + 규칙 CRUD UI + email(MailHog)/webhook/block/tag 액션 + 쿨다운 + 발화 이력. 
완료 기준: "1시간 비용 $X 초과 시 이메일" 규칙을 만들고 loadgen으로 초과시키면 MailHog에 메일이 도착한다.

**P5 — 품질 평가 + 스트리밍 + 폴백** 
eval worker(샘플링, 평가 LLM), Quality 화면, 품질 조건 규칙 연동, SSE 프록시, 모델 폴백. 
완료 기준: 샘플링된 요청에 품질 점수가 붙고, 품질 하락 규칙이 발화한다. 스트리밍 요청이 정상 프록시되고 usage가 집계된다.

**P6 — 멀티테넌시** 
AUTH_MODE=multi: 가입/로그인(NextAuth + scrypt), 프로젝트 격리(세션의 현재 프로젝트로 모든 읽기를 좁힘 — 콘솔·rules·eval 워커 전부), 멤버/역할(owner/member, 마지막 owner 보호), 주간 리포트 메일(프로젝트별 요약을 owner 에게, 그룹 C email 재사용). 인증은 미들웨어 한 곳에서 none/single/multi 분기. 
완료 기준: 두 계정이 서로의 데이터를 볼 수 없다 — 목록으로도, 요청 id 를 직접 열어도(IDOR).

## 11. 부하 생성기 & 측정 지표 (이력서용 숫자 확보)

loadgen 요구사항:
- 모드 1 (이벤트 직발행): Kafka에 직접 이벤트 발행 — 파이프라인 처리량 측정용
- 모드 2 (게이트웨이 경유): 게이트웨이 HTTP 호출(mock provider) — E2E 지연 측정용
- 파라미터: RPS, 지속 시간, 모델 분포, 에러 비율, 프로젝트/키 분포

기록해둘 숫자 (README에 벤치마크 섹션으로 남길 것):
- 파이프라인 최대 처리량 (events/sec), 그때의 컨슈머 랙 추이
- 파티션/컨슈머 수 변화에 따른 처리량 변화 (1→3→6)
- 게이트웨이 오버헤드 (mock provider 기준 p50/p95 추가 지연)
- 캐시 히트 시 vs 미스 시 지연 비교

## 12. 비범위 (Non-goals)

- Kubernetes/멀티 노드 클러스터 구성 (단일 노드 compose까지만)
- 결제/과금 시스템
- 모델 파인튜닝
- 프롬프트 관리(버저닝) 도구 — A/B 비교 뷰[P6] 이상으로 확장하지 않음

## 13. 리포지토리 구조

```
llm-tollbooth/
├── docker-compose.yml
├── .env.example
├── .github/workflows/ci.yml
├── gateway/          # Fastify + TS
├── workers/          # Python: ingest/, rules/, eval/ + 공용 lib
├── dashboard/        # Next.js
├── loadgen/          # Python CLI
├── infra/
│   ├── cassandra/init.cql
│   └── mongo/seed.js        # pricing 시드 등
└── docs/             # 아키텍처 다이어그램, 벤치마크 결과
```

## 14. 구현 시 일관 원칙 (Claude Code 지시)

- 각 Phase를 넘어가기 전에 해당 완료 기준을 실제로 실행해 검증한다.
- 게이트웨이 hot path에서는 동기 DB 조회를 최소화한다 (키/예산 상태는 짧은 TTL 인메모리 캐시 허용).
- 이벤트 발행 실패가 사용자 응답을 실패시키면 안 된다 (로그 후 계속).
- 모든 서비스는 /health 엔드포인트를 가진다.
- 시크릿은 전부 .env로. 코드에 하드코딩 금지. .env.example을 항상 최신으로 유지.
- 테스트: gateway(비용 계산, 캐시 키 정규화, 예산 판정)와 rules(조건 판정)에는 단위 테스트 필수. 나머지는 Phase 완료 기준의 수동/스크립트 검증으로 갈음.
