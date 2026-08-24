# Aura Media Downloader Incident Log

이 문서는 반복 수정과 회귀를 막기 위한 인시던트 기록이다. 코드 테스트만 통과한 경우에는 `해결됨`으로 닫지 않고 `코드 반영·실브라우저 미검증`으로 남긴다.

## 상태 규칙

- `OPEN`: 원인이 확인되지 않았거나 사용자 경로에서 계속 재현됨
- `CODE-FIXED / LIVE-UNVERIFIED`: 코드와 집중 테스트는 통과했지만 실제 Chrome/Whale 사용자 경로 확인 전
- `RESOLVED`: 재현 경로, 회귀 테스트, 실제 브라우저 확인을 모두 통과
- `BLOCKED`: 외부 영상 서버·브라우저 권한 등 코드 밖의 조건으로 진행이 막힘

## 현재 인시던트

### INC-2026-08-17-001 — 탭 이동 후 다운로드 진행창 누락

- 상태: `CODE-FIXED / LIVE-UNVERIFIED`
- 영향: 영상이 있는 원래 탭에서는 보이지만 영상이 없는 다른 탭으로 이동하면 진행창이 보이지 않거나, Chrome에서 탭별로 다르게 보임
- 범위: 감지탭, 링크 입력탭, YouTube, Chrome + Aura AdBlock
- 원인: 진행창 전달이 원래 탭/활성 탭 중심이었고, 기존 탭의 오래된 content script와 Aura AdBlock의 고정 요소 선택자가 겹침
- 조치: 일반 `http/https` 탭 전체에 진행창 리스너를 연결하고, 현재 content script를 재주입하며, 진행창 host 식별자를 광고 차단 선택자와 분리
- 반영: 0.3.64 이후, 현재 staging-pro 0.3.70
- 남은 검증: 작업 중인 상태에서 영상 없는 일반 탭으로 이동해 진행률·취소 버튼 확인

### INC-2026-08-17-002 — 저장 폴더 권한 만료 반복

- 상태: `CODE-FIXED / LIVE-UNVERIFIED`
- 영향: 업데이트 또는 재시도마다 같은 저장 폴더를 다시 선택하라는 메시지가 표시됨
- 원인: File System Access 핸들은 IndexedDB에 남아도 오프스크린 워커의 `queryPermission()` 결과가 새 컨텍스트에서 `granted`가 아닐 수 있었고, 재시도 UI가 저장된 핸들을 먼저 복구하지 않고 폴더 선택을 강제함
- 조치: 다운로드 버튼의 사용자 클릭에서 저장된 핸들의 권한을 먼저 갱신하고, 저장된 핸들이 있으면 선택창을 반복해서 열지 않도록 변경. 워커의 사전 권한검사는 유지해 무한 대기를 막음
- 반영: 0.3.66 이후, 현재 staging-pro 0.3.70
- 남은 검증: 같은 폴더를 유지한 채 업데이트 후 새 다운로드 실행. 실제 브라우저 권한이 완전히 `denied`인 경우에는 설정에서 한 번 복구해야 할 수 있음

### INC-2026-08-17-003 — `저장 준비 중…` 무한 대기

- 상태: `CODE-FIXED / LIVE-UNVERIFIED`
- 영향: 다운로드 작업이 하루 종일 `저장 준비 중…`에 머묾
- 원인: 0.3.68에서 워커의 사전 권한검사를 제거해 오프스크린 컨텍스트가 실제 파일 접근 권한 응답을 무기한 기다릴 수 있었음
- 조치: 사전 권한검사를 복구하고, 권한 갱신 책임을 사용자 클릭이 있는 팝업으로 이동
- 반영: 0.3.69~0.3.70
- 남은 검증: 이전에 멈춘 작업은 취소/삭제하고 0.3.70에서 새 작업으로 확인

### INC-2026-08-17-004 — 자막 생성 파이프라인 실패

- 상태: `CODE-FIXED / LIVE-UNVERIFIED`
- 영향: Modal에서 영상 서버 접근 차단 오류가 발생하고 자막 생성이 실패함
- 확인된 원인: 브라우저에서 재생 가능한 추출 링크라도 원격 Modal 작업은 같은 브라우저 세션과 요청 문맥을 갖지 못해 미디어 입력 단계에서 차단될 수 있음. 기존 구조는 원격 다운로드와 ffmpeg 오디오 추출 시간에도 GPU 작업을 점유함
- 0.3.76 조치: HLS master에 별도 audio rendition이 있으면 확장의 기존 인증된 fetch 경로로 오디오 트랙만 수집해 크기 제한이 있는 raw audio stream으로 업로드함. 별도 오디오 트랙이 없거나 준비가 실패하면 기존 URL 기반 입력 경로로 자동 fallback함
- 서버 조치: Cloudflare Worker가 브라우저 오디오 업로드를 검증해 Modal의 `/submit-audio`로 전달함. Modal은 URL 다운로드와 업로드 정규화를 CPU 함수에서 수행하고, GPU class는 준비된 16 kHz mono WAV의 ASR·번역만 수행하도록 분리함
- 회귀 테스트: HLS audio rendition 선택 시 video rendition을 요청하지 않는 테스트, raw audio streaming client/Worker proxy 테스트, 전체 `npm test` 398개 중 394 pass·0 fail·PowerShell 패키지 2건 및 선택적 브라우저 레이아웃 2건 skip
- 정적 검증: `python3 -m py_compile modal/asr_app.py` 통과, 격리한 공식 Modal SDK 1.5.4 환경에서 모듈 데코레이터 로딩 통과
- staging 버전: `0.3.76`
- 남은 검증: Worker와 Modal을 배포한 뒤 실제 Pro 사용자 경로에서 audio upload, 진행률, 취소, SRT 저장을 확인해야 함. progressive 또는 muxed HLS처럼 별도 audio rendition이 없는 입력은 아직 URL fallback을 사용함

### INC-2026-08-17-005 — 감지탭 브라우저 재생 버튼 누락

- 상태: `CODE-FIXED / LIVE-UNVERIFIED`
- 영향: 이전 버전에 있던 감지탭 브라우저 재생 버튼이 사라짐
- 원인: 기본 action popup 연결이 `popup-play.html`이 아닌 다른 팝업으로 변경됨
- 조치: manifest의 기본 팝업을 `popup-play.html`로 복구
- 남은 검증: Chrome과 Whale에서 감지탭 재생 버튼 클릭 및 플레이어 세션 생성 확인

### INC-2026-08-17-006 — MissAV DOCP-259 브라우저 재생 실패

- 상태: `CODE-FIXED / LIVE-UNVERIFIED`
- 재현: Chrome에서 `https://missav123.com/dm31/ko/docp-259`를 열고 감지된 후보의 브라우저 재생 실행
- 영향: Aura Media Player가 열리지만 영상이 시작되지 않고 `readyState=0`, 재생시간 0에서 멈춤
- 사용자 제공 기준선: 같은 시점에 사이트 자체 스트리밍 재생은 성공했고 Aura의 영상 감지와 다운로드도 성공했으며, Aura 브라우저 재생기만 실패함. 따라서 공급자 전체 장애보다 player 전용 request context 또는 HLS 처리 차이가 우선 조사 대상임
- 기존 관측: 0.3.71~0.3.75의 일부 live run에서 manifest HTTP 200 이후 첫 fragment 403 또는 HTTP 200 뒤 `aborted`, `readyState=0`을 관측함. 실제 0.3.54 패키지도 같은 시점의 URL에서 Aura player 재생에 실패했으므로 최신 소스 한 커밋에 한정된 회귀는 아님
- 0.3.76 조치: 다운로드와 재생이 동일한 source tab/frame·기록된 Referer·허용된 요청 헤더 선택기를 공유하도록 `media-request-context.js`를 추가함. 재생/다운로드 요청의 host, path hash, header name, HTTP status, redirect, cache, duration만 기록하고 URL query와 header value는 기록하지 않음
- HLS 조치: `MEDIA_ATTACHED`, `MANIFEST_PARSED`, `FRAG_LOADING/LOADED/PARSED/BUFFERED`를 진단하고, nonfatal 내부 `aborted`는 hls.js 자체 처리에 맡겨 Aura의 1회 alternate recovery를 소비하지 않게 함. 실제 fragment load error/timeout과 fatal error만 Aura recovery 대상으로 분리함
- 회귀 테스트: request-context 우선순위·비밀값 비노출·redirect 연속성·동일 URL 병렬 요청, HLS recovery decision, 기존 contextual loader와 player security 테스트 포함 전체 `npm test` 398개 중 394 pass·0 fail·PowerShell 패키지 2건 및 선택적 브라우저 레이아웃 2건 skip
- 서버 live 결과: 0.3.76 Xvfb Chromium에서 MissAV 페이지가 HTTP 403/Cloudflare challenge로 차단되어 해당 환경에서는 제품 경로를 실행하지 못했으며 `BLOCKED`로 기록함
- staging 버전: `0.3.76`
- 남은 검증: 사용자 Windows Chrome과 Whale에서 DOCP-259 및 SIMD를 재검증해야 함. 사이트 자체 재생, Aura 다운로드, Aura player를 같은 시점에 실행하고 redacted request diagnostics와 HLS event 단계를 비교한 뒤에만 `RESOLVED`로 전환함

### INC-2026-08-17-007 — 라이브 후보 오탐과 JSON player source 누락

- 상태: `CODE-FIXED / LIVE-UNVERIFIED`
- 영향: Playmogo의 Cloudflare RUM·CSS·font 및 `/d/` player page가 progressive media 후보로 승격됐고, OnlyJerk의 현재 player API가 JSON `streaming_url`로 돌려주는 실제 HLS는 후보에 나타나지 않았음
- 확인된 원인: media-element/content-type 신호가 정적 자산과 player page에 과도하게 관대했고, MAIN-world observer는 manifest text만 검사해 구조화된 player API 응답의 URL 필드를 놓침
- 0.3.76 조치: 알려진 Cloudflare telemetry, 정적 확장자, 일반 `/d/`·`/e/` player page를 media 후보에서 제외함. JSON API 응답에서는 bounded key matcher로 stream/playback/manifest URL만 추출하며 `eval`, page JSON parser 교체, 임의 객체 순회를 사용하지 않음
- 회귀 테스트: 정적 자산·player page 거부, JSON `streaming_url` 검출, 기존 observer 보안 제약과 전체 회귀 통과
- live 결과: Playmogo의 기존 false-positive 후보는 사라졌고 현재 페이지는 visible challenge 때문에 `BLOCKED`됨. OnlyJerk에서는 실제 HLS 후보와 manifest HTTP 200을 확인했지만 ARM64 test Chromium이 codec을 지원하지 않아 playback은 `BLOCKED`됨
- staging 버전: `0.3.76`
- 0.3.77 조치: `.vtt`, `.srt`, `.ass` 등 자막 text-track 확장자와 `text/vtt`·TTML 계열 MIME을 known non-media로 분류함. URL 확장자가 없더라도 MIME으로 차단해 media-element fallback이 자막을 `PROGRESSIVE` 후보로 승격하지 않도록 함
- 회귀 테스트: 자막 text-track URL과 extensionless `text/vtt` 모두 `isKnownNonMediaResourceUrl`, `mediaTypeForResource`, `makeCandidate` 단계에서 거부; focused 22 pass, 전체 399 pass, site fixture 16 pass
- 0.3.77 live recheck: av19 Level5 iframe의 native video는 `readyState=4`, `currentTime=14.3s`, `1080x460`, HTTP 206으로 재생됐고 `thumbs.vtt` false-positive는 사라졌지만, 확장 후보가 0개가 되어 Level5 HLS primary 선택까지는 확인하지 못함
- staging 버전: `0.3.77`
- 남은 검증: 현재 공급자 frame에서 Level5 HLS source가 후보로 다시 노출되는 경로를 Windows Chrome/Whale에서 확인하고, `thumbs.vtt` 제거와 Level5 HLS primary 선택을 함께 통과한 뒤에만 `RESOLVED`로 전환함

#### 결론 및 변동 사이트 대응 원칙

- 결론: 2026-08-16에는 같은 av19 계열 페이지에서 native playback과 Level5 HLS 후보 2개가 관측됐지만, 2026-08-17에는 native playback은 계속 성공하는 동안 Level5 HLS source가 확장에 노출되지 않아 후보가 0개가 됐다. 이는 현재 증거만으로 확장 회귀라고 단정할 수 없고, 공급자 player/source 노출 방식의 변동 가능성이 우선이다.
- `.vtt` false-positive 차단은 유지하되, 이 하루의 관측만으로 provider-specific URL rule이나 더 공격적인 후보 승격을 추가하지 않는다.
- 실사이트 판정은 `native-page playback`, `detect`, `progressive-probe`, `extension-download`, `subtitle`, `overlay`를 독립 surface로 기록한다. native playback 성공 + detect 0은 provider drift 후보로 분류하고, main/control과 후보 빌드의 동일 시점 A/B가 없으면 제품 회귀로 확정하지 않는다.
- 대응 전략: bounded generic adapter(플레이어 source, manifest MIME, JSON의 제한된 stream 키)와 text-track/정적 자산 차단을 유지하고, URL·host·DOM selector를 고정하는 사이트별 예외는 추가하지 않는다.
- 운영 전략: known-good main artifact와 후보 artifact를 같은 브라우저·같은 URL·같은 AdBlock/VPN 모드로 비교하고, 이틀 연속 또는 main 대비 후보만 실패할 때만 코드 수정 incident를 연다. Cloudflare, 연결 리셋, codec, source 비노출은 별도 환경/provider 상태로 분류한다.

## 회귀 방지 체크리스트

모든 버그 수정은 다음 순서로 진행한다.

1. 이 문서에서 기존 인시던트와 동일한 증상·경로인지 먼저 검색한다. 동일 원인이면 새 항목을 만들지 말고 기존 항목의 타임라인을 갱신한다.
2. 증상, 재현 경로, 브라우저, 확장 버전, 외부 의존성을 분리해 기록한다. 추측을 원인으로 기록하지 않는다.
3. 수정 전후의 모든 관련 경로를 확인한다: 감지탭, 링크 입력탭, YouTube, 자막, Chrome, Whale, Aura AdBlock on/off.
4. 수정에는 회귀 테스트를 추가하거나 기존 테스트를 보강한다. 테스트가 없는 사용자 경로는 `LIVE-UNVERIFIED`로 남긴다.
5. 실제 브라우저에서 새 작업을 실행해 확인한다. 기존 `chrome.storage.session`의 실패·멈춤 작업을 새 코드의 결과로 착각하지 않도록 기존 작업을 정리한 뒤 확인한다.
6. 소스 변경 handoff 전 `manifest.json` patch 버전을 올리고 `artifacts/chrome-web-store/staging-pro`에 직접 반영한다. 사용자가 요청하지 않는 한 ZIP을 만들지 않는다.
7. 수정 후 이 문서의 반영 버전, 테스트 결과, 실브라우저 결과, 남은 위험을 즉시 갱신한다.

## 변경 타임라인

| 버전 | 주요 변경 | 인시던트 |
| --- | --- | --- |
| 0.3.64 | 오래된 탭 content script 재주입 및 overlay host 분리 | 001 |
| 0.3.66 | 저장 핸들 재사용 및 재시도 시 강제 폴더 선택 제거 | 002 |
| 0.3.68 | 권한 사전검사 제거로 저장 준비 무한 대기 발생 | 003 |
| 0.3.69 | 워커 권한 사전검사 복구 및 팝업 권한 갱신 추가 | 002, 003 |
| 0.3.70 | 저장된 핸들이 있으면 폴더 선택창 반복 방지 | 002, 003 |
| 0.3.71 | MissAV DOCP-259 live 재생 재현 및 외부 HLS 403 확인 | 006 |
| 0.3.76 | 공통 media request context, HLS recovery 분리, JSON player source 감지, audio-first 자막 ingest | 004, 006, 007 |
| 0.3.91 | Pro 창 포커스 이탈 일시정지 우회 제거, Dood 현재 재생 iframe 재바인딩, Companion 설치 안내 URL 게이트 | 011, 012 |
| 0.3.92 | 공식 Cloudflare Companion 설치 안내 URL 기본 연결 | 011, 012 |
| 0.3.93 | Dood `/pass_md5/` 단서 격리·응답 URL 검증 및 ShadowRoot 오버레이 분리 | 012 |
| 0.3.94 | Companion 설치 후 store/development origin 자동 감지 및 재연결 | 013 |

### INC-2026-08-17-006 follow-up — 0.3.54 package recheck

- The 0.3.54 package and the 0.3.75 old-playback-compatibility A/B both failed in Aura Player against the same DOCP-259 URL at the time of the test.
- Both observed manifest HTTP 200 and first-fragment HTTP 403 with `readyState=0`. This rules out a regression isolated to the latest source, but it does not prove a provider-wide outage.
- The user later confirmed that the native site player and Aura download path succeeded while Aura Player failed. Treat the player-specific request or media pipeline as the primary remaining scope.
- Evidence: `artifacts/live-media-0.3.75-docp-259-old-compat.json`; `C:\Users\coseung2\AppData\Local\Temp\aura-mdownloader-054\artifacts\live-media-0.3.54-docp-259-package.json`.
- Status remains `CODE-FIXED / LIVE-UNVERIFIED`; do not mark resolved until the same Windows Chrome/Whale user path passes with 0.3.76 or later.
- QA 진단 조치: 0MB 후보의 redacted `host/path`, media type, frame, player/session/source metadata를 download job에 보존하고 source-page overlay host와 document root의 `data-aura-qa-candidates`에 노출한다. 토큰 query 값은 기록하지 않는다. staging `0.3.79`; live retest `LIVE-UNVERIFIED`.
- INC-2026-08-17-007 follow-up: live trace on `https://av19t.com/korea/97526` confirmed `https://cdn.plyr.io/static/blank.mp4` as the `main=true` `PROGRESSIVE` candidate (`frameId=164`, `source=web-response`, `score=67`) and the source of the 0MB completion. Added generic placeholder-media rejection in `candidate.js` plus a focused regression test. Staging `0.3.80`; status `CODE-FIXED / LIVE-UNVERIFIED` until the user Chrome path is retested.
- INC-2026-08-17-007 follow-up: staging `0.3.81` adds a tab-scoped QA candidate query from the content script, stored as `document.documentElement.dataset.auraQaDetectedCandidates`, so zero-candidate detection can be distinguished from expired overlay diagnostics. Live result `LIVE-UNVERIFIED`.
- INC-2026-08-17-007 follow-up: staging `0.3.82` triggers the tab-scoped candidate diagnostic once at page load, not only when a download overlay exists. Live result `LIVE-UNVERIFIED`.
- INC-2026-08-17-007 live result: staging `0.3.82` correctly removes `cdn.plyr.io/static/blank.mp4`, but the user Chrome page then reports zero downloadable candidates while the cross-origin AV19 player visibly plays. Status remains `CODE-FIXED / LIVE-UNVERIFIED`; next scope is player-frame source exposure, not candidate ranking.
- INC-2026-08-17-007 follow-up: staging `0.3.83` exposes a bounded token-redacted `webRequest` trace at `document.documentElement.dataset.auraQaRequestTrace` to locate player-frame media requests that never become candidates. Live result `LIVE-UNVERIFIED`.
- INC-2026-08-17-007 follow-up: staging `0.3.84` adds bounded inline Level5 source extraction for player initialization URLs. On the live AV19 iframe, the extracted `v.html` URL returns `application/vnd.apple.mpegurl` HLS when requested with the player-frame referrer; focused Level5 bridge tests pass. Live extension detect/download retest remains pending.
- INC-2026-08-17-007 live evidence: after the 0.3.84 reload, the AV19 player frame emitted the real `v.html` HLS request with HTTP 200 and `application/vnd.apple.mpegurl`, followed by `v/session` and encrypted media-chunk requests. The persistent QA candidate attribute was still the page-load snapshot taken before those requests, so it is inconclusive rather than a confirmed zero-candidate result. Extension-download remains unverified.
- INC-2026-08-17-007 follow-up: staging `0.3.85` fixes the confirmed candidate rejection: `isKnownNonMediaResourceUrl()` treated the provider's `.html` HLS endpoint as static HTML before honoring its explicit HLS MIME. Explicit HLS/DASH MIME now overrides only that static-extension check; blank media and text tracks remain rejected. Candidate regression 25/25, full test suite pass, staging build pass. Live Chrome reload/download verification remains pending.
- Download-mode follow-up: staging `0.3.86` adds evidence-based `downloadMode` classification to candidates and the download diagnostic, plus a machine-readable site mode registry. Full test suite and 60-file Pro staging build pass; no live behavior change is claimed from the taxonomy alone.
- INC-2026-08-17-007 live closure evidence: user confirmed that the staged Chrome extension download path now works on both MissAV and AV19. Keep subtitle, progressive-probe, and Aura playback as separate unverified surfaces until tested directly.

### INC-2026-08-17-008 Dood authenticated source-frame download failure

- Status: `RESOLVED (Chrome 0.3.88 확인) — Whale 별도 검증 필요`
- Reproduction: user's headed Chrome session with extension `0.3.86` Pro; Dood candidate is detected and Aura browser playback succeeds. DevTools shows a tokenized CDN media URL, but opening that URL in a new tab is blocked. The extension-download surface still fails.
- Confirmed behavior: the Dood CDN authorizes the media request from the player frame context. A top-level navigation is not an equivalent test and is expected to be hotlink-blocked.
- Confirmed code gap: the download `media-stream` path carried the source tab but dropped the candidate `frameId` before requesting a fresh Dood URL, allowing the refresh to target the wrong frame and losing the exact player-frame context.
- Code action in `0.3.87`: carry `videoFrameId` through the progressive session and target `get-dood-direct` at that frame; Dood-compatible progressive candidates now prefer the source-frame browser-download handoff instead of an extension-origin probe.
- Regression test: `hls-download.test.mjs` covers frame propagation and source-frame preference; focused suite passes.
- Live result after code action (2026-08-23): user's real Chrome with `0.3.88` staging extension on `https://playmogo.com/d/37fhiw3581dr` — detect `PASS` (8 candidates including Dood `AUTHENTICATED_SOURCE_FRAME`), Aura browser playback `PASS`, extension-download `PASS`. The automated bridge recorded the candidate/request trace before the successful retry; the successful download itself was user-verified. Resolves for Chrome; Whale remains unverified.

### INC-2026-08-17-009 download overlay was tab-local and close was not global

- Status: `CODE-FIXED / LIVE-UNVERIFIED`
- Reproduction: extension `0.3.87` in the user's headed Chrome session; a download or subtitle-generation overlay appeared per tab, and closing it in one tab did not prevent it from returning after switching tabs.
- Confirmed root cause: each content script owned its own `shownDownloadJobIds` set and timer. The close button only removed that tab's host; tab activation could repopulate another tab from active/recent jobs.
- Code action in `0.3.88`: background now owns a session-persisted overlay job list, sends the same accumulated list to every eligible web tab, preserves terminal records until global close, and broadcasts `hide-download-overlay` after dismissal.
- Regression test: content overlay activation and global-hide message coverage pass; full `npm test` and Pro staging build pass.
- Live result after code action: `LIVE-UNVERIFIED`; reload the `0.3.88` staging extension and verify tab switching, accumulated records, and global close in the user's Chrome session.

### INC-2026-08-17-010 DASH ContentProtection was not rejected

- Status: `CODE-FIXED / LIVE-UNVERIFIED`
- Reproduction: GitHub issue #2 describes a static DASH MPD containing `ContentProtection` (for example CENC/Widevine/PlayReady). The previous parser accepted the manifest and `dashMediaForRepresentation()` produced tracks with `keys: []`, allowing encrypted segments to enter the normal save path.
- Confirmed root cause: `dash.js` parsed XML and segment layouts but had no DRM/`ContentProtection` guard. Unlike HLS SAMPLE-AES handling, the DASH path therefore did not fail closed before download preparation.
- Code action in `0.3.89`: `parseDashManifest()` rejects any MPD containing `ContentProtection` with stable `DRM_PROTECTED` error code; `prepareDownloadCandidate()` maps that code to a clear user-facing DRM unsupported message. No DRM key extraction or decryption is attempted.
- Regression test: `dash.test.mjs` includes a CENC `ContentProtection` fixture. The modular site/provider/downloader suite passes 23/23; full `npm test` passes 421 total / 417 pass / 0 fail / 4 environment-dependent skips.
- Architecture follow-up in `0.3.89`: progressive, HLS, and DASH preparation/save dispatch moved behind `downloaders/`; reusable player/auth behavior moved behind `providers/`; each site now owns a thin `sites/<id>/profile.js` and colocated `regressions.js`. Candidates retain the top-level `siteUrl` separately from iframe referrers and expose `siteId`, `providerId`, and `downloaderId` in redacted diagnostics. Pro staging build passes with 83 files.
- Live result after code action: `LIVE-UNVERIFIED`; no real DRM-protected DASH site or post-refactor site matrix was exercised in Chrome/Whale, so only deterministic parser, dispatch, packaging, and download preparation behavior is confirmed.

### INC-2026-08-23-011 Pro download paused when Chrome lost window focus

- Status: `CODE-FIXED / LIVE-UNVERIFIED`
- Reproduction: user's headed Chrome session, extension `0.3.88` Pro, `https://playmogo.com/d/0p6sbp4xtvw1`; while an extension download was active, switching away from the Chrome window showed `일시정지 — 원래 페이지로 돌아가주세요.`
- Browser and surface: Chrome (not Whale), extension-download pause state. AdBlock/VPN mode was not reported.
- Confirmed root cause: `chrome.windows.onFocusChanged` handled `WINDOW_ID_NONE` by sending `paused: true` directly to every source job. That branch bypassed `resolvePlan()` and therefore ignored Pro's `backgroundDownloads: true`; normal tab activation already used the correct plan-aware path.
- Changed files: `background.js` routes window-focus loss through `applyTabPauseState(null)`; `popup.js`, popup HTML/CSS, `edition.js`, i18n, and build scripts add a gated Companion install-guide link; package tests were updated for the restored Companion runtime.
- Regression: `popup.test.mjs` asserts that the focus-loss handler calls the plan-aware path and cannot directly force `paused: true`. Companion UI tests assert HTTPS configuration, missing-host gating, both popup variants, localization, and keyboard focus sizing. Store/dev staging tests cover the generated install URL and Companion runtime allowlist.
- Staging version: code fix `0.3.91`; current handoff `0.3.92` with the verified Companion guide URL.
- Real-browser result: `LIVE-UNVERIFIED`; reload `0.3.92` in the user's Chrome profile, start the same PlayMogo download, switch to another application, and confirm the Pro job keeps running. Whale remains separately unverified.

### INC-2026-08-23-012 PlayMogo Dood playback succeeds while download intermittently fails

- Status: `CODE-FIXED / LIVE-UNVERIFIED`
- Reproduction: user's headed Chrome session, extension `0.3.88` Pro, `https://playmogo.com/d/0p6sbp4xtvw1`; browser playback succeeds, while extension download intermittently pauses or fails.
- Browser and surfaces: Chrome (not Whale); browser playback `PASS` by user report, extension-download `FAIL/INTERMITTENT`. AdBlock/VPN mode was not reported.
- Live evidence: the Chrome bridge found the exact PlayMogo tab, but while claiming it the controllable tab changed to a `ty.tyrotation.com` advertising redirect and the original tab ID was no longer claimable. This confirms live frame/tab churn during diagnosis, but does not by itself identify the failed network request.
- Confirmed code defects: Dood direct URLs were cached only by tab for up to ten minutes, allowing an expired or unrelated iframe URL to be reused. When the original candidate frame was replaced, a fresh URL discovered from another currently playing frame did not propagate that new `frameId` to the source-frame download click.
- Code action in `0.3.91`: cache Dood URLs by `tabId:frameId` for at most 60 seconds; try the candidate frame first, then current frame-state entries ordered by playing/visible evidence; propagate the refreshed frame ID through the media session and target the download click at that exact frame. No generic downloader transport was changed.
- Site fixture: `sites/playmogo/regressions.js` includes `playmogo-0p6sbp4xtvw1-dood-frame-replacement` as a live-only target.
- Regression: the background harness proves that a stale frame 3 candidate is rebound to currently playing frame 8 and that frame 8 reaches the downstream source-frame session; the progressive session test proves that the refreshed frame ID replaces the stale candidate frame. Focused background/downloader/site suite: 53 pass. Full suite: 428 pass, 0 fail.
- Staging version: code fix `0.3.91`; current handoff `0.3.92` with the verified Companion guide URL.
- Real-browser result after code action: `LIVE-UNVERIFIED`; reload staging `0.3.92`, play the exact URL, start a new download, and verify both continued progress while Chrome is unfocused and a non-empty completed file. Whale remains separately unverified.
- `0.3.92` live retest (2026-08-24): the user's Chrome 151 profile loaded the unpacked `artifacts/chrome-web-store/staging-pro` extension. The background held 14 PlayMogo/Dood progressive candidates and ranked a tokenized `cloudatacdn` `video.js` candidate as primary, so the failure is not an empty candidate list. Four extension-download jobs failed with the video-preparation-no-response status.
- Confirmed additional root cause in `0.3.92`: `resolveDoodDirectOnce()` scans `document.documentElement.outerHTML` with an unbounded-enough `/pass_md5/` match. The same content script writes redacted candidate JSON containing an earlier `/pass_md5/` URL into a `data-aura-*` attribute on that element. A forced Dood refresh can therefore select its own HTML-escaped diagnostic copy before the real player config and request a malformed `/pass_md5/...` path. The live request trace showed repeated malformed paths followed by failed preparation; `text/html` MIME alone is not a failure because the prior successful Dood baseline used the same MIME with an exact URL body.
- Live frame evidence: the top-level `/d/` document had no media element and hosted the player in `/e/0p6sbp4xtvw1`. The user reported visible playback at the start, but the target `cloudatacdn` media request later ended with `net::ERR_FAILED`; the `/e/` frame then contained a Google connection-refused page with zero video elements while stale candidates from prior frames remained. This explains the apparent disagreement between visible/recent playback and current playing-frame state.
- Separate overlay defect observed in the same build: `downloadOverlayHost()` returns a `ShadowRoot`, but `refreshDownloadOverlay()` uses `host.dataset`, producing a `TypeError` every second when diagnostic jobs are visible. This interrupts overlay rendering after candidate diagnostics are published; it is not the cause of the background candidate count, but it can leave the page overlay stale or absent.
- Required regression before the next handoff: exclude Aura-owned diagnostic attributes from Dood source discovery, bound and validate the exact `/pass_md5/` path, prove a self-injected prior URL cannot win over the real player config, cover resume/frame replacement, and verify the ShadowRoot overlay host separately. No source change or version increment was made during this diagnosis.
- Code action in `0.3.93`: Dood discovery now reads only bounded player `script` text/src and explicit `/pass_md5/` links, requires a same-origin bounded path, and never scans the Aura-owned root diagnostics. Pass responses must resolve to one exact whitespace/markup-free URL or an approved JSON URL field while preserving the historical exact-URL `text/html` response contract. The overlay now keeps diagnostics on the host element and renders into its ShadowRoot separately.
- Changed files: `content.js`, `content.test.mjs`, `manifest.json`, generated `artifacts/chrome-web-store/staging-pro` files, and this incident record. No common downloader or transport module changed.
- Regression after code action: `content.test.mjs` 23/23 pass, including self-injected stale `/pass_md5/`, historical `text/html` exact URL, markup-contaminated response rejection, and real ShadowRoot rendering. Focused content/security/background/Dood/downloader/site/popup suite: 105/105 pass. Full `npm test`: 432/432 pass, 0 fail, 0 skip.
- Staging result: `npm run build:dev-staging` returned `DEV_STAGING_OK` for Pro `0.3.93` with 85 files. Source and staging `content.js` are byte-identical; both source and staging manifests report `0.3.93`. No ZIP was created.
- Remaining live verification: reload `0.3.93` in the user's Chrome, use the same resume path, confirm a fresh current-frame Dood candidate, complete a non-empty extension download, and verify the overlay no longer logs the `ShadowRoot.dataset` exception. Detect, native playback, extension-download, and overlay must be recorded separately; Whale remains unverified.

### INC-2026-08-24-013 Companion installation is not adopted by the development extension

- Status: `CODE-FIXED / LIVE-UNVERIFIED`
- Reproduction: user's Chrome 151 profile with unpacked Pro staging extension `fnnilboncpjgaachejfhednccmfflmkl`, source version `0.3.93`. After using the popup's Companion install link, the popup continued to offer browser-folder saving instead of selecting Companion.
- Browser and surface: Chrome, Companion detection and extension-download destination selection. PlayMogo/Dood transport itself is not the failing surface.
- Confirmed live install state: both Chrome and Edge Native Messaging registry keys pointed to `C:\Users\coseung2\Downloads\새 폴더\Companion\com.aura.media_companion.json`. That manifest allowed only the published Chrome origin `chrome-extension://kniniopdkceodiddkijnddnggdgmjmmo/`, so Chrome could not connect from the currently loaded development origin. A valid host and tools also existed under `%LOCALAPPDATA%\Aura Media\Companion`. The first local `0.3.94` installer retest additionally proved that Inno Setup reused this historical noncanonical folder and wrote its non-ASCII path with non-UTF-8 bytes, leaving an invalid Native Messaging manifest path.
- Confirmed root cause: Native Messaging requires an exact extension origin in `allowed_origins`, while the installer build accepted only caller-supplied Chrome/Edge IDs and had no repository-controlled development-origin contract. Inno Setup's default previous-directory reuse and ANSI manifest write preserved the stale Korean-path installation. The popup already checked `companionStatus()` before every download, but a denied or invalid native connection could never become available.
- Code action in `0.3.94`: add one deduplicated store/development origin contract shared by packaged and manual installers; pass the full list to Inno Setup; force the canonical `%LOCALAPPDATA%\Aura Media\Companion` directory; write the Native Messaging manifest as UTF-8; support the installed Inno Setup 7 compiler; recheck Companion availability when the popup regains focus or visibility; preserve the existing download-click rule that selects Companion before browser-folder saving. No Dood provider, source-frame authorization, or common downloader transport was changed.
- Changed files: `installer/companion-extension-origins.json`, `installer/AuraMediaCompanion.iss`, `scripts/build-companion-installer.ps1`, `install-media-companion.ps1`, `popup.js`, `companion-architecture.test.mjs`, `popup.test.mjs`, `manifest.json`, generated development staging files, and this incident record.
- Regression after code action: focused Companion/popup suite 24/24 pass. Inno Setup 7.1 compiled `Aura-Media-Companion-0.3.94-win-x64.exe`; its SHA-256 is `BC25B866993714AA76CF988A49F9337847C3B08FC569C32BA60DE572F8AF7727`, and it remains unsigned pending the owner signing input. Full `npm test`: 433/433 pass, 0 fail, 0 skip.
- Current-install verification: silent reinstall exited 0 and reset both Chrome and Edge registry keys to `%LOCALAPPDATA%\Aura Media\Companion\com.aura.media_companion.json`. Strict UTF-8 parsing passed without a BOM; the canonical executable exists; and the manifest contains the published ID plus current and historical development IDs exactly once. Direct framed Native Messaging smoke returned `hello.ok=true`, protocol 2, `status.ok=true`, and `toolsReady=true`.
- Staging result: `npm run build:dev-staging` returned `DEV_STAGING_OK` for Pro `0.3.94` with 85 files. No development ZIP was created.
- Real-browser result: `LIVE-UNVERIFIED`; the real Chrome bridge was resolved to profile `사용자 이름 1`, and its open Aura Player tabs confirm the loaded extension ID `fnnilboncpjgaachejfhednccmfflmkl`. Browser policy blocks claiming `chrome://extensions/` and `chrome-extension://` surfaces, so reload `0.3.94`, open the popup, confirm the Companion install link hides, and prove one download selects Companion without opening a save-folder picker. Whale remains separately unverified.
- Publication gap: the HTTPS download endpoint still reports the previous 92,469,043-byte installer. The corrected local installer is 92,501,131 bytes and has not been uploaded or deployed in this code-fix pass.

### INC-2026-08-24-014 Shackledshow MxContent Companion download stalls at 1%

- Status: `CODE-FIXED / LIVE-UNVERIFIED`
- Reproduction: user's Chrome on `https://shackledshow.cc/videos/1692b65a-48d5-4a6e-a477-9ed151f65568`, extension staging `0.3.94`; start the embedded video and download it through Companion. The transfer repeatedly remains at 1% until it is cancelled.
- Browser and affected surface: user's Chrome 151 profile `사용자 이름 1`; extension-download through Companion. AdBlock/VPN mode was not reported. Native-page playback was reported working.
- Live evidence: the Shackledshow page embeds `https://miixdrop.top/e/q1dz00v7aemvpl`; the extension's recorded job contains the tokenized `https://a-delivery31.mxcontent.net/v2/q1dz00v7aemvpl.mp4` progressive candidate from the `video.js` iframe (`frameId 1705` in the recorded job). The Companion job was later cancelled. A separate context-menu retry that lost the iframe context failed with HTTP 403, so it is not the same path as the 1% stall.
- Confirmed root cause: `saveProgressive()` used six-way bounded Range reception only for File System Access folder sinks. When no folder sink existed and Companion supplied the native sequential writer, it always called one unbounded `streamFetchToWritable()` request even after preparation had confirmed `206` Range support and the total size. MxContent playback and resilient saving both use bounded byte ranges; the native-only transport divergence explains why detection and playback succeeded while the Companion transfer stalled near the beginning.
- Code action in `0.3.95`: route a Range-capable Companion progressive save through the existing ordered parallel downloader; pass the already authenticated/prepared total so no redundant unauthenticated size probe is made; use the authenticated fetch implementation for a fallback probe when the total is unknown; retain a fresh native single-stream fallback if bounded reception cannot start. Add a Shackledshow site profile and exact MxDrop/MxContent fixture without placing transport logic in the site module.
- Changed files: `hls-download.js`, `parallel-download.js`, their focused tests, `sites/shackledshow/profile.js`, `sites/shackledshow/regressions.js`, site registries/tests, runtime package file lists/tests, `manifest.json`, generated development staging files, this incident record, and `SITE_QA_LOG.md`.
- Regression: the new Companion test failed before the fix because the native path sent an unbounded request; it now proves one exact bounded Range request and native close. The parallel downloader test proves a prepared total avoids the global probe and all ranges use the authenticated fetch implementation. Shackledshow profile/fixture, downloader registry, and store-package focused suites pass. Full `npm test`: 438/438 pass, 0 fail, 0 skip.
- Staging version: `0.3.95`; `npm run build:dev-staging` returned `DEV_STAGING_OK` for Pro with 86 files. Source and staging copies of `hls-download.js`, `parallel-download.js`, the site registry, and the Shackledshow profile are byte-identical; manifests are semantically identical at `0.3.95`. No development ZIP was created.
- Real-browser result: `LIVE-UNVERIFIED`; reload `0.3.95` in the same Chrome profile, replay the exact URL to obtain a fresh tokenized iframe candidate, and complete a non-empty Companion download. Detect, playback, progressive-probe, extension-download, subtitle, and overlay remain separate surfaces; Whale is not tested.

### INC-2026-08-24-015 Generated subtitle is not saved when the subtitle folder permission is unavailable

- Status: `CODE-FIXED / LIVE-UNVERIFIED`
- Reproduction: ongoing user's headed Chrome session with the unpacked development extension and installed Companion; generate a Korean subtitle successfully, then reach the final SRT save step without an authorized browser subtitle folder. The job reports that the subtitle was generated but the folder could not be saved.
- Browser and affected surface: user's Chrome 151 profile `사용자 이름 1`; subtitle-generation output saving. The exact loaded extension version could not be read from the blocked extension page; source/development staging before this fix was `0.3.95`. AdBlock/VPN mode and exact source site were not established.
- Live evidence: the current Chrome connection was selected by extension instance ID and contained the Aura Player plus AVsee and MissAV source tabs. The source-page diagnostics no longer retained the subtitle job record, so the exact terminal job payload is user-reported; the on-disk failure text and call path exactly match that report.
- Confirmed root cause: `download-worker.js` converted the completed VTT to SRT and immediately required `getStoredSubtitleDirectory()` plus browser File System Access write permission. It never tried the installed native writer. Media saving also still preferred an existing browser folder internally even though the popup had already selected Companion, so Companion preference was not enforced end to end.
- Code action in `0.3.96`: add one generated-subtitle save contract that writes UTF-8 SRT to Companion `Downloads\Aura Media` first and falls back to the authorized subtitle folder; load the seven-day generated-subtitle cache before repeating transcription so a failed save can retry immediately; make progressive, HLS, and DASH outputs attempt Companion before a stored browser folder; show Companion as the active popup destination. Source-frame-authenticated exceptions remain on their required browser-frame path.
- Changed files: `subtitle-save.js` and its tests, `download-worker.js`, subtitle generation tests, `hls-download.js` and focused tests, `native-file-writer.test.mjs`, `background.js`, popup/i18n files and tests, runtime package lists/tests, `manifest.json`, generated development staging files, this incident record, and `SITE_QA_LOG.md`.
- Regression: focused Companion/media/subtitle/popup/package suite passes. Tests prove Companion wins over a configured folder, SRT bytes are written through the native writer, folder fallback remains available, both-destination failure stays explicit, and retries consult the generated cache before the subtitle service. Full `npm test`: 442/442 pass, 0 fail, 0 skip.
- Staging version: `0.3.96`; `npm run build:dev-staging` returned `DEV_STAGING_OK` for Pro with 87 files. Source and staging copies of `subtitle-save.js`, `download-worker.js`, `hls-download.js`, `popup.js`, and `i18n.js` are byte-identical; manifests are semantically identical at `0.3.96`. No development ZIP was created.
- Real-browser result: `LIVE-UNVERIFIED`; reload `0.3.96`, retry the failed subtitle job or press generate again, and confirm the cached SRT appears in `Downloads\Aura Media`. Subtitle generation and subtitle saving must remain separately recorded; Whale is not tested.

### INC-2026-08-24-016 Companion had no pause, resume, retry, playback, or shared download folder

- Status: `CODE-FIXED / LIVE-UNVERIFIED`
- Reproduction: open the Companion manager window with active and failed jobs. Before this change the window could only cancel a job and open the downloads folder. A stopped transfer had to be discarded and restarted from the browser, playback was unavailable, and the app and the extension each resolved their own save destination.
- Browser and affected surface: Windows Companion manager window and the extension's `companion-client.js` command surface. No site or browser path changed.
- Live evidence: the previous window reported `일시정지 미지원`, `재시도 미지원`, and `재생 준비 중` in its own Settings view because the native host exposed only `cancel-job`, `list-jobs`, `open-folder`, `status`, `youtube-info`, and `youtube-download`. The library was derived from completed job records, so a file moved or deleted outside the app still appeared.
- Confirmed root cause: three separate gaps. The host had one stop path (`.cancel`) that is terminal and discards the partial transfer, so a pause that preserves yt-dlp's `.part` file was impossible. Restarting a job had no command even though the submitted `.request.json` was already persisted. `aura_downloads_dir()` always returned `%USERPROFILE%\Downloads\Aura Media`, so no entry point could choose a folder and no entry point could learn another's choice.
- Code action in `0.3.99`: add a `.pause` marker distinct from `.cancel` and stop the download loop on it while keeping the partial file, with `--continue` stated explicitly in the yt-dlp arguments; add `pause-job`, `resume-job`, `retry-job`, `set-download-folder`, and `play-file` to the host dispatch, where resume and retry share one `restart_job` that replays the persisted request after clearing both markers; move the media folder into `settings.json` as `downloadFolder`, validated on both sides as absolute with no traversal or control characters and falling back to the default when malformed; build the manager Library from a non-recursive listing of the download folder instead of job history.
- Changed files: `native-host/src/main.rs`, `companion-client.js`, the new `companion-gui` crate (`Cargo.toml`, `src/main.rs`, `src/app.rs`, `src/jobs.rs`, `src/model.rs`, `src/theme.rs`, `src/widgets.rs`, `README.md`), `installer/AuraMediaCompanion.iss`, `scripts/build-companion-installer.ps1`, `README.md`, `DOCUMENTATION.md`, `.gitignore`, `manifest.json`, generated development staging files, and this incident record.
- Regression: `native-host` 29 tests pass, covering the distinct pause marker, unsafe job-id refusal for both markers, absolute-path validation, a folder write that preserves the license key, and a paused state surviving persistence. `companion-gui` 56 tests pass, covering the action set per status, restart offered only when the request record survives, playback offered only when the file is in the folder, the folder-driven library including a hand-placed file and a job whose file is gone, and the on-disk size winning over a stale byte count. Full `npm test`: 491/491 pass, 0 fail, 0 skip.
- Staging version: `0.3.99`; `npm run build:dev-staging` returned `DEV_STAGING_OK` for Pro with 87 files. The previous `0.3.98` staging build is preserved at `artifacts/chrome-web-store/staging-pro-0.3.98`. No development ZIP was created.
- Real-browser result: `LIVE-UNVERIFIED`. The window was launched against an isolated fixture profile and the action sets, the folder-driven library, and Korean rendering were confirmed by screenshot; no listener is opened. Synthetic mouse input did not reach egui, so the click paths for pause, resume, retry, play, and the folder picker still need a real user click. The extension side of `set-download-folder` was not exercised in a browser.
