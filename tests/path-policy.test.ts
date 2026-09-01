import { describe, expect, it } from "vitest";
import { PathPolicy } from "../src/sync/path-policy";

const policy = new PathPolicy({
  configDir: ".obsidian",
  ignoredPathPrefixes: ["Private"]
});

describe("PathPolicy", () => {
  it("normalizes safe vault paths", () => {
    expect(policy.normalizeAndValidate("Notes//today.md")).toBe("Notes/today.md");
  });

  it.each([
    "../outside.md",
    "/absolute.md",
    "C:\\vault\\note.md",
    ".obsidian/plugins/secrets.json",
    ".trash/deleted.md",
    "Private/note.md"
  ])("rejects unsafe or excluded path %s", (path) => {
    expect(() => policy.normalizeAndValidate(path)).toThrow();
  });
});
