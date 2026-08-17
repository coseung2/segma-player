# Aura Media Downloader 미디어 파이프라인 기술 리뷰

- 검토 기준 브랜치: `main`
- 검토 범위: MV3 서비스 워커, MAIN/isolated world 브리지, HLS/DASH/직접 미디어 감지, iframe 처리, 요청 헤더와 DNR, 토큰 갱신, 브라우저 재생, 테스트, 패키징 및 Chrome Web Store 위험
- 재현 기준 사례:
  - `https://missav123.com/ko/simd-012`
  - `https://av19t.com/bj/39141`

## 1. 결론

기존 구현은 이미 다음 기반을 갖추고 있었다.

- MV3 서비스 워커와 offscreen document를 분리한 다운로드 실행 구조
- `webRequest`, DOM 미디어 요소, Performance API, MAIN-world Fetch/XHR를 함께 보는 다중 감지 경로
- exact URL 단위 DNR lease와 요청 헤더 저장소
- HLS master/media playlist 파싱, AES-128 처리, 병렬 segment 수신
- iframe별 content script 실행과 Level5 전용 key bridge
- 비교적 넓은 순수 로직 단위 테스트

그러나 실제 사이트 변경에 견디는 데 필요한 핵심 개념이 빠져 있었다.

1. 감지 결과가 단순 URL 후보였고, **어떤 플레이어 세션에서 어떤 근거로 관측됐는지**가 보존되지 않았다.
2. `main` 여부가 사실상 DOM 크기나 먼저 들어온 iframe 정보에 의존해, 광고 iframe이 본편보다 먼저 승격될 수 있었다.
3. 토큰 URL은 갱신 가능한 세션이 아니라 일회성 문자열로 취급됐다.
4. 다운로드와 브라우저 재생이 원본 iframe의 Referer/Origin/Cookie 컨텍스트를 끝까지 동일하게 재현하지 못했다.
5. 브라우저 재생은 raw token URL을 확장 페이지 query string으로 전달하고, HLS segment마다 요청 컨텍스트를 설치하지 않았다.
6. MV3 서비스 워커 재시작 시 공개 job 상태는 남아도 실제 재실행에 필요한 candidate intent가 충분히 복구되지 않았다.
7. 실사이트 제보를 고정하는 회귀 데이터와 조기 경보용 모니터가 없었다.

이번 변경에서는 파이프라인을 다음 세 축으로 재정리했다.

- **Evidence pipeline**: URL이 아니라 `source + player + session + frame state`를 저장한다.
- **Selection pipeline**: 광고 여부, 실제 재생, 면적, 길이, top frame, 플레이어 직접 증거를 점수화한다.
- **Refresh/request-context pipeline**: exact source frame에서 URL을 다시 얻고, 실제 요청 직전에 exact DNR lease를 설치한다.

이 구조로 두 제보 사례의 핵심 실패 조건을 결정론적 회귀 테스트로 고정했다. 다만 이 검토 환경에서는 실제 사이트를 직접 방문해 재생까지 수행하지 않았으며, 실사이트 모니터는 별도 opt-in 실행 경로로 추가했다.

---

## 2. 변경 후 데이터 흐름

```text
[페이지 MAIN world]
  page-media-observer.js
    ├─ Fetch/XHR manifest 관측
    ├─ hls.js adapter
    ├─ video.js/VHS adapter
    ├─ JWPlayer adapter
    ├─ Plyr adapter
    └─ Level5/Hls.js session snapshot
          │ postMessage (bounded metadata only)
          ▼
[isolated world, frame별]
  content.js
    ├─ media element URL
    ├─ playing / muted / duration / visible area
    ├─ iframe layout / ad hint
    ├─ player source metadata 검증 및 정규화
    └─ source refresh request relay
          │ chrome.runtime.sendMessage
          ▼
[MV3 service worker]
  background.js
    ├─ candidate.js: 정규화, evidence merge, token freshness
    ├─ candidate-ranking.js: primary/alternate/ad 점수화
    ├─ request-header-store.js: exact request context 보관
    ├─ media-fetch-lease.js: exact URL + exact tab DNR lease
    ├─ playback-session.js: raw URL 비노출 재생 세션
    ├─ download intent/session 복구
    └─ exact source frame refresh
          │
          ├─ [offscreen download-worker]
          │     hls-download.js
          │       ├─ manifest/segment/key 요청
          │       ├─ 401/403 시 source-frame refresh
          │       └─ 기존 playlist shape 검증 후 이어받기
          │
          └─ [player.html]
                contextual-hls-loader.js
                  └─ manifest/segment/key마다 exact lease 설치
```

핵심 원칙은 다음과 같다.

- MAIN world는 플레이어 내부 상태를 볼 수 있지만 신뢰할 수 있는 보안 경계가 아니다.
- isolated world는 MAIN에서 받은 값을 길이·형식·프로토콜 기준으로 제한한다.
- background는 MAIN 이벤트 하나만 믿지 않고 frame 재생 상태, 네트워크 증거, iframe layout을 결합한다.
- token URL 원문은 candidate/session 내부에서만 유지하고, 일반 UI에는 redacted URL을 노출한다.
- Referer/Origin/Cookie는 전체 host 규칙이 아니라 exact URL, exact extension tab, 짧은 lease로만 재생한다.

---

## 3. 실제 실패 사례 분석

### 3.1 MissAV: 광고 iframe manifest가 본편보다 먼저 선택됨

기존 실패 경로는 다음과 같았다.

1. 최상위 페이지의 iframe 중 큰 프레임이 `main-frame`으로 보고된다.
2. 광고 프레임이 먼저 재생되거나 본편과 비슷한 크기를 차지하면 해당 frame의 HLS가 `main=true`가 된다.
3. popup은 `main` boolean을 우선 정렬한다.
4. 실제 본편이 `blob:` video element 뒤의 `surrit.com` HLS에 있더라도, hls.js 세션과 blob의 연결 관계가 보존되지 않아 광고 HLS가 먼저 보인다.

변경 후에는 다음 신호를 함께 평가한다.

- `player-adapter`에서 직접 관측된 hls.js source: 높은 가중치
- 실제 `playing=true`인 frame: 높은 가중치
- 긴 duration: 가산점
- 큰 visible area: 가산점
- top frame 또는 큰 본편 iframe: 가산점
- muted autoplay + 매우 짧은 duration: 감점
- URL/제목/iframe 속성의 ad, preroll, VAST, banner 신호: 큰 감점
- 여러 독립 source의 동일 후보 관측: corroboration 가산점

`candidate-ranking.test.mjs`와 `sites/missav/regressions.js`에서 광고 iframe과 `surrit.com` 본편을 동시에 넣어 본편만 primary가 되는 조건을 고정했다.

### 3.2 AV19: Level5/Hls.js 내부 token URL과 정확한 iframe Referer 필요

기존 구조의 문제는 다음과 같았다.

- `p.nnvivi.site` iframe 안의 Level5Player가 만든 hls.js 인스턴스와 후보 URL의 관계가 약했다.
- `webRequest`가 URL을 보더라도 짧은 token이 만료된 뒤 새 URL을 얻을 방법이 없었다.
- outer page URL과 iframe page URL 중 어떤 값을 Referer로 써야 하는지가 candidate에 명시되지 않았다.
- 브라우저 player에서 manifest URL만 직접 열고 segment/key 요청에는 source frame 컨텍스트를 적용하지 않았다.

변경 후에는 다음 값이 candidate evidence에 들어간다.

```text
source      = player-adapter
player      = level5
sessionId   = level5:<bounded-id>
frameId     = 실제 player iframe frameId
pageUrl     = 실제 iframe URL
resourceUrl = 현재 세션의 exact manifest URL
```

다운로드 직전과 401/403 발생 시 `refreshCandidateFromSourceFrame()`이 해당 `tabId + frameId + player + sessionId`로 snapshot을 요청한다. 새 manifest를 받으면 URL 원문을 갱신하고, 요청 헤더 저장소에서 동일 frame 컨텍스트를 조회한다.

`hls-download.js`의 `refreshHlsMedia()`는 새 playlist가 다음 조건을 만족할 때만 진행 중 다운로드에 덮어쓴다.

- media sequence 동일
- segment 개수 동일
- segment path가 80% 이상 동일

즉, 단순히 “새 HLS가 보였다”는 이유로 다른 영상으로 갈아타지 않는다.

---

## 4. 파일 및 함수 단위 검토와 변경 사항

### 4.1 `candidate.js`

#### 기존 문제

- candidate가 URL 중심 구조였다.
- query를 제거한 key로 합치면서 최신 token 원문을 갱신하는 의도는 있었지만, frame·player session 근거가 분리되지 않았다.
- 만료 시각을 알 수 있어도 구조화된 `expiresAt`, `refreshAfter`가 없었다.

#### 변경

- `mediaUrlFreshness()` 추가
  - `token`, `sig`, `expires`, `expiry`, `hdnts`, `policy`, `X-Amz-Date`, `X-Amz-Expires` 계열을 제한적으로 인식한다.
  - URL 자체는 변경하지 않고 `tokenized`, `expiresAt`, `refreshAfter`만 계산한다.
- `normalizeCandidateEvidence()` 추가
  - source/player/session/request type/confidence/time을 bounded token으로 정규화한다.
- candidate 필드 확장
  - `explicitMain`
  - `classification`
  - `score`, `scoreReasons`
  - `firstObservedAt`, `lastObservedAt`, `observationCount`
  - `evidence`
  - `player`, `sessionId`
  - `tokenized`, `expiresAt`, `refreshAfter`, `refreshable`
- `candidateKey()`에 frame ID를 포함한다.
- `upsertCandidate()`가 exact 최신 token URL을 보존하면서 evidence를 합친다.
- UI projection은 raw URL, session ID, evidence를 제외하고 redacted URL과 최소 메타데이터만 반환한다.

### 4.2 `candidate-ranking.js`

새로 추가된 순수 모듈이다.

#### 주요 함수

- `candidateLooksLikeAdvertisement()`
  - hostname/path/title/iframe ad hint를 평가한다.
- `scoreCandidate()`
  - evidence source, player 직접 증거, 실제 재생, 면적, duration, top frame, recency, token 만료 임박, 광고 신호를 합산한다.
- `rankCandidates()`
  - non-ad 최고 점수를 primary로 선택한다.
  - 같은 frame 또는 같은 player session의 가까운 대체 rendition만 함께 primary로 허용한다.

frame 상태는 30초 TTL을 둔다. 과거 광고가 한 번 재생됐다는 이유로 계속 primary가 되는 현상을 막기 위해 `content.js`가 15초마다 heartbeat를 갱신하고, 오래된 frame state는 점수에 사용하지 않는다.

### 4.3 `page-media-observer.js`

#### 기존 문제

- Fetch/XHR manifest 관측은 있었지만 플레이어 객체와 URL의 직접 연결이 약했다.
- playlist 본문을 MAIN → isolated message에 포함해 메시지 크기와 개인정보 보존 면에서 과도했다.
- 플레이어가 늦게 로드되면 초기 hook만으로 놓칠 수 있었다.

#### 변경

- `reportPlayerSource()`와 bounded player source registry 추가
- `discoverPlayerAdapters()`가 최대 60초 동안 플레이어를 탐색하고 load/play 이벤트에서도 재실행된다.
- adapter:
  - hls.js: `loadSource()`, `startLoad()`, levels/audio/subtitle
  - video.js: `currentSources()`, `currentSource()`, VHS/HLS tech
  - JWPlayer: playlist/config/setup
  - Plyr: source/config/media attachment
  - generic media element attached hls.js/Level5 internals
- snapshot protocol:
  - request: `aura-media-observer-snapshot-request-v1`
  - response: player source events + `snapshot-complete`
- stable session ID가 일치하면 token 갱신 중 CDN host/path 변경을 허용한다.
- manifest event에서 playlist text를 제거했다. URL, MIME, truncated 여부만 전달한다.
- MSE `appendBuffer()`나 `MediaSource`는 패치하지 않는다.

#### 주의

MAIN world 코드는 페이지와 같은 JavaScript realm에 있으므로 페이지가 같은 event 형식을 위조할 수 있다. 따라서 이 신호는 “권한 부여”가 아니라 “후보 증거”로만 사용해야 한다. 현재 background 점수화가 이 원칙을 따른다.

### 4.4 `level5-page-bridge.js`

- 기존 Level5 key 복구 경로는 유지했다.
- `postLevel5Source()`와 `reportLevel5Session()`을 추가해 Level5 내부 hls.js URL/levels/loadLevelObj를 즉시 보고한다.
- hls 인스턴스별 bounded session ID를 부여한다.

개발 소스에는 사이트가 제공한 same-origin runtime/WASM을 동적으로 불러오는 fallback이 남아 있다. Chrome Web Store ZIP 생성기는 해당 경로를 제거하고, `store-package.test.mjs`가 `WebAssembly`, `/assets/`, dynamic runtime helper가 최종 ZIP에 없는지 검사한다. 이 stripping이 깨지면 원격 호스팅 코드 정책 위험이 매우 크므로 release blocker로 유지해야 한다.

### 4.5 `content.js`

#### 변경

- `report()` dedupe key를 URL 하나가 아니라 `URL + source + player + session + request type`으로 변경
- `reportFrameMediaState()` 추가
  - playing
  - muted
  - visible area
  - viewport ratio
  - duration
  - top-frame 여부
  - blob source 존재
- 15초 heartbeat 추가
- `reportMainFrames()`가 단일 largest URL 대신 bounded frame layout 배열을 보낸다.
- iframe id/title/name/src에서 광고 hint를 계산한다.
- `handlePageMediaEvent()`가 player metadata를 보존한다.
- `handleRefreshMediaSource()`가 MAIN snapshot을 요청하고 가장 적합한 최신 URL을 반환한다.
- Dood direct resolver도 player evidence로 기록한다.

### 4.6 `background.js`

이 파일은 여전히 많은 책임을 가진다. 이번 변경으로 안정성은 높아졌지만 중기 리팩터링에서 가장 먼저 분리해야 할 파일이다.

#### 추가 또는 변경된 핵심 함수

- `rerankTabCandidates()`
  - tab의 frame state/layout과 candidate를 결합한다.
- `refreshCandidateFromSourceFrame()`
  - exact tab/frame/player/session에서 새 URL을 요청한다.
- `recoverInterruptedMediaDownloads()`
  - `downloadJobs`뿐 아니라 `downloadIntents`를 이용해 worker 재시작 후 작업을 다시 dispatch한다.
- `hasDownloadWorkerDocument()`
  - 최신 `offscreen.hasDocument()`가 없으면 `runtime.getContexts()`, 다시 없으면 `clients.matchAll()`을 사용한다.
- playback session 함수군
  - `createPlaybackSessionForCandidate()`
  - `createPlaybackSessionFromTab()`
  - `resolvePlaybackSession()`
  - `playerOwnsPlaybackSession()`
- request sender 구분
  - download worker만 key decode/source-frame download/native stream 권한을 가진다.
  - `player.html`은 media fetch lease만 사용할 수 있다.

#### webRequest 범위 축소

기존에는 모든 HTTP(S) resource type에 대해 request headers를 관측했다. 이제 다음 type만 본다.

- `media`
- `xmlhttprequest`
- `other`

이미지, stylesheet, font 등 불필요한 요청에서 Cookie/Authorization 메타데이터를 처리하지 않도록 표면을 줄였다.

#### 남은 구조 문제

`background.js`는 detection repository, scoring coordinator, DNR broker, download orchestrator, license/YouTube route, playback session을 모두 가진다. 중기에는 아래 모듈로 분리해야 한다.

```text
background/
  candidate-repository.js
  detection-coordinator.js
  source-refresh-broker.js
  request-context-broker.js
  download-orchestrator.js
  playback-session-broker.js
  lifecycle-recovery.js
```

### 4.7 `request-header-store.js` 및 `media-fetch-lease.js`

#### 현재 설계

- 요청 헤더는 메모리의 bounded TTL store에만 보관한다.
- Cookie, Authorization, x-auth/x-token 계열은 exact URL 일치에서만 재생한다.
- origin-path fallback에서는 credential header를 제외한다.
- diagnostics는 URL과 값이 아니라 header name과 redacted host만 노출한다.

#### 변경

- DNR header operation을 이름별로 dedupe한다.
- 전달된 exact iframe Referer가 recorded stale Referer보다 우선한다.
- 원본 요청에 Origin이 있었다면 그 값을 그대로 재생한다.
- 원본 Origin이 없었다면 `chrome-extension://` Origin 누출을 막기 위해 Origin을 제거한다.
- resource type에 `media`를 추가해 `<video src>` 직접 재생도 lease를 적용받는다.
- rule은 exact full URL, exact extension tab, 짧은 lease로 제한한다.

Cookie를 JavaScript fetch header로 직접 설정하지 않고 DNR `modifyHeaders`로만 적용하는 점이 중요하다.

### 4.8 `hls-download.js`

#### 변경

- `createDownloadContext()`가 source candidate를 보존한다.
- 초기 manifest가 401/403이면 source frame에서 candidate를 갱신하고 한 번 다시 읽는다.
- segment가 401/403이면 `refreshHlsMedia()`를 호출한다.
- 갱신 playlist shape를 검증한 뒤 segment/key/init URL을 교체한다.
- 갱신 후 active encryption key를 다시 계산한다.
- 같은 job의 refresh는 promise로 합쳐 중복 snapshot을 막고 5초 cooldown을 둔다.

#### 제한

source tab과 frame이 모두 사라지고 token이 플레이어 JavaScript 세션에서만 생성된다면 새 token을 만들 수 없다. 이미 받은 segment는 offscreen document가 계속 저장할 수 있지만, 만료 후 새 URL 생성에는 원본 세션이 필요하다. 장기 해법은 “사용자 동의하에 유지되는 refresh context”이며, 임의 hidden tab을 몰래 유지하는 방식은 권장하지 않는다.

### 4.9 `download-worker.js` 및 MV3 수명주기

- worker는 현재 실행 중인 job ID를 `download-worker-state`로 반환한다.
- service worker가 재시작되면 `downloadJobs`와 `downloadIntents`를 비교한다.
- offscreen worker에 이미 존재하는 job은 중복 실행하지 않는다.
- worker에 없는 queued/running/paused job은 다시 dispatch한다.
- background download가 허용되지 않은 plan에서 source tab이 닫혔다면 명시적으로 실패 처리한다.
- terminal 상태에서 intent를 제거한다.

이 구조는 “페이지를 떠나도 offscreen download가 계속된다”는 요구를 충족한다. 다만 token 재발급이 source JS session에 의존하면 앞 절의 제한이 남는다.

### 4.10 브라우저 재생: `playback-session.js`, `contextual-hls-loader.js`, `player.js`

#### 기존 치명적 문제

- `playback-addon.js`가 DOM에 출력된 redacted URL을 다시 읽어 player URL로 사용했다.
- raw media URL을 `player.html?url=...` query에 넣었다.
- browser history, crash report, bookmark에 token이 남을 수 있었다.
- HLS manifest 이후 segment/key 요청에는 exact iframe context가 적용되지 않았다.
- refresh가 active tab의 첫 main candidate를 선택해 다른 영상으로 바뀔 수 있었다.

#### 변경

- popup card에 candidate ID만 data attribute로 둔다.
- `create-playback-session`이 background의 candidate를 30분 TTL session으로 보관한다.
- launcher에는 opaque session ID만 반환한다.
- player URL은 `player.html?session=<uuid>` 형태다.
- player sender URL의 session ID와 요청 session ID가 일치해야 raw URL을 받을 수 있다.
- `contextual-hls-loader.js`가 hls.js 기본 loader를 감싸 요청마다:
  1. exact DNR lease 생성
  2. 요청 실행
  3. success/error/timeout/abort 시 lease 해제
- progressive `<video>`는 재생 동안 exact lease를 유지하고 heartbeat를 보낸다.
- fatal playback error는 source frame snapshot으로 한 번 자동 갱신한다.
- 사용자가 수동 갱신을 누르면 source page를 명시적으로 열고 해당 새 tab의 최고 non-ad candidate만 session에 연결한다.
- tokenized URL은 bookmark 기반 컬렉션에 새로 저장하지 않는다.

#### 남은 제한

- DASH browser playback은 아직 구현되지 않았다. 현재는 잘못된 재생을 시도하지 않고 다운로드 사용을 안내한다.
- 기존 버전에서 이미 bookmark에 저장된 raw token URL은 migration 대상이다. 새 session 경로는 raw URL을 query에 넣지 않지만, `collection.js`의 legacy bookmark format 자체는 호환성을 위해 남아 있다.

---

## 5. 요구사항별 답변

### 5.1 사이트별 하드코딩을 최소화하는 범용 감지 계층

권장 계층은 다음 순서다.

1. **Player adapter evidence**: 가장 강한 신호
2. **Media element evidence**: blob/direct URL과 실제 playing state
3. **MAIN Fetch/XHR evidence**: manifest response
4. **webRequest response evidence**: MIME 기반
5. **Performance evidence**: 가장 약한 보조 신호
6. **Site recipe**: 위 계층으로 해결되지 않을 때만 제한적으로 추가

이번 구현은 1~5를 공통 evidence contract로 통합했다. site recipe는 Level5 key decode처럼 프로토콜 특수성이 명확한 경우에만 유지한다.

사이트별 코드를 추가할 때는 hostname if문보다 다음 인터페이스를 사용해야 한다.

```text
PlayerAdapter
  detect(global, document) -> PlayerSession[]
  snapshot(session) -> MediaSourceEvidence[]
  refresh(session) -> MediaSourceEvidence[]
```

향후 adapter registry를 별도 파일로 분리하되, MAIN-world에서 ES module import가 페이지 CSP에 걸릴 수 있으므로 store 빌드 시 단일 번들로 만드는 편이 안전하다.

### 5.2 hls.js, video.js, Plyr, JWPlayer, Level5 adapter 구조

이번 변경은 동일 파일 안에서 adapter 동작을 구현했다. 다음 단계에서는 아래처럼 분리한다.

```text
page-adapters/
  registry.js
  hlsjs.js
  videojs.js
  plyr.js
  jwplayer.js
  level5.js
  media-element.js
```

공통 반환 형식:

```json
{
  "source": "player-adapter",
  "player": "hls.js",
  "sessionId": "hls.js:3",
  "url": "https://cdn.example/master.m3u8?...",
  "contentType": "application/vnd.apple.mpegurl",
  "confidence": 100,
  "observedAt": 1700000000000
}
```

adapter는 player method를 완전히 대체하지 않고 native shape를 보존하는 thin wrapper 또는 read-only inspection을 사용한다. 예외는 모두 흡수해 페이지 재생을 깨지 않도록 한다.

### 5.3 iframe 및 MAIN world에서 manifest 수집

- `all_frames: true`로 각 frame에 MAIN observer와 isolated content script를 함께 넣는다.
- MAIN observer는 player session과 network API를 본다.
- isolated content script는 현재 frame URL과 frame playback state를 붙인다.
- background는 Chrome이 부여한 `sender.frameId`와 `sender.url`을 권위 있는 frame identity로 사용한다.
- message가 주장하는 `frameUrl`은 sender URL이 없을 때만 canonical fallback으로 사용한다.
- refresh는 broad broadcast가 아니라 `chrome.tabs.sendMessage(tabId, ..., {frameId})`로 exact frame에 보낸다.

### 5.4 광고와 본편 점수 기반 선정

현재 점수는 규칙 기반이지만 테스트 가능하고 설명 가능하다.

강한 양의 신호:

- player adapter 직접 source
- frame playing
- 긴 duration
- 큰 visible area
- top frame
- 여러 독립 source의 corroboration

강한 음의 신호:

- ad hostname/path/title/iframe hint
- 짧은 duration
- muted autoplay
- 만료 임박 token

향후 실제 오탐 데이터를 수집할 때 score 상수를 config로 이동하고, 후보 카드의 debug mode에서 `scoreReasons`를 표시하면 현장 튜닝이 쉬워진다. 일반 사용자 UI에는 상세 근거를 노출하지 않는다.

### 5.5 만료 URL 감지 및 자동 갱신

- URL query와 AWS signed URL에서 만료 시각을 추정한다.
- 다운로드 시작 전에 tokenized/player candidate를 snapshot한다.
- manifest/segment 401·403에서 source frame snapshot을 다시 수행한다.
- browser player fatal error도 한 번 자동 refresh한다.
- 동일 player session ID가 있으면 host/path rotation을 허용한다.
- 진행 중 HLS 다운로드는 playlist shape가 동일할 때만 URL을 교체한다.

장기적으로는 adapter별 `refresh()` 성공률, token lifetime, status code를 익명 local metric으로만 집계해 refresh timing을 조정할 수 있다. 외부 전송은 별도 opt-in과 개인정보 고지가 없으면 하지 않는다.

### 5.6 403 방지: Referer, Origin, Cookie, 요청 컨텍스트

안전한 전달 규칙:

- candidate의 `pageUrl`은 outer page가 아니라 실제 source iframe URL이다.
- webRequest header store key에는 tab ID, frame ID, initiator origin을 포함한다.
- Cookie/Authorization/x-token은 exact full URL match에서만 재생한다.
- Referer는 exact source frame URL로 덮어쓴다.
- Origin은 원본 요청에서 관측된 값이 있으면 재생하고, 없으면 extension Origin을 제거한다.
- DNR rule은 exact URL + exact extension tab + 짧은 TTL이다.
- HLS player는 각 manifest/segment/key 요청 직전에 rule을 만든다.
- 값은 로그나 UI에 출력하지 않는다.

`credentials: include`만으로는 충분하지 않다. extension origin의 cookie policy, Referer, Origin이 원본 iframe과 다르기 때문이다. 반대로 모든 CDN host에 장기간 Cookie를 강제로 넣는 broad DNR rule은 보안상 허용하면 안 된다.

### 5.7 자동 회귀 테스트와 실사이트 모니터링

결정론적 테스트:

- `candidate-ranking.test.mjs`
- `site-regression.test.mjs`
- `sites/<id>/profile.js`
- `sites/<id>/regressions.js`
- `downloaders/registry.test.mjs`
- `page-media-observer.test.mjs`
- `content.test.mjs`
- `hls-download.test.mjs`
- `contextual-hls-loader.test.mjs`
- `playback-session.test.mjs`
- `player-security.test.mjs`

실사이트 모니터:

- `scripts/live-media-smoke.mjs`
- 확장 프로그램을 unpacked 상태로 로드
- fixture URL 방문
- bounded settle 후 candidate list 조회
- expected primary host/player 검증
- report에는 redacted URL만 저장
- `AURA_MONITOR_AUTOPLAY=1`일 때만 play 시도
- CI에서는 repository variable 또는 manual input으로 opt-in

실사이트 자동화는 사이트 이용약관, robots 정책, 트래픽 부하, 지역 차단을 고려해야 한다. 기본 schedule job은 repository variable이 없으면 실행되지 않도록 구성했다.

### 5.8 페이지 이탈 후 다운로드 유지

- offscreen document가 실제 fetch/write를 담당한다.
- service worker는 accepted intent와 public job state를 `storage.session`에 저장한다.
- service worker 재기동 시 worker active job과 intent를 대조해 재dispatch한다.
- source tab이 닫혀도 이미 유효한 URL과 lease로 진행 가능한 구간은 계속된다.
- source tab이 필요한 plan/refresh 조건에서는 명확히 실패한다.

장기적으로 native file writer 없이 매우 큰 다운로드를 안정화하려면 checkpoint에 다음 값을 추가하는 것이 좋다.

- manifest fingerprint
- media sequence
- completed segment bitmap
- refreshed URL generation number
- output file byte offset
- encryption key identity hash

### 5.9 보안·개인정보·Chrome Web Store 위험

#### 높은 위험

1. **원격 코드**
   - 개발용 Level5 runtime import가 store ZIP에 들어가면 안 된다.
   - store packager stripping + ZIP audit를 release gate로 유지한다.
2. **광범위 host permission**
   - `http://*/*`, `https://*/*`와 `webRequest` 조합은 강한 심사 사유다.
   - 중기에는 optional host permissions와 사용자 시작형 site access로 전환한다.
3. **민감 헤더**
   - Cookie/Authorization 값은 메모리 TTL store와 exact lease 밖으로 나가면 안 된다.
   - 로그, crash report, sync storage, analytics에 포함하지 않는다.
4. **token URL 노출**
   - raw URL query 전달을 제거했다.
   - legacy collection bookmark는 migration이 필요하다.

#### 중간 위험

- MAIN-world observation은 페이지 변조 가능성이 있다.
- 광고 판별은 휴리스틱이므로 false positive가 가능하다.
- 실사이트 monitor가 과도한 자동 방문으로 보이지 않도록 opt-in과 낮은 빈도를 유지해야 한다.
- dev manifest의 `bookmarks` 권한은 playback collection용이며 store General ZIP에서는 제거되는지 계속 검사해야 한다.

#### 낮지만 관리할 위험

- candidate/session state가 `storage.session`에 raw token을 포함한다.
  - 디스크 영구 저장이 아니고 trusted context로 제한했지만, 최소 TTL과 cap을 유지해야 한다.
- redacted URL도 path 자체에 식별자가 있으면 콘텐츠 식별 정보가 될 수 있다.
  - 외부 전송은 금지하고 artifact retention을 짧게 둔다.

### 5.10 실행 계획

#### 단기: 즉시 반영한 항목

- evidence 모델과 score 기반 primary 선정
- generic player adapter 및 MAIN snapshot
- frame playback/layout 수집
- token freshness 메타데이터
- source-frame 자동 refresh
- 401/403 HLS 이어받기
- Referer/Origin/Cookie exact lease 정리
- browser playback session 및 per-request HLS lease
- MV3 download intent 복구
- deterministic site fixtures 및 opt-in live monitor
- Chrome 111 minimum 선언
- offscreen document API 호환 fallback

#### 중기: 다음 리팩터링 순서

1. `background.js` 책임 분리
2. adapter registry 파일 분리 및 build-time bundle
3. optional host permissions 도입
4. legacy collection token migration
5. DASH browser player 추가
6. score debug tooling과 fixture generator
7. request-context store에 generation ID를 도입해 stale header와 fresh token의 혼합 방지
8. source tab이 닫히기 전 refresh deadline을 사용자에게 표시

#### 장기: 아키텍처

```text
Detection Core
  EvidenceBus
  AdapterRegistry
  FrameStateIndex
  CandidateRepository
  CandidateRanker

Refresh Core
  SourceSessionRegistry
  RefreshBroker
  RequestContextBroker
  TokenGenerationGuard

Transfer Core
  DownloadOrchestrator
  OffscreenExecutor
  CheckpointStore
  HlsTransferEngine
  DashTransferEngine

Quality Core
  FixtureRunner
  LiveProbe
  RedactedDiagnostics
  SiteChangeAlerts
```

사이트별 코드는 `Adapter` 또는 `RefreshRecipe` 플러그인으로만 들어가고, core에서 hostname 분기를 늘리지 않는 것이 목표다.

---

## 6. 테스트 전략

### 6.1 PR 필수

```bash
npm run test:media-sites
npm test
```

필수 assertions:

- 광고 iframe이 primary가 되지 않는다.
- Level5 source가 incidental performance HLS보다 높다.
- stale frame state가 30초 뒤 score에서 빠진다.
- 최신 exact token URL이 upsert 후 보존된다.
- player session launcher response에 raw URL이 없다.
- player sender URL과 session ID가 다르면 session resolve가 거부된다.
- HLS loader가 network 시작 전에 lease를 얻고 모든 종료 경로에서 해제한다.
- 403 후 새 playlist shape가 일치하면 segment 다운로드가 계속된다.
- recorded Origin과 exact Referer가 중복 없이 적용된다.
- store ZIP에 remote runtime/WASM fallback이 없다.

### 6.2 Nightly/수동 live probe

- 기본은 감지만 수행한다.
- autoplay는 명시적 환경 변수에서만 수행한다.
- raw token, Cookie, Referer 값을 artifact에 저장하지 않는다.
- 실패 시 다음만 보고한다.
  - case ID
  - expected/actual host
  - player adapter 이름
  - redacted candidate list
  - 오류 코드

### 6.3 릴리스 전 수동 확인

1. MissAV 사례에서 광고 재생 전/중/후 candidate 순위 확인
2. AV19 사례에서 iframe frame ID, player session ID, exact Referer 확인
3. source tab 유지 상태에서 token 만료 후 자동 갱신 확인
4. source tab 닫은 뒤 다운로드가 가능한 구간과 불가능한 구간 구분 확인
5. browser player에서 manifest, segment, key DNR lease 생성/해제 확인
6. store ZIP을 새 profile에 설치해 remote code, 권한, popup, download, update path 확인

---

## 7. 남아 있는 결정 사항

1. **DASH browser playback**
   - 다운로드 파이프라인과 별도로 player adapter가 필요하다.
2. **source session 유지 정책**
   - 사용자가 tab을 닫은 뒤에도 token refresh가 필요한 사이트를 어떻게 처리할지 UX 결정이 필요하다.
3. **optional host permission 전환**
   - 항상 감지와 사용자 클릭 후 감지 사이의 제품 요구를 정해야 한다.
4. **legacy collection migration**
   - bookmark에 저장된 raw token URL을 source-page recipe로 바꿀지, tokenized entry를 삭제할지 결정해야 한다.
5. **실사이트 probe 운영 주체**
   - 실행 지역, 빈도, 사이트별 opt-out, failure notification channel을 정해야 한다.

---

## 8. 최종 평가

변경 전 구조는 여러 감지 수단을 갖췄지만 “URL을 발견하는 확장 프로그램”에 가까웠다. 변경 후에는 “플레이어 세션의 증거를 수집하고, 실제 재생 후보를 선택하고, 만료 시 원본 세션에서 갱신하며, 요청마다 원본 컨텍스트를 재현하는 파이프라인”으로 이동했다.

가장 큰 개선은 특정 hostname 하드코딩이 아니라 다음 공통 contract를 도입한 점이다.

```text
Candidate = URL + Frame + PlayerSession + Evidence + Freshness + RequestContext
```

이 contract를 유지하면 사이트가 iframe host, CDN, token query, player wrapper를 바꾸더라도 adapter와 score의 일부만 조정하면 된다. 반대로 이 contract를 우회해 새 hostname if문이나 broad DNR rule을 추가하면 동일한 장애가 반복될 가능성이 높다.
