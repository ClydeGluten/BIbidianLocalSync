import type { FileKind } from "../model";

export interface ListedFile {
  path: string;
  kind: Exclude<FileKind, "deleted">;
  size: number;
  mtime: number;
}

export interface WrittenFile {
  size: number;
  mtime: number;
}

export interface SyncFileStore {
  list(): Promise<ListedFile[]>;
  read(path: string): Promise<ArrayBuffer>;
  write(path: string, content: ArrayBuffer): Promise<WrittenFile>;
  trash(path: string): Promise<void>;
  stat(path: string): Promise<ListedFile | null>;
  conflictPath(path: string, sourceDeviceId: string, changedAt: number): string;
}
