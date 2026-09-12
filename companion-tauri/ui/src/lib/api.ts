import { convertFileSrc, invoke } from "@tauri-apps/api/core";

export interface CommandError {
  code: string;
  message: string;
}

export type JobActionCode = "pause" | "resume" | "retry" | "play" | "cancel" | "openFolder";

export interface JobDto {
  jobId: string;
  jobType: string | null;
  requestId: string | null;
  candidateId: string | null;
  inputKind: string | null;
  outputFormat: string | null;
  status: string;
  statusText: string;
  statusLabel: string;
  tone: "neutral" | "success" | "danger" | "warning";
  title: string;
  detail: string | null;
  progress: number | null;
  completed: number | null;
  total: number | null;
  transfer: string | null;
  language: string | null;
  fileName: string | null;
  active: boolean;
  paused: boolean;
  actions: JobActionCode[];
  createdAt: number;
  updatedAt: number;
}

export interface JobsResponse { jobs: JobDto[]; }
export interface JobIdRequest { jobId: string; }
export interface JobActionResponse { jobId: string; accepted: boolean; }
export interface JobOutputDto { folder: string | null; fileName: string; }

export interface LibraryMetadataDto {
  rating: number;
  favorite: boolean;
  watchedOverride: boolean | null;
  lastPosition: number;
  duration: number;
  updatedAt: number;
  poseMarkers: number[];
  watchState: "unwatched" | "inProgress" | "completed";
}

export interface LibraryEntryDto {
  fileName: string;
  title: string;
  typeLabel: string;
  size: string | null;
  jobId: string | null;
  thumbnailKey: string;
  modifiedAt: number;
  metadata: LibraryMetadataDto;
}

export interface LibraryFolderDto { name: string; mediaCount: number; }
export interface LibraryListRequest { folder?: string | null; }
export interface LibraryListResponse {
  folder: string | null;
  folders: LibraryFolderDto[];
  entries: LibraryEntryDto[];
  missingOutputCount: number;
  usageBytes: number;
}

export interface MetadataUpdateRequest {
  folder?: string | null;
  fileName: string;
  rating?: number;
  favorite?: boolean;
  watchedOverride?: boolean | null;
  lastPosition?: number;
  duration?: number;
  poseMarkers?: number[];
}
export interface MetadataUpdateResponse {
  changed: boolean;
  persisted: boolean;
  fileName: string;
  metadata: LibraryMetadataDto;
}

export interface MoveLibraryFileRequest {
  sourceFolder?: string | null;
  fileName: string;
  destinationFolder?: string | null;
  destinationFileName?: string | null;
}
export interface MoveLibraryFileResponse { folder: string | null; fileName: string; }
export interface DeleteLibraryFileRequest { folder?: string | null; fileName: string; }
export interface DeleteLibraryFileResponse {
  folder: string | null;
  fileName: string;
  recycled: boolean;
}
export interface LibraryFileRef { folder: string | null; fileName: string; }
export interface DeleteLibraryFilesRequest { items: LibraryFileRef[]; }
export interface DeleteLibraryItemResult {
  item: LibraryFileRef;
  recycled: boolean;
  errorCode: string | null;
}
export interface DeleteLibraryFilesResponse {
  items: DeleteLibraryItemResult[];
  succeeded: number;
  failed: number;
}
export interface AutoOrganizeRequest { apply?: boolean; }
export interface OrganizationFileRefDto { folder: string | null; fileName: string; }
export interface OrganizationResultItemDto {
  source: OrganizationFileRefDto;
  destination: OrganizationFileRefDto;
  succeeded: boolean;
  errorCode: string | null;
}
export interface AutoOrganizeResponse {
  applied: boolean;
  items: OrganizationResultItemDto[];
  succeeded: number;
  failed: number;
}

export interface LicenseDto {
  pro: boolean;
  maskedKey: string | null;
  expiresAt: number | null;
  daysRemaining: number | null;
  devices: number | null;
  limit: number | null;
}
export interface VerifyLicenseRequest { key: string; }
export interface SettingsDto { downloadFolder: string; }
export interface UpdateDownloadFolderRequest { downloadFolder: string; }
export interface LibraryFolderRequest { folder?: string | null; }
export interface RevealLibraryFileRequest { folder?: string | null; fileName: string; }
export interface SystemOperationResponse { accepted: boolean; }

export interface MediaFileRequest {
  folder?: string | null;
  fileName: string;
}

export interface PrepareMediaSourceResponse {
  path: string;
  mimeType: string;
  title: string;
  folder: string | null;
  fileName: string;
}

export interface RemuxTsToMp4Response {
  path: string;
  folder: string | null;
  fileName: string;
}

export interface SeekPreviewRequest extends MediaFileRequest {
  timestampSeconds: number;
  durationSeconds: number;
}

export interface SeekPreviewResponse {
  path: string;
  mimeType: string;
  title: string;
  timestampSeconds: number;
  fileName: string;
}

export interface ThumbnailResponse {
  path: string;
  mimeType: string;
  title: string;
  fileName: string;
}

export interface SidecarSubtitleDto {
  fileName: string;
  title: string;
  format: string;
  language: string | null;
  text: string;
}

export interface SidecarSubtitlesResponse {
  fileName: string;
  subtitles: SidecarSubtitleDto[];
}

export interface StartOrGenerateSubtitleRequest {
  folder?: string | null;
  fileName: string;
  sourceLanguage: string;
  targetLanguage: string;
}

export interface SubtitleJobResponse {
  jobId: string;
  status: string;
  sourceLanguage: string;
  targetLanguage: string;
}

export interface ImportSubtitleRequest {
  folder?: string | null;
  fileName: string;
}

export interface ImportSubtitleResponse {
  mediaFileName: string;
  fileName: string;
  format: string;
}

export interface SyncSubtitleRequest {
  folder?: string | null;
  fileName: string;
  subtitleFileName: string;
  offsetSeconds: number;
}

export interface SyncSubtitleResponse {
  mediaFileName: string;
  fileName: string;
  format: string;
  offsetSeconds: number;
}

export interface SupportedSubtitleLanguageDto {
  code: string;
  label: string;
}

export interface SubtitleCapabilitiesDto {
  sourceLanguages: SupportedSubtitleLanguageDto[];
  targetLanguages: SupportedSubtitleLanguageDto[];
  formats: string[];
  maxAudioBytes: number;
  maxResultBytes: number;
  maxOffsetSeconds: number;
}

export interface GifExportRequest extends MediaFileRequest {
  startSeconds: number;
  endSeconds: number;
  width: number;
  fps: number;
}

export interface GifExportResponse {
  path: string;
  folder: string | null;
  fileName: string;
}

export type CloudOperation = "upload" | "download" | "delete";

export interface CloudStatusDto {
  schemaVersion: number;
  capability: string;
  executableAvailable: boolean;
  telegramConfigured: boolean;
}

export interface CloudItemDto {
  itemId: string;
  provider: string;
  fileName: string;
  size: number;
}

export interface CloudJobDto {
  jobId: string;
  provider: string;
  itemId: string;
  operation: CloudOperation;
  status: string;
  phase: string | null;
  fileName: string | null;
  progress: number | null;
  completed: number | null;
  total: number | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface CloudUploadSelectionDto { localPath: string; fileName: string; size: number; }
export interface CloudDownloadPickerRequest { fileName: string; }
export interface CloudStartUploadRequest { localPath: string; folderId?: string | null; }
export interface CloudItemRequest { itemId: string; }
export interface CloudStartDownloadRequest { itemId: string; localPath: string; }
export interface CloudJobRequest { jobId: string; }

export interface PreviewUnavailable {
  available: false;
  command: string;
  reason: "native-media-engine-required";
}

export type MediaCommandResult<T> = T | PreviewUnavailable;

export const isTauriRuntime = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const previewMetadata = (): LibraryMetadataDto => ({
  rating: 0,
  favorite: false,
  watchedOverride: null,
  lastPosition: 0,
  duration: 0,
  updatedAt: 0,
  poseMarkers: [],
  watchState: "unwatched",
});

function previewResult<T>(command: string, payload: unknown): T {
  switch (command) {
    case "list_jobs": return { jobs: [] } as T;
    case "list_subtitle_capabilities": return {
      sourceLanguages: [
        { code: "ja", label: "Japanese" },
        { code: "en", label: "English" },
      ],
      targetLanguages: [{ code: "ko", label: "Korean" }],
      formats: ["srt", "vtt", "ass"],
      maxAudioBytes: 80 * 1024 * 1024,
      maxResultBytes: 2 * 1024 * 1024,
      maxOffsetSeconds: 24 * 60 * 60,
    } as T;
    case "start_or_generate_subtitle":
    case "import_subtitle":
    case "sync_subtitle": throw nativeUnavailableError();
    case "list_library": return {
      folder: (payload as LibraryListRequest | undefined)?.folder ?? null,
      folders: [], entries: [], missingOutputCount: 0, usageBytes: 0,
    } as T;
    case "get_settings": return { downloadFolder: "브라우저 미리보기 폴더" } as T;
    case "get_license": return {
      pro: false, maskedKey: null, expiresAt: null, daysRemaining: null, devices: null, limit: null,
    } as T;
    case "cloud_status": return {
      schemaVersion: 1,
      capability: "cloud-job-v1",
      executableAvailable: false,
      telegramConfigured: false,
    } as T;
    case "list_cloud_items": return [] as T;
    case "list_cloud_jobs": return [] as T;
    case "pick_cloud_upload":
    case "pick_cloud_download_destination": return null as T;
    case "start_cloud_upload":
    case "start_cloud_download":
    case "start_cloud_delete": return {
      jobId: `preview-${Date.now()}`,
      provider: "telegram", operation: "upload", itemId: "preview-item",
      status: "queued", phase: "queued", completed: null, total: null,
      progress: 0, fileName: null, error: null, createdAt: Date.now(), updatedAt: Date.now(),
    } as T;
    case "cancel_cloud_job": return undefined as T;
    case "update_library_metadata": return {
      changed: true, persisted: false,
      fileName: (payload as MetadataUpdateRequest).fileName,
      metadata: previewMetadata(),
    } as T;
    case "move_library_file": {
      const request = payload as MoveLibraryFileRequest;
      return { folder: request.destinationFolder ?? null, fileName: request.destinationFileName ?? request.fileName } as T;
    }
    case "delete_library_file": {
      const request = payload as DeleteLibraryFileRequest;
      return { folder: request.folder ?? null, fileName: request.fileName, recycled: true } as T;
    }
    case "delete_library_files": {
      const items = (payload as DeleteLibraryFilesRequest).items;
      return {
        items: items.map((item) => ({ item, recycled: true, errorCode: null })),
        succeeded: items.length, failed: 0,
      } as T;
    }
    case "auto_organize_library": return { applied: Boolean((payload as AutoOrganizeRequest)?.apply), items: [], succeeded: 0, failed: 0 } as T;
    case "verify_license": return { pro: true, maskedKey: "PREVIEW-••••-••••", expiresAt: null, daysRemaining: null, devices: 1, limit: 1 } as T;
    case "remove_license": return { pro: false, maskedKey: null, expiresAt: null, daysRemaining: null, devices: null, limit: null } as T;
    case "cancel_job":
    case "pause_job":
    case "resume_job":
    case "retry_job": return { jobId: (payload as JobIdRequest).jobId, accepted: true } as T;
    case "resolve_job_output":
    case "reveal_job_output": throw nativeUnavailableError();
    case "open_library_folder":
    case "reveal_library_file":
    case "recycle_library_file": return { accepted: true } as T;
    case "update_download_folder": return { downloadFolder: (payload as UpdateDownloadFolderRequest).downloadFolder } as T;
    default: throw new Error(`Unsupported preview command: ${command}`);
  }
}

function nativeUnavailableError(): Error {
  const error = new Error("이 작업은 Tauri Companion에서 사용할 수 있습니다.");
  Object.assign(error, { code: "native-unavailable" });
  return error;
}

function previewMediaResult<T>(command: string): MediaCommandResult<T> {
  return { available: false, command, reason: "native-media-engine-required" };
}

function commandError(error: unknown): CommandError {
  if (error && typeof error === "object") {
    const candidate = error as Partial<CommandError>;
    if (typeof candidate.code === "string" && typeof candidate.message === "string") {
      return { code: candidate.code, message: candidate.message };
    }
  }
  return { code: "command-failed", message: typeof error === "string" ? error : "Companion 작업을 완료하지 못했습니다." };
}

async function command<T>(name: string, payload?: unknown): Promise<T> {
  if (!isTauriRuntime()) return previewResult<T>(name, payload);
  try {
    return await invoke<T>(name, payload === undefined ? undefined : { request: payload });
  } catch (error) {
    const normalized = commandError(error);
    const wrapped = new Error(normalized.message);
    Object.assign(wrapped, { code: normalized.code });
    throw wrapped;
  }
}

async function mediaCommand<T>(name: string, payload: unknown): Promise<MediaCommandResult<T>> {
  if (!isTauriRuntime()) return previewMediaResult<T>(name);
  try {
    return await invoke<T>(name, { request: payload });
  } catch (error) {
    const normalized = commandError(error);
    const wrapped = new Error(normalized.message);
    Object.assign(wrapped, { code: normalized.code });
    throw wrapped;
  }
}

export function isPreviewUnavailable<T>(result: MediaCommandResult<T>): result is PreviewUnavailable {
  return typeof result === "object" && result !== null && "available" in result && result.available === false;
}

/**
 * Rust has already checked the media reference and allowed this exact output
 * in the Tauri asset scope. Browser preview deliberately returns no asset URL.
 */
export function authorizedAssetUrl(response: Pick<PrepareMediaSourceResponse, "path"> | Pick<SeekPreviewResponse, "path"> | Pick<ThumbnailResponse, "path"> | Pick<GifExportResponse, "path">): string | null {
  if (!isTauriRuntime() || !response.path) return null;
  return convertFileSrc(response.path);
}

export const listJobs = (): Promise<JobsResponse> => command("list_jobs");
export const cancelJob = (request: JobIdRequest): Promise<JobActionResponse> => command("cancel_job", request);
export const pauseJob = (request: JobIdRequest): Promise<JobActionResponse> => command("pause_job", request);
export const resumeJob = (request: JobIdRequest): Promise<JobActionResponse> => command("resume_job", request);
export const retryJob = (request: JobIdRequest): Promise<JobActionResponse> => command("retry_job", request);
export const resolveJobOutput = (request: JobIdRequest): Promise<JobOutputDto> => command("resolve_job_output", request);
export const revealJobOutput = (request: JobIdRequest): Promise<SystemOperationResponse> => command("reveal_job_output", request);
export const listLibrary = (request: LibraryListRequest): Promise<LibraryListResponse> => command("list_library", request);
export const updateLibraryMetadata = (request: MetadataUpdateRequest): Promise<MetadataUpdateResponse> => command("update_library_metadata", request);
export const moveLibraryFile = (request: MoveLibraryFileRequest): Promise<MoveLibraryFileResponse> => command("move_library_file", request);
export const deleteLibraryFile = (request: DeleteLibraryFileRequest): Promise<DeleteLibraryFileResponse> => command("delete_library_file", request);
export const deleteLibraryFiles = (request: DeleteLibraryFilesRequest): Promise<DeleteLibraryFilesResponse> => command("delete_library_files", request);
export const autoOrganizeLibrary = (request: AutoOrganizeRequest): Promise<AutoOrganizeResponse> => command("auto_organize_library", request);
export const getLicense = (): Promise<LicenseDto> => command("get_license");
export const verifyLicense = (request: VerifyLicenseRequest): Promise<LicenseDto> => command("verify_license", request);
export const removeLicense = (): Promise<LicenseDto> => command("remove_license");
export const getSettings = (): Promise<SettingsDto> => command("get_settings");
export const updateDownloadFolder = (request: UpdateDownloadFolderRequest): Promise<SettingsDto> => command("update_download_folder", request);
export const openLibraryFolder = (request: LibraryFolderRequest): Promise<SystemOperationResponse> => command("open_library_folder", request);
export const revealLibraryFile = (request: RevealLibraryFileRequest): Promise<SystemOperationResponse> => command("reveal_library_file", request);
export const recycleLibraryFile = (request: RevealLibraryFileRequest): Promise<SystemOperationResponse> => command("recycle_library_file", request);
export const prepareMediaSource = (request: MediaFileRequest): Promise<MediaCommandResult<PrepareMediaSourceResponse>> => mediaCommand("prepare_media_source", request);
export const openMediaExternally = (request: MediaFileRequest): Promise<MediaCommandResult<SystemOperationResponse>> => mediaCommand("open_media_externally", request);
export const remuxTsToMp4 = (request: MediaFileRequest): Promise<MediaCommandResult<RemuxTsToMp4Response>> => mediaCommand("remux_ts_to_mp4", request);
export const generateSeekPreview = (request: SeekPreviewRequest): Promise<MediaCommandResult<SeekPreviewResponse>> => mediaCommand("generate_seek_preview", request);
export const generateThumbnail = (request: MediaFileRequest): Promise<MediaCommandResult<ThumbnailResponse>> => mediaCommand("generate_thumbnail", request);
export const loadSidecarSubtitles = (request: MediaFileRequest): Promise<MediaCommandResult<SidecarSubtitlesResponse>> => mediaCommand("load_sidecar_subtitles", request);
export const exportGif = (request: GifExportRequest): Promise<MediaCommandResult<GifExportResponse>> => mediaCommand("export_gif", request);
export const listSubtitleCapabilities = (): Promise<SubtitleCapabilitiesDto> => command("list_subtitle_capabilities");
export const startOrGenerateSubtitle = (request: StartOrGenerateSubtitleRequest): Promise<SubtitleJobResponse> => command("start_or_generate_subtitle", request);
export const importSubtitle = (request: ImportSubtitleRequest): Promise<ImportSubtitleResponse> => command("import_subtitle", request);
export const syncSubtitle = (request: SyncSubtitleRequest): Promise<SyncSubtitleResponse> => command("sync_subtitle", request);
export const cloudStatus = (): Promise<CloudStatusDto> => command("cloud_status");
export const listCloudItems = (): Promise<CloudItemDto[]> => command("list_cloud_items");
export const listCloudJobs = (): Promise<CloudJobDto[]> => command("list_cloud_jobs");
export const pickCloudUpload = (): Promise<CloudUploadSelectionDto | null> => command("pick_cloud_upload");
export const pickCloudDownloadDestination = (request: CloudDownloadPickerRequest): Promise<string | null> => command("pick_cloud_download_destination", request);
export const startCloudUpload = (request: CloudStartUploadRequest): Promise<CloudJobDto> => command("start_cloud_upload", request);
export const startCloudDownload = (request: CloudStartDownloadRequest): Promise<CloudJobDto> => command("start_cloud_download", request);
export const startCloudDelete = (request: CloudItemRequest): Promise<CloudJobDto> => command("start_cloud_delete", request);
export const cancelCloudJob = (request: CloudJobRequest): Promise<void> => command("cancel_cloud_job", request);
