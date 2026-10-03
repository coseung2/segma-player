<script lang="ts">
  import LibraryView from "./lib/routes/LibraryView.svelte";
  import PlayerView from "./lib/routes/PlayerView.svelte";
  import QueueView from "./lib/routes/QueueView.svelte";
  import SettingsView from "./lib/routes/SettingsView.svelte";
  import SubtitlesView from "./lib/routes/SubtitlesView.svelte";
  import { onMount } from "svelte";
  import { getCompanionConnectionStatus, isTauriRuntime, type CompanionConnectionStatus } from "./lib/api";
  import { SHELL_VIEWS, viewById, type ViewId } from "./lib/views";

  const NAV_ICONS: Record<ViewId, string> = { queue: "⇩", library: "▦", player: "▶", subtitles: "≡", settings: "⚙" };

  let activeViewId = $state<ViewId>("queue");
  let activeView = $derived(viewById(activeViewId));
  let connection = $state<CompanionConnectionStatus>({
    state: isTauriRuntime() ? "degraded" : "unavailable",
    label: isTauriRuntime() ? "Companion 확인 중…" : "브라우저 미리보기",
    version: null,
  });

  onMount(() => {
    if (!isTauriRuntime()) return;
    let disposed = false;
    const refresh = async () => {
      try {
        const status = await getCompanionConnectionStatus();
        if (!disposed) connection = status;
      } catch {
        if (!disposed) connection = { state: "unavailable", label: "Companion 연결 안 됨", version: null };
      }
    };
    void refresh();
    const interval = window.setInterval(refresh, 15_000);
    return () => { disposed = true; window.clearInterval(interval); };
  });
</script>

<div class="app-shell">
  <aside class="rail" aria-label="Segma Player 탐색">
    <div class="brand" title="Segma Player"><span class="brand-mark" aria-hidden="true">S</span><span class="sr-only">Segma Player</span></div>
    <nav class="navigation" aria-label="주요 화면">{#each SHELL_VIEWS as view}<button type="button" class:active={activeViewId === view.id} aria-current={activeViewId === view.id ? "page" : undefined} onclick={() => (activeViewId = view.id)}><span class="nav-icon" aria-hidden="true">{NAV_ICONS[view.id]}</span><span class="nav-label">{view.label}</span></button>{/each}</nav>
    <div class="connection-status" aria-live="polite" title={connection.label}><span class="status-dot" class:connected={connection.state === "connected"} aria-hidden="true"></span><span class="sr-only">{connection.label}</span></div>
  </aside>
<main class="content" tabindex="-1">{#if activeViewId === "queue"}<QueueView view={activeView} onOpenPlayer={() => (activeViewId = "player")} />{:else if activeViewId === "library"}<LibraryView view={activeView} onOpenPlayer={() => (activeViewId = "player")} onOpenSettings={() => (activeViewId = "settings")} />{:else if activeViewId === "player"}<PlayerView view={activeView} onOpenLibrary={() => (activeViewId = "library")} />{:else if activeViewId === "subtitles"}<SubtitlesView view={activeView} onOpenLibrary={() => (activeViewId = "library")} />{:else}<SettingsView view={activeView} />{/if}</main>
</div>
