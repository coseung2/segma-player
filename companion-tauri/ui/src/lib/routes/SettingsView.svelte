<script lang="ts">
  import { onMount } from "svelte";
  import type { ShellView } from "../views";
  import { isTauriRuntime } from "../api";
  import { licenseState, loadLicense, removeLicenseKey, verifyLicenseKey } from "../stores/license";
  import { loadSettings, openDownloadFolder, saveDownloadFolder, settingsState } from "../stores/settings";

  let { view }: { view: ShellView } = $props();
  let folderInput = $state("");
  let licenseInput = $state("");
  let confirmRemove = $state(false);
  let settingsInitialized = false;
  onMount(() => { void loadSettings(); void loadLicense(); });
  $effect(() => { if (!settingsInitialized && $settingsState.settings) { folderInput = $settingsState.settings.downloadFolder; settingsInitialized = true; } });
</script>

<section class="view" aria-labelledby="settings-title">
  <header class="view-header"><div><h1 id="settings-title" class="view-title">{view.title}</h1><p class="view-summary">{view.summary}</p></div><span class="environment-chip">{isTauriRuntime() ? "Tauri 앱" : "브라우저 미리보기"}</span></header>
  {#if $settingsState.error}<div class="notice error" role="alert">{$settingsState.error}</div>{/if}{#if $settingsState.notice}<div class="notice success" role="status">{$settingsState.notice}</div>{/if}
  <section class="settings-group" aria-labelledby="storage-title"><div class="group-heading"><h2 id="storage-title">저장 위치</h2><p>다운로드한 미디어가 저장되는 폴더입니다.</p></div><div class="setting-row"><div><label for="download-folder">다운로드 폴더</label><p class="setting-value">{folderInput || "폴더를 입력해 주세요"}</p></div><div class="setting-controls"><input id="download-folder" bind:value={folderInput} type="text" autocomplete="off" placeholder="예: C:\\Users\\me\\Downloads" disabled={$settingsState.loading} /><button class="button primary" type="button" onclick={() => saveDownloadFolder(folderInput)} disabled={$settingsState.saving}>{$settingsState.saving ? "저장 중…" : "저장"}</button><button class="button secondary" type="button" onclick={() => openDownloadFolder()} disabled={$settingsState.action === "open-folder"}>폴더 열기</button></div></div></section>
  <section class="settings-group" aria-labelledby="license-title"><div class="group-heading"><h2 id="license-title">라이선스</h2><p>승인된 키는 이 기기에 로컬로 저장되며 원문은 다시 표시되지 않습니다.</p></div><div class="setting-row license-row"><div><span class="field-label">현재 상태</span>{#if $licenseState.loading}<p class="setting-value">확인 중…</p>{:else if $licenseState.license?.pro}<p class="setting-value status-success">Pro · {$licenseState.license.maskedKey}</p>{:else}<p class="setting-value">일반 플랜</p>{/if}</div>{#if $licenseState.license?.pro}<div class="setting-controls"><span class="license-detail">{$licenseState.license.daysRemaining === null ? "기간 정보 없음" : `${$licenseState.license.daysRemaining}일 남음`}</span><button class="button danger-quiet" type="button" onclick={() => (confirmRemove = true)} disabled={$licenseState.removing}>{$licenseState.removing ? "제거 중…" : "라이선스 제거"}</button></div>{:else}<form class="setting-controls" onsubmit={(event) => { event.preventDefault(); const key = licenseInput; licenseInput = ""; void verifyLicenseKey(key); }}><label class="sr-only" for="license-key">라이선스 키</label><input id="license-key" bind:value={licenseInput} type="password" autocomplete="off" placeholder="라이선스 키 입력" disabled={$licenseState.verifying} /><button class="button primary" type="submit" disabled={$licenseState.verifying}>{$licenseState.verifying ? "확인 중…" : "인증"}</button></form>{/if}</div></section>
  {#if $licenseState.error}<div class="notice error" role="alert">{$licenseState.error}</div>{/if}{#if $licenseState.notice}<div class="notice success" role="status">{$licenseState.notice}</div>{/if}
</section>

{#if confirmRemove}<dialog open class="modal" aria-labelledby="remove-license-title"><h2 id="remove-license-title">라이선스를 제거할까요?</h2><p>이 기기에서 Pro 인증을 제거하고 일반 플랜으로 전환합니다.</p><div class="modal-actions"><button class="button quiet" type="button" onclick={() => (confirmRemove = false)}>취소</button><button class="button danger" type="button" onclick={() => { confirmRemove = false; void removeLicenseKey(); }}>제거</button></div></dialog>{/if}
