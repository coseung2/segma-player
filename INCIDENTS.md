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

- 상태: `OPEN / 외부 서버 접근 제한`
- 영향: Modal에서 영상 서버 접근 차단 오류가 발생하고 자막 생성이 실패함
- 원인: 브라우저에서 재생 가능한 추출 링크라도 Modal이 동일한 브라우저 세션·쿠키·Referer를 갖지 않아 영상 서버가 직접 음성 읽기를 차단함
- 조치: 추출한 `mediaUrl`과 `sourceUrl`을 자막 서버까지 전달하고, Modal에서 curl 헤더·HLS materialization fallback을 추가
- 남은 문제: 실제 사용자 영상에서 Modal 전사 성공을 아직 확인하지 못함. 영상 URL별로 인증/오디오 트랙 유무를 별도 기록해야 함

### INC-2026-08-17-005 — 감지탭 브라우저 재생 버튼 누락

- 상태: `CODE-FIXED / LIVE-UNVERIFIED`
- 영향: 이전 버전에 있던 감지탭 브라우저 재생 버튼이 사라짐
- 원인: 기본 action popup 연결이 `popup-play.html`이 아닌 다른 팝업으로 변경됨
- 조치: manifest의 기본 팝업을 `popup-play.html`로 복구
- 남은 검증: Chrome과 Whale에서 감지탭 재생 버튼 클릭 및 플레이어 세션 생성 확인

### INC-2026-08-17-006 — MissAV DOCP-259 브라우저 재생 실패

- 상태: `CODE-FIXED / LIVE-UNVERIFIED`
- 재현: Chrome에서 `https://missav123.com/dm31/ko/docp-259`를 열고 감지된 후보의 브라우저 재생 실행
- 확장 버전: `0.3.71`
- 영향: Aura Media Player가 열리지만 영상이 시작되지 않고 `readyState=0`, 재생시간 0에서 멈춤
- 확인된 경로: `surrit.com` HLS 매니페스트는 HTTP 200, 첫 조각 `video0.jpeg` 요청은 HTTP 403. HLS 진단은 `manifestParsed=true`, `fragmentLoading=true`, `fragLoadError`임
- 재현 범위: live smoke의 headless와 headed Chrome 모두 동일. Referer와 Origin을 바꾼 직접 요청도 조각 서버에서 403
- 현재 판단: 플레이어 화면 자체보다 해당 페이지에서 선택된 `surrit.com` 조각 경로가 Cloudflare/영상 서버에서 차단된 것이 직접 원인이다. 이전 버전의 성공 여부는 별도 artifact가 없어 아직 증명하지 못했다.
- 조치: DOCP-259를 `media-site-regressions.json`의 별도 live QA 케이스로 추가하고, 실패 증거를 `SITE_QA_LOG.md`에 기록. 효과가 확인되지 않은 재생 rule 변경은 배포 상태에 남기지 않음
- 회귀 가설: `0.3.71` 작업트리의 HLS 플레이어가 `pLoader`만 contextual loader로 감싸 fragment 요청을 기본 loader로 우회시켰을 가능성이 있음. manifest는 200이고 fragment만 403인 관측과 일치하지만, 실제 서버 응답 변화와의 구분은 live 재검증이 필요함
- 조치: `player.js`의 HLS loader를 `loader` 전체 적용으로 수정해 manifest·playlist·fragment가 모두 동일한 media-fetch lease/context를 사용하도록 변경하고, 요청 종료 시 lease를 해제. `player-security.test.mjs`에 `pLoader` 회귀 방지 assertion 추가
- 회귀 테스트: `node --test contextual-hls-loader.test.mjs player-security.test.mjs hls-download.test.mjs` — 30 pass, 0 fail
- 추가 조치: fragment 오류(`fragLoadError`, timeout, aborted) 발생 시 같은 source tab의 동일 HLS 계열 alternate 후보로 1회 자동 전환하도록 playback session refresh 경로를 추가
- 회귀 테스트: `node --test contextual-hls-loader.test.mjs player-security.test.mjs hls-download.test.mjs` — 30 pass, 0 fail
- 추가 조치: source tab ID가 player payload에서 비어도 playback session의 후보 tab ID를 사용해 alternate 후보를 찾도록 보강
- staging 버전: `0.3.74`
- 남은 검증: `0.3.74`를 같은 Chrome/Whale 사용자 경로에서 재생하고, primary 실패 후 alternate 전환 및 `readyState`를 확인. 성공 후 다운로드·자막·overlay를 각각 별도 확인

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
### INC-2026-08-17-006 follow-up — 0.3.54 package recheck

- The 0.3.54 package and current 0.3.75 old-playback-compatibility A/B were both tested against the same DOCP-259 URL in headed Chromium.
- Both detected the HLS manifest with HTTP 200 but received HTTP 403 for the first `surrit.com` fragment and remained at `readyState=0`.
- This confirms a current external HLS authorization/CDN rejection is present independently of the latest extension source. It does not prove what changed on the site; the site page and manifest still returned HTTP 200.
- Evidence: `artifacts/live-media-0.3.75-docp-259-old-compat.json`; `C:\Users\coseung2\AppData\Local\Temp\aura-mdownloader-054\artifacts\live-media-0.3.54-docp-259-package.json`.
- Status remains `CODE-FIXED / LIVE-UNVERIFIED`; do not mark resolved until a fresh source-page/native-player or alternate provider path is confirmed.
