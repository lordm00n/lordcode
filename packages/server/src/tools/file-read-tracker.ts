export interface FileSnapshot {
  mtimeMs: number;
  size: number;
}

export interface FileReadTracker {
  /** Record a successful file read. */
  record(absPath: string, snapshot: FileSnapshot): void;
  /** Look up the last recorded snapshot. */
  get(absPath: string): FileSnapshot | undefined;
  /** Clear the record (e.g. when a file is deleted). */
  forget(absPath: string): void;
}

export function createInMemoryFileReadTracker(): FileReadTracker {
  const map = new Map<string, FileSnapshot>();
  return {
    record: (p, s) => { map.set(p, s); },
    get: (p) => map.get(p),
    forget: (p) => { map.delete(p); },
  };
}
