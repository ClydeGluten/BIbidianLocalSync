import { normalizePath } from "obsidian";

export interface PathPolicyOptions {
  configDir: string;
  ignoredPathPrefixes: readonly string[];
  maxPathLength?: number;
}

const WINDOWS_ABSOLUTE = /^[a-zA-Z]:[\\/]/;

export class PathPolicy {
  private readonly excludedPrefixes: string[];
  private readonly maxPathLength: number;

  constructor(options: PathPolicyOptions) {
    const configDir = normalizePath(options.configDir);
    this.maxPathLength = options.maxPathLength ?? 1024;
    this.excludedPrefixes = [
      configDir,
      ".trash",
      ...options.ignoredPathPrefixes.map((path) => normalizePath(path))
    ].filter(Boolean);
  }

  normalizeAndValidate(input: unknown): string {
    if (typeof input !== "string" || input.length === 0 || input.length > this.maxPathLength) {
      throw new Error("Invalid sync path length");
    }
    if (input.includes("\0") || input.startsWith("/") || WINDOWS_ABSOLUTE.test(input)) {
      throw new Error("Absolute and null-containing sync paths are not allowed");
    }
    const rawSegments = input.replaceAll("\\", "/").split("/");
    if (rawSegments.some((segment) => segment === "..")) {
      throw new Error("Parent path traversal is not allowed");
    }

    const normalized = normalizePath(input);
    if (!normalized || normalized === "." || normalized.startsWith("../")) {
      throw new Error("Invalid normalized sync path");
    }
    if (this.excludedPrefixes.some(
      (prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`)
    )) {
      throw new Error(`The path is excluded from synchronization: ${normalized}`);
    }
    return normalized;
  }

  allows(input: unknown): input is string {
    try {
      this.normalizeAndValidate(input);
      return true;
    } catch {
      return false;
    }
  }
}
