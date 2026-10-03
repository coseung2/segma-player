<script lang="ts">
  import { onMount } from "svelte";
  import type { ShellView } from "../views";
  import { cloudStatus, configureTelegram, installCloudComponent, isTauriRuntime, type CloudStatusDto } from "../api";
  import { licenseState, loadLicense, removeLicenseKey, verifyLicenseKey } from "../stores/license";
  import { loadSettings, openDownloadFolder, saveDownloadFolder, settingsState } from "../stores/settings";

  let { view }: { view: ShellView } = $props();
  let folderInput = $state("");
  let licenseInput = $state("");
  let confirmRemove = $state(false);
  let botToken = $state("");
  let channelId = $state("");
  let cloud = $state<CloudStatusDto | null>(null);
  let cloudAction = $state<"loading" | "saving" | "installing" | null>(null);
  let cloudError = $state<string | null>(null);
  let cloudNotice = $state<string | null>(null);
  let settingsInitialized = false;
  const errorMessage = (error: unknown, fallback: string) => error instanceof Error && error.message ? error.message : fallback;
  async function refreshCloud(action: typeof cloudAction = "loading") {
    cloudAction = action;
    try { cloud = await cloudStatus(); }
    catch (error) { cloudError = errorMessage(error, "클라우드 상태를 확인하지 못했습니다."); }
    finally { cloudAction = null; }
  }
  async function saveTelegram(event: SubmitEvent) {
    event.preventDefault();
    if (cloudAction) return;
    cloudAction = "saving"; cloudError = null; cloudNotice = null;
    const token = botToken;
    botToken = "";
    try {
      await configureTelegram({ token, channelId });
      channelId = "";
      cloudNotice = "텔레그램 저장소 설정을 저장했습니다.";
    } catch (error) { cloudError = errorMessage(error, "텔레그램 저장소 설정을 저장하지 못했습니다."); }
    finally { await refreshCloud(null); }
  }
  async function repairCloud() {
    if (cloudAction) return;
    cloudAction = "installing"; cloudError = null; cloudNotice = null;
    try { await installCloudComponent(); cloudNotice = "클라우드 구성 요소를 설치했습니다."; }
    catch (error) { cloudError = errorMessage(error, "클라우드 구성 요소를 복구하지 못했습니다."); }
    finally { await refreshCloud(null); }
  }
  onMount(() => { void loadSettings(); void loadLicense(); void refreshCloud(); });
  $effect(() => { if (!settingsInitialized && $settingsState.settings) { folderInput = $settingsState.settings.downloadFolder; settingsInitialized = true; } });
</script>

<section class="view" aria-labelledby="settings-title">
  <header class="view-header"><div><h1 id="settings-title" class="view-title">{view.title}</h1><p class="view-summary">{view.summary}</p></div><span class="environment-chip">{isTauriRuntime() ? "Tauri 앱" : "브라우저 미리보기"}</span></header>
  {#if $settingsState.error}<div class="notice error" role="alert">{$settingsState.error}</div>{/if}{#if $settingsState.notice}<div class="notice success" role="status">{$settingsState.notice}</div>{/if}
  <section class="settings-group" aria-labelledby="storage-title"><div class="group-heading"><h2 id="storage-title">저장 위치</h2><p>다운로드한 미디어가 저장되는 폴더입니다.</p></div><div class="setting-row"><div><label for="download-folder">다운로드 폴더</label><p class="setting-value">{folderInput || "폴더를 입력해 주세요"}</p></div><div class="setting-controls"><input id="download-folder" bind:value={folderInput} type="text" autocomplete="off" placeholder="예: C:\\Users\\me\\Downloads" disabled={$settingsState.loading} /><button class="button primary" type="button" onclick={() => saveDownloadFolder(folderInput)} disabled={$settingsState.saving}>{$settingsState.saving ? "저장 중…" : "저장"}</button><button class="button secondary" type="button" onclick={() => openDownloadFolder()} disabled={$settingsState.action === "open-folder"}>폴더 열기</button></div></div></section>
  <section class="settings-group" aria-labelledby="telegram-title"><div class="group-heading"><div class="eyebrow"><span class="status-chip" class:tone-success={cloud?.executableAvailable && cloud?.telegramConfigured} class:tone-warning={!cloud?.executableAvailable || !cloud?.telegramConfigured}>{cloudAction === "loading" ? "확인 중…" : !cloud?.executableAvailable ? "구성 요소 없음" : !cloud?.telegramConfigured ? "설정 필요" : "사용 가능"}</span></div><h2 id="telegram-title">텔레그램 보관함</h2><p>봇 토큰은 클라우드 구성 요소로 바로 전달되어 이 앱의 설정에는 저장되지 않습니다.</p></div>{#if !cloud?.executableAvailable}<div class="setting-row"><div><span class="field-label">클라우드 구성 요소</span><p class="setting-value">이 PC의 로컬 설치 파일 또는 구성 요소 파일로 설치하거나 복구합니다.</p></div><div class="setting-controls"><button class="button primary" type="button" onclick={repairCloud} disabled={cloudAction !== null}>{cloudAction === "installing" ? "복구 중…" : "설치/복구"}</button></div></div>{/if}<form class="setting-row" onsubmit={saveTelegram}><div><span class="field-label">저장소 연결</span><p class="setting-value">텔레그램 BotFather 토큰과 저장소 채팅 ID를 입력하세요.</p></div><div class="setting-controls"><label class="sr-only" for="telegram-token">봇 토큰</label><input id="telegram-token" bind:value={botToken} type="password" autocomplete="new-password" placeholder="봇 토큰" disabled={!cloud?.executableAvailable || cloudAction !== null} /><label class="sr-only" for="telegram-channel">저장소 채팅 ID</label><input id="telegram-channel" bind:value={channelId} type="text" inputmode="numeric" autocomplete="off" placeholder="예: -1001234567890" disabled={!cloud?.executableAvailable || cloudAction !== null} /><button class="button primary" type="submit" disabled={!cloud?.executableAvailable || cloudAction !== null || !botToken || !channelId}>{cloudAction === "saving" ? "저장 중…" : "저장"}</button></div></form>{#if cloudError}<div class="notice error" role="alert">{cloudError}</div>{/if}{#if cloudNotice}<div class="notice success" role="status">{cloudNotice}</div>{/if}</section>
  <section class="settings-group" aria-labelledby="license-title"><div class="group-heading"><h2 id="license-title">라이선스</h2><p>승인된 키는 이 기기에 로컬로 저장되며 원문은 다시 표시되지 않습니다.</p></div><div class="setting-row license-row"><div><span class="field-label">현재 상태</span>{#if $licenseState.loading}<p class="setting-value">확인 중…</p>{:else if $licenseState.license?.pro}<p class="setting-value status-success">Pro · {$licenseState.license.maskedKey}</p>{:else}<p class="setting-value">일반 플랜</p>{/if}</div>{#if $licenseState.license?.pro}<div class="setting-controls"><span class="license-detail">{$licenseState.license.daysRemaining === null ? "기간 정보 없음" : `${$licenseState.license.daysRemaining}일 남음`}</span><button class="button danger-quiet" type="button" onclick={() => (confirmRemove = true)} disabled={$licenseState.removing}>{$licenseState.removing ? "제거 중…" : "라이선스 제거"}</button></div>{:else}<form class="setting-controls" onsubmit={(event) => { event.preventDefault(); const key = licenseInput; licenseInput = ""; void verifyLicenseKey(key); }}><label class="sr-only" for="license-key">라이선스 키</label><input id="license-key" bind:value={licenseInput} type="password" autocomplete="off" placeholder="라이선스 키 입력" disabled={$licenseState.verifying} /><button class="button primary" type="submit" disabled={$licenseState.verifying}>{$licenseState.verifying ? "확인 중…" : "인증"}</button></form>{/if}</div></section>
  {#if $licenseState.error}<div class="notice error" role="alert">{$licenseState.error}</div>{/if}{#if $licenseState.notice}<div class="notice success" role="status">{$licenseState.notice}</div>{/if}
</section>

{#if confirmRemove}<dialog open class="modal" aria-labelledby="remove-license-title"><h2 id="remove-license-title">라이선스를 제거할까요?</h2><p>이 기기에서 Pro 인증을 제거하고 일반 플랜으로 전환합니다.</p><div class="modal-actions"><button class="button quiet" type="button" onclick={() => (confirmRemove = false)}>취소</button><button class="button danger" type="button" onclick={() => { confirmRemove = false; void removeLicenseKey(); }}>제거</button></div></dialog>{/if}
