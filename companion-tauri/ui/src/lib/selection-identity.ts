export function normalizeFolder(folder: string | null | undefined): string | null {
  if (typeof folder !== "string") return null;
  const normalized = folder
    .trim()
    .replaceAll("\\", "/")
    .split("/")
    .filter((part) => part.length > 0 && part !== ".")
    .join("/");
  return normalized || null;
}

export function normalizeFileName(fileName: string): string {
  return fileName.trim().replaceAll("\\", "/");
}

export function mediaIdentity(folder: string | null | undefined, fileName: string): string {
  return `${normalizeFolder(folder) ?? ""}\u0000${normalizeFileName(fileName)}`;
}

export function mediaIdentityMatches(
  identity: string,
  folder: string | null | undefined,
  fileName: string,
): boolean {
  return identity === mediaIdentity(folder, fileName);
}

export function mediaFolderMatches(identity: string, folder: string | null | undefined): boolean {
  const separator = identity.indexOf("\u0000");
  return separator >= 0 && identity.slice(0, separator) === (normalizeFolder(folder) ?? "");
}

/**
 * Deterministic race-test seam: same basenames in different folders must not
 * compare equal, even when callers provide Windows separators or whitespace.
 */
export function mediaIdentityProbe(): { first: string; second: string; distinct: boolean } {
  const first = mediaIdentity("Season\\One", " clip.mp4 ");
  const second = mediaIdentity("Season/Two", "clip.mp4");
  return { first, second, distinct: first !== second };
}
