<script lang="ts">
  import { get } from "svelte/store";
  import { onMount } from "svelte";
  import type { ShellView } from "../views";
  import { jobsState, loadJobs, removeHistory, runJobAction } from "../stores/jobs";
  import { canRemoveHistory, pendingActionLabel } from "../queue-policy";
  import { playerState } from "../stores/player";
  import {
    generateSubtitleFor,
    importSubtitleFor,
    loadSubtitleCapabilities,
    loadSubtitlesFor,
    setSelectedSourceLanguage,
    setSelectedTargetLanguage,
    setSyncOffsetSeconds,
    subtitleState,
    syncSubtitleFor,
  } from "../stores/subtitles";
  import { subtitleFormat } from "../subtitle-parser";

  let { view, onOpenLibrary }: { view: ShellView; onOpenLibrary: () => void } = $props();
  let selectedSubtitleFile = $state("");
  let subtitleJobWasActive = false;
  let subtitleRefreshInFlight = false;
  let selected = $derived($playerState.selection);
  let selectedTrack = $derived($subtitleState.subtitles.find((item) => item.fileName === selectedSubtitleFile) ?? null);
  let subtitleJobs = $derived($jobsState.jobs.filter((job) => job.jobType === "subtitle"));
  let removableSubtitleIds = $derived(subtitleJobs.filter((job) => canRemoveHistory(job) && !$jobsState.busy[job.jobId] && !$jobsState.pending[job.jobId]).map((job) => job.jobId));
  let subtitleHistoryDialog: HTMLDialogElement;
  let subtitleHistoryIds = $state<string[]>([]);

  function confirmSubtitleHistoryRemoval(): void {
    subtitleHistoryIds = [...removableSubtitleIds];
    subtitleHistoryDialog.showModal();
  }

  function removeConfirmedSubtitleHistory(): void {
    subtitleHistoryDialog.close();
    void removeHistory(subtitleHistoryIds);
  }
  let maxOffsetSeconds = $derived($subtitleState.capabilities?.maxOffsetSeconds ?? 24 * 60 * 60);
  let canSync = $derived(Boolean(selected && selectedTrack && subtitleFormat(selectedTrack.fileName, selectedTrack.format) !== "ass"));

  async function refreshSubtitleSurface(): Promise<void> {
    if (subtitleRefreshInFlight) return;
    subtitleRefreshInFlight = true;
    try {
      await loadJobs(true);
      const current = get(playerState).selection;
      const active = get(jobsState).jobs.some((job) => job.jobType === "subtitle" && job.active);
      // Keep the completed transition visible: the first poll after an active
      // job ends must rediscover the newly saved sidecar exactly once.
      if (current && (active || subtitleJobWasActive)) {
        await loadSubtitlesFor(current.folder, current.entry.fileName, true);
      }
      subtitleJobWasActive = active;
    } finally {
      subtitleRefreshInFlight = false;
    }
  }

  onMount(() => {
    void refreshSubtitleSurface();
    void loadSubtitleCapabilities();
    const timer = window.setInterval(() => { void refreshSubtitleSurface(); }, 5_000);
    return () => window.clearInterval(timer);
  });

  $effect(() => {
    const current = $playerState.selection;
    if (!current) {
      selectedSubtitleFile = "";
      return;
    }
    void loadSubtitlesFor(current.folder, current.entry.fileName);
  });

  $effect(() => {
    const tracks = $subtitleState.subtitles;
    if (!tracks.some((track) => track.fileName === selectedSubtitleFile)) selectedSubtitleFile = tracks[0]?.fileName ?? "";
  });

  function currentFile(): string | null { return selected?.entry.fileName ?? null; }
  function currentFolder(): string | null { return selected?.folder ?? null; }
  function refresh(): void {
    const fileName = currentFile();
    if (fileName) void loadSubtitlesFor(currentFolder(), fileName, true);
  }
  function refreshCapabilities(): void { void loadSubtitleCapabilities(true); }
  function isPending(action: "generate" | "import" | "sync"): boolean { return $subtitleState.pendingAction === action; }
  function actionLabel(action: string): string { return ({ cancel: "취소", pause: "일시정지", resume: "재개", retry: "같은 설정으로 다시 생성" } as Record<string, string>)[action] ?? action; }

  function generate(): void {
    if (!selected || !$subtitleState.selectedSourceLanguage || !$subtitleState.selectedTargetLanguage) return;
    subtitleJobWasActive = true;
    void generateSubtitleFor({
      folder: selected.folder,
      fileName: selected.entry.fileName,
      sourceLanguage: $subtitleState.selectedSourceLanguage,
      targetLanguage: $subtitleState.selectedTargetLanguage,
    });
  }

  function importSelected(): void {
    if (!selected) return;
    void importSubtitleFor({ folder: selected.folder, fileName: selected.entry.fileName });
  }

  function syncSelected(): void {
    if (!selected || !selectedTrack) return;
    void syncSubtitleFor({
      folder: selected.folder,
      fileName: selected.entry.fileName,
      subtitleFileName: selectedTrack.fileName,
      offsetSeconds: $subtitleState.syncOffsetSeconds,
    });
  }
</script>

<svelte:head><title>{view.title} · Segma Player</title></svelte:head>
<section class="view subtitles-view" aria-labelledby="subtitles-title">
  <header class="view-header">
    <div>
      <h1 id="subtitles-title" class="view-title">{view.title}</h1>
      <p class="view-summary">선택한 미디어의 사이드카 자막</p>
    </div>
    <div class="header-actions">
      {#if selected}<button class="button secondary" type="button" onclick={refresh} disabled={$subtitleState.loading}>새로 고침</button>{/if}
      <button class="button primary" type="button" onclick={onOpenLibrary}>보관함에서 선택</button>
    </div>
  </header>

  {#if !selected}
    <div class="empty">
      <strong>미디어가 선택되지 않았습니다.</strong>
      <span>보관함에서 미디어를 선택하면 자막을 관리할 수 있습니다.</span>
      <button class="button primary" type="button" onclick={onOpenLibrary}>보관함 열기</button>
    </div>
  {:else}
    <section class="subtitle-manager" aria-labelledby="selected-media-title">
      <div class="selected-media-heading">
        <div>
          <span class="eyebrow"><span class="type-chip">{selected.entry.typeLabel}</span><span class="file-meta">{selected.folder ? `${selected.folder} / ` : ""}{selected.entry.fileName}</span></span>
          <h2 id="selected-media-title">{selected.entry.title}</h2>
        </div>
        <span class="subtitle-count">{$subtitleState.loading ? "확인 중…" : `${$subtitleState.subtitles.length}개`}</span>
      </div>

      {#if $subtitleState.error}<div class="notice error" role="alert">{$subtitleState.error}<button class="text-button" type="button" onclick={refresh}>다시 시도</button></div>{/if}
      {#if $subtitleState.notice}<div class="notice success" role="status">{$subtitleState.notice}</div>{/if}

      <section class="subtitle-actions" aria-labelledby="subtitle-actions-title">
        <div class="panel-heading">
          <div>
            <h3 id="subtitle-actions-title">자막 작업</h3>
            <p>생성, 가져오기, 동기화</p>
          </div>
          {#if $subtitleState.capabilitiesLoading}<span class="status-chip tone-neutral" role="status">기능 확인 중…</span>{:else if $subtitleState.capabilities}<span class="status-chip tone-success">지원 기능 확인됨</span>{/if}
        </div>
        {#if $subtitleState.capabilities}
          <div class="subtitle-action-grid">
            <label>
              <span>원본 언어</span>
              <select value={$subtitleState.selectedSourceLanguage} onchange={(event) => setSelectedSourceLanguage((event.currentTarget as HTMLSelectElement).value)} disabled={Boolean($subtitleState.pendingAction)}>
                {#each $subtitleState.capabilities.sourceLanguages as language}<option value={language.code}>{language.label}</option>{/each}
              </select>
            </label>
            <label>
              <span>대상 언어</span>
              <select value={$subtitleState.selectedTargetLanguage} onchange={(event) => setSelectedTargetLanguage((event.currentTarget as HTMLSelectElement).value)} disabled={Boolean($subtitleState.pendingAction)}>
                {#each $subtitleState.capabilities.targetLanguages as language}<option value={language.code}>{language.label}</option>{/each}
              </select>
            </label>
            <button class="button primary" type="button" onclick={generate} disabled={Boolean($subtitleState.pendingAction) || !$subtitleState.selectedSourceLanguage || !$subtitleState.selectedTargetLanguage}>{isPending("generate") ? "생성 요청 중…" : "자막 생성"}</button>
            <button class="button secondary" type="button" onclick={importSelected} disabled={Boolean($subtitleState.pendingAction)}>{isPending("import") ? "가져오는 중…" : "자막 가져오기"}</button>
          </div>
          <div class="subtitle-sync-row">
            <label>
              <span>동기화할 사이드카</span>
              <select value={selectedSubtitleFile} onchange={(event) => (selectedSubtitleFile = (event.currentTarget as HTMLSelectElement).value)} disabled={Boolean($subtitleState.pendingAction) || $subtitleState.subtitles.length === 0}>
                {#each $subtitleState.subtitles as track}<option value={track.fileName}>{track.title} · {track.format.toUpperCase()}</option>{/each}
              </select>
            </label>
            <label>
              <span>오프셋 (초)</span>
              <input type="number" value={$subtitleState.syncOffsetSeconds} min={-maxOffsetSeconds} max={maxOffsetSeconds} step="0.1" inputmode="decimal" oninput={(event) => setSyncOffsetSeconds(Number((event.currentTarget as HTMLInputElement).value))} disabled={Boolean($subtitleState.pendingAction) || !selectedTrack} />
            </label>
            <button class="button secondary" type="button" onclick={syncSelected} disabled={Boolean($subtitleState.pendingAction) || !canSync}>{isPending("sync") ? "동기화 중…" : "자막 동기화"}</button>
          </div>
          <p class="subtitle-capability-note">지원 형식: {$subtitleState.capabilities.formats.map((format) => format.toUpperCase()).join(", ")} · 오프셋 범위: ±{maxOffsetSeconds}초 · 자막 생성은 영상의 처음 1시간까지 처리됩니다.</p>
        {:else}<div class="notice error" role="alert">자막 기능을 확인하지 못했습니다.<button class="text-button" type="button" onclick={refreshCapabilities}>다시 확인</button></div>{/if}
      </section>

      {#if $subtitleState.unavailable}<div class="empty compact-empty"><strong>Tauri Companion 필요</strong><span>브라우저 미리보기에서는 로컬 사이드카를 읽을 수 없습니다. 생성과 가져오기도 Companion에서 실행됩니다.</span></div>
      {:else if $subtitleState.loading}<div class="loading-state" role="status">사이드카를 확인하는 중…</div>
      {:else if $subtitleState.subtitles.length === 0}<div class="empty compact-empty"><strong>사이드카 자막이 없습니다.</strong><span>자막 생성 또는 가져오기 작업으로 이 미디어의 자막을 추가할 수 있습니다.</span></div>
      {:else}<div class="subtitle-manager-grid">
        <div class="subtitle-list" aria-label="사이드카 자막 목록">
          {#each $subtitleState.subtitles as track (track.fileName)}
            {@const format = subtitleFormat(track.fileName, track.format)}
            <button class:active={track.fileName === selectedSubtitleFile} class="subtitle-item" type="button" aria-pressed={track.fileName === selectedSubtitleFile} onclick={() => (selectedSubtitleFile = track.fileName)}>
              <span class="subtitle-item-main"><strong>{track.title}</strong><span>{track.language ?? "언어 정보 없음"}</span></span>
              <span class="type-chip">{format.toUpperCase()}</span>
              <span class:unsupported={format === "ass"} class="subtitle-item-status">{format === "ass" ? "렌더링 미지원" : "사용 가능"}</span>
            </button>
          {/each}
        </div>
        {#if selectedTrack}{@const format = subtitleFormat(selectedTrack.fileName, selectedTrack.format)}<div class="subtitle-preview-panel"><div class="panel-heading"><div><h3>{selectedTrack.title}</h3><p>{format.toUpperCase()} · {selectedTrack.language ?? "언어 정보 없음"}</p></div>{#if format === "ass"}<span class="status-chip tone-warning">렌더링 미지원</span>{:else}<span class="status-chip tone-success">읽기 가능</span>{/if}</div><pre class="subtitle-text">{selectedTrack.text.slice(0, 12000)}</pre>{#if selectedTrack.text.length > 12000}<p class="form-message">표시 용량을 넘는 뒷부분은 생략했습니다.</p>{/if}</div>{/if}
      </div>{/if}
    </section>
  {/if}

  <section class="subtitle-jobs" aria-labelledby="subtitle-jobs-title">
    <div class="panel-heading"><div><h2 id="subtitle-jobs-title">자막 작업 기록</h2></div><div class="header-actions"><button class="button secondary" type="button" onclick={confirmSubtitleHistoryRemoval} disabled={!removableSubtitleIds.length}>기록 정리</button><button class="button quiet" type="button" onclick={() => loadJobs()} disabled={$jobsState.loading || $jobsState.refreshing}>새로 고침</button></div></div>
    {#if $jobsState.error}<div class="notice error" role="alert">{$jobsState.error}</div>{/if}
    {#if $jobsState.notice}<div class="notice success" role="status">{$jobsState.notice}</div>{/if}
    {#if subtitleJobs.length === 0}<p class="empty compact-empty">자막 작업이 없습니다.</p>
    {:else}<div class="job-table subtitle-job-table" role="list" aria-label="자막 작업">{#each subtitleJobs as job (job.jobId)}{@const busy = $jobsState.busy[job.jobId] ?? $jobsState.pending[job.jobId]?.action}{@const running = job.active || job.paused}<div class="job-row" class:job-active={job.active} role="listitem" aria-busy={Boolean(busy)} title={[job.detail, job.statusText].filter(Boolean).join(" · ") || undefined}><span class="job-dot tone-{job.tone}" aria-hidden="true"></span><span class="job-title">{job.title}</span><span class="job-quality">{(job.outputFormat ?? "SUB").toUpperCase()}</span><span class="job-status tone-{job.tone}" role="status">{busy ? pendingActionLabel(busy) : running && job.progress !== null ? `${job.statusLabel} ${job.progress}%` : job.statusLabel}</span><span class="job-size">{job.language ?? ""}</span><span class="job-actions">{#each job.actions.filter((action) => ["cancel", "pause", "resume", "retry"].includes(action)) as action}<button class="icon-button" type="button" disabled={Boolean(busy)} title={actionLabel(action)} aria-label={`${job.title} ${actionLabel(action)}`} onclick={() => runJobAction(job, action)}><span aria-hidden="true">{busy === action ? "…" : ({ cancel: "✕", pause: "❚❚", resume: "▶", retry: "↻" } as Record<string, string>)[action]}</span></button>{/each}{#if canRemoveHistory(job)}<button class="icon-button" type="button" disabled={Boolean($jobsState.busy[job.jobId])} title="기록 삭제" aria-label={`${job.title} 기록 삭제`} onclick={() => removeHistory([job.jobId])}><span aria-hidden="true">{$jobsState.busy[job.jobId] === "remove" ? "…" : "⌫"}</span></button>{/if}</span>{#if running}<span class="job-progress" class:indeterminate={job.active && job.progress === null} role="progressbar" aria-label={`${job.title} 진행률`} aria-valuemin="0" aria-valuemax="100" aria-valuenow={job.progress ?? undefined}><span style={`width: ${job.progress ?? 0}%`}></span></span>{/if}</div>{/each}</div>{/if}
  </section>
</section>

<dialog class="history-dialog" bind:this={subtitleHistoryDialog} aria-labelledby="subtitle-history-title" aria-describedby="subtitle-history-description">
  <h2 id="subtitle-history-title">자막 작업 기록 {subtitleHistoryIds.length}개를 삭제할까요?</h2>
  <p id="subtitle-history-description">완료·실패·취소된 자막 작업 기록만 삭제됩니다. 생성된 자막 파일은 그대로 유지됩니다.</p>
  <div class="modal-actions"><button class="button secondary" type="button" onclick={() => subtitleHistoryDialog.close()}>돌아가기</button><button class="button danger" type="button" onclick={removeConfirmedSubtitleHistory}>기록 삭제</button></div>
</dialog>
