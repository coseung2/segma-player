import { createNativeFileWriter } from "./native-file-writer.js";
import { createUniqueFile, hasReadWritePermission } from "./save-directory.js";
import { cuesToSrt, mediaIdentifier, parseSubtitle } from "./player-subtitle.js";
import { getStoredSubtitleDirectory } from "./subtitle-folder.js";

export function generatedSubtitleFilename(title, mediaUrl) {
  const safeTitle = String(title || "")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .trim()
    .slice(0, 120);
  return `${safeTitle || mediaIdentifier(mediaUrl) || "aura-subtitle"}.srt`;
}

export async function saveGeneratedSubtitleSrt(input, vtt, dependencies = {}) {
  const srt = cuesToSrt(parseSubtitle(vtt));
  if (!srt) throw new Error("empty-srt");
  const filename = generatedSubtitleFilename(input?.title, input?.mediaUrl);
  const createWriter = dependencies.createWriter || createNativeFileWriter;
  let writer = null;
  let companionError = null;
  try {
    writer = await createWriter(filename);
    await writer.write(new TextEncoder().encode(srt));
    const closed = await writer.close();
    return {
      filename: closed?.fileName || writer.name || filename,
      folderName: "Downloads\\Aura Media",
      destination: "companion",
    };
  } catch (error) {
    companionError = error;
    try { await writer?.abort(); } catch { /* best effort */ }
  }

  const getDirectory = dependencies.getDirectory || getStoredSubtitleDirectory;
  const hasPermission = dependencies.hasPermission || hasReadWritePermission;
  const createFile = dependencies.createFile || createUniqueFile;
  const directory = await getDirectory();
  if (!directory || !await hasPermission(directory)) {
    const error = new Error("subtitle-save-permission-required", { cause: companionError });
    error.code = "subtitle-save-permission-required";
    throw error;
  }
  const output = await createFile(directory, filename);
  const writable = await output.fileHandle.createWritable();
  try {
    await writable.write(srt);
  } finally {
    await writable.close();
  }
  return {
    filename: output.filename,
    folderName: directory.name || "자막 폴더",
    destination: "folder",
  };
}
