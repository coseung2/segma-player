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

```powershell
npx wrangler pages deploy site --project-name aura-media
```

## GitHub Pages

저장소의 `.github/workflows/pages.yml`이 `main`의 `site/**` 변경을 감지해 정적 사이트를 배포합니다. 저장소 Settings → Pages → Source를 `GitHub Actions`로 한 번 설정해야 합니다.

## 공개 전 확인

- Chrome 웹 스토어 항목 공개 상태
- 공식 지원 이메일 또는 문의 폼
- 정식 게시자명 및 사업자 표시 정보
- Aura Media Companion 공식 설치 URL
- 개인정보처리방침과 이용약관 시행일
