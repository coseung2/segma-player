# Aura Media static site

빌드 단계가 없는 정적 사이트입니다. Cloudflare Pages와 GitHub Pages에서 그대로 배포할 수 있습니다.

## 로컬 미리보기

```powershell
npx serve site
```

## Cloudflare Pages

- Framework preset: `None`
- Build command: 비움
- Build output directory: `site`
- Root directory: 저장소 루트

CLI 배포 예시:

최신 Cloudflare Pages 정적 자산 런타임에서는 저장소 루트에서 다음 명령을 사용합니다.

```powershell
npm run deploy
```

## GitHub Pages

`site/` 내용만 담은 `gh-pages` 브랜치가 준비되어 있습니다. 현재 저장소는 비공개이며 계정 플랜이 비공개 저장소 Pages를 지원하지 않으므로, 저장소를 공개로 전환하거나 지원 플랜으로 변경한 뒤 Pages 소스를 `gh-pages / (root)`로 지정해야 합니다.

## 공개 전 확인

- Chrome 웹 스토어 항목 공개 상태
- 공식 지원 이메일 또는 문의 폼
- 정식 게시자명 및 사업자 표시 정보
- Aura Media Companion 공식 설치 URL
- 개인정보처리방침과 이용약관 시행일
