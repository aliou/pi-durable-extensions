import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { vol } from "memfs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_CANDIDATES,
  loadContextFile,
  loadProjectContextFiles,
} from "./loader";

vi.mock("node:fs");
vi.mock("node:fs/promises");

beforeEach(() => {
  vol.reset();
});

async function load(cwd: string, candidates?: readonly string[]) {
  const env = new NodeExecutionEnv({ cwd });
  return loadProjectContextFiles(
    env,
    candidates === undefined ? undefined : { candidates },
    context,
  );
}

describe("loadProjectContextFiles", () => {
  it("collects context files from the working directory and its ancestors, root-most first", async () => {
    vol.fromJSON({
      "/repo/AGENTS.md": "root rules",
      "/repo/packages/app/AGENTS.md": "app rules",
      "/repo/packages/app/src/AGENTS.md": "src rules",
    });
    const files = await load("/repo/packages/app/src");
    expect(files.map((file) => file.content)).toEqual([
      "root rules",
      "app rules",
      "src rules",
    ]);
    expect(files[0]?.path).toBe("/repo/AGENTS.md");
    expect(files[2]?.path).toBe("/repo/packages/app/src/AGENTS.md");
  });

  it("prefers the first matching candidate in a directory", async () => {
    vol.fromJSON({
      "/repo/AGENTS.md": "generic",
      "/repo/AGENTS.override.md": "override",
    });
    const files = await load("/repo");
    expect(files).toEqual([
      { path: "/repo/AGENTS.override.md", content: "override" },
    ]);
  });

  it("falls through to the next candidate when a higher one is not a readable file", async () => {
    vol.fromJSON({
      "/repo/AGENTS.override.md": null,
      "/repo/AGENTS.md": "agents rules",
    });
    const files = await load("/repo");
    expect(files).toEqual([
      { path: "/repo/AGENTS.md", content: "agents rules" },
    ]);
  });

  it("strips a byte-order mark", async () => {
    vol.fromJSON({ "/repo/AGENTS.md": "﻿rules" });
    const files = await load("/repo");
    expect(files[0]?.content).toBe("rules");
  });

  it("returns no files when the tree has none", async () => {
    vol.fromJSON({ "/repo/README.md": "readme" });
    const files = await load("/repo");
    expect(files).toEqual([]);
  });

  it("ignores files outside the default candidates", async () => {
    vol.fromJSON({
      "/repo/CLAUDE.md": "claude rules",
      "/repo/NOTES.md": "note rules",
    });
    const files = await load("/repo");
    expect(files).toEqual([]);
  });

  it("supports custom candidates", async () => {
    vol.fromJSON({
      "/repo/AGENTS.md": "agents",
      "/repo/NOTES.md": "notes",
    });
    const files = await load("/repo", ["NOTES.md"]);
    expect(files.map((file) => file.content)).toEqual(["notes"]);
    expect(DEFAULT_CANDIDATES[0]).toBe("AGENTS.override.md");
  });

  it("stops at the file system root", async () => {
    const files = await load("/", ["definitely-missing.md"]);
    expect(files).toEqual([]);
  });

  it("loadContextFile resolves absolute and relative paths", async () => {
    vol.fromJSON({ "/repo/notes/extra.md": "extra rules" });
    const env = new NodeExecutionEnv({ cwd: "/repo" });
    const absolute = await loadContextFile(
      env,
      "/repo/notes/extra.md",
      context,
    );
    expect(absolute).toEqual({
      path: "/repo/notes/extra.md",
      content: "extra rules",
    });
    const relative = await loadContextFile(env, "notes/extra.md", context);
    expect(relative?.content).toBe("extra rules");
    const missing = await loadContextFile(env, "/repo/missing.md", context);
    expect(missing).toBeUndefined();
  });
});
