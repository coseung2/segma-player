<script lang="ts">
  import { onMount } from "svelte";
  import type { ShellView } from "../views";
  import { isQueueActionSupported, jobsState, loadJobs, queueActionReason, runJobAction, startJobsPolling, removeHistory } from "../stores/jobs";
  import { canRemoveHistory, jobQuality, jobRowTitle, matchesQueueFilter, pendingActionLabel, type QueueFilter } from "../queue-policy";

  let { view, onOpenPlayer }: { view: ShellView; onOpenPlayer: () => void } = $props();
  let query = $state("");
  let filter = $state<QueueFilter>("all");
  let historyDialog: HTMLDialogElement;
  let historyIds = $state<string[]>([]);
  const filters = [
    ["all", "전체"], ["active", "진행 중"], ["paused", "일시정지"], ["complete", "완료"], ["failed", "실패"], ["cancelled", "취소됨"],
  ] as const;

  onMount(() => {
    void loadJobs();
    return startJobsPolling();
  });

  let mediaJobs = $derived($jobsState.jobs.filter((job) => job.jobType === "media"));
  let activeCount = $derived(mediaJobs.filter((job) => job.active).length);
  let visibleJobs = $derived.by(() => mediaJobs.filter((job) => {
    const text = `${job.title} ${job.fileName ?? ""} ${job.statusLabel}`.toLocaleLowerCase();
    const matchesQuery = !query.trim() || text.includes(query.trim().toLocaleLowerCase());
    return matchesQuery && matchesQueueFilter(job, filter);
  }));
  let removableIds = $derived(visibleJobs.filter((job) => canRemoveHistory(job) && !$jobsState.busy[job.jobId] && !$jobsState.pending[job.jobId]).map((job) => job.jobId));

  function confirmHistoryRemoval(): void {
    historyIds = [...removableIds];
    historyDialog.showModal();
  }

  function removeConfirmedHistory(): void {
    historyDialog.close();
    void removeHistory(historyIds);
  }

  function formatDate(timestamp: number): string {
    return new Intl.DateTimeFormat("ko-KR", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(timestamp);
  }

  // Short time for the row: "21:54" today, "10/2" otherwise; the full date is the tooltip.
  function formatRowTime(timestamp: number): string {
    const date = new Date(timestamp);
    const now = new Date();
    if (date.toDateString() === now.toDateString()) {
      return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
    }
    return `${date.getMonth() + 1}/${date.getDate()}`;
  }

  // Hide meaningless "0 B / …" for jobs that never transferred anything.
  function rowSize(job: (typeof mediaJobs)[number]): string {
    if (!job.transfer) return "";
    if (!job.completed && !job.active && !job.paused) return "";
    return job.transfer;
  }

  function actionLabel(action: string, missingOutput = false): string {
    if (action === "retry" && missingOutput) return "다시 받기";
    return ({ pause: "일시정지", resume: "재개", retry: "다시 시도", cancel: "취소", play: "재생", openFolder: "폴더 열기" } as Record<string, string>)[action] ?? action;
  }

  function disabledActionReason(action: string): string | null {
    return isQueueActionSupported(action) ? null : queueActionReason(action);
  }

  // Compact status text for the one-line row; full status stays in the tooltip.
  function rowStatus(job: (typeof mediaJobs)[number], pendingAction: string | undefined): string {
    if (pendingAction) return pendingActionLabel(pendingAction);
    if ((job.active || job.paused) && job.progress !== null) return `${job.statusLabel} ${job.progress}%`;
    return job.statusLabel;
  }

  function rowNote(job: (typeof mediaJobs)[number]): string {
    const notes = [job.detail && job.detail !== job.title ? job.detail : "", job.statusText && job.statusText !== job.detail ? job.statusText : ""];
    if (!job.active && !job.paused && !job.actions.includes("retry") && (job.status === "failed" || job.statusLabel === "파일 없음")) {
      notes.push("브라우저에서 영상을 다시 열어 다운로드를 시작할 수 있습니다.");
    }
    notes.push(...job.actions.map((action) => disabledActionReason(action) ?? ""));
    return [...new Set(notes.filter(Boolean))].join(" · ");
  }

  const actionIcons: Record<string, string> = { pause: "❚❚", resume: "▶", retry: "↻", cancel: "✕", play: "▶", openFolder: "▤" };
</script>

<section class="view queue-view" aria-labelledby="queue-title">
  <header class="view-header">
    <div><h1 id="queue-title" class="view-title">{view.title}</h1><p class="view-summary">{activeCount ? `${activeCount}개 다운로드 중 · ` : ""}전체 {mediaJobs.length}개</p></div>
    <div class="header-actions">
      <button class="button secondary" type="button" onclick={confirmHistoryRemoval} disabled={!removableIds.length}>기록 정리</button>
      <button class="button quiet" type="button" onclick={() => loadJobs()} disabled={$jobsState.loading || $jobsState.refreshing}>새로 고침</button>
    </div>
  </header>

  <div class="toolbar" aria-label="다운로드 필터">
    <div class="segmented-control" role="group" aria-label="작업 상태">
      {#each filters as [value, label]}
        <button class:active={filter === value} type="button" aria-pressed={filter === value} onclick={() => (filter = value)}>{label}<span class="filter-count">{mediaJobs.filter((job) => matchesQueueFilter(job, value)).length}</span></button>
      {/each}
    </div>
    <label class="search-field"><span class="sr-only">다운로드 검색</span><input bind:value={query} type="search" placeholder="제목 또는 파일명 검색" /></label>
  </div>

  {#if $jobsState.error}<div class="notice error" role="alert">{$jobsState.error}<button class="text-button" type="button" onclick={() => loadJobs()}>다시 시도</button></div>{/if}
  {#if $jobsState.notice}<div class="notice success" role="status">{$jobsState.notice}</div>{/if}
  {#if $jobsState.loading}<div class="loading-state" role="status" aria-live="polite">다운로드 목록을 불러오는 중…</div>
  {:else if visibleJobs.length === 0}<div class="empty"><strong>{query || filter !== "all" ? "조건에 맞는 작업이 없습니다." : "다운로드 기록이 없습니다."}</strong><span>{query || filter !== "all" ? "검색어와 필터를 확인해 주세요." : "브라우저의 Segma Player 확장에서 다운로드를 시작하세요."}</span>{#if query || filter !== "all"}<button class="button secondary" type="button" onclick={() => { query = ""; filter = "all"; }}>전체 보기</button>{/if}</div>
  {:else}<div class="job-table" role="list" aria-label="다운로드 작업">{#each visibleJobs as job (job.jobId)}
    {@const pendingAction = $jobsState.busy[job.jobId] ?? $jobsState.pending[job.jobId]?.action}
    {@const note = rowNote(job)}
    {@const quality = jobQuality(job)}
    <div class="job-row" class:job-active={job.active} role="listitem" aria-busy={Boolean(pendingAction)} title={note || undefined}>
      <span class="job-dot tone-{job.tone}" aria-hidden="true"></span>
      <span class="job-title">{jobRowTitle(job)}</span>
      <span class="job-quality">{quality}</span>
      <span class="job-status tone-{job.tone}" role="status">{rowStatus(job, pendingAction)}</span>
      <span class="job-size">{rowSize(job)}</span>
      <time class="job-time" datetime={new Date(job.createdAt).toISOString()} title={formatDate(job.createdAt)}>{formatRowTime(job.createdAt)}</time>
      <span class="job-actions">{#each job.actions as action}{@const reason = disabledActionReason(action)}{@const label = actionLabel(action, job.statusLabel === "파일 없음")}<button class="icon-button" type="button" disabled={Boolean(reason) || Boolean(pendingAction)} title={reason ?? label} aria-label={reason ? `${label}: ${reason}` : `${jobRowTitle(job)} ${label}`} onclick={() => runJobAction(job, action, onOpenPlayer)}><span aria-hidden="true">{pendingAction === action ? "…" : actionIcons[action] ?? "•"}</span></button>{/each}{#if canRemoveHistory(job)}<button class="icon-button" type="button" disabled={Boolean(pendingAction)} title="기록 삭제" aria-label={`${job.title} 기록 삭제`} onclick={() => removeHistory([job.jobId])}><span aria-hidden="true">⌫</span></button>{/if}</span>
      {#if job.active || job.paused}<span class="job-progress" class:indeterminate={job.active && job.progress === null} aria-label={`${job.title} 진행률`} role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow={job.progress ?? undefined}><span style={`width: ${job.progress ?? 0}%`}></span></span>{/if}
    </div>
  {/each}</div>{/if}
</section>

<dialog class="history-dialog" bind:this={historyDialog} aria-labelledby="history-dialog-title" aria-describedby="history-dialog-description">
  <h2 id="history-dialog-title">다운로드 기록 {historyIds.length}개를 삭제할까요?</h2>
  <p id="history-dialog-description">현재 목록의 완료·실패·취소 기록이 삭제됩니다. 다운로드한 파일은 그대로 유지됩니다.</p>
  <div class="modal-actions"><button class="button secondary" type="button" onclick={() => historyDialog.close()}>돌아가기</button><button class="button danger" type="button" onclick={removeConfirmedHistory}>기록 삭제</button></div>
</dialog>
