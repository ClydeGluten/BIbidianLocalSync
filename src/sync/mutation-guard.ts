export class RemoteMutationGuard {
  private readonly paths = new Map<string, number>();

  constructor(private readonly lifetimeMs = 15_000) {}

  mark(path: string): void {
    this.paths.set(path, Date.now() + this.lifetimeMs);
  }

  consume(path: string): boolean {
    this.cleanup();
    if (!this.paths.has(path)) return false;
    this.paths.delete(path);
    return true;
  }

  clear(): void {
    this.paths.clear();
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [path, expiresAt] of this.paths) {
      if (expiresAt <= now) this.paths.delete(path);
    }
  }
}
