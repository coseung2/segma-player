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
| 0.4.27 | 재생 전 설정·JSON 주소·플레이어 페이지·Shadow/srcdoc 주소 찾기 강화 | 038 |
| 0.4.29 | 난독화 탐색 MIME·디코딩·동적 캐시 무효화 회귀 보정 | 038 |

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

### INC-2026-08-24-017 Companion window did not open after a 0.3.99 download

- Status: `RESOLVED`
- Reproduction: user downloaded from `https://01.avsee.is/bbs/board.php?bo_table=javmgs&wr_id=90512` with staging `0.3.99` and reported that the Companion window never appeared even though the Companion was installed locally.
- Browser and affected surface: Windows Companion window launch (`show-ui` and the Start Menu shortcut). No site or transport path is involved.
- Live evidence: the installed folder `%LOCALAPPDATA%\Aura Media\Companion` contained only `aura-media-companion.exe` (0.46 MB, installed 2026-08-24 01:17), the host manifest, and the uninstaller. `aura-media-manager.exe` was absent. A byte scan of the installed host found `--manager` and `AuraMediaCompanionWindow` but none of `list-jobs`, `cancel-job`, `open-folder`, or `subtitle.create`, so the installed binary predates the current dispatch entirely. The built host in `native-host/target/release` was 3.26 MB.
- Confirmed root cause: two compounding facts. The installed Companion was a stale build from before the manager window existed, and INC-2026-08-24-016 moved the window into a separate `aura-media-manager.exe` that no existing install contains. `spawn_manager()` therefore resolved a path that was not present and returned a bare `NotFound`, which `show-ui` reported as a generic error, so the click appeared to do nothing.
- Code action in `0.4.0`: `show-ui` now distinguishes the missing-window case and replies with `manager-not-installed` plus an actionable Korean message instead of a bare I/O error; `manager_executable_in()` was split out so the host-only install case is unit tested. The installer already ships both binaries as of INC-2026-08-24-016, and a fresh `Aura-Media-Companion-0.4.0-win-x64.exe` was produced so the window can actually be installed.
- Changed files: `native-host/src/main.rs`, `manifest.json`, generated development staging files, and this incident record.
- Regression: `native-host` 30 tests pass. The new test asserts that a directory without the manager binary yields `NotFound`/`manager-not-installed` and that adding the binary makes resolution succeed. Full `npm test`: 503/503 pass.
- Staging version: `0.4.0`. Installer rebuilt at `dist/Aura-Media-Companion-0.4.0-win-x64.exe`.
- Real-browser result: `RESOLVED` for the diagnosis; the user must run the new installer, because no code change can add a binary to an already-installed folder. After installing, `--manager` and the Start Menu shortcut open the window.

### INC-2026-08-24-018 AVsee job title used the board code instead of the video title

- Status: `CODE-FIXED / LIVE-UNVERIFIED`
- Reproduction: download from `https://01.avsee.is/bbs/board.php?bo_table=javmgs&wr_id=90512`. The job and filename were named `MFC-361` instead of the actual title `MFC-361 さな - 사나`.
- Browser and affected surface: extension detection and job naming for AVsee board pages. Transport was unaffected.
- Live evidence: the served page has `<title>MFC-361</title>` and `og:title` of `MFC-361`, while the full title is the first `h2` inside `div.view-content` (`<h2>MFC-361 さな - 사나</h2>`). The player is a same-origin iframe at `/player/player.php?720=http://cdn.apiavsee.com/h/2026/08/19/MFC-361.mp4`, and fetching that iframe directly returns `<title>AVseeTV player</title>`.
- Confirmed root cause: two independent naming gaps. `content.js` always reported `document.title`, which on this board is only the post code, and a candidate detected inside the player iframe reported that iframe's own generic title because `message.pageTitle` took precedence over the tab title.
- Code action in `0.4.0`: extend the site-profile contract with read-only `titleSelectors` and `playerFramePaths`; add an `avsee` profile whose selectors were verified against the live markup; have the background push the selectors for the matching site to the reporting frame once per tab so the content script re-reports with the resolved title; prefer the tab title over a player frame's own title. A heading that merely repeats the document title is skipped, and the document title remains the fallback. No transport, token, or file-writing logic was added to the site module.
- Changed files: `sites/profile.js`, `sites/registry.js`, `sites/regressions.js`, new `sites/avsee/profile.js` and `sites/avsee/regressions.js`, `content.js`, `background.js`, new `avsee-title.test.mjs`, runtime package file lists (`scripts/build-dev-staging.mjs`, `scripts/build-store-package.ps1`, `store-package.test.mjs`), `manifest.json`, generated development staging files, this incident record, and `SITE_QA_LOG.md`.
- Regression: 10 new tests in `avsee-title.test.mjs` prove the board title resolves to `MFC-361 さな - 사나`, that the document title is kept when no selector matches, that a repeated heading is not preferred, that selectors are published for the page and not for the CDN host, that the player frame is recognised, and that `content.js` hardcodes no site selectors. A new site regression fixture covers the progressive candidate inside the player frame. Full `npm test`: 503/503 pass, 0 fail.
- Staging version: `0.4.0`; `npm run build:dev-staging` returned `DEV_STAGING_OK` for Pro with 88 files. The `0.3.98` and `0.3.99` staging builds are preserved alongside it.
- Real-browser result: `LIVE-UNVERIFIED`; reload `0.4.0`, replay the exact URL, and confirm the job and saved filename carry `MFC-361 さな - 사나`. Detect, playback, progressive-probe, extension-download, subtitle, and overlay remain separate surfaces; Whale is not tested. Only this one AVsee layout was inspected, so other board tables may use a different heading element.

### INC-2026-08-24-019 Legacy per-job Win32 progress window removed

- Status: `RESOLVED`
- Reproduction: not a user-visible defect. After INC-2026-08-24-016 moved the manager window into `companion-gui`, the host still carried the older per-job Win32 progress window and spawned one process per submitted job.
- Browser and affected surface: Companion host process lifecycle. No browser or site path is involved.
- Live evidence: `native-host/src/main.rs` still contained `mod windows_ui` with its own `RegisterClassW`/`CreateWindowExW` message loop, `spawn_job_runner` still ran `spawn_detached(["--job-ui", job_id])`, and `main` still routed `--job-ui`. Two dead-code warnings (`set_status`, `close_later`) came from that module.
- Confirmed root cause: the legacy window was left in place during the manager-window migration, so every download opened an extra throwaway window process whose state now duplicates the manager's job list.
- Code action in `0.4.1`: delete the `windows_ui` module, the `--job-ui` argument arm, and the per-job UI spawn; drop the now-unused `c_void` import. `--manager` is retained so an existing Start Menu shortcut still opens the window through `aura-media-manager.exe`.
- Changed files: `native-host/src/main.rs`, `companion-architecture.test.mjs`, `manifest.json`, generated development staging files, and this incident record.
- Regression: the architecture test was split. One case still pins job detachment (`--run-job` in its own process), and a new case asserts the host carries no `--job-ui`, no `mod windows_ui`, no `run_job_ui`, and no `CreateWindowExW`, while `--manager` still resolves `aura-media-manager.exe`. `native-host` builds warning-free with 30 tests passing. Full `npm test`: 504/504 pass.
- Staging version: `0.4.1`; installer rebuilt at `dist/Aura-Media-Companion-0.4.1-win-x64.exe` and installed. Installed and built binaries match by SHA-256 for both the host and the manager.
- Real-browser result: `RESOLVED` for removal. The window was launched from the installed path and opened with no network listener. Per-job progress now appears only in the manager window, which is `LIVE-UNVERIFIED` for a real download because no job was run after this install.

### INC-2026-08-25-020 Installed Companion saved media but the manager window did not open

- Status: `CODE-FIXED / LIVE-UNVERIFIED`
- Reproduction: with the locally installed Companion detected, press Download in the extension on a normal detected progressive/HLS/DASH candidate. The extension reports `Aura Companion으로 저장` and writes through the native file writer, but no manager window appears; the extension overlay continues to show the transfer by itself.
- Browser and affected surface: user's Chrome profile `사용자 이름 1`, unpacked development extension, generic media download through Companion. The exact provider download was not restarted during diagnosis.
- Confirmed root cause: Companion adoption and Companion UI launch were separate paths. Normal media used `media-open`/`media-chunk`/`media-close`, while only an explicit `show-ui` command launched `aura-media-manager.exe`. The native writer also generated a second random job ID and persisted no state, so even a manually opened manager could not show that extension transfer.
- Code action in `0.4.2`: pass the extension job ID, title, media type, and prepared total into `media-open`; create and continuously update the same `.state.json` record while native bytes are written; launch the manager on `media-open`; if its window already exists, restore and focus it instead of spawning duplicate windows. The browser still performs authenticated media fetching and sends bytes to the installed Companion, but the transfer is now visible in the native manager as one shared job.
- Changed files: `native-file-writer.js`, `hls-download.js`, `download-worker.js`, `native-host/src/main.rs`, `native-host/Cargo.toml`, focused tests, `manifest.json`, generated development staging files, this incident record, and `SITE_QA_LOG.md`.
- Regression: focused native-writer/downloader/architecture tests prove the extension job ID and metadata reach `media-open`, manager launch is tied to native open, and native state persistence is present. Native host 31/31 and manager 56/56 tests pass; full `npm test` is 505/505 pass, 0 fail, 0 skip.
- Staging version: `0.4.2`.
- Real-browser result: `LIVE-UNVERIFIED`; reload `0.4.2`, start one fresh detected-media download, and verify that the native window opens or focuses automatically and displays the same title/progress. A completed file and browser fallback remain separate checks.
- Follow-up reproduction in `0.4.18`: every extension media download raises or focuses the Companion manager even when the user only wants the background transfer. The extension still passes `showUi: true` in the native writer metadata because `0.4.2` deliberately coupled visibility to `media-open`.
- Follow-up code action in `0.4.19`: extension-originated progressive and HLS/DASH native writer sessions now pass `showUi: false`. The same job state is still persisted and remains visible whenever the user opens the manager, but starting another extension download no longer steals foreground focus or raises the app window.
- `0.4.19` regression: the focused Companion writer/downloader test pins `showUi: false`; real extension-to-installed-host behavior remains `LIVE-UNVERIFIED` until staging is reloaded and one download is started while another app owns focus.

### INC-2026-08-25-021 Jamak Dood download used the slow browser source-frame path

- Status: `CODE-FIXED / LIVE-UNVERIFIED`
- Reproduction: user's Chrome, `https://jamak.cc/bbs/board.php?bo_table=gallery&wr_id=126&sst=wr_hit&sod=desc&sop=and&page=4`; start the DS player and download the detected `FC2-PPV-2594710` media. The transfer is much slower than expected.
- Browser and affected surface: user's Chrome profile `사용자 이름 1`; Jamak embeds `https://playmogo.com/e/6rspotukejm4`; extension-download speed. AdBlock/VPN mode was not reported.
- Live evidence: playback exposed a primary tokenized `cloudatacdn.com` progressive MP4 candidate. A real `Range: bytes=0-0` probe returned HTTP 206, `Content-Range: bytes 0-0/780363155`, and `video/mp4`, proving byte-range support for the 744 MiB source. The Dood provider policy still forced this prepared candidate through `download-in-source-frame`, bypassing the six-way bounded Range downloader and Companion writer.
- Confirmed root cause: Dood's source-frame preference was unconditional whenever the source tab and frame existed. That preference was originally required for hotlink-protected URLs, but it also overrode a successfully prepared direct progressive URL whose Range support had already been established.
- Code action in `0.4.3`: Dood keeps source-frame fallback for blocked, unprobed, or non-Range media, but a successfully prepared Range-capable progressive candidate now stays on the existing six-way bounded Range path and writes through Companion.
- Changed files: `providers/dood.js`, `download-policy.js`, `hls-download.js`, focused policy/downloader tests, `manifest.json`, generated development staging files, this incident record, and `SITE_QA_LOG.md`. No Jamak page parser or shared Range transport algorithm was changed.
- Regression: focused policy/progressive/parallel/native-writer suite passes 34/34, including a Dood Range candidate that must not set `sourceFrameFallbackPreferred`; full-suite and staging results are recorded below after the handoff build.
- Staging version: `0.4.3`.
- Real-browser result: `LIVE-UNVERIFIED`; reload staging `0.4.3`, reopen or replay the same Jamak DS player to obtain a fresh token, start a new download, and confirm sustained progress and a non-empty completed file. Detect, playback, progressive-probe, extension-download, subtitle, and overlay remain separate surfaces.

### INC-2026-08-25-022 Companion queue omitted progress and Library omitted thumbnails

- Status: `CODE-FIXED / LIVE-UNVERIFIED`
- Reproduction: open the installed Companion manager while a browser-streamed download has no known total, then open Library after completed media exists in the shared folder. The queue row has no progress track, and Library renders bordered text rows rather than the Figma `MediaTile` grid.
- Affected surface: native Rust/egui Companion manager `0.4.2`; Download and Library views. No site or media transport is involved.
- Confirmed root cause: `job_row()` rendered the `ProgressBar` only when a determinate percentage existed, despite the design component belonging to every active/paused job. `library_view()` used a temporary bordered row layout and never implemented the exported full-bleed 16:9 `MediaTile`; the README explicitly left thumbnails as a backend gap even though bundled ffmpeg was already available.
- Code action in `0.4.3`: active and paused jobs always render the design-system progress track; unknown totals use an indeterminate moving fill. Library now uses a responsive one-to-three-column, chrome-free `MediaTile` grid. A single background worker extracts a 640x360 local frame with bundled ffmpeg, caches it under the Companion root, decodes JPEG off the UI thread, and uploads textures on the egui thread. `.ts` and `.m2ts` outputs are included in the real-folder Library.
- Changed files: `companion-gui/src/app.rs`, `widgets.rs`, `model.rs`, `jobs.rs`, new `thumbnails.rs`, manager dependency/version files, manager README, this incident record, and installer output.
- Regression: manager unit tests cover cache-key invalidation and transport-stream file extensions in addition to the existing progress and folder-source-of-truth cases. Release build, installer, local install, thumbnail-cache generation, and visible-window checks are recorded below after validation.
- Staging version: `0.4.3`.
- Real-app result: `LIVE-UNVERIFIED` until the rebuilt installed manager is opened against the user's current active and completed jobs and the visible progress/thumbnail layout is inspected.

### INC-2026-08-25-023 Jamak Streamtape playback was not promoted to a download candidate

- Status: `CODE-FIXED / LIVE-UNVERIFIED`
- Reproduction: user's Chrome, `https://www.jamak.cc/bbs/board.php?bo_table=gallery&wr_id=83&page=5`; select the Streamtape server and start native-page playback. The Streamtape iframe and player UI load, but the extension reports no downloadable candidate. Dood on the same board page remains a separate path.
- Browser and affected surface: user's Chrome profile `사용자 이름 1`, Jamak Streamtape detect surface. AdBlock/VPN mode was not reported.
- Live evidence: the active iframe was `https://streamtape.com/e/2PXX3pz824FZg6X`. Current Streamtape markup no longer writes only `norobotlink`; it rotates among `ideoolink`, `botlink`, and `robotlink`, with the direct same-origin `/get_video` URL assembled by a bounded string-plus-substring expression.
- Confirmed root cause: the parser accepted only the legacy `norobotlink` element name, and the background waited for a later media request instead of resolving a known player iframe when its HTML response arrived.
- Code action in `0.4.4`: accept only the known rotating Streamtape element names while retaining the same-origin `/get_video` validation; resolve known `sub_frame` player pages through the bounded player graph immediately; register Jamak and add its exact live fixture. No transport, token, or file-writing logic was added to the site profile.
- Changed files: `player-page-resolver.js`, `background.js`, `sites/jamak/profile.js`, `sites/jamak/regressions.js`, site/package registries, focused tests, `manifest.json`, this incident record, and `SITE_QA_LOG.md`.
- Regression: parser tests cover the current rotated element expression and reject arbitrary element names; Jamak site fixture expects the Streamtape `/get_video` candidate. Focused Streamtape/Jamak suite passes 75/75. Full-suite and staging results are recorded after handoff validation.
- Staging version: `0.4.4`.
- Real-browser result: the current player URL resolved to a validated Streamtape `/get_video` result during diagnosis, but the unpacked `0.4.4` extension has not yet been reloaded and observed end-to-end. Detect and extension-download remain `LIVE-UNVERIFIED`.

### INC-2026-08-25-024 Companion YouTube link download failed with HTTP 403

- Status: `CODE-FIXED / LIVE-UNVERIFIED`
- Reproduction: submit `https://www.youtube.com/watch?v=GKLEMACUWps` at 1080p through the extension's link input. Companion job `1e96253e-708e-499d-935e-93ef6d4420dc` reaches `제목 확인 중…`, then fails with `ERROR: unable to download video data: HTTP Error 403: Forbidden`. The same symptom recurred in installed `0.4.14` with `https://www.youtube.com/watch?v=jQCOF1l1FUk` at Best as job `80be8656-9972-4c33-a03d-0b0f6eb38243`, even with the manager window open.
- Affected surface: extension YouTube link input and native Companion yt-dlp runner. Installed tools at diagnosis were yt-dlp `2026.06.09`, Node `v25.5.0`, and ffmpeg `7.1.1`.
- Earlier failed fix in `0.4.4`: bounded HTTP, fragment, and extractor retries plus one whole-process re-extraction covered an expired media URL, but both attempts still selected the same now-unsafe YouTube client. Immediate retry therefore did not cover the recurrent path.
- Confirmed root cause: bundled yt-dlp `2026.06.09` selected `ANDROID_VR` format `399+251` while reporting no PO Token provider. YouTube's August 2026 enforcement made `android_vr` high-quality Googlevideo URLs require a GVS PO Token and intermittently return 403. Official yt-dlp `2026.08.19` instead selected the tokenless `VISIONOS` client for the same format pair. Its official Windows SHA-256 `66674953fe251b89f4d08c5f0e35e0728679bd67ab3d7d05c0562af101dd3e7a` was verified locally. The first installed-tool retry then exposed a separate completion-reporting defect: yt-dlp wrote the complete file but exited with `ERROR: [Errno 22] Invalid argument` when a Windows filename replacement character such as `⧸` was printed through a legacy-encoded native pipe.
- Code action in `0.4.15`: update the bundled yt-dlp to official stable `2026.08.19`; make the installer build reject yt-dlp releases older than `2026.08.19`; force yt-dlp's native-pipe output to UTF-8; synchronize package versions. Keep the bounded transport and one-process retry as defense against genuinely transient failures.
- Changed files: `scripts/build-companion-installer.ps1`, `companion-architecture.test.mjs`, native host and manager version files, `manifest.json`, this incident record, and installer tool/output state. No extension YouTube routing or shared media downloader changed.
- Regression: the architecture suite passes 5/5 and pins the minimum yt-dlp gate; the native-host suite passes 33/33 and pins UTF-8 pipe output; the manager suite passes 113/113; full `npm test` passes 516/516. A real full download using the exact Companion arguments selected `VISIONOS` format `399+251`, downloaded and merged a 50,238,747-byte MP4 with 1920x1080 AV1 video, Opus audio, and 969.821-second duration.
- Staging version: `0.4.15`.
- Install and real-app result: `npm run build:dev-staging` returned `DEV_STAGING_OK` with 90 Pro files. Inno Setup built `dist/Aura-Media-Companion-0.4.15-win-x64.exe` (130,270,861 bytes, SHA-256 `9662b12a00d2dbf741af17e3d717b3c26c5d80a9eeada2dc3f2c958b286e70bb`). Silent install completed after closing the manager-owned mpv backend; Add/Remove Programs reports `0.4.15`; installed host and manager hashes exactly match their release binaries; installed yt-dlp reports `2026.08.19`. Re-running preserved job `80be8656-9972-4c33-a03d-0b0f6eb38243` through the installed host now records `completed`, progress 100, title, and the non-empty 1080p filename. The manager was reopened. The extension link-input click itself remains `LIVE-UNVERIFIED`, so this incident is not yet marked resolved.

### INC-2026-08-25-025 Companion manager could open duplicate windows

- Status: `CODE-FIXED / LIVE-UNVERIFIED`
- Reproduction: start the installed manager and then invoke it again from the installer shortcut or another caller. Two separate `Aura Media Companion` windows and processes can remain open.
- Affected surface: Windows native manager process lifecycle; no media transport or browser path.
- Confirmed root cause: the host tried to focus an existing window before spawning, but `aura-media-manager.exe` itself had no single-instance guard. Direct launches therefore bypassed the host-side check.
- Code action in `0.4.4`: acquire a named per-user Windows mutex before creating the egui window; a second direct manager process exits immediately. The host's existing restore/focus behavior remains unchanged.
- Regression/validation: source-level architecture and manager tests pass; installed-process verification is required after the rebuilt installer replaces the manager.
- Staging version: `0.4.4`.
- Real-app result: `LIVE-UNVERIFIED` until two direct launches leave exactly one installed manager process and window.

### INC-2026-08-25-026 Recu mediafront archive segment failed with HTTP 422

- Status: `CODE-FIXED / LIVE-UNVERIFIED`
- Reproduction: user's browser on `https://recu.me/ellinrose/video/195409102/play`; start the archive download. The first HLS segment at `f62.mediafront.net` fails with `영상 1 요청 실패 (422)` even though page playback is available.
- Browser and affected surface: browser version/channel and AdBlock/VPN mode were not reported; Recu HLS extension-download. Playback was reported working on the supplied page. Detect, progressive-probe, subtitle, and overlay were not independently tested.
- Live evidence: immediately re-requesting the reported segment later returned 404 with Referer, Origin, and User-Agent variations. This is consistent with mediafront replacing or expiring an archive generation path, not a fixed request-header denial. The previous HLS recovery path refreshed only 401/403 failures, so 422 was treated as terminal.
- Confirmed code defects: HTTP 404/410/422 were absent from both the refresh and retry status sets; the Recu profile used the nonexistent `DOWNLOAD_MODES.HLS` property instead of `HLS_MANIFEST`; and refreshed archive playlists were rejected when mediafront changed only the parent generation directory while preserving media sequence, segment count, order, and segment filenames.
- Code action in `0.4.5`: make 404/410/422 HLS segment failures eligible for one source-page candidate refresh; accept a refreshed playlist only when media sequence and segment count match and at least 80% of ordered segment filenames match; register Recu on the shared HLS downloader with an exact site fixture. No site-local transport or file-writing logic was added.
- Changed files: `hls-download.js`, `hls-download.test.mjs`, `sites/recu/profile.js`, `sites/recu/regressions.js`, site/package registries and tests, `manifest.json`, this incident record, and `SITE_QA_LOG.md`.
- Regression: the focused test reproduces a 422 on the stale mediafront generation, refreshes the source candidate once, accepts the same ordered segments under a new generation directory, and completes both chunks. Full-suite and staging results are recorded after validation.
- Staging version: `0.4.5`.
- Real-browser result: `LIVE-UNVERIFIED`; reload staging `0.4.5`, replay the exact Recu URL to obtain its current manifest, start a new download, and verify that a generation rollover continues to a non-empty completed file. A current 404 for the historical segment cannot serve as a successful post-fix download test.

### INC-2026-08-25-027 Companion Library click did not start native playback

- Status: `CODE-FIXED / LIVE-UNVERIFIED`
- Reproduction: open the native Companion manager, enter Library, and click a saved video tile or its Play menu action. The app changes to the Player view, but the video remains at `00:00` and never starts. The same screen also exposed inconsistent control heights, a subtitle dropdown/`CC`-style label, text actions, and a thumbnail-overlay overflow menu that did not match the checked-in Figma export.
- Affected surface: Windows Rust/egui Companion manager `0.4.5`; Library organization and embedded mpv Player. Browser detection and media transport are not involved.
- Confirmed root cause: the controller cloned one synchronous Windows named-pipe handle, then left a background thread blocked in `read_line()` on that handle. After the first `observe_property` write, the blocked read serialized access to the pipe and prevented the controller from sending the remaining observations and `loadfile`. Folder-aware Library playback also reused the currently browsed folder for queue jobs, so a root download could resolve against the wrong directory.
- Code action in `0.4.6`: poll mpv IPC with `PeekNamedPipe` on the controller thread and parse only complete JSON lines, preserving partial lines for the next tick; keep queue playback rooted while Library playback retains its folder; implement root-level collection folders with safe single-component names and non-overwriting moves; place the Lucide overflow action on the title row; remove the nested menu wrapper; convert play, pause, resume, retry, cancel, folder, refresh, subtitle, speed, range, volume, and fullscreen actions to aligned Lucide controls; make subtitles a direct on/off action with native-language labels; add seek-hover preview and Auto/16–235/0–255 range cycling.
- Changed files: `companion-gui/src/app.rs`, `jobs.rs`, `widgets.rs`, `icons.rs`, `player_backend.rs`, `player_contract.rs`, `player_ui.rs`, `seek_preview.rs`, `main.rs`, `theme.rs`, `Cargo.toml`, `Cargo.lock`, Lucide SVG assets, installer build inputs, `manifest.json`, and this incident record.
- Regression: manager unit suite passes 85/85. A separate headless mpv test launches with `--vo=null`, polls IPC before the second write (the former deadlock point), sends `loadfile`, and receives `file-loaded`. Native host tests pass 33/33 and full `npm test` passes 515/515. The manager release build completes and `git diff --check` is clean.
- Staging version: `0.4.6`; `npm run build:dev-staging` returned `DEV_STAGING_OK` with 90 Pro files. No development ZIP was created. Inno Setup 7.1 built `dist/Aura-Media-Companion-0.4.6-win-x64.exe` (130,538,226 bytes, SHA-256 `148325F7BE69AF3C91D6586EF891EA1F0D6D18BB6F5CB687ED793D19BF1B4260`) with the verified mpv build and its third-party notice.
- Real-app result: `LIVE-UNVERIFIED`; per user instruction, review from this point is headless only. A later user-driven window check must confirm tile click playback, visual alignment, subtitle toggling, seek preview placement, range switching, title-row overflow placement, folder creation/move, and Explorer actions before this incident can be marked resolved.

### INC-2026-08-25-028 Download action buttons had no perceptible press state

- Status: `CODE-FIXED / LIVE-UNVERIFIED`
- Reproduction: open the Companion Download view and click the Play, Folder, Retry, or other icon actions. The command fires, but there is no visible pressed transition; Play also carries a stronger button wrapper than the adjacent folder icon.
- Affected surface: native Rust/egui Companion Download rows and Player controls.
- Confirmed cause: shared icon buttons only delegated to egui's static button paint, while custom language and value pills painted their own static hover state. The Download row assigned Play the secondary treatment, so it did not share the folder action's quiet icon treatment.
- Code action in `0.4.7`: add shared 120ms hover and 100ms press interpolation plus a 140ms post-click pulse; move the icon down and scale it by one point during press; apply the same motion to text buttons, popup rows, subtitle chips, speed/range pills, and icon controls; set Download Play to the same quiet treatment as Folder.
- Changed files: `companion-gui/src/widgets.rs`, `companion-gui/src/player_ui.rs`, `companion-gui/Cargo.toml`, `manifest.json`, this incident record, and the regenerated development staging/installer artifacts.
- Regression: manager unit suite remains 85/85 and `cargo check` passes. The 0.4.7 manager release and installer are rebuilt; visible confirmation is intentionally left to the user's app check.

### INC-2026-08-25-029 Settings folder section was needlessly tall

- Status: `CODE-FIXED / LIVE-UNVERIFIED`
- Reproduction: open Settings. The save-folder card stacks a title, path, explanatory line, change action, and a separate internal job-folder row, making one path occupy roughly six lines of vertical space.
- Affected surface: native Rust/egui Companion Settings view.
- Confirmed cause: the folder setting was composed from nested vertical content and two framed rows even though only the user-selected save path is actionable.
- Code action in `0.4.8`: render one compact row with a folder glyph, truncated monospace path, and trailing folder action icon; remove the internal job-state path and duplicate explanatory copy; hide the empty header summary and duplicate header folder action.
- Changed files: `companion-gui/src/app.rs`, `companion-gui/Cargo.toml`, `manifest.json`, this incident record, and regenerated development staging/installer artifacts.
- Regression: manager unit suite remains 85/85, `cargo check` passes, and the compact row preserves an accessible folder-change icon action. Visible confirmation is left to the refreshed app window.
- Follow-up reproduction in `0.4.18`: Settings still dedicates a large five-row “동작 범위” card to static “사용 가능” badges and descriptions. None of those rows changes a setting, while the player's eight hard-coded keyboard actions cannot be customized.
- Confirmed follow-up cause: the settings screen exposed a capability inventory instead of an editable preference model; player input built a fixed key/action vector inside `player_ui` and persisted no shortcut state.
- Follow-up code action in `0.4.19`: remove the entire static action-range card. Add a width-bounded, two-column shortcut editor split into playback, marking/loop, and rating groups. Its 20 customizable actions cover playback/navigation, volume, subtitles, fullscreen, pose marking, previous/next frame, A/B loop controls, and direct ratings `0` through `5`. Support click-then-key capture, Ctrl/Alt/Shift combinations, immediate persistence in the existing bounded `settings.json`, one-click default restoration, and conflict-safe swapping when an assigned shortcut is already used. Keep Escape reserved for fullscreen exit and capture cancellation. Pass the persisted bindings into the real player input path and persist marking/rating results through `LibraryState`.
- Changed files: new `companion-gui/src/shortcuts.rs`, `app.rs`, `jobs.rs`, `main.rs`, `player_ui.rs`, `widgets.rs`, manager/native package version files, `manifest.json`, this incident record, and regenerated development staging/installer artifacts.
- `0.4.19` regression and live-install results are recorded after handoff validation; the incident remains `CODE-FIXED / LIVE-UNVERIFIED` until the installed Settings editor and customized player action are exercised visibly.
- `0.4.19` handoff: manager tests pass 128/128 and full Node tests pass 518/518. The installed window was opened and the compact two-column editor visibly showed Korean labels for playback and marking/loop groups with editable key pills; evidence is `artifacts/qa/0.4.19-final-settings.png`. Direct shortcut reassignment followed by player execution and the lower rating group still require a user-path check, so the status remains `CODE-FIXED / LIVE-UNVERIFIED`.
- Follow-up reproduction in `0.4.19`: Settings still presents each region as a rounded bordered card with a tinted caption strip, and each shortcut row is separated by another horizontal rule. The requested hierarchy is flat: one divider between major regions and no dividers inside a region.
- Follow-up code action in `0.4.20`: remove setting card fills, outlines, corner radii, and caption bands. Render a single section divider and plain heading for 저장 폴더, 재생 단축키, 마킹·구간, and 별점 단축키; replace all internal shortcut-row separators with spacing while preserving the existing two-column alignment and key hit targets.

### INC-2026-08-26-034 Library rating controls and popup menu consumed excessive width

- Status: `CODE-FIXED / LIVE-UNVERIFIED`
- Reproduction: open Library. Under every thumbnail, five full control-height boxed star buttons create an oversized rating strip. Open the tile overflow menu; its fixed 168-point minimum leaves unnecessary horizontal padding around short Korean labels.
- Affected surface: native Rust/egui Companion Library tile metadata row and overflow popup.
- Confirmed cause: the tile reused the global 32-point icon-button primitive for every star and removed inter-item spacing without reducing hit/icon size. The popup hard-coded `set_min_width(168.0)` while `menu_row` independently enforced another 150-point minimum, so neither width followed measured content.
- Code action in `0.4.19`: render rating stars with a dedicated 26-point hit area, 14-point glyph, two-point spacing, quiet selected tint, and no persistent boxed background. Measure the longest visible popup label and set the menu width to that text plus exact icon/gap/padding space; menu rows consume that calculated width without a second minimum.
- Changed files: `companion-gui/src/app.rs`, `widgets.rs`, this incident record, and regenerated `0.4.19` manager/installer artifacts.
- Regression and visible installed-app results are recorded after the rebuilt handoff; this remains `LIVE-UNVERIFIED` until a real Library tile and popup are inspected.
- `0.4.19` handoff: manager 128/128 and Node 518/518 pass. The final installed manager hash matches the release binary, but the attempted automated Library navigation lost foreground ownership to another active desktop window before capture. Star sizing and content-measured popup width therefore remain `LIVE-UNVERIFIED` rather than being inferred from tests.

### INC-2026-08-26-035 Companion downloads discarded checkpoints and cancel could lose the worker abort

- Status: `CODE-FIXED / LIVE-UNVERIFIED`
- Reproduction: start an extension progressive or HLS/DASH download that writes through Companion, interrupt the connection, then press Retry. The transfer starts from byte/segment zero and allocates a new output instead of reopening the existing `.part`. Separately, pressing Cancel can turn the card terminal before the offscreen worker receives its abort, leaving fetch/native writes alive. The two history-clear actions exist in the popup markup but their 9-pixel quiet styling makes them effectively undiscoverable.
- Browser and affected surface: Chrome/Whale extension download worker, service-worker job persistence, native Companion media writer, and popup download history. The exact browser/channel and provider were not supplied; no site-specific parser or provider authentication code changed.
- Confirmed root cause: browser File System Access downloads used `download-checkpoint.js`, but the Companion-preferred writer bypassed that checkpoint contract. `media-open` always allocated a unique `.part`, and every transport exception called `media-abort`, which deletes it. Service-worker persistence also stripped the private `retryPayload`, while failed jobs forgot their retained download intent. Cancellation patched terminal state before delivering the worker abort, allowing lifecycle cleanup to race the only cancellation message.
- Code action in `0.4.19`: persist bounded private retry payloads in extension-only `storage.session`; retain failed intents; reopen only the exact sanitized Companion partial named by the checkpoint; truncate a partial that is ahead of the last committed checkpoint and resume from its cumulative byte/segment offset; add `media-suspend` to sync and preserve a partial on disconnect while reserving `media-abort` for explicit cancel; preserve progressive/HLS checkpoints on resumable failures and suppress sink fallback that would silently start a second file; deliver worker/native cancellation before terminal cleanup, then clear the media checkpoint. Increase history-tool text to 11 pixels and give each clear button a distinct destructive treatment.
- Changed files: `background.js`, `download-jobs.js`, `native-file-writer.js`, `hls-download.js`, `native-host/src/main.rs`, `popup.css`, focused tests, package version files, `manifest.json`, generated staging/installer artifacts, and this incident record.
- Regression: focused extension tests pass 35/35 for persisted private retry state, progressive Range saving, native resume metadata, cumulative committed bytes, and suspend-without-delete. Native host tests pass 34/34, including reopening the exact `.part`, truncating it to the checkpoint, seeking to the append position, and reporting resumed bytes. Architecture tests pin worker abort before terminal state and failed-intent retention; popup tests pin visible clear controls. Full-suite, staging, install, and real-browser results are recorded after final validation.
- Staging version: `0.4.19`.
- Real-browser result: `LIVE-UNVERIFIED`; reload staging `0.4.19`, interrupt one real Companion-backed progressive or HLS transfer, press Retry, and confirm progress continues from the prior byte/segment checkpoint into the same `.part`. In a separate run press Cancel and confirm network/native bytes stop and the partial/checkpoint are removed. Verify both history-clear buttons in the extension popup. Detection, playback, subtitle, overlay, and site-specific token refresh remain separate surfaces.
- Final validation/install: full Node suite passes 518/518, manager 128/128, native host 34/34, and `git diff --check` reports no whitespace error. `npm run build:dev-staging` produced 90 Pro files at `0.4.19`; no ZIP was created. Inno Setup produced `dist/Aura-Media-Companion-0.4.19-win-x64.exe` (130,296,894 bytes, SHA-256 `42D95763BA94240029BCEBC03CB2A81E1B361A26937FA571E0DB0DC555D00B15`). Silent install exited 0; Add/Remove Programs reports `0.4.19`; installed host SHA-256 `3B1E385D6A4AF9EF6F1BEAF8A9D68BB0F6912F0E1B9AF6DA55EFCFE48E88DEE4` and manager SHA-256 `DE5130EB70344B659E10A478D3088D52796D948A48CEB27E8942032097017806` exactly match release. The installed manager is running with no TCP listener. A live network interruption/cancel remains required, so the incident stays `CODE-FIXED / LIVE-UNVERIFIED`.
- Follow-up reproduction in installed `0.4.19`: pressing Cancel in the Companion card only shows a separate `취소를 요청했습니다.` notice, while the card can remain active and there is no visible manager-side history deletion action. This is distinct from the extension popup controls fixed above.
- Confirmed follow-up cause: the manager wrote the shared `.cancel` marker but reported success through a layout-consuming notice rather than the card state. On the Companion native-writer route, marker detection persisted `cancelled` but left the writer and `.part` open and relied on JavaScript to send a second `media-abort`. The manager queue had no API or control for deleting terminal state records.
- Follow-up code action in `0.4.20`: after the stop marker is durably written, update the same card text to `취소 처리 중…`; only the host changes it to terminal `cancelled` after it consumes the marker. On the native writer's next boundary, take and close the active writer, persist cancelled state, remove its `.part`, and consume the marker directly. Remove success notices for pause/resume/retry/cancel and express those transitions in each card's status text. Add a visible `이력 삭제` text action beside queue filters that removes only completed, failed, and cancelled state/request/marker records; preserve active jobs and downloaded media files.
- `0.4.20` regression: manager tests pass 130/130, including cancel marker-before-state ordering and terminal-history cleanup that preserves an active job. Native host tests pass 35/35, including direct close/removal of an open writer partial and persisted cancelled state. Full-suite, staging, install, and real-window results are recorded after final validation.

### INC-2026-08-25-030 Seek-hover preview showed a holder without the frame

- Status: `CODE-FIXED / LIVE-UNVERIFIED`
- Reproduction: while an in-app video is playing, hover the seek bar. The preview rectangle and timecode appear, but the extracted thumbnail image is not visible.
- Affected surface: native Rust/egui Player seek-hover preview.
- Confirmed evidence: the Companion cache contains valid per-slot JPEGs with 320×180 video frames and non-empty image statistics, so ffmpeg extraction and JPEG decoding are not the failing stage. The failure is in the native child overlay's GDI presentation path.
- Code action in `0.4.9`: resize decoded frames to the exact 192×108 image area, remove the sibling-window transparency style that can defer/obscure child painting, and fall back from `StretchDIBits` to `SetDIBitsToDevice` when GDI reports no drawn pixels.
- Changed files: `companion-gui/src/seek_preview.rs`, `companion-gui/Cargo.toml`, `manifest.json`, this incident record, and regenerated development staging/installer artifacts.
- Regression: manager unit suite remains 85/85, `cargo check` passes, and the cached frame probe confirms valid JPEG input. A visible hover check in the refreshed app is still required to mark this resolved.
- Follow-up reproduction in `0.4.13`: moving across uncached half-second seek slots makes the preview disappear and reappear, so otherwise valid thumbnails feel abrupt. Revisiting a disk-cached slot still incurs JPEG decode and UI replacement latency.
- Confirmed follow-up cause: `SeekPreviewController::request` hid the native overlay before every new extraction. The disk cache avoided ffmpeg work after the first visit but did not retain a decoded frame or prevent the deliberate blank interval.
- Follow-up code action in `0.4.14`: keep the last decoded frame visible and repositioned until the newest requested frame is ready, add a bounded 32-frame in-memory LRU above the existing disk cache, and retain successful stale worker results for immediate revisit. The same release adds bounded per-video pose-start metadata, seek-bar marks, marker-linked preview hover, and exact marker click seeking.
- `0.4.14` regression: manager suite passes 113/113, including LRU eviction, marker persistence/toggle normalization, invalid marker rejection, nearest-marker hit selection, and exact saved-timestamp snapping. Real-window smoothness and marker interaction remain `LIVE-UNVERIFIED` until the refreshed installed app is checked.
- `0.4.14` staging/install: full Node suite passes 515/515; Pro staging contains 90 files at `0.4.14`; Inno Setup produced `dist/Aura-Media-Companion-0.4.14-win-x64.exe` (130,632,477 bytes, SHA-256 `56F3E75AE1B901264D2A6FB1261B26C0F62961B4FB99EE288D7D59672407085D`). Silent install exited 0, the installed manager matches the release SHA-256 (`DBC11F451D9072511389EE20611555B503360CF0BEA646EA39A0A4D0DA5FCCDC`), is running from the installed path, and owns no TCP listener. Visual smoothness and marker interaction remain user-driven checks.
- Follow-up reproduction in `0.4.16`: quickly move the pointer across uncached seek slots. The overlay retains the previous frame, but the requested frame still appears late because the single worker cannot cancel the already-running ffmpeg process for an obsolete position; the newest replaceable pending request waits behind it.
- Confirmed follow-up cause: queue coalescing bounded pending work but `generate` used blocking `Command::status()`. Each first-visit slot spawned ffmpeg at 320×180, then Rust decoded and resampled it again to the 192×108 overlay. The 32-frame memory LRU covered only 16 seconds of half-second slots.
- Follow-up code action in `0.4.17`: poll the ffmpeg child every 12ms and kill an in-flight extraction when a different newest request is pending; process that newest request next; generate new JPEGs directly at 192×108 while retaining compatibility with older 320×180 disk entries; expand the decoded memory LRU from 32 to 96 frames. Keep 500ms quantization, one worker, bounded pending state, stale-result caching, and the 96-file disk cap.
- `0.4.17` regression/install: manager suite passes 116/116 and covers in-flight supersession, newest-request preservation, native overlay generation size, old-cache resize compatibility through the decode path, and 96-frame LRU eviction. Full `npm test` passes 516/516; Pro staging contains 90 files at `0.4.17`. Inno Setup produced `dist/Aura-Media-Companion-0.4.17-win-x64.exe` (130,276,785 bytes, SHA-256 `5575DBE0F73EFEBC426606D2158381D2A59BDA2AD78D375568E2406C53FB91CF`). Silent install exited 0; installed manager SHA-256 matches release (`6CAE45E7390D11ADEEFFF77ED26E586E1045A6E0CCFA01C0FCDD9A8E4275FDA9`) and is running. Real pointer-motion timing remains `LIVE-UNVERIFIED`.
- Follow-up reproduction in `0.4.17`: in windowed Player mode, the control card and seek track are wider than the centered 16:9 video. Hovering either end of the seek track updates the target time, but the thumbnail stops at the video's left or right edge. Fullscreen does not expose the mismatch because its video and track are nearly the same width.
- Confirmed follow-up cause: `scrubber` correctly derived time from the full `track`, then clamped preview X against `video_rect.left/right`. Horizontal interaction and preview placement therefore had different coordinate owners.
- Follow-up reproduction in `0.4.17`: in the normal window, the thumbnail overlaps the seek bar; in fullscreen, it appears near the top of the video. Hovering fullscreen also reveals the complete 116-point control card even though only seeking is needed.
- Confirmed follow-up cause: the ordinary player mixed seek-track coordinates with the video rectangle for vertical placement. The fullscreen scrubber ran in a separate immediate viewport, then returned its viewport-local placement as if it were parent-client coordinates. The fullscreen overlay also reused the complete ordinary `control_bar` composition.
- Follow-up code action in `0.4.18`: clamp preview X against the full seek-track rectangle, derive Y directly above that track, and translate fullscreen viewport-local placement into parent-client coordinates. Replace the fullscreen control card with a floating 42-point seek-only surface; it does not resize the video and retains the existing bottom-hover animation.
- `0.4.18` regression/install: manager suite passes 118/118 and covers left edge, midpoint, and right edge placement across the complete seek track, exact preview-to-track vertical spacing in both coordinate spaces, and the seek-only overlay's fixed height/no-video-reflow contract. Native host passes 33/33 and full `npm test` passes 516/516. Pro staging contains 90 files at `0.4.18`. Inno Setup produced `dist/Aura-Media-Companion-0.4.18-win-x64.exe` (130,285,705 bytes, SHA-256 `5FEF64DC95786EC2C6CD3D32A1141608D960B9BB7C08BEF5CFD5D6834C122E01`). Silent install succeeded; Add/Remove Programs reports `0.4.18`; installed manager and host hashes match their release binaries (`9117B6E49E9DF10CBBE65924BCBEEE310476ED60102E5820CFA9F066269F9CC6` and `1345D5BFD0FE0DA15F63259F73DADCE82AD9A0F375A5CE78FAB32BEBCAD13779`). The installed manager is responsive and owns no TCP listener. Real pointer placement and fullscreen appearance remain `LIVE-UNVERIFIED` pending user interaction.

### INC-2026-08-25-031 Fullscreen expanded the window but retained the page layout

- Status: `CODE-FIXED / LIVE-UNVERIFIED`
- Reproduction: click the Player fullscreen control. The viewport expands, but the rail, header, next-play row, and ordinary page spacing remain, so the video itself does not become the dominant fullscreen surface.
- Affected surface: native Rust/egui Companion Player fullscreen mode.
- Confirmed cause: fullscreen only toggled the eframe viewport flag; `PlayerUiInput` and the app shell continued rendering the normal Player page composition.
- Code action in `0.4.10`: add a fullscreen-only composition that removes the rail/header/up-next content, gives the video the available 16:9 area, and reserves a bottom control zone. The control zone animates upward on pointer hover in the bottom 96px and slides back down when the pointer leaves; F/fullscreen toggles retain the existing command path.
- Changed files: `companion-gui/src/app.rs`, `companion-gui/src/player_ui.rs`, `companion-gui/Cargo.toml`, `manifest.json`, this incident record, and regenerated development staging/installer artifacts.
- Regression: manager unit suite remains 85/85, `cargo check` passes, and the 0.4.10 release build is packaged. Visible fullscreen and bottom-hover confirmation remains a user-window check.
- Follow-up reproduction in `0.4.11`: reveal the fullscreen controls by hovering the lower edge. The video rectangle is recomputed from `available.height() - control_height`, so it shrinks and recenters during the 180ms reveal instead of staying visually stable behind the rising bar.
- Confirmed follow-up cause: `fullscreen_player` coupled the animated control height to the video layout. The control bar also reused the fully opaque ordinary-page surface.
- Follow-up code action in `0.4.12`: compute the aspect-fit video rectangle once from the complete fullscreen viewport, move only a separately positioned control overlay from below the viewport to a 16px floating inset, and fade its white surface to 86% alpha. The lower hover region includes the fully revealed bar so its scrubber and controls remain reachable.
- Follow-up regression: manager unit suite passes 107/107. New layout tests prove that hidden and fully shown controls produce the identical centered video rectangle and 16:9 ratio, while the control rectangle alone moves upward and its final fill remains translucent. Real-window appearance remains `LIVE-UNVERIFIED` under the user's headless-review rule.
- Follow-up staging/install: `npm run build:dev-staging` returned `DEV_STAGING_OK` for 90 Pro files at `0.4.12`. Inno Setup produced `dist/Aura-Media-Companion-0.4.12-win-x64.exe` (130,585,799 bytes, SHA-256 `90DC3DD71EA6FCF5D567766C12627CDF84EBDEDF575FACF9157EB12E0BC3AD94`). Silent install exited 0; the installed manager SHA-256 matches the release binary (`6B3F192C98B545E32631D6D9044088BF791ADC16B198A886A00EDDD7BB136EF`), launched from the installed path, and opened no TCP listener. Visual fullscreen confirmation remains user-driven.
- Real-app failure in `0.4.12`: the user confirmed that lower-edge hover revealed no visible controls and Escape did not restore the previous window size. The pure layout tests passed but did not exercise Win32 child-window composition or the missing key binding.
- Confirmed `0.4.12` causes: mpv renders into a child HWND, which occupies the airspace above paint submitted to its egui parent, so the in-window translucent bar was physically hidden behind video. Keyboard bindings exposed fullscreen toggle on `F` only; `Escape` had no fullscreen-only mapping.
- Code action in `0.4.13`: render the controls in an undecorated, transparent, taskbar-hidden immediate viewport positioned above the mpv HWND; preserve hover while the pointer transfers from the main viewport into that overlay; keep the video rectangle unchanged; and map Escape to fullscreen exit only while fullscreen, including when the overlay owns input. The app clear color is transparent so the overlay alpha composites with video.
- `0.4.13` regression: manager suite passes 107/107 and checks that non-fullscreen bindings exclude Escape while fullscreen bindings include it. Real-window hover, overlay interaction, transparency, and Escape restoration remain `LIVE-UNVERIFIED` until the refreshed installed app is checked.
- `0.4.13` staging/install: Pro staging contains 90 files at `0.4.13`; Inno Setup produced `dist/Aura-Media-Companion-0.4.13-win-x64.exe` (130,610,693 bytes, SHA-256 `0E927A47FB7C961B4B88DCAA34991F116DD4433FC63C16518646E3E3B74C8D6B`). Silent install exited 0, the installed manager matches the release SHA-256 (`B034B9B2444C5E11C7837D4DB98FEA8E94C043745660F4A24CF4FFC24D87AB17`), and the refreshed installed app is running for the user check.
- User follow-up after `0.4.17`: fullscreen hover must expose only a compact seek bar, without the ordinary playback/volume/advanced control rows or their reserved visual height.
- Corrective action in `0.4.18`: replace fullscreen reuse of `control_bar` with a dedicated 42-point seek-only overlay. Keep the video rectangle invariant, bottom-hover animation, click-to-pause, `F`, and Escape behavior. Preview coordinate correction is recorded with INC-2026-08-25-030.
- `0.4.18` corrective verification: manager suite passes 118/118, release and installed hashes match, Add/Remove Programs reports `0.4.18`, and the responsive installed app is running. Visible lower-edge hover remains a user-window check.

### INC-2026-08-26-032 YouTube playback opened in a constrained page and the filename title showed missing glyphs

- Status: `CODE-FIXED / LIVE-UNVERIFIED`
- Reproduction: in installed Companion `0.4.15`, play completed YouTube job `80be8656-9972-4c33-a03d-0b0f6eb38243`. The 16:9 video is limited by the ordinary Player page's 560-point maximum while rail/header/controls remain visible. The header renders boxes where the filename contains yt-dlp's Windows slash replacement `⧸`. Evidence: `C:\Users\coseung2\Pictures\Screenshots\스크린샷 2026-08-26 000628.png`.
- Affected surface: Windows Companion Player entry behavior and native YouTube title/filename preparation. Browser detection, transport, and subtitle behavior are not involved.
- Confirmed root causes: existing fullscreen composition and Escape/control-overlay handling work only after an explicit fullscreen request; `play_file_in` changed the view and loaded mpv without requesting it. The downloaded file itself is a real 50,238,747-byte MP4 with 1920×1080 AV1 video, Opus audio, and 969.821-second duration, so the apparent low resolution is the constrained presentation area rather than a 1080p download failure. Separately, `--windows-filenames` maps `/` to `⧸`, which is not covered by the installed UI font.
- Code action in `0.4.16`: every Queue/Library media selection requests the dedicated fullscreen composition on the next frame; retain 16:9 aspect-fit, black letterboxing, lower-edge controls, F toggle, and Escape exit. Normalize slash/backslash title separators to ` - ` through yt-dlp metadata before Windows filename sanitization, preserving Korean text and applying the same readable title to metadata and future filenames.
- Changed files: `companion-gui/src/app.rs`, `native-host/src/main.rs`, native host/manager version files, `manifest.json`, this incident record, development staging, installed binaries/tools state, and installer output.
- Regression: manager suite passes 114/114 and covers fullscreen request state on media selection; native-host suite passes 33/33 and pins the UTF-8 title separator arguments; full `npm test` passes 516/516. A live yt-dlp metadata probe returns `마르티넬리와 알힐랄 - 텔을 임대보낸다고? - 맨시티와 각포 영입 참전?` and a Windows-safe filename with the same hyphen separators.
- Staging version: `0.4.16`.
- Install and real-app result: `npm run build:dev-staging` returned `DEV_STAGING_OK` with 90 Pro files. Inno Setup built `dist/Aura-Media-Companion-0.4.16-win-x64.exe` (130,279,519 bytes, SHA-256 `7246811107e4b29f3bb3188e8d1df53da07c2c3efb0bf39724d6696f9d1cfe02`). Silent install exited 0; Add/Remove Programs reports `0.4.16`; installed manager SHA-256 matches the release binary (`5FEE36CC9356D32F8DD06CBE5C5D5C5530C96E585655F9CB7D360BCEA2150023`). The existing 50,238,747-byte file was renamed in place with hyphen separators, and rerunning its preserved request updated job state to `completed`, progress 100, with readable title and filename. The refreshed manager is running. Automatic fullscreen, lower-edge controls, and Escape restoration remain `LIVE-UNVERIFIED` until the user reopens the video.
- User correction after `0.4.16`: automatic fullscreen is not the desired default. Playback must open in the ordinary window; fullscreen remains an explicit action through the button or `F`.
- Corrective action in `0.4.17`: remove the playback-entry fullscreen request and its state while preserving the existing explicit fullscreen composition, lower-edge controls, `F`, and Escape behavior. The title normalization and verified 1080p file are unchanged.
- `0.4.17` corrective verification: manager suite passes 116/116, release/install hashes match, Add/Remove Programs reports `0.4.17`, and the refreshed app is running. Default windowed playback and explicit fullscreen remain a visible user check.
- User follow-up after `0.4.17`: remove the bracketed YouTube video ID from the saved filename entirely.
- Code action in `0.4.18`: change the native yt-dlp output template from `[height] title [id].ext` to `[height] title.ext`. Keep the readable hyphen title normalization and UTF-8 pipe output. Existing file and preserved job state are renamed/refreshed during installation verification.
- `0.4.18` verification: native-host 33/33 pins the ID-free output template. The existing 50,238,747-byte 1080p file was renamed in place to `[1080p] 마르티넬리와 알힐랄 - 텔을 임대보낸다고？ - 맨시티와 각포 영입 참전？.mp4`; rerunning the preserved request through the installed `0.4.18` host kept the job `completed` at 100% and rewrote its UTF-8 title and ID-free filename state without downloading the media again.

### INC-2026-08-26-033 Korean UI typography mixed incompatible font metrics

- Status: `CODE-FIXED / LIVE-UNVERIFIED`
- Reproduction: open the installed Companion Player with a title containing `[1080p]`, Korean text, punctuation, and a YouTube ID. Even after unsupported filename glyphs are removed, the title's Latin/numeric and Hangul portions have visibly inconsistent weight, width, and baseline.
- Affected surface: all proportional Korean text in the Windows Companion manager. mpv video/subtitle rendering and downloaded media bytes are not involved.
- Confirmed root cause: `install_fonts` appended Malgun Gothic after egui's default proportional font. egui therefore rendered Latin, numbers, and punctuation with its bundled face and only missing Hangul glyphs with Malgun Gothic inside the same label. Monospace and proportional responsibilities were not separated.
- Code action in `0.4.17`: make system Malgun Gothic the first proportional UI font so mixed Korean labels use one face and metrics; keep egui's monospace font first for code/path values and append Korean only as its Hangul fallback. Gulim remains the system fallback only when Malgun Gothic cannot be read.
- Changed files: `companion-gui/src/app.rs`, manager/native package version files, `manifest.json`, this incident record, development staging, installer output, and installed manager state.
- Regression: manager suite passes 116/116 and pins Korean as the first proportional font and last monospace fallback; full `npm test` passes 516/516. Pro staging and the installed `0.4.17` manager match the release details recorded under INC-2026-08-25-030.
- Staging version: `0.4.17`.
- Real-app result: installed and running; mixed `[1080p]` plus Korean titles in Queue, Library, and Player remain `LIVE-UNVERIFIED` pending the user's visual inspection.

### INC-2026-08-26-036 Store KO branding still used the Aura Companion name and navy mark

- Status: `CODE-FIXED / LIVE-UNVERIFIED`
- Reproduction: open the installed manager after the Store KO Figma page (`PPruXutd0mseQAugWYU9ZS`, node `39:392`) was approved as the source of truth. The rail still said `Aura Media` / `Companion`, the window title stayed `Aura Media Companion`, progress and primary actions used near-black, and the mark was the old navy/cyan download glyph.
- Affected surface: native manager window, installer display name, and Store KO logo assets. Native host identity, `%LOCALAPPDATA%\Aura Media\Companion`, and `Downloads\Aura Media` remain compatibility paths and were not migrated.
- Confirmed root cause: display strings and tokens still mirrored the older Companion Figma file. Store KO specifies `SEGMA` over `PLAYER`, the interlocking puzzle playback mark (`#17191D`, `#59616D`, `#D6D9DE`, `#FFA31A`, white triangle), and `#FFA31A` only as the signal/progress/CTA accent. Selected library filters stay inverse black.
- Code action in `0.4.21`: replace the visible app name with Segma Player, paint the Figma puzzle mark in the rail and window/installer icons, add `color::ACCENT` `#FFA31A`, and apply it to primary buttons, download/player progress, selected rating stars, and library watch-progress. Keep the native messaging host id, install directory, and download folder unchanged.
- Changed files: `companion-gui/src/{theme,widgets,app,main,player_ui,jobs}.rs`, `companion-gui/assets/segma-mark.svg`, `companion-gui/assets/segma-mark-256.png`, `assets/aura-media-mark.svg`, `assets/microsoft-store/source/logo-mark-1024x1024.svg`, `assets/microsoft-store/source/segma-player.ico`, `installer/AuraMediaCompanion.iss`, `native-host/src/main.rs`, `design-system/tokens/tokens.json`, version files, this incident record.
- Regression: manager suite passes 131/131 including the Store KO rail-name assertion and `#FFA31A` token check; native host suite passes 35/35; full `npm test` passes 518/518. Staging and the installed window remain recorded after handoff validation.
- Staging version: `0.4.21`.
- Real-app result: `LIVE-UNVERIFIED` until the installed window shows `SEGMA` / `PLAYER`, the puzzle mark, orange progress/CTA, and unchanged download folder paths.
- Follow-up in `0.4.22`: keep the Store KO Figma PNG as the mark instead of reconstructing puzzle paths. Clip only the existing 1024 canvas to a rounded app-icon mask, embed that ICO in the manager binary, and create a desktop `Segma Player` shortcut while deleting the leftover `Aura Media Companion.lnk`.
- Follow-up reproduction in installed `0.4.22`: the rail showed egui's red broken-image warning because `egui_extras` was built with only the SVG loader while the rail now embeds the Figma PNG. The same exported icon also retained the Figma canvas margin, making the puzzle mark too small in the title bar, desktop shortcut, and other logo slots.
- Follow-up action in `0.4.23`: enable egui's raster image loader and keep the downloaded node `39:402` PNG as a pristine source. Crop only its exact 640px mark bounds at `(192, 192)` and regenerate rail, executable, installer, desktop, Start menu, and Microsoft Store square icons from that source. No puzzle paths or colors are redrawn.
- Extension follow-up in `0.4.24`: align the browser connector with the same Segma Player mark and `#FFA31A` light theme; make `popup.html` canonical; keep only media detection and link/download handoff; remove popup-visible browser playback and subtitle-folder controls; remove their runtime files from store/development package allowlists; remove the extension-only `bookmarks` permission. Existing native host ids and compatibility download paths remain unchanged.
- Regression: focused connector, staging, package, and architecture tests pass 31/31. Real Chrome/Whale detection and Companion handoff remain `LIVE-UNVERIFIED` for this version; browser playback and extension subtitle generation are intentionally `NOT_RUN` because those surfaces are no longer shipped.
- Staging version: `0.4.24`.
- UI follow-up in `0.4.24`: redesign the link-input panel, media-detection tab and action buttons as light Segma surfaces with `#FFA31A` primary actions; restyle the settings page with the same brand header, typography, field treatment, focus states, and responsive layout while preserving existing IDs and Companion wiring.
- UI regression: full `npm test` passes 513/513 with 5 intentional skips; `npm run build:dev-staging` produces `0.4.24` Pro staging with 78 files. Popup/settings visual inspection in real Chrome/Whale remains `LIVE-UNVERIFIED`.
- Cleanup follow-up in `0.4.25`: remove the packaged background import and state persistence for browser playback sessions, playback-only media-fetch rules, and obsolete playback session handlers. Add a staging module-graph check so an allowlisted JavaScript import cannot reference a file omitted from the package.
- Cleanup verification: focused architecture, staging, and media-lease tests pass 15/15; full `npm test` passes 509/509 with 9 intentional skips; Pro staging is `0.4.25` with 78 files. Generic detected-media/link download still uses the extension worker because the Companion has no generic media-download command yet; do not remove that path until the replacement protocol is implemented.

- Taskbar reproduction through installed `0.4.24`: even after replacing the EXE resource and calling `WM_SETICON`, the taskbar continued to show the earlier white-backed icon. The app was not pinned (`User Pinned\TaskBar` contained only Explorer and Whale), and live HWND inspection confirmed 16/32 icons were already attached.
- Confirmed taskbar root cause: Explorer's icon cache databases were still open. `ie4uinit.exe -show` and repeated window-icon replacement did not evict the cached image for the stable `aura-media-manager.exe` path. Microsoft documents that Explorer must be stopped before deleting `IconCache.db`/`iconcache*`; after that exact sequence, the old white-backed image disappeared.
- Corrective action in `0.4.25`: keep 16/32/48 ICO entries as 32-bit BMP plus AND mask, remove eframe's PNG `with_icon` path, explicitly load the EXE's 16/32 resources for window and class icons, and call `SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST | SHCNF_FLUSHNOWAIT)` before showing the window so future upgrades invalidate Explorer's image list.
- Changed files: `assets/microsoft-store/segma-icon-source.mjs`, `scripts/export-segma-brand-assets.mjs`, `scripts/segma-taskbar-ico.test.mjs`, `companion-gui/src/{main,app}.rs`, manager/native/manifest version files, generated Segma icon assets, development staging, and this incident record.
- Taskbar regression: `scripts/segma-taskbar-ico.test.mjs` passes; manager `taskbar_icon_uses_embedded_win32_resource` passes and pins 16/32 resource loading, removal of eframe PNG icon injection, and shell-cache invalidation.
- Taskbar real-app result: `RESOLVED` on installed `0.4.25`; Explorer was stopped, icon caches were deleted, Explorer and Segma Player were relaunched, and `artifacts/taskbar-current.png` shows the puzzle mark directly with no white backing plate.
- User verification: `2026-08-26`, Windows 11 installed Companion `0.4.25`, native taskbar surface — user confirmed the corrected icon as "오 완벽해 ㅋㅋ굿굿" after the final Explorer/cache rebuild. This closes the taskbar-icon sub-incident with both captured evidence and real-user visual confirmation.

### INC-2026-08-26-037 Companion split broke candidate persistence and installed-app detection

- Status: `CODE-FIXED / LIVE-UNVERIFIED`
- Reproduction: load development extension `fnnilboncpjgaachejfhednccmfflmkl`, visit a media page, and trigger candidate observation. The service worker throws `ReferenceError: persistTimer is not defined` from `persistCandidates` via `observeCandidate`; the popup then shows no detected media. Open the settings page or a popup rendered in a normal extension tab and Companion status receives no response. Whale also reports the locally installed Companion as unavailable.
- Browser and affected surface: Chrome Default and Whale Default both point at `artifacts/chrome-web-store/staging-pro`; affected surfaces are service-worker media detection, popup/settings Companion status, candidate/link handoff, and Whale native messaging. Browser playback and extension subtitle generation are intentionally out of scope because they are no longer shipped.
- Confirmed root causes: the feature split removed the module-level `persistTimer` declaration while retaining `persistCandidates`; the installed host was still `0.4.23` and did not advertise `media-download-v1`; the installer registered only Chrome and Edge, not Whale; and UI message routes rejected every sender with `sender.tab`, which excluded the settings page and extension pages opened as tabs. The live monitor also retained stale hard-coded `Aura Media Downloader`, browser-playback, and `chrome.downloads` assumptions after the rebrand/split.
- Code action in `0.4.26`: restore the bounded persistence timer; route candidate/link downloads only through Companion media-download v1; allow trusted same-extension pages while continuing to reject web content senders; register `com.aura.media_companion` for Whale in both installers; update the live monitor to use the active manifest name, exact staging root, detection-only semantics, and optional Companion readiness. Rebuild and silently install Segma Player `0.4.26`.
- Changed files: `background.js`, `companion-client.js`, `native-host/src/main.rs`, `installer/AuraMediaCompanion.iss`, `install-media-companion.ps1`, `scripts/live-media-smoke.mjs`, `companion-architecture.test.mjs`, focused/full tests, `README.md`, `manifest.json`, generated Pro staging, this incident record, and `SITE_QA_LOG.md`.
- Regression: focused connector/background/installer tests pass; full `npm test` passes 492/514 with 22 intentional legacy skips and 0 failures. Native host previously passed 37/37, release compilation succeeded, and direct installed-host hello/status return protocol 2, version `0.4.26`, `toolsReady=true`, and `media-download-v1`.
- Staging/install result: `npm run build:dev-staging` returns `DEV_STAGING_OK`, version `0.4.26`, 49 files. Installed host and manager hashes exactly match their release binaries; Add/Remove Programs reports `0.4.26`; Chrome and Whale HKCU native-host registrations both resolve to the installed manifest. Segma Player was reopened with window title `Segma Player`.
- Real-browser result: isolated Chromium loaded the exact `staging-pro` path as extension ID `fnnilboncpjgaachejfhednccmfflmkl`. With Aura AdBlock on, live Beeg detection returned 14 candidates including main `video.beeg.com` HLS media, while Companion status returned `0.4.26`, `toolsReady=true`, and `media-download-v1`; evidence is `artifacts/live-media-0.4.26-staging-beeg-pass.json`. The user's already-open Chrome/Whale profiles still require one extension reload and popup/settings retest, so the incident remains `LIVE-UNVERIFIED` for those exact active profiles.

### INC-2026-08-26-038 Pre-playback media URL discovery was too narrow

- Status: `CODE-FIXED / LIVE-UNVERIFIED`
- Reproduction: adult streaming pages that hide the real media URL until playback, or that embed Filemoon/Mixdrop/Voe/player iframes, JSON `play_url` values without `.m3u8`, Shadow DOM video, or `srcdoc` player config. The extension already saw playing hls.js/Fetch/XHR sources, but pre-playback address finding missed those clues.
- Browser and affected surface: Chrome/Whale detection (`detect`) for current-tab media URL discovery. Playback, subtitle, and quality selection are out of scope.
- Confirmed root cause: isolated `content.js` harvested only `video_url`/`video_url_hd` base64; MAIN-world JSON matching required an explicit media extension; `looksLikePlayerPage()` started the player graph only for Streamtape `/v|/e` and generic `/d/` `/e/`; media-element scans did not walk open Shadow roots or `srcdoc` frames.
- Code action in `0.4.27`: harvest `data-src`/`data-file`, JSON-LD `contentUrl`/`embedUrl`, `og:video`, and bounded inline script media URLs before playback; accept JSON keys such as `play_url`/`videoUrl` and extensionless HLS/DASH-looking URLs; start player-graph resolution for `/embed` `/player` and Filemoon/Mixdrop/Voe pages; scan open Shadow roots and `srcdoc` iframe config. Keep eval/JSON.parse replacement, quality selection, and extra player adapters out of this patch.
- De-obfuscation action in `0.4.27`: add a deterministic, zero-eval Dean Edwards Packer unpacker and hex-escaped URL decoder across `content.js`, `page-media-observer.js`, and `player-page-resolver.js`. Obfuscated inline player scripts and player-page responses are unpacked and decoded without dynamic code execution (`eval()`), exposing hidden media URLs before playback.
- De-obfuscation action in `0.4.28`: add static string reversal (`decodeReversedUrls`), percent/double URL encoding decoder (`decodePercentEscapedUrls`), and Base64 JSON config payload decoder (`decodeBase64JsonConfigs`) across `content.js`, `page-media-observer.js`, and `player-page-resolver.js`. Hidden media URLs encoded in reversed strings, %-escaped literals, or Base64 JSON config payloads are extracted statically without dynamic code evaluation.
- Follow-up in `0.4.29`: preserve inferred HLS/DASH MIME for pre-playback inline config instead of forcing every discovered address to `video/mp4`; keep ordinary non-JSON Fetch/XHR text from being promoted as high-confidence `api-json`; accept tokenized reversed URLs, normal `encodeURIComponent()` URL strings, Base64URL JSON objects/arrays, and invalidate cached pre-playback clues when `data-*`, `srcdoc`, or media meta content changes. Inline script harvesting now also has a 1 MB aggregate text budget per scan in addition to the per-script bound.
- Changed files: `content.js`, `page-media-observer.js`, `player-page-resolver.js`, focused tests, `manifest.json`, this incident record, and `SITE_QA_LOG.md`.
- Regression: `0.4.29` focused candidate/content/MAIN-observer/player-resolver/download-mode tests pass 128/128, including new reproductions for extensionless HLS/DASH routing, non-JSON false positives, dynamic config cache invalidation, tokenized reversed URLs, standard percent encoding, and Base64URL JSON arrays. Live Chrome/Whale detection of obfuscated player pages remains `NOT_RUN`.
- Staging version: `0.4.29`.

### INC-2026-08-27-039 Clean GitHub Actions checkout could not run the taskbar ICO regression

- Status: `CODE-FIXED / CI-PENDING`
- Reproduction: run `npm test` from a clean GitHub Actions checkout where the ignored `artifacts/` directory does not already exist. `scripts/segma-taskbar-ico.test.mjs` calls `writeSegmaIco()` with `artifacts/segma-player-taskbar-test.ico`, and `writeFile()` fails with `ENOENT` before the icon assertions run.
- Root cause: the taskbar regression test depended on a local build artifact directory as implicit fixture setup. Existing development checkouts normally already had that ignored directory, masking the clean-checkout failure.
- Code action in `0.4.30`: make the test create its output directory recursively before writing the temporary ICO and remove the temporary ICO in `finally`, so it is hermetic on fresh runners and leaves no generated test file behind.
- GitHub Actions context: the repository was changed from private to public on `2026-08-27`; this restored hosted-runner allocation. The first allocated Ubuntu runner passed `npm ci` and all 35 media-site regressions, then exposed this single full-suite failure (`499` pass, `1` fail, `25` skipped).
- Staging version: `0.4.30`.
