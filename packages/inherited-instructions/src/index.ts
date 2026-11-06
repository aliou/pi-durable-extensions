import type { Context } from "@earendil-works/chord/context";
import {
  defineExtension,
  type PromptInput,
  section,
} from "@earendil-works/pi-durable";
import {
  type ContextFile,
  DEFAULT_CANDIDATES,
  loadContextFile,
  loadProjectContextFiles,
} from "./loader";
import {
  INHERITED_INSTRUCTIONS_EXTENSION_NAME,
  PROJECT_INSTRUCTIONS_SECTION_KEY,
} from "./names";

export {
  type ContextFile,
  DEFAULT_CANDIDATES,
  loadContextFile,
  loadProjectContextFiles,
} from "./loader";
export {
  INHERITED_INSTRUCTIONS_EXTENSION_NAME,
  PROJECT_INSTRUCTIONS_SECTION_KEY,
} from "./names";

export const PROJECT_INSTRUCTIONS_HEADER =
  "Project-specific instructions and guidelines:";

export type ExtraFile = {
  path: string;
  position?: "prepend" | "append";
};

export type InheritedInstructionsOptions = {
  candidates?: readonly string[];
  header?: string;
  extraFiles?: readonly ExtraFile[];
};

function renderProjectContext(
  header: string,
  files: readonly ContextFile[],
): string {
  return [
    header,
    ...files.map(
      ({ path, content }) =>
        `<project_instructions path="${path}">\n${content}\n</project_instructions>`,
    ),
  ]
    .filter((part) => part !== "")
    .join("\n\n");
}

async function loadExtraFiles(
  fs: NonNullable<PromptInput["env"]>,
  extraFiles: readonly ExtraFile[],
  context: Context,
): Promise<ContextFile[]> {
  const files: ContextFile[] = [];
  for (const { path } of extraFiles) {
    const file = await loadContextFile(fs, path, context);
    if (file !== undefined) files.push(file);
  }
  return files;
}

function mergeFiles(
  inherited: readonly ContextFile[],
  extra: readonly ExtraFile[],
  loaded: readonly ContextFile[],
): ContextFile[] {
  const byPath = new Map(loaded.map((file) => [file.path, file]));
  const contentOf = (path: string) => byPath.get(path);
  const ordered = [
    ...extra
      .filter((file) => file.position === "prepend")
      .flatMap((file) => contentOf(file.path) ?? []),
    ...inherited,
    ...extra
      .filter((file) => (file.position ?? "append") === "append")
      .flatMap((file) => contentOf(file.path) ?? []),
  ];
  const seen = new Set<string>();
  return ordered.filter((file) => {
    if (seen.has(file.path)) return false;
    seen.add(file.path);
    return true;
  });
}

export function createInheritedInstructionsExtension(
  options: InheritedInstructionsOptions = {},
) {
  const candidates = options.candidates ?? DEFAULT_CANDIDATES;
  const header = options.header ?? PROJECT_INSTRUCTIONS_HEADER;
  const extraFiles = options.extraFiles;
  return defineExtension({
    name: INHERITED_INSTRUCTIONS_EXTENSION_NAME,
    sections: [
      section(
        PROJECT_INSTRUCTIONS_SECTION_KEY,
        async (input, context) => {
          const env = input.env;
          if (env === undefined) return undefined;
          const inherited = await loadProjectContextFiles(
            env,
            { candidates },
            context,
          );
          const extra =
            extraFiles === undefined
              ? []
              : await loadExtraFiles(env, extraFiles, context);
          const files = mergeFiles(inherited, extraFiles ?? [], extra);
          if (files.length === 0) return undefined;
          return renderProjectContext(header, files);
        },
        { tag: false },
      ),
    ],
  });
}

export const InheritedInstructions = createInheritedInstructionsExtension();
