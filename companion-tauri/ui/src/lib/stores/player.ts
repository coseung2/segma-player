import { writable } from "svelte/store";
import type { LibraryEntryDto } from "../api";
import { mediaIdentity } from "../selection-identity";

export interface PlayerSelection {
  folder: string | null;
  entry: LibraryEntryDto;
}

export interface PlayerState {
  selection: PlayerSelection | null;
  entries: LibraryEntryDto[];
  index: number;
}

const initial: PlayerState = { selection: null, entries: [], index: -1 };

export const playerState = writable<PlayerState>(initial);

export function selectMedia(entry: LibraryEntryDto, folder: string | null, entries: LibraryEntryDto[]): void {
  const identity = mediaIdentity(folder, entry.fileName);
  const index = entries.findIndex((item) => mediaIdentity(folder, item.fileName) === identity);
  playerState.set({ selection: { folder, entry }, entries: [...entries], index });
}

export function selectAdjacent(offset: -1 | 1): void {
  playerState.update((state) => {
    const nextIndex = state.index + offset;
    const entry = state.entries[nextIndex];
    if (!entry || !state.selection) return state;
    return {
      ...state,
      index: nextIndex,
      selection: { ...state.selection, entry },
    };
  });
}

export function replaceSelectedFile(fileName: string, typeLabel = "MP4"): void {
  playerState.update((state) => {
    if (!state.selection) return state;
    const currentIndex = state.index >= 0
      ? state.index
      : state.entries.findIndex((item) => mediaIdentity(state.selection?.folder, item.fileName)
        === mediaIdentity(state.selection?.folder, state.selection?.entry.fileName ?? ""));
    if (currentIndex < 0) return state;
    const current = state.entries[currentIndex];
    const entry = { ...current, fileName, typeLabel };
    const entries = state.entries.map((item, index) => (index === currentIndex ? entry : item));
    return { ...state, entries, selection: { ...state.selection, entry } };
  });
}

export function clearSelection(): void {
  playerState.set(initial);
}
