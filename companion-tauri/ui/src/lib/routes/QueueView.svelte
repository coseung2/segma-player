<script lang="ts">
  import { onMount } from "svelte";
  import type { ShellView } from "../views";
  import { isQueueActionSupported, jobsState, loadJobs, queueActionReason, runJobAction, startJobsPolling } from "../stores/jobs";

  let { view, onOpenPlayer }: { view: ShellView; onOpenPlayer: () => void } = $props();
  let query = $state("");
  let filter = $state<"all" | "active" | "paused" | "complete" | "failed">("all");
  const filters = [
    ["all", "전체"], ["active", "진행 중"], ["paused", "일시정지"], ["complete", "완료"], ["failed", "실패"],
  ] as const;

  onMount(() => {
    void loadJobs();
    return startJobsPolling();
  });

  let visibleJobs = $derived.by(() => $jobsState.jobs.filter((job) => {
    const text = `${job.title} ${job.fileName ?? ""} ${job.statusLabel}`.toLocaleLowerCase();
    const matchesQuery = !query.trim() || text.includes(query.trim().toLocaleLowerCase());
    const matchesFilter = filter === "all"
      || (filter === "active" && job.active)
      || (filter === "paused" && job.paused)
      || (filter === "complete" && job.tone === "success")
      || (filter === "failed" && job.tone === "danger");
    return matchesQuery && matchesFilter;
  }));

  function actionLabel(action: string): string {
    return ({ pause: "일시정지", resume: "재개", retry: "다시 시도", cancel: "취소", play: "재생", openFolder: "폴더 열기" } as Record<string, string>)[action] ?? action;
  }

  function disabledActionReason(action: string): string | null {
    return isQueueActionSupported(action) ? null : queueActionReason(action);
  }
</script>

<section class="view" aria-labelledby="queue-title">
  <header class="view-header">
    <div><h1 id="queue-title" class="view-title">{view.title}</h1><p class="view-summary">{view.summary}</p></div>
    <button class="button secondary" type="button" onclick={() => loadJobs()} disabled={$jobsState.loading || $jobsState.refreshing}>새로 고침</button>
  </header>

  <div class="toolbar" aria-label="다운로드 필터">
    <div class="segmented-control" role="tablist" aria-label="작업 상태">
      {#each filters as [value, label]}
        <button class:active={filter === value} type="button" role="tab" aria-selected={filter === value} onclick={() => (filter = value)}>{label}</button>
      {/each}
    </div>
    <label class="search-field"><span class="sr-only">다운로드 검색</span><input bind:value={query} type="search" placeholder="제목 또는 파일명 검색" /></label>
  </div>

  {#if $jobsState.error}<div class="notice error" role="alert">{$jobsState.error}<button class="text-button" type="button" onclick={() => loadJobs()}>다시 시도</button></div>{/if}
  {#if $jobsState.notice}<div class="notice success" role="status">{$jobsState.notice}</div>{/if}
  {#if $jobsState.loading}<div class="loading-state" role="status" aria-live="polite">다운로드 목록을 불러오는 중…</div>
  {:else if visibleJobs.length === 0}<div class="empty"><strong>{query || filter !== "all" ? "조건에 맞는 작업이 없습니다." : "진행 중인 다운로드가 없습니다."}</strong><span>{query || filter !== "all" ? "검색어와 필터를 확인해 주세요." : "브라우저 미리보기에서는 실제 작업을 표시하지 않습니다."}</span></div>
  {:else}<div class="job-list">{#each visibleJobs as job (job.jobId)}
    <article class="job-card">
      <div class="job-main"><div class="eyebrow"><span class="type-chip">{job.inputKind ?? job.outputFormat ?? "MEDIA"}</span><span class="status-chip tone-{job.tone}">{job.statusLabel}</span></div><h2>{job.title}</h2><p>{job.detail ?? job.fileName ?? job.statusText}</p></div>
      <div class="job-meta"><span>{job.transfer ?? (job.progress === null ? "진행률 없음" : `${job.progress}%`)}</span><span>{job.language ?? ""}</span></div>
      <div class="progress-track" aria-label={`${job.title} 진행률`} role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow={job.progress ?? undefined}><span style={`width: ${job.progress ?? 0}%`}></span></div>
      <div class="job-footer"><span>{job.statusText}</span><div class="row-actions">{#each job.actions as action}{@const reason = disabledActionReason(action)}<button class="button quiet" type="button" disabled={Boolean(reason) || $jobsState.action === `${action}:${job.jobId}`} title={reason ?? undefined} aria-label={reason ? `${actionLabel(action)}: ${reason}` : actionLabel(action)} onclick={() => runJobAction(job, action, onOpenPlayer)}>{$jobsState.action === `${action}:${job.jobId}` ? "처리 중…" : actionLabel(action)}</button>{/each}</div></div>
      {#if job.actions.some((action) => !isQueueActionSupported(action))}<p class="action-disabled-note">{job.actions.map((action) => disabledActionReason(action)).filter(Boolean).join(" ")}</p>{/if}
    </article>
  {/each}</div>{/if}
</section>
