<script lang="ts">
  import { onMount } from "svelte";
  import type { LibraryEntryDto } from "../api";
  import type { ShellView } from "../views";
  import { libraryState, editMetadata, loadLibrary, moveFile, openFolder, organize, recycleFile, revealFile } from "../stores/library";
  import { failThumbnail, requestThumbnail, resetThumbnails, thumbnailState } from "../stores/thumbnails";
  import { mediaIdentity, normalizeFolder } from "../selection-identity";
  import { selectMedia } from "../stores/player";

  let { view, onOpenPlayer }: { view: ShellView; onOpenPlayer: () => void } = $props();
  let query = $state("");
  let filter = $state<"all" | "favorite" | "unwatched" | "inProgress" | "completed">("all");
  let display = $state<"grid" | "list">("grid");
  let deleteTarget = $state<LibraryEntryDto | null>(null);
  let moveTarget = $state<LibraryEntryDto | null>(null);
  let destination = $state("");
  let thumbnailObserver: IntersectionObserver | null = null;
  let thumbnailFolder = $state<string | undefined>(undefined);
  const thumbnailNodes = new Map<HTMLElement, { folder: string | null; fileName: string }>();
  const filters = [["all", "전체"], ["favorite", "즐겨찾기"], ["unwatched", "미시청"], ["inProgress", "시청 중"], ["completed", "완료"]] as const;

  onMount(() => {
    void loadLibrary(null);
    if (typeof IntersectionObserver === "undefined") return;
    thumbnailObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const target = entry.target as HTMLElement;
        const identity = thumbnailNodes.get(target);
        if (!identity) continue;
        requestThumbnail(identity.folder, identity.fileName);
        thumbnailObserver?.unobserve(target);
      }
    }, { rootMargin: "0px" });
    for (const node of thumbnailNodes.keys()) thumbnailObserver.observe(node);
    return () => {
      thumbnailObserver?.disconnect();
      thumbnailObserver = null;
      thumbnailNodes.clear();
      resetThumbnails();
    };
  });
  let data = $derived($libraryState.data);
  let visibleEntries = $derived.by(() => data.entries.filter((entry) => {
    const text = `${entry.title} ${entry.fileName}`.toLocaleLowerCase();
    const matchesQuery = !query.trim() || text.includes(query.trim().toLocaleLowerCase());
    const state = entry.metadata.watchState;
    const matchesFilter = filter === "all" || (filter === "favorite" && entry.metadata.favorite) || state === filter;
    return matchesQuery && matchesFilter;
  }));

  $effect(() => {
    const nextFolder = normalizeFolder(data.folder) ?? "";
    if (nextFolder === thumbnailFolder) return;
    thumbnailFolder = nextFolder;
    resetThumbnails();
  });

  function observeThumbnail(node: HTMLElement, value: { folder: string | null; fileName: string }) {
    let current = value;
    thumbnailNodes.set(node, current);
    if (thumbnailObserver) thumbnailObserver.observe(node);
    return {
      update(next: { folder: string | null; fileName: string }) {
        if (mediaIdentity(current.folder, current.fileName) === mediaIdentity(next.folder, next.fileName)) return;
        thumbnailObserver?.unobserve(node);
        current = next;
        thumbnailNodes.set(node, current);
        thumbnailObserver?.observe(node);
      },
      destroy() {
        thumbnailObserver?.unobserve(node);
        thumbnailNodes.delete(node);
      },
    };
  }

  function selectFolder(folder: string | null) { void loadLibrary(folder); }
  function folderLabel(folder: string | null) { return folder ?? "전체 보관함"; }
  function formatDate(value: number) { return value ? new Date(value).toLocaleDateString("ko-KR") : "날짜 없음"; }
  function toggleFavorite(entry: LibraryEntryDto) { void editMetadata({ folder: data.folder, fileName: entry.fileName, favorite: !entry.metadata.favorite }); }
  function setRating(entry: LibraryEntryDto, rating: number) { void editMetadata({ folder: data.folder, fileName: entry.fileName, rating }); }
  function startMove(entry: LibraryEntryDto) { moveTarget = entry; destination = ""; }
  function submitMove() { if (moveTarget) { const target = moveTarget; moveTarget = null; void moveFile(target, destination || null); } }
  function dragStart(event: DragEvent, entry: LibraryEntryDto) { event.dataTransfer?.setData("text/plain", entry.fileName); if (event.dataTransfer) event.dataTransfer.effectAllowed = "move"; }
  function dropOnFolder(event: DragEvent, folder: string | null) { event.preventDefault(); const fileName = event.dataTransfer?.getData("text/plain"); const entry = data.entries.find((item) => item.fileName === fileName); if (entry) void moveFile(entry, folder); }
  function openPlayer(entry: LibraryEntryDto) { selectMedia(entry, data.folder, data.entries); onOpenPlayer(); }
</script>

<svelte:head><title>{view.title} · Segma Player</title></svelte:head>
<section class="view" aria-labelledby="library-title">
  <header class="view-header"><div><h1 id="library-title" class="view-title">{view.title}</h1><p class="view-summary">{view.summary}</p></div><div class="header-actions"><button class="button secondary" type="button" onclick={() => openFolder()} disabled={$libraryState.action === "open-folder"}>폴더 열기</button><button class="button primary" type="button" onclick={() => organize(false)} disabled={$libraryState.action?.startsWith("organize:")}>자동 정리 미리보기</button></div></header>

  <div class="folder-strip" aria-label="보관함 폴더"><button class:active={data.folder === null} class="folder-button" type="button" onclick={() => selectFolder(null)}>전체 보관함 <span>{data.entries.length}</span></button>{#each data.folders as folder}<button class:active={data.folder === folder.name} class="folder-button" type="button" ondragover={(event) => event.preventDefault()} ondrop={(event) => dropOnFolder(event, folder.name)} onclick={() => selectFolder(folder.name)}>{folder.name} <span>{folder.mediaCount}</span></button>{/each}</div>
  <div class="toolbar library-toolbar"><div class="segmented-control" role="tablist" aria-label="보관함 필터">{#each filters as [value, label]}<button class:active={filter === value} type="button" role="tab" aria-selected={filter === value} onclick={() => (filter = value)}>{label}</button>{/each}</div><label class="search-field"><span class="sr-only">보관함 검색</span><input bind:value={query} type="search" placeholder="제목 또는 파일명 검색" /></label><div class="segmented-control compact" aria-label="표시 방식"><button class:active={display === "grid"} type="button" onclick={() => (display = "grid")}>그리드</button><button class:active={display === "list"} type="button" onclick={() => (display = "list")}>목록</button></div></div>
  {#if $libraryState.error}<div class="notice error" role="alert">{$libraryState.error}<button class="text-button" type="button" onclick={() => loadLibrary(data.folder)}>다시 시도</button></div>{/if}
  {#if $libraryState.notice}<div class="notice success" role="status">{$libraryState.notice}</div>{/if}
  {#if $libraryState.loading}<div class="loading-state" role="status">보관함을 불러오는 중…</div>
  {:else if visibleEntries.length === 0}<div class="empty"><strong>{query || filter !== "all" ? "조건에 맞는 미디어가 없습니다." : "보관함이 비어 있습니다."}</strong><span>{query || filter !== "all" ? "검색어나 필터를 확인해 주세요." : "다운로드한 미디어가 이곳에 표시됩니다."}</span></div>
  {:else}<div class:media-list={display === "list"} class="media-grid">{#each visibleEntries as entry (mediaIdentity(data.folder, entry.fileName))}
    {@const thumbnailKey = mediaIdentity(data.folder, entry.fileName)}
    {@const thumbnail = $thumbnailState.get(thumbnailKey)}
    <article class="media-tile" draggable="true" ondragstart={(event) => dragStart(event, entry)}>
    <button class="media-thumb" use:observeThumbnail={{ folder: data.folder, fileName: entry.fileName }} type="button" aria-label={`${entry.title} 재생`} onclick={() => openPlayer(entry)}>
      {#if thumbnail?.status === "ready" && thumbnail.url}<img class="media-thumb-image" src={thumbnail.url} alt="" onerror={(event) => failThumbnail(thumbnailKey, (event.currentTarget as HTMLImageElement).src)} />{:else}<span>{entry.typeLabel}</span><strong>{entry.title.slice(0, 1).toUpperCase()}</strong>{/if}
      {#if thumbnail?.status === "loading"}<span class="media-thumb-status" aria-hidden="true">불러오는 중</span>{/if}
    </button>
    <div class="media-copy"><div class="media-title-row"><h2 title={entry.title}>{entry.title}</h2><button class:favorite={entry.metadata.favorite} class="icon-button" type="button" aria-label={entry.metadata.favorite ? "즐겨찾기 해제" : "즐겨찾기 추가"} aria-pressed={entry.metadata.favorite} onclick={() => toggleFavorite(entry)}>★</button></div><p>{entry.size ?? "크기 없음"} · {formatDate(entry.modifiedAt)}</p><div class="rating" aria-label={`별점 ${entry.metadata.rating}점`}>{#each [1, 2, 3, 4, 5] as rating}<button class:filled={rating <= entry.metadata.rating} type="button" aria-label={`${rating}점으로 평가`} onclick={() => setRating(entry, rating)}>★</button>{/each}</div></div>
    <div class="media-actions"><button class="button primary" type="button" onclick={() => openPlayer(entry)}>재생</button><button class="button quiet" type="button" onclick={() => revealFile(entry)}>위치 보기</button><button class="button quiet" type="button" onclick={() => startMove(entry)}>이동</button><button class="button danger-quiet" type="button" onclick={() => (deleteTarget = entry)}>삭제</button></div>
  </article>{/each}</div>{/if}

  {#if $libraryState.organization}<section class="organization-panel" aria-labelledby="organization-title"><div class="panel-heading"><div><h2 id="organization-title">자동 정리 계획</h2><p>{$libraryState.organization.items.length ? `이동 예정 ${$libraryState.organization.items.length}개` : "정리할 파일이 없습니다."}</p></div>{#if !$libraryState.organization.applied && $libraryState.organization.items.length}<button class="button primary" type="button" onclick={() => organize(true)}>적용</button>{/if}</div>{#if $libraryState.organization.items.length}<ul>{#each $libraryState.organization.items as item}<li><span>{item.source.folder ? `${item.source.folder}/` : ""}{item.source.fileName}</span><span aria-hidden="true">→</span><span>{item.destination.folder ? `${item.destination.folder}/` : ""}{item.destination.fileName}</span></li>{/each}</ul>{/if}</section>{/if}
</section>

{#if moveTarget}<dialog open class="modal" aria-labelledby="move-title"><h2 id="move-title">파일 이동</h2><p>{moveTarget.title}</p><label>대상 폴더<select bind:value={destination}><option value="">전체 보관함</option>{#each data.folders as folder}<option value={folder.name}>{folder.name}</option>{/each}</select></label><div class="modal-actions"><button class="button quiet" type="button" onclick={() => (moveTarget = null)}>취소</button><button class="button primary" type="button" onclick={submitMove}>이동</button></div></dialog>{/if}
{#if deleteTarget}<dialog open class="modal" aria-labelledby="delete-title"><h2 id="delete-title">휴지통으로 이동할까요?</h2><p>{deleteTarget.title}을(를) 삭제하면 휴지통에서 복원할 수 있습니다.</p><div class="modal-actions"><button class="button quiet" type="button" onclick={() => (deleteTarget = null)}>취소</button><button class="button danger" type="button" onclick={() => { if (deleteTarget) { const target = deleteTarget; deleteTarget = null; void recycleFile(target); } }}>휴지통으로 이동</button></div></dialog>{/if}
