export const VIEW_IDS = ["queue", "library", "player", "subtitles", "settings"] as const;
export type ViewId = (typeof VIEW_IDS)[number];
export interface ShellView { id: ViewId; label: string; title: string; summary: string; }
export const SHELL_VIEWS: readonly ShellView[] = [
  { id: "queue", label: "다운로드", title: "다운로드", summary: "진행 중인 작업과 완료된 다운로드를 확인합니다." },
  { id: "library", label: "보관함", title: "보관함", summary: "저장된 미디어를 검색하고 정리합니다." },
  { id: "player", label: "재생", title: "재생", summary: "선택한 로컬 미디어를 재생합니다." },
  { id: "subtitles", label: "자막", title: "자막", summary: "자막 생성과 가져오기 작업을 관리합니다." },
  { id: "settings", label: "설정", title: "설정", summary: "저장 폴더와 Companion 라이선스를 관리합니다." },
];
export function viewById(id: ViewId): ShellView {
  const view = SHELL_VIEWS.find((item) => item.id === id);
  if (!view) throw new Error(`Unknown shell view: ${id}`);
  return view;
}
