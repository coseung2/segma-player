<script lang="ts">
  import { onMount } from "svelte";
  import type { CloudItemDto, CloudJobDto, LibraryEntryDto } from "../api";
  import type { ShellView } from "../views";
  import { libraryState, editMetadata, loadLibrary, moveFile, openFolder, organize, recycleFile, revealFile } from "../stores/library";
  import { failThumbnail, requestThumbnail, resetThumbnails, thumbnailState } from "../stores/thumbnails";
  import { mediaIdentity, normalizeFolder } from "../selection-identity";
  import { selectMedia } from "../stores/player";
  import {
    cancelCloudTransfer, cloudState, deleteCloudItem, downloadCloudItem,
    isCloudJobActive, isCloudJobCancellable, loadCloud, startCloudPolling,
    stopCloudPolling, uploadCloudItem,
  } from "../stores/cloud";

  let { view, onOpenPlayer }: { view: ShellView; onOpenPlayer: () => void } = $props();
  let query = $state("");
  let filter = $state<"all" | "favorite" | "unwatched" | "inProgress" | "completed">("all");
  let display = $state<"grid" | "list">("grid");
  let deleteTarget = $state<LibraryEntryDto | null>(null);
  let moveTarget = $state<LibraryEntryDto | null>(null);
  let destination = $state("");
  let libraryTab = $state<"local" | "telegram">("local");
  let cloudDeleteTarget = $state<CloudItemDto | null>(null);
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
  let activeCloudJobs = $derived($cloudState.jobs.filter(isCloudJobActive));
  let recentCloudJobs = $derived($cloudState.jobs.filter((job) => !isCloudJobActive(job)).slice(0, 8));

  $effect(() => {
    if (libraryTab !== "telegram") return;
    startCloudPolling();
    return stopCloudPolling;
  });

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
  function cloudOperationLabel(operation: CloudJobDto["operation"]) {
    return operation === "upload" ? "업로드" : operation === "download" ? "다운로드" : "삭제";
  }
  function cloudStatusLabel(job: CloudJobDto) {
    if (job.status === "completed") return "완료";
    if (job.status === "failed") return "실패";
    if (job.status === "cancelled") return "취소됨";
    if (job.status === "running") return "진행 중";
    return "대기 중";
  }
  function cloudTone(job: CloudJobDto) {
    if (job.status === "completed") return "success";
    if (job.status === "failed") return "danger";
    if (job.status === "cancelled") return "warning";
    return "neutral";
  }
  function cloudPhase(job: CloudJobDto) {
    const phases: Record<string, string> = { queued: "작업 대기 중", uploading: "업로드 중", downloading: "다운로드 중", deleting: "삭제 중", finalizing: "마무리 중" };
    return (job.phase && phases[job.phase]) || "작업 진행 중";
  }
  function cloudSize(value: number) {
    if (value < 1024) return `${value} B`;
    if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
    if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
    return `${(value / 1024 ** 3).toFixed(1)} GB`;
  }
  function cloudDate(value: number) { return value ? new Date(value).toLocaleString("ko-KR", { dateStyle: "short", timeStyle: "short" }) : "시간 정보 없음"; }
  function cloudProgress(job: CloudJobDto) { return Math.max(0, Math.min(100, job.progress ?? (isCloudJobActive(job) ? 0 : 100))); }
</script>

<svelte:head><title>{view.title} · Segma Player</title></svelte:head>
<section class="view" aria-labelledby="library-title">
  <header class="view-header"><div><h1 id="library-title" class="view-title">{view.title}</h1><p class="view-summary">{view.summary}</p></div>{#if libraryTab === "local"}<div class="header-actions"><button class="button secondary" type="button" onclick={() => openFolder()} disabled={$libraryState.action === "open-folder"}>폴더 열기</button><button class="button primary" type="button" onclick={() => organize(false)} disabled={$libraryState.action?.startsWith("organize:")}>자동 정리 미리보기</button></div>{:else}<div class="header-actions"><button class="button primary" type="button" onclick={() => uploadCloudItem()} disabled={!$cloudState.status?.telegramConfigured || !$cloudState.status?.executableAvailable || $cloudState.action !== null}>{$cloudState.action === "upload" ? "파일 선택 중…" : "업로드"}</button></div>{/if}</header>

  <div class="content-tabs" role="tablist" aria-label="보관함 위치">
    <button class:active={libraryTab === "local"} type="button" role="tab" aria-selected={libraryTab === "local"} aria-controls="local-library-panel" onclick={() => (libraryTab = "local")}>로컬</button>
    <button class:active={libraryTab === "telegram"} type="button" role="tab" aria-selected={libraryTab === "telegram"} aria-controls="telegram-library-panel" onclick={() => (libraryTab = "telegram")}>텔레그램</button>
  </div>

  {#if libraryTab === "local"}
  <div id="local-library-panel" role="tabpanel">
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
  </div>
  {:else}
  <div id="telegram-library-panel" class="cloud-library" role="tabpanel">
    {#if $cloudState.error}<div class="notice error" role="alert"><span>{$cloudState.error}</span><button class="text-button" type="button" onclick={() => loadCloud()}>다시 시도</button></div>{/if}
    {#if $cloudState.notice}<div class="notice success" role="status">{$cloudState.notice}</div>{/if}
    {#if $cloudState.loading}<div class="loading-state" role="status">텔레그램 보관함을 불러오는 중…</div>
    {:else}
      <section class="cloud-status-card" aria-labelledby="cloud-status-title">
        <div><div class="eyebrow"><span class="status-dot" class:connected={$cloudState.status?.telegramConfigured && $cloudState.status?.executableAvailable}></span><span class="status-chip" class:tone-success={$cloudState.status?.telegramConfigured && $cloudState.status?.executableAvailable} class:tone-warning={!$cloudState.status?.telegramConfigured || !$cloudState.status?.executableAvailable}>{$cloudState.status?.telegramConfigured && $cloudState.status?.executableAvailable ? "사용 가능" : "설정 필요"}</span></div><h2 id="cloud-status-title">텔레그램 보관함</h2><p>{$cloudState.status?.telegramConfigured ? ($cloudState.status.executableAvailable ? "파일을 올리고 내려받을 준비가 되었습니다." : "텔레그램 전송 기능을 시작할 수 없습니다.") : "텔레그램 저장소 연결을 먼저 설정해 주세요."}</p></div>
        <button class="button secondary" type="button" onclick={() => loadCloud()} disabled={$cloudState.refreshing || $cloudState.action !== null}>{$cloudState.refreshing ? "새로 고치는 중…" : "새로 고침"}</button>
      </section>

      {#if !$cloudState.status?.telegramConfigured}
        <div class="empty cloud-empty"><strong>텔레그램 저장소 설정이 필요합니다.</strong><span>설정을 마친 뒤 이 화면에서 파일을 안전하게 올리고 받을 수 있습니다.</span></div>
      {:else if !$cloudState.status.executableAvailable}
        <div class="empty cloud-empty"><strong>텔레그램 저장소를 사용할 수 없습니다.</strong><span>잠시 후 새로 고침을 눌러 상태를 다시 확인해 주세요.</span></div>
      {:else}
        {#if activeCloudJobs.length}
          <section class="cloud-section" aria-labelledby="active-transfers-title"><div class="cloud-section-heading"><h2 id="active-transfers-title">진행 중인 전송</h2><span>{activeCloudJobs.length}개</span></div><div class="cloud-job-list">{#each activeCloudJobs as job (job.jobId)}<article class="cloud-job-card"><div class="cloud-job-copy"><div class="eyebrow"><span class="type-chip">{cloudOperationLabel(job.operation)}</span><span class={`status-chip tone-${cloudTone(job)}`}>{cloudStatusLabel(job)}</span></div><h3 title={job.fileName ?? "파일"}>{job.fileName ?? "파일"}</h3><p>{cloudPhase(job)}</p></div><span class="cloud-progress-value">{cloudProgress(job)}%</span><div class="progress-track" aria-label={`${job.fileName ?? "파일"} ${cloudProgress(job)}%`} role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow={cloudProgress(job)}><span style={`width: ${cloudProgress(job)}%`}></span></div><div class="cloud-job-footer"><span>{cloudDate(job.updatedAt)}</span>{#if isCloudJobCancellable(job)}<button class="button quiet" type="button" onclick={() => cancelCloudTransfer(job)} disabled={$cloudState.action !== null}>{$cloudState.action === `cancel:${job.jobId}` ? "취소 중…" : "취소"}</button>{/if}</div></article>{/each}</div></section>
        {/if}

        <section class="cloud-section" aria-labelledby="cloud-items-title"><div class="cloud-section-heading"><div><h2 id="cloud-items-title">저장된 파일</h2><p>텔레그램에 보관된 미디어입니다.</p></div><span>{$cloudState.items.length}개</span></div>
          {#if $cloudState.items.length === 0}<div class="empty cloud-empty"><strong>저장된 파일이 없습니다.</strong><span>업로드를 눌러 첫 파일을 보관해 보세요.</span></div>
          {:else}<div class="cloud-item-list">{#each $cloudState.items as item (item.itemId)}<article class="cloud-item-row"><div class="cloud-file-icon" aria-hidden="true">▶</div><div class="cloud-item-copy"><h3 title={item.fileName}>{item.fileName}</h3><p>{cloudSize(item.size)}</p></div><div class="row-actions"><button class="button secondary" type="button" onclick={() => downloadCloudItem(item)} disabled={$cloudState.action !== null}>{$cloudState.action === `download:${item.itemId}` ? "위치 선택 중…" : "다운로드"}</button><button class="button danger-quiet" type="button" onclick={() => (cloudDeleteTarget = item)} disabled={$cloudState.action !== null}>삭제</button></div></article>{/each}</div>{/if}
        </section>

        {#if recentCloudJobs.length}<section class="cloud-section" aria-labelledby="recent-transfers-title"><div class="cloud-section-heading"><h2 id="recent-transfers-title">최근 전송</h2></div><div class="cloud-recent-list">{#each recentCloudJobs as job (job.jobId)}<article class="cloud-recent-row"><div><div class="eyebrow"><span class="type-chip">{cloudOperationLabel(job.operation)}</span><span class={`status-chip tone-${cloudTone(job)}`}>{cloudStatusLabel(job)}</span></div><strong title={job.fileName ?? "파일"}>{job.fileName ?? "파일"}</strong>{#if job.error}<p class="cloud-job-error">{job.error}</p>{/if}</div><time datetime={new Date(job.updatedAt).toISOString()}>{cloudDate(job.updatedAt)}</time></article>{/each}</div></section>{/if}
      {/if}
    {/if}
  </div>
  {/if}
</section>

{#if moveTarget}<dialog open class="modal" aria-labelledby="move-title"><h2 id="move-title">파일 이동</h2><p>{moveTarget.title}</p><label>대상 폴더<select bind:value={destination}><option value="">전체 보관함</option>{#each data.folders as folder}<option value={folder.name}>{folder.name}</option>{/each}</select></label><div class="modal-actions"><button class="button quiet" type="button" onclick={() => (moveTarget = null)}>취소</button><button class="button primary" type="button" onclick={submitMove}>이동</button></div></dialog>{/if}
{#if deleteTarget}<dialog open class="modal" aria-labelledby="delete-title"><h2 id="delete-title">휴지통으로 이동할까요?</h2><p>{deleteTarget.title}을(를) 삭제하면 휴지통에서 복원할 수 있습니다.</p><div class="modal-actions"><button class="button quiet" type="button" onclick={() => (deleteTarget = null)}>취소</button><button class="button danger" type="button" onclick={() => { if (deleteTarget) { const target = deleteTarget; deleteTarget = null; void recycleFile(target); } }}>휴지통으로 이동</button></div></dialog>{/if}
{#if cloudDeleteTarget}<dialog open class="modal" aria-labelledby="cloud-delete-title"><h2 id="cloud-delete-title">텔레그램에서 삭제할까요?</h2><p><strong>{cloudDeleteTarget.fileName}</strong> 파일이 텔레그램 보관함에서 삭제됩니다. 이 작업은 되돌릴 수 없습니다.</p><div class="modal-actions"><button class="button quiet" type="button" onclick={() => (cloudDeleteTarget = null)}>취소</button><button class="button danger" type="button" onclick={() => { if (cloudDeleteTarget) { const target = cloudDeleteTarget; cloudDeleteTarget = null; void deleteCloudItem(target); } }}>영구 삭제</button></div></dialog>{/if}
