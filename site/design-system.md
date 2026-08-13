# Aura Media — 사이트 디자인 시스템

`site/styles.css`에서 추출한 현재 구현 기준 토큰입니다. 새 UI/콘텐츠를 추가할 때는 이 표준을 따릅니다.

## 색 (Color)

| 토큰 | 값 | 용도 |
| --- | --- | --- |
| `--bg` | `#ffffff` | 페이지 배경 |
| `--panel` | `#f7f9fd` | 카드/보조 배경 |
| `--panel-2` | `#eef2f9` | 중첩 보조 배경 |
| `--text` | `#0d1420` | 본문 |
| `--muted` | `#5b6675` | 보조 텍스트 |
| `--line` | `rgba(13,24,43,.12)` | 구분선/보더 |
| `--blue` | `#1f6bff` | 포인트/링크/액션 |
| `--blue-strong` | `#0f5ef0` | 호버/강조 |
| `--violet` | `#6d5cff` | 보조 포인트 |
| `--ink` | `#0d121c` | 다크 카드/헤더 버튼 배경 |

## 타이포 (Type scale)

본문 폰트: `Pretendard / Noto Sans KR / Segoe UI / Malgun Gothic`, 16px 기준.

| 역할 | 크기 (clamp) | 모바일 | 비고 |
| --- | --- | --- | --- |
| Hero H1 | `44–72px` (5.2vw) | `36–50px` | `letter-spacing -.05em`, `line-height 1.04` |
| 섹션 H2 | `34–58px` (4.4vw) | `34px` | `line-height 1.08` |
| Final CTA H2 | `40–78px` (5.4vw) | `34px` | 최종 액션 강조 |
| 카드 H3 | `28–48px` (3.2vw) | 동일 | 플랜 카드 제목 |
| 피처 H3 | `23–36px` (2.4vw) | 동일 | 기능 카드 제목 |
| 스텝 H3 | `25–38px` (2.4vw) | 동일 | 워크플로 목록 |
| 라벨/키커 | `11–12px`, 800, `.16–.22em` | 동일 | 섹션 인덱스·배지 |
| 본문 | `16–17px`, `line-height 1.78` | 동일 | 법률/안내 페이지 |

원칙:
- 최대 표시 크기는 Hero 72px, 섹션 58px을 넘지 않는다 (과도한 헤더 금지).
- 위계는 크기 → 굵기(800/700) → 라벨(키커) 순으로 표현하고, 장식 요소로 위계를 대체하지 않는다.
- 긴 문장은 `word-break: keep-all`, `line-height ≥ 1.04`를 유지한다.

## 간격·모양 (Spacing & shape)

- 섹션 패딩: `clamp(110px, 13vw, 200px)` (모바일 100px)
- 콘텐츠 최대 폭: `--max: 1320px`, 섹션 양쪽 여백 32px(데스크톱 64px)
- 카드 반경: 26px / 버튼·배지: 999px / 입력·소형 요소: 8–9px
- 버튼 최소 높이: 52px (터치 44px 이상)
- 그림자: `0 8px 30px rgba(15,30,60,.06)` (스크롤 시 `.12`)

## 향후 Figma 동기화

이 문서의 토큰을 Figma Variables(색·간격)와 Text Styles(타이포)로 매핑한다. 동기화 대상 Figma 파일이 정해지면 `figma-generate-library` 워크플로로 반영한다.
