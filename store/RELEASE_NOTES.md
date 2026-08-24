# Chromium store release notes template

> [!WARNING]
> Legacy extension-primary release template. Replace it with version-specific
> Companion-first connector notes after implementation and live verification.

## Version

`[OWNER INPUT: VERSION]` · `[OWNER INPUT: RELEASE_DATE]`

## English

- Added or improved compatible media detection and local download queue behavior.
- Enforced the free edition limits: one concurrent media job, 1 GiB per download, and YouTube downloads capped at 1080p.
- Pro benefits remain visible in the product UI and listing: no concurrent-job limit, no artificial byte cap, and uncapped quality.
- Removed subtitle extraction, translation, and remuxing.
- Added the optional Aura Media Companion path for persistent Windows jobs, local YouTube execution, and native saving to `Downloads\\Aura Media`; browser saving remains as a fallback when the Companion is unavailable.
- Fixed an incorrect Pro pause when the browser window loses focus, and added a Companion installation-guide link that appears only when the native host is unavailable.
- Connected the missing-host guide directly to the verified official Companion page at `aura.mdownloader.workers.dev/download`.

## 한국어

- 호환 가능한 미디어 감지와 로컬 다운로드 대기열 동작을 개선했습니다.
- 무료 버전 제한을 적용했습니다: 미디어 작업 1개 동시 실행, 다운로드 1건당 1GiB, YouTube는 1080p까지, 탭 이동 시 다운로드 일시중지.
- Pro 혜택을 제품 UI와 등록 문안에 표시합니다: 동시 작업 제한 없음, 인위적인 용량 제한 없음, 화질 제한 없음.
- 자막 추출·번역·병합 기능을 제거했습니다.
- Windows에서 Aura Media Companion을 선택적으로 사용해 지속형 다운로드 작업, 로컬 YouTube 처리, `Downloads\\Aura Media` 네이티브 저장을 지원하며, Companion이 없을 때는 기존 브라우저 저장 경로를 사용합니다.
- 브라우저 창이 포커스를 잃을 때 Pro 다운로드가 잘못 일시정지되던 문제를 수정했고, 네이티브 호스트가 없을 때만 Companion 설치 안내 링크를 표시합니다.
- 네이티브 호스트가 없을 때 표시되는 안내를 검증된 공식 Companion 페이지 `aura.mdownloader.workers.dev/download`에 연결했습니다.

## Compliance note

This release does not claim DRM bypass, universal compatibility, or authorization to download third-party copyrighted media. Users must provide their own lawful authorization.
