<script lang="ts">
  import LibraryView from "./lib/routes/LibraryView.svelte";
  import PlayerView from "./lib/routes/PlayerView.svelte";
  import QueueView from "./lib/routes/QueueView.svelte";
  import SettingsView from "./lib/routes/SettingsView.svelte";
  import SubtitlesView from "./lib/routes/SubtitlesView.svelte";
  import { isTauriRuntime } from "./lib/api";
  import { SHELL_VIEWS, viewById, type ViewId } from "./lib/views";

  let activeViewId = $state<ViewId>("queue");
  let activeView = $derived(viewById(activeViewId));
</script>

<div class="app-shell">
  <aside class="rail" aria-label="Segma Player 탐색">
    <div class="brand"><span class="brand-mark" aria-hidden="true">S</span><span>Segma Player</span></div>
    <nav class="navigation" aria-label="주요 화면">{#each SHELL_VIEWS as view}<button type="button" class:active={activeViewId === view.id} aria-current={activeViewId === view.id ? "page" : undefined} onclick={() => (activeViewId = view.id)}><span class="nav-marker" aria-hidden="true"></span><span>{view.label}</span></button>{/each}</nav>
    <div class="connection-status"><span class="status-dot" aria-hidden="true"></span><span>{isTauriRuntime() ? "Companion 연결됨" : "브라우저 미리보기"}</span></div>
  </aside>
<main class="content" tabindex="-1">{#if activeViewId === "queue"}<QueueView view={activeView} onOpenPlayer={() => (activeViewId = "player")} />{:else if activeViewId === "library"}<LibraryView view={activeView} onOpenPlayer={() => (activeViewId = "player")} />{:else if activeViewId === "player"}<PlayerView view={activeView} onOpenLibrary={() => (activeViewId = "library")} />{:else if activeViewId === "subtitles"}<SubtitlesView view={activeView} onOpenLibrary={() => (activeViewId = "library")} />{:else}<SettingsView view={activeView} />{/if}</main>
</div>
