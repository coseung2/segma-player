# Companion → Tauri (Svelte) 이전 명세

> Status: 제안 (Implementation-ready spec)
> Scope: `companion-gui` (egui/eframe) → Tauri v2 + Svelte 5 + TypeScript
> 재생은 보조 기능으로 전환: 임베디드 mpv(HWND) 대신 웹 `<video>` 사용

## 1. 배경과 목표

현재 `companion-gui`는 egui/eframe 기반 네이티브 Rust GUI다. 다운로드
잡/보관함/재생/자막/설정을 한 창에서 처리한다.

**이전 이유:**

- UI 디테일(여백, 정렬, 로고, 시크바, PiP)을 CSS로 빠르고 정확하게 구현 가능
- 에이전트(코덱스 등)가 HTML/CSS/JS 작업을 egui보다 훨씬 능숙하게 수행
- "영상은 보조" 결정: mpv 임베디드(HWND 오버레이)의 유지보수 비용 대비
  이득이 적다. 웹 `<video>`로 대체

**이전하지 않는 것:**

- 백엔드 로직: `jobs`, `library_state`, `license`, `model`, `seek_preview`,
  `thumbnails`, `gif_export` — Rust 그대로 유지 (프론트에서 command 호출)
- 확장(extensions): 기존 MV3 확장 구조 유지 (이 명세 범위 밖)
- `native-host`: stdio 프로세스 유지
- ffmpeg 배포: `tools/ffmpeg/ffmpeg.exe` 그대로 사용

## 2. 대상 아키텍처

```
companion-gui/            (기존 — 삭제 예정)
companion-tauri/          (신규)
  src/                    Rust 백엔드 (Tauri commands)
    main.rs / lib.rs
    commands/
      jobs.rs             잡 읽기/취소/일시정지/재개
      library.rs          보관함 목록/조직/삭제/이동
      player.rs           <video> 재생용 커맨드 (재생/시크/볼륨/자막)
      subtitles.rs        자막 추출/가져오기/번역/동기화
      settings.rs         설정 읽기/쓰기
      system.rs           explorer 열기, 휴지통 삭제, 외부 플레이어 열기
    remux.rs              TS → MP4 리먹스 (ffmpeg -c copy)
  ui/                     Svelte 5 + TypeScript
    src/
      lib/
        components/       시크바, 재생 컨트롤, PiP, 타일, 모달
        stores/           jobs.svelte.ts, library.svelte.ts ...
        api/              invoke wrappers
      routes/             (파일 라우팅)
        queue.svelte      다운로드
        library.svelte    보관함
        player.svelte     재생 (보조)
        subtitles.svelte  자막
        settings.svelte   설정
  design-system/          CSS 변수로 이식 (tokens.css 그대로)
  tauri.conf.json
```

## 3. 화면별 이전 범위

기존 `View` enum: `Queue | Library | Player | Subtitles | Settings`

| 화면 | egui (현재) | Svelte (이전) |
|---|---|---|
| 다운로드 (Queue) | 잡 목록, 필터(전체/진행/일시/완료/실패), 검색 | 동일 + 필터/검색은 Svelte 상태로 |
| 보관함 (Library) | 미디어 타일, 폴더, 드래그 앤 드롭, 별점, 삭제 확인, 자동 조직 | 동일 (드래그앤드롭은 HTML5 DnD) |
| 재생 (Player) | mpv 임베디드, 시크바, PiP 오버레이, 전체화면 | `<video>` + 커스텀 시크바 + PiP (CSS) |
| 자막 (Subtitles) | 자막 추출/번역/동기화 UI | 동일 (백엔드 command 연동) |
| 설정 (Settings) | 다운로드 폴더, 테마, 티어 | 동일 |

### 재생 (Player) 화면 상세

- `<video>` 요소 + 커스텀 컨트롤
  - 시크바: 트랙 라인만 (배경 카드 제거) + 호버 시 썸네일 + 드래그
  - 진행/시간: 생성된 상태로 표시
  - 볼륨: 아이콘 + 슬라이더 (호버 시 노출)
  - 재생/일시정지/이전/다음/속도
- **PiP**: 화면만 + 호버 시에만 오버레이 컨트롤 (CSS `:hover` + transition)
  - 경계 hover 시에만 리사이즈 핸들러 노출 (상시 표시 금지)
  - 카드/프레임 없음 — hairline 테두리만
- 자막: SRT/VTT 기본 표시 (`<track>` 또는 커스텀 오버레이)
- **코덱 fallback**: `<video>` 재생 실패 시 "외부 플레이어로 열기" 버튼
  (Rust command → 시스템 기본 앱)
- **TS → MP4**: 다운로드 완료 후 `ffmpeg -i in.ts -c copy -movflags +faststart out.mp4`
  리먹스 (재인코딩 없음). 실패 시 원본 .ts 유지 + 외부 플레이어 fallback

## 4. 백엔드 재사용 vs 신규

| 모듈 | 처리 | 비고 |
|---|---|---|
| `jobs.rs` | ✅ 재사용 | 상태 파일 파싱/쓰기 그대로, command 래퍼만 |
| `library_state.rs` | ✅ 재사용 | 마이그레이션/조직 로직 그대로 |
| `license.rs` | ✅ 재사용 | 티어 검증 command 노출 |
| `model.rs` | ✅ 재사용 | 포맷/라벨 함수 command로 노출하거나 프론트로 이식 |
| `seek_preview.rs` | ✅ 재사용 | 프레임 추출 로직 유지, 이미지 URL 반환 |
| `thumbnails.rs` | ✅ 재사용 | 썸네일 생성 유지 |
| `gif_export.rs` | ✅ 재사용 | (유지 보수 우선순위 낮음) |
| `player_backend.rs` | ❌ **삭제** | mpv 프로세스/HWND 파이프 제어 전체 제거 |
| `player_ui.rs` | ❌ 삭제 | CSS/Svelte 컴포넌트로 대체 |
| `widgets.rs` / `theme.rs` / `icons.rs` | ❌ 삭제 | CSS 변수 + SVG 아이콘으로 대체 |
| `design-system/` | ✅ 이식 | `tokens.css` 그대로 사용, components는 Svelte로 재구현 |

## 5. 상태 / IPC 설계

- **Rust가 소유하는 상태**: 잡 상태 파일, 보관함 폴더 스캔, 라이선스, ffmpeg
  작업 (썸네일/리먹스/GIF)
- **Tauri command**: `invoke("jobs_list")`, `invoke("job_cancel", {id})`,
  `invoke("library_list")` 등 — 전부 비동기, `serde` 직렬화
- **이벤트**: `emit("job-updated")`로 잡 변경 알림 → Svelte store 갱신
- **폴링 제거**: 기존 900ms 폴링 대신 파일 변경 감지(watch) 또는
  command 호출 시점 갱신 (초기에는 폴링 유지해도 무방)
- 단일 인스턴스 가드: `CreateMutexW` 로직 그대로 유지

## 6. 디자인 시스템 이식

- `tokens.css` (이미 CSS 변수) → Svelte 전역 스타일에 `:root` 주입
- 폰트: `Segoe UI Variable Text, Segoe UI, Malgun Gothic, sans-serif`
- 라이트 테마 단일 유지
- 컴포넌트: `components/components.json` 기준으로 Svelte 컴포넌트 재구현
- 아이콘: 현재 `icons.rs` 벡터 드로잉 → SVG 파일/인라인 컴포넌트로

## 7. 마이그레이션 단계

```
Phase 1 — 뼈대
  - companion-tauri 프로젝트 생성 (Tauri 2 + Svelte 5 + TS)
  - tokens.css 주입, 라우트 5개 빈 셸
  - 단일 인스턴스 가드, 최소 window 설정

Phase 2 — 백엔드 command
  - jobs/library/license command 노출 (Rust 코드 이식)
  - 프론트 invoke 래퍼 + Svelte store

Phase 3 — 핵심 화면
  - Queue (잡 목록/필터/검색/취소/재개/일시)
  - Library (타일/폴더/DnD/별점/삭제/자동 조직)
  - Settings

Phase 4 — 재생 (보조)
  - <video> + 커스텀 시크바(라인)/컨트롤/PiP(hover 오버레이)
  - 자막(SRT/VTT) 표시
  - 외부 플레이어 열기 fallback
  - TS→MP4 리먹스 command

Phase 5 — 자막 화면
  - 자막 추출/번역/동기화 UI (command 연동)

Phase 6 — 정리
  - companion-gui 삭제, README/docs 갱신, 동안 regressions 확인
```

### Phase 4 (재생) 상세 — 이전 시 제거되는 것

- `player_backend.rs`의 mpv spawn/파이프/Win32 HWND 코드 모두 제거
- `PlayerSnapshot` 폴링 대신 `<video>` 이벤트 사용
- `@aura-range` 컬러레인지 보정은 CSS 필터로 대체 (필요 시)

## 8. 리스크와 결정 사항

| 항목 | 결정/리스크 |
|---|---|
| mpv 고급 기능 | 프레임 스텝/컬러레인지 등 포기 (재생 보조 목적) |
| ASS 자막 | SRT/VTT 우선. ASS 필요 시 jassub(WASM)을 후속 작업으로 |
| HEVC/고급 코덱 | `<video>`로 안 되면 "외부 플레이어 열기" fallback |
| TS 시크 불안 | 저장 시 mp4 리먹스(`-c copy`)로 해결 |
| 설치 용량 | egui ~5MB → Tauri ~15MB (ffmpeg 제외) — 허용 범위 |
| WebView2 의존 | Windows 10/11 대부분 내장. 구형 OS면 설치 안내 |
| 다운로드 폴더 권한 | 기존 `downloadFolder` 검증 로직 그대로 command로 |

## 9. 검증 기준

- `cargo test` (companion-tauri) — 기존 jobs/library/license 테스트 이식
- `npm run build` (Svelte) — 타입 체크 + 빌드
- 수동 QA:
  1. 잡 다운로드 → 목록 갱신/취소/재개
  2. 보관함 드래그 이동/별점/폴더 조직
  3. mp4 재생 + 시크바 드래그 + PiP 호버 오버레이
  4. TS 파일 → 리먹스 후 재생 + 외부 플레이어 fallback
  5. SRT 자막 표시

## 10. 참고

- 기존: `companion-gui/README.md` (현 동작, IPC 없음/폴링)
- 디자인: `design-system/README.md`, `design-system/tokens/tokens.css`
- 제품 방향: `PRODUCT_DIRECTION.md` (Companion이 UI 소유 — 이전해도 일치)
- 재생 백엔드 상세: `companion-gui/src/player_backend.rs`