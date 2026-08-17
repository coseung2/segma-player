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

- Status: `CODE-FIXED / LIVE-UNVERIFIED`
- Reproduction: user's headed Chrome session with extension `0.3.86` Pro; Dood candidate is detected and Aura browser playback succeeds. DevTools shows a tokenized CDN media URL, but opening that URL in a new tab is blocked. The extension-download surface still fails.
- Confirmed behavior: the Dood CDN authorizes the media request from the player frame context. A top-level navigation is not an equivalent test and is expected to be hotlink-blocked.
- Confirmed code gap: the download `media-stream` path carried the source tab but dropped the candidate `frameId` before requesting a fresh Dood URL, allowing the refresh to target the wrong frame and losing the exact player-frame context.
- Code action in `0.3.87`: carry `videoFrameId` through the progressive session and target `get-dood-direct` at that frame; Dood-compatible progressive candidates now prefer the source-frame browser-download handoff instead of an extension-origin probe.
- Regression test: `hls-download.test.mjs` covers frame propagation and source-frame preference; focused suite passes.
- Live result after code action: `LIVE-UNVERIFIED`; the real Chrome Dood tab must be reloaded and the extension-download surface retested. Do not infer download success from Aura playback or from a direct new-tab test.

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
