import type { Context } from "@earendil-works/chord/context";
import type { FileSystem } from "@earendil-works/pi-durable/env";

export type ContextFile = {
  path: string;
  content: string;
};

export const DEFAULT_CANDIDATES = [
  "AGENTS.override.md",
  "AGENTS.md",
  "AGENTS.MD",
] as const;

const BOM = "\uFEFF";

export function stripBom(content: string): string {
  return content.startsWith(BOM) ? content.slice(BOM.length) : content;
}

export async function loadContextFile(
  fs: FileSystem,
  path: string,
  context: Context,
): Promise<ContextFile | undefined> {
  const absolute = await fs.absolutePath(path, context);
  if (!absolute.ok) return undefined;
  const read = await fs.readTextFile(absolute.value, context);
  if (!read.ok) return undefined;
  return { path: absolute.value, content: stripBom(read.value) };
}

async function loadContextFileFromDir(
  fs: FileSystem,
  dir: string,
  candidates: readonly string[],
  context: Context,
): Promise<ContextFile | undefined> {
  for (const filename of candidates) {
    const joined = await fs.joinPath([dir, filename], context);
    if (!joined.ok) continue;
    const read = await fs.readTextFile(joined.value, context);
    if (!read.ok) continue;
    return { path: joined.value, content: stripBom(read.value) };
  }
  return undefined;
}

export async function loadProjectContextFiles(
  fs: FileSystem,
  options: { candidates?: readonly string[] } | undefined,
  context: Context,
): Promise<ContextFile[]> {
  const candidates = options?.candidates ?? DEFAULT_CANDIDATES;
  const start = await fs.absolutePath(fs.cwd, context);
  if (!start.ok) return [];

  const files: ContextFile[] = [];
  let dir = start.value;
  while (true) {
    const file = await loadContextFileFromDir(fs, dir, candidates, context);
    if (file !== undefined) files.unshift(file);

    const parent = await fs.joinPath([dir, ".."], context);
    if (!parent.ok || parent.value === dir) break;
    dir = parent.value;
  }
  return files;
}
