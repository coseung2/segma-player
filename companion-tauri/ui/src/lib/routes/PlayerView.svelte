<script lang="ts">
  import { onMount } from "svelte";
  import type { GifExportResponse, LibraryEntryDto } from "../api";
  import { authorizedAssetUrl, exportGif, generateSeekPreview, isPreviewUnavailable, openMediaExternally, prepareMediaSource, remuxTsToMp4, revealLibraryFile } from "../api";
  import type { ShellView } from "../views";
  import { editMetadata } from "../stores/library";
  import { playerState, replaceSelectedFile, selectAdjacent, selectMedia } from "../stores/player";
  import { loadSubtitlesFor, resetSubtitles, subtitleState } from "../stores/subtitles";
  import { mediaFolderMatches, mediaIdentity, mediaIdentityMatches } from "../selection-identity";
  import { cueAt, parseSubtitle, subtitleFormat, type SubtitleCue } from "../subtitle-parser";

  let { view, onOpenLibrary }: { view: ShellView; onOpenLibrary: () => void } = $props();
  let videoEl = $state<HTMLVideoElement | undefined>();
  let stageEl = $state<HTMLElement | undefined>();
  let fullscreen = $state(false);
  let sourceUrl = $state<string | null>(null);
  let mediaLoading = $state(false);
  let mediaUnavailable = $state(false);
  let mediaError = $state<string | null>(null);
  let playerNotice = $state<string | null>(null);
  let isPlaying = $state(false);
  let currentTime = $state(0);
  let duration = $state(0);
  let volume = $state(1);
  let muted = $state(false);
  let playbackRate = $state(1);
  let miniPlayer = $state(false);
  let pipSupported = $state(false);
  let preparedKey = $state<string | null>(null);
  let prepareSequence = 0;

  let hoverTime = $state<number | null>(null);
  let hoverPercent = $state(0);
  let previewUrl = $state<string | null>(null);
  let previewTimer: number | null = null;
  let previewInFlight = false;
  let pendingPreviewTime: number | null = null;
  let previewSequence = 0;
  let lastPreviewRequestAt = 0;
  const PREVIEW_INTERVAL_MS = 180;

  let subtitleEnabled = $state(true);
  let selectedSubtitleFile = $state("");
  let activeCue = $state<SubtitleCue | null>(null);
  let subtitleCues = $derived.by(() => {
    const track = $subtitleState.subtitles.find((item) => item.fileName === selectedSubtitleFile);
    const format = track ? subtitleFormat(track.fileName, track.format) : "unknown";
    return track && format !== "ass" ? parseSubtitle(track.text, format) : [];
  });

  let remuxState = $state<"idle" | "pending" | "success" | "error">("idle");
  let remuxError = $state<string | null>(null);
  let gifDialog = $state(false);
  let gifState = $state<"idle" | "pending" | "success" | "error">("idle");
  let gifError = $state<string | null>(null);
  let gifFileName = $state<string | null>(null);
  let gifAssetUrl = $state<string | null>(null);
  let gifStart = $state(0);
  let gifEnd = $state(5);
  let gifWidth = $state(640);
  let gifFps = $state(12);

  let selection = $derived($playerState.selection);
  let canPrevious = $derived($playerState.index > 0);
  let canNext = $derived($playerState.index >= 0 && $playerState.index < $playerState.entries.length - 1);
  let isTs = $derived(Boolean(selection?.entry.fileName.toLowerCase().endsWith(".ts")));
  let selectedTrack = $derived($subtitleState.subtitles.find((item) => item.fileName === selectedSubtitleFile) ?? null);
  let nextEntries = $derived(selection ? $playerState.entries.slice($playerState.index + 1, $playerState.index + 5) : []);

  $effect(() => {
    const current = $playerState.selection;
    const key = current ? mediaIdentity(current.folder, current.entry.fileName) : null;
    if (key === preparedKey) return;
    preparedKey = key;
    clearSeekPreview();
    prepareSequence += 1;
    remuxState = "idle";
    remuxError = null;
    gifDialog = false;
    gifState = "idle";
    gifError = null;
    gifFileName = null;
    gifAssetUrl = null;
    if (!current) {
      sourceUrl = null;
      mediaLoading = false;
      mediaUnavailable = false;
      mediaError = null;
      resetSubtitles();
      return;
    }
    playerNotice = null;
    void prepareSelection(current.folder, current.entry.fileName);
    void loadSubtitlesFor(current.folder, current.entry.fileName);
  });

  $effect(() => {
    const tracks = $subtitleState.subtitles;
    if (!tracks.some((track) => track.fileName === selectedSubtitleFile)) selectedSubtitleFile = tracks[0]?.fileName ?? "";
  });

  $effect(() => {
    activeCue = subtitleEnabled ? cueAt(subtitleCues, currentTime) : null;
  });

  onMount(() => {
    const handleFullscreenChange = () => {
      fullscreen = document.fullscreenElement === stageEl;
    };
    const handleKeydown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, select, textarea, button")) return;
      if (event.key === " ") { event.preventDefault(); togglePlay(); }
      else if (event.key.toLowerCase() === "f") { event.preventDefault(); void toggleFullscreen(); }
      else if (event.key === "ArrowLeft") { event.preventDefault(); seekBy(-5); }
      else if (event.key === "ArrowRight") { event.preventDefault(); seekBy(5); }
    };
    window.addEventListener("keydown", handleKeydown);
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => {
      window.removeEventListener("keydown", handleKeydown);
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
      clearSeekPreview();
    };
  });

  async function prepareSelection(folder: string | null, fileName: string): Promise<void> {
    const sequence = ++prepareSequence;
    const identity = mediaIdentity(folder, fileName);
    sourceUrl = null;
    mediaLoading = true;
    mediaUnavailable = false;
    mediaError = null;
    currentTime = 0;
    duration = 0;
    try {
      const result = await prepareMediaSource({ folder, fileName });
      if (sequence !== prepareSequence || !isCurrentSelection(identity)) return;
      if (isPreviewUnavailable(result)) {
        mediaUnavailable = true;
        mediaLoading = false;
        return;
      }
      if (!mediaIdentityMatches(identity, result.folder, result.fileName)) return;
      const assetUrl = authorizedAssetUrl(result);
      if (!assetUrl) throw new Error("Tauri 미디어 경로를 준비하지 못했습니다.");
      sourceUrl = assetUrl;
      mediaLoading = false;
      pipSupported = false;
    } catch (error) {
      if (sequence !== prepareSequence || !isCurrentSelection(identity)) return;
      mediaLoading = false;
      mediaError = error instanceof Error ? error.message : "미디어를 준비하지 못했습니다.";
    }
  }

  function handleLoadedMetadata(): void {
    const value = videoEl?.duration ?? 0;
    duration = Number.isFinite(value) ? value : 0;
    const savedPosition = selection?.entry.metadata.lastPosition ?? 0;
    if (videoEl && savedPosition > 0 && savedPosition < duration) videoEl.currentTime = savedPosition;
    pipSupported = Boolean(videoEl && typeof (videoEl as HTMLVideoElement & { requestPictureInPicture?: unknown }).requestPictureInPicture === "function");
  }

  function handleTimeUpdate(): void {
    currentTime = videoEl?.currentTime ?? 0;
  }

  function handlePause(): void {
    isPlaying = false;
    persistPosition();
  }

  function handlePlay(): void { isPlaying = true; }
  function handleEnded(): void { isPlaying = false; persistPosition(); }
  function handleVideoError(): void { mediaError = "이 미디어를 HTML 비디오로 재생할 수 없습니다."; mediaLoading = false; }

  async function togglePlay(): Promise<void> {
    if (!videoEl || mediaError || !sourceUrl) return;
    const identity = selection ? mediaIdentity(selection.folder, selection.entry.fileName) : null;
    if (videoEl.paused) {
      try { await videoEl.play(); } catch { if (!identity || isCurrentSelection(identity)) mediaError = "재생을 시작하지 못했습니다."; }
    } else videoEl.pause();
  }

  function seekBy(offset: number): void {
    if (!videoEl || !Number.isFinite(duration)) return;
    videoEl.currentTime = Math.max(0, Math.min(duration, videoEl.currentTime + offset));
  }

  function seekTo(value: number): void {
    if (videoEl && Number.isFinite(value)) videoEl.currentTime = Math.max(0, Math.min(duration, value));
  }

  function setVolume(value: number): void {
    volume = Math.max(0, Math.min(1, value));
    muted = volume === 0;
    if (videoEl) { videoEl.volume = volume; videoEl.muted = muted; }
  }

  function toggleMute(): void {
    muted = !muted;
    if (videoEl) videoEl.muted = muted;
  }

  function setSpeed(value: number): void {
    playbackRate = value;
    if (videoEl) videoEl.playbackRate = value;
  }

  async function toggleFullscreen(): Promise<void> {
    if (!stageEl) return;
    const identity = selection ? mediaIdentity(selection.folder, selection.entry.fileName) : null;
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await stageEl.requestFullscreen();
    } catch { if (!identity || isCurrentSelection(identity)) playerNotice = "전체 화면을 사용할 수 없습니다."; }
  }

  async function togglePictureInPicture(): Promise<void> {
    if (!videoEl) return;
    const identity = selection ? mediaIdentity(selection.folder, selection.entry.fileName) : null;
    const pipVideo = videoEl as HTMLVideoElement & { requestPictureInPicture?: () => Promise<unknown> };
    try {
      if (document.pictureInPictureElement === videoEl) {
        await document.exitPictureInPicture();
      } else if (pipSupported && pipVideo.requestPictureInPicture) {
        await pipVideo.requestPictureInPicture();
      } else {
        miniPlayer = true;
      }
    } catch {
      if (identity && !isCurrentSelection(identity)) return;
      miniPlayer = true;
      playerNotice = "OS Picture-in-Picture를 사용할 수 없어 미니 플레이어로 전환했습니다.";
    }
  }

  function selectTrack(fileName: string): void {
    selectedSubtitleFile = fileName;
    subtitleEnabled = Boolean(fileName);
  }

  function persistPosition(): void {
    if (!selection || !Number.isFinite(currentTime)) return;
    void editMetadata({ folder: selection.folder, fileName: selection.entry.fileName, lastPosition: currentTime, duration });
  }

  function openNext(entry: LibraryEntryDto): void {
    selectMedia(entry, selection?.folder ?? null, $playerState.entries);
  }

  async function openExternal(): Promise<void> {
    if (!selection) return;
    const current = selection;
    const identity = mediaIdentity(current.folder, current.entry.fileName);
    try {
      const result = await openMediaExternally({ folder: current.folder, fileName: current.entry.fileName });
      if (!isCurrentSelection(identity)) return;
      if (isPreviewUnavailable(result)) playerNotice = "브라우저 미리보기에서는 외부 플레이어를 실행하지 않습니다.";
      else playerNotice = "외부 플레이어에서 열었습니다.";
    } catch (error) { if (!isCurrentSelection(identity)) return; playerNotice = error instanceof Error ? error.message : "외부 플레이어를 열지 못했습니다."; }
  }

  async function remuxCurrent(): Promise<void> {
    if (!selection || remuxState === "pending") return;
    const current = selection;
    const identity = mediaIdentity(current.folder, current.entry.fileName);
    remuxState = "pending";
    remuxError = null;
    try {
      const result = await remuxTsToMp4({ folder: current.folder, fileName: current.entry.fileName });
      if (!isCurrentSelection(identity)) return;
      if (isPreviewUnavailable(result)) {
        remuxState = "error";
        remuxError = "TS 변환은 Tauri Companion에서만 실행할 수 있습니다.";
        return;
      }
      if (!mediaFolderMatches(identity, result.folder)) return;
      replaceSelectedFile(result.fileName, "MP4");
      remuxState = "success";
      playerNotice = `${result.fileName}로 전환했습니다.`;
    } catch (error) {
      if (!isCurrentSelection(identity)) return;
      remuxState = "error";
      remuxError = error instanceof Error ? error.message : "TS를 MP4로 변환하지 못했습니다.";
    }
  }

  function openGifDialog(): void {
    gifStart = Math.max(0, Math.min(currentTime, Math.max(0, duration - 0.1)));
    gifEnd = duration > gifStart ? Math.min(duration, gifStart + 5) : gifStart + 5;
    gifState = "idle";
    gifError = null;
    gifFileName = null;
    gifAssetUrl = null;
    gifDialog = true;
  }

  async function submitGif(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (!selection || gifState === "pending") return;
    if (!Number.isFinite(gifStart) || !Number.isFinite(gifEnd) || gifEnd <= gifStart) {
      gifState = "error";
      gifError = "끝 시간은 시작 시간보다 커야 합니다.";
      return;
    }
    const current = selection;
    const identity = mediaIdentity(current.folder, current.entry.fileName);
    gifState = "pending";
    gifError = null;
    try {
      const result = await exportGif({ folder: current.folder, fileName: current.entry.fileName, startSeconds: gifStart, endSeconds: gifEnd, width: gifWidth, fps: gifFps });
      if (!isCurrentSelection(identity)) return;
      if (isPreviewUnavailable(result)) {
        gifState = "error";
        gifError = "GIF 내보내기는 Tauri Companion에서만 실행할 수 있습니다.";
        return;
      }
      if (!mediaFolderMatches(identity, result.folder)) return;
      applyGifResult(result, identity);
    } catch (error) {
      if (!isCurrentSelection(identity)) return;
      gifState = "error";
      gifError = error instanceof Error ? error.message : "GIF를 저장하지 못했습니다.";
    }
  }

  function applyGifResult(result: GifExportResponse, identity: string): void {
    if (!isCurrentSelection(identity) || !mediaFolderMatches(identity, result.folder)) return;
    gifState = "success";
    gifFileName = result.fileName;
    gifAssetUrl = authorizedAssetUrl(result);
  }

  async function revealGif(): Promise<void> {
    if (!selection || !gifFileName) return;
    const current = selection;
    const identity = mediaIdentity(current.folder, current.entry.fileName);
    try {
      await revealLibraryFile({ folder: current.folder, fileName: gifFileName });
      if (isCurrentSelection(identity)) playerNotice = "GIF 파일 위치를 열었습니다.";
    } catch (error) { if (!isCurrentSelection(identity)) return; gifError = error instanceof Error ? error.message : "GIF 파일 위치를 열지 못했습니다."; }
  }

  function handleSeekPointerMove(event: PointerEvent): void {
    if (!selection || duration <= 0) return;
    const target = event.currentTarget as HTMLElement;
    const rect = target.getBoundingClientRect();
    if (rect.width <= 0) return;
    const percent = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    hoverPercent = percent * 100;
    hoverTime = percent * duration;
    scheduleSeekPreview(hoverTime);
  }

  function scheduleSeekPreview(time: number): void {
    if (!isTauriMediaContext() || !selection || duration <= 0) return;
    pendingPreviewTime = time;
    // Any pointer move makes an in-flight frame stale. The identity check
    // below protects folder/file changes; this sequence protects the hover
    // timestamp while the same file remains selected.
    previewSequence += 1;
    previewUrl = null;
    if (previewInFlight || previewTimer !== null) return;
    const wait = Math.max(0, PREVIEW_INTERVAL_MS - (Date.now() - lastPreviewRequestAt));
    previewTimer = window.setTimeout(() => {
      previewTimer = null;
      void flushSeekPreview();
    }, wait);
  }

  async function flushSeekPreview(): Promise<void> {
    if (previewInFlight || pendingPreviewTime === null || !selection || duration <= 0 || hoverTime === null) return;
    const current = selection;
    const identity = mediaIdentity(current.folder, current.entry.fileName);
    const time = pendingPreviewTime;
    pendingPreviewTime = null;
    previewInFlight = true;
    lastPreviewRequestAt = Date.now();
    const requestId = ++previewSequence;
    try {
      const result = await generateSeekPreview({ folder: current.folder, fileName: current.entry.fileName, timestampSeconds: time, durationSeconds: duration });
      if (requestId !== previewSequence || hoverTime === null || !isCurrentSelection(identity) || isPreviewUnavailable(result)) return;
      if (!mediaIdentityMatches(identity, current.folder, result.fileName)) return;
      previewUrl = authorizedAssetUrl(result);
    } catch {
      if (requestId === previewSequence && isCurrentSelection(identity)) previewUrl = null;
    } finally {
      previewInFlight = false;
      if (pendingPreviewTime !== null && hoverTime !== null) scheduleSeekPreview(pendingPreviewTime);
    }
  }

  function clearSeekPreview(): void {
    if (previewTimer !== null) window.clearTimeout(previewTimer);
    previewTimer = null;
    pendingPreviewTime = null;
    previewSequence += 1;
    hoverTime = null;
    previewUrl = null;
  }

  function isTauriMediaContext(): boolean {
    return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  }

  function isCurrentSelection(identity: string): boolean {
    const current = $playerState.selection;
    return Boolean(current && mediaIdentityMatches(identity, current.folder, current.entry.fileName));
  }

  function formatTime(value: number): string {
    if (!Number.isFinite(value) || value < 0) return "00:00";
    const total = Math.floor(value);
    const seconds = total % 60;
    const minutes = Math.floor(total / 60) % 60;
    const hours = Math.floor(total / 3600);
    return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}` : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
</script>

<svelte:head><title>{view.title} · Segma Player</title></svelte:head>
<section class:mini-mode={miniPlayer} class="view player-view" aria-labelledby="player-title">
  <header class="view-header"><div><h1 id="player-title" class="view-title">{selection?.entry.title ?? view.title}</h1><p class="view-summary">{selection ? selection.entry.fileName : "미디어를 선택해 재생하세요."}</p></div><div class="header-actions"><button class="button secondary" type="button" onclick={onOpenLibrary}>보관함</button>{#if selection}<button class="button quiet" type="button" onclick={() => void openExternal()}>외부 플레이어</button>{/if}</div></header>

  {#if !selection}<div class="player-empty empty"><strong>재생할 미디어가 없습니다.</strong><span>보관함에서 파일을 선택하면 이곳에서 재생합니다.</span><button class="button primary" type="button" onclick={onOpenLibrary}>보관함 열기</button></div>
  {:else}<div class:mini-player={miniPlayer} class="player-stage" bind:this={stageEl}>
    {#if sourceUrl && !mediaError}<video bind:this={videoEl} src={sourceUrl} playsinline preload="metadata" onloadedmetadata={handleLoadedMetadata} ontimeupdate={handleTimeUpdate} onplay={handlePlay} onpause={handlePause} onended={handleEnded} onerror={handleVideoError} aria-label={`${selection.entry.title} 비디오`}><track kind="captions" srclang="und" label="사이드카 자막" src="data:text/vtt,WEBVTT%0A" /></video>{:else if mediaLoading}<div class="stage-state" role="status">미디어 준비 중…</div>{:else if mediaUnavailable}<div class="stage-state"><strong>브라우저 미리보기</strong><span>Tauri Companion의 미디어 엔진이 연결되면 재생할 수 있습니다.</span></div>{:else if mediaError}<div class="stage-state error-state" role="alert"><strong>재생할 수 없습니다.</strong><span>{mediaError}</span><button class="button secondary" type="button" onclick={() => void openExternal()}>외부 플레이어로 열기</button></div>{/if}
    {#if sourceUrl && subtitleEnabled && activeCue}<div class="subtitle-overlay" aria-live="off">{activeCue.text}</div>{/if}
    {#if fullscreen}<button class="fullscreen-exit" type="button" aria-label="전체 화면 종료" onclick={() => void toggleFullscreen()}>전체 화면 종료</button>{/if}
    {#if miniPlayer}<button class="mini-close" type="button" aria-label="미니 플레이어 닫기" onclick={() => (miniPlayer = false)}>×</button>{/if}
  </div>

  <div class="player-controls" aria-label="재생 컨트롤">
    <div class="seek-control" role="group" aria-label="탐색 미리보기" onpointermove={handleSeekPointerMove} onpointerleave={clearSeekPreview}>
      {#if previewUrl && hoverTime !== null}<div class="seek-preview" style={`left: ${hoverPercent}%`}><img src={previewUrl} alt={`${formatTime(hoverTime)} 미리보기`} /><span>{formatTime(hoverTime)}</span></div>{/if}
      <input class="seek-range" type="range" min="0" max={Math.max(duration, 0.1)} step="0.1" value={currentTime} oninput={(event) => seekTo(Number((event.currentTarget as HTMLInputElement).value))} aria-label="재생 위치" disabled={!sourceUrl || duration <= 0} />
    </div>
    <div class="control-row">
      <div class="control-cluster"><button class="icon-control" type="button" aria-label="이전 미디어" onclick={() => selectAdjacent(-1)} disabled={!canPrevious}>⏮</button><button class="icon-control control-primary" type="button" aria-label={isPlaying ? "일시정지" : "재생"} onclick={() => void togglePlay()} disabled={!sourceUrl || Boolean(mediaError)}>{isPlaying ? "❚❚" : "▶"}</button><button class="icon-control" type="button" aria-label="다음 미디어" onclick={() => selectAdjacent(1)} disabled={!canNext}>⏭</button><span class="time-readout" aria-live="off">{formatTime(currentTime)} / {formatTime(duration)}</span></div>
      <div class="control-cluster control-secondary"><button class="icon-control" type="button" aria-label={muted ? "음소거 해제" : "음소거"} aria-pressed={muted} onclick={toggleMute}>{muted ? "🔇" : "🔊"}</button><label class="volume-control"><span class="sr-only">볼륨</span><input type="range" min="0" max="1" step="0.05" value={muted ? 0 : volume} oninput={(event) => setVolume(Number((event.currentTarget as HTMLInputElement).value))} aria-label="볼륨" /></label><select value={playbackRate} onchange={(event) => setSpeed(Number((event.currentTarget as HTMLSelectElement).value))} aria-label="재생 속도"><option value="0.5">0.5x</option><option value="0.75">0.75x</option><option value="1">1.0x</option><option value="1.25">1.25x</option><option value="1.5">1.5x</option><option value="2">2.0x</option></select><button class="icon-control" type="button" aria-label="Picture-in-Picture" onclick={() => void togglePictureInPicture()} disabled={!sourceUrl}>{pipSupported ? "▣" : "▣"}</button><button class="icon-control" type="button" aria-label="전체 화면" onclick={() => void toggleFullscreen()} disabled={!sourceUrl}>⛶</button></div>
    </div>
    {#if playerNotice}<p class="player-notice" role="status">{playerNotice}</p>{/if}
  </div>

  <div class="player-details"><div><span class="eyebrow"><span class="type-chip">{selection.entry.typeLabel}</span>{#if selectedTrack}<span class="type-chip">{selectedTrack.format.toUpperCase()}</span>{/if}</span><p class="file-meta">{selection.folder ? `${selection.folder} / ` : ""}{selection.entry.fileName}</p></div><div class="player-actions"><label class="subtitle-picker"><span>자막</span><select value={selectedSubtitleFile} onchange={(event) => selectTrack((event.currentTarget as HTMLSelectElement).value)} disabled={$subtitleState.loading || $subtitleState.subtitles.length === 0}><option value="">끄기</option>{#each $subtitleState.subtitles as track}<option value={track.fileName}>{track.title}{track.language ? ` · ${track.language}` : ""} ({track.format.toUpperCase()})</option>{/each}</select></label>{#if selectedTrack && subtitleFormat(selectedTrack.fileName, selectedTrack.format) === "ass"}<span class="unsupported-note">ASS 렌더링 미지원</span>{/if}{#if isTs}<button class="button secondary" type="button" onclick={() => void remuxCurrent()} disabled={remuxState === "pending"}>{remuxState === "pending" ? "변환 중…" : "TS → MP4"}</button>{/if}<button class="button secondary" type="button" onclick={openGifDialog}>GIF 내보내기</button></div></div>
  {#if $subtitleState.error}<div class="notice error" role="alert">{$subtitleState.error}</div>{:else if $subtitleState.unavailable}<div class="notice" role="status">자막 목록은 Tauri Companion에서 확인할 수 있습니다.</div>{:else if $subtitleState.loading}<div class="notice" role="status">자막 확인 중…</div>{:else if $subtitleState.subtitles.length === 0}<div class="notice" role="status">이 미디어의 사이드카 자막이 없습니다.</div>{/if}
  {#if remuxError}<div class="notice error" role="alert">{remuxError}</div>{/if}
  {#if nextEntries.length}<section class="up-next" aria-labelledby="up-next-title"><h2 id="up-next-title">다음 재생</h2><div class="up-next-grid">{#each nextEntries as entry (entry.fileName)}<button class="up-next-item" type="button" onclick={() => openNext(entry)}><span class="media-thumb mini-thumb"><span>{entry.typeLabel}</span><strong>{entry.title.slice(0, 1).toUpperCase()}</strong></span><span class="up-next-title">{entry.title}</span><span class="up-next-meta">{entry.size ?? "크기 없음"}</span></button>{/each}</div></section>{/if}
  {/if}
</section>

{#if gifDialog}<dialog open class="modal gif-dialog" aria-labelledby="gif-title"><h2 id="gif-title">GIF 내보내기</h2>{#if gifState === "success"}<p class="status-success">{gifFileName} 저장됨</p>{#if gifAssetUrl}<img class="gif-result" src={gifAssetUrl} alt="저장된 GIF 미리보기" />{/if}<div class="modal-actions"><button class="button quiet" type="button" onclick={() => (gifDialog = false)}>닫기</button><button class="button secondary" type="button" onclick={() => void revealGif()}>파일 위치 열기</button></div>{:else}<form onsubmit={submitGif}><div class="gif-fields"><label>시작 <input type="number" min="0" step="0.1" bind:value={gifStart} /></label><label>끝 <input type="number" min="0" step="0.1" bind:value={gifEnd} /></label><label>너비 <input type="number" min="160" max="1920" step="1" bind:value={gifWidth} /></label><label>FPS <input type="number" min="1" max="30" step="1" bind:value={gifFps} /></label></div>{#if gifError}<p class="form-error" role="alert">{gifError}</p>{/if}<div class="modal-actions"><button class="button quiet" type="button" onclick={() => (gifDialog = false)}>취소</button><button class="button primary" type="submit" disabled={gifState === "pending"}>{gifState === "pending" ? "저장 중…" : "GIF 저장"}</button></div></form>{/if}</dialog>{/if}
