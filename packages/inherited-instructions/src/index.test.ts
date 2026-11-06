import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  createModels,
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai";
import {
  createRegistry,
  Harness,
  MemoryStorage,
  SystemEntry,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { vol } from "memfs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createInheritedInstructionsExtension,
  InheritedInstructions,
  PROJECT_INSTRUCTIONS_HEADER,
} from "./index";

vi.mock("node:fs");
vi.mock("node:fs/promises");

const model = { provider: "faux", modelId: "faux-1" };

beforeEach(() => {
  vol.reset();
});

function makeTree(files: Record<string, string>) {
  vol.fromJSON(files);
}

async function openHarness(root: string, extension = InheritedInstructions) {
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage("Done."),
  ] satisfies FauxResponseStep[]);
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  registry.install(extension);
  const harness = await Harness.open(
    new MemoryStorage(),
    { models, registry, env: ({ cwd = "/" }) => new NodeExecutionEnv({ cwd }) },
    context,
  );
  const conversation = await harness.root(context, {
    agent: { model, cwd: root },
  });
  return { conversation, harness };
}

type OpenHarness = Awaited<ReturnType<typeof openHarness>>;

async function submit(
  conversation: OpenHarness["conversation"],
  content: string,
) {
  const submission = await conversation.submit(
    { type: "input", content },
    context,
  );
  await submission.wait(context);
}

type SystemSections = Array<[string, string | null]>;

function sectionsOf(
  entry: Parameters<typeof SystemEntry.is>[0],
): SystemSections {
  const message = entry?.model?.[0];
  return message?.role === "system"
    ? Object.entries(message.sections ?? {})
    : [];
}

async function systemSections(
  conversation: OpenHarness["conversation"],
): Promise<SystemSections> {
  const page = await conversation.entries({}, 20, undefined, context);
  const entries = [...page.items]
    .reverse()
    .filter((entry) => SystemEntry.is(entry));
  return entries.flatMap(sectionsOf);
}

describe("InheritedInstructions", () => {
  it("renders ancestor context files as a project instructions section", async () => {
    makeTree({
      "/repo/AGENTS.md": "repo rules",
      "/repo/packages/app/AGENTS.md": "app rules",
    });
    const { conversation, harness } = await openHarness("/repo/packages/app");
    await submit(conversation, "hi");

    const sections = await systemSections(conversation);
    const instructions = sections.find(
      ([key]) => key === "project_instructions",
    )?.[1];
    expect(instructions).toContain(PROJECT_INSTRUCTIONS_HEADER);
    expect(instructions).toContain(
      '<project_instructions path="/repo/AGENTS.md">\nrepo rules\n',
    );
    expect(instructions?.indexOf("repo rules") ?? 0).toBeLessThan(
      instructions?.indexOf("app rules") ?? 0,
    );
    await harness.close(context);
  });

  it("renders no section when the tree has no context files", async () => {
    makeTree({ "/repo/README.md": "readme" });
    const { conversation, harness } = await openHarness("/repo");
    await submit(conversation, "hi");

    const sections = await systemSections(conversation);
    expect(sections.some(([key]) => key === "project_instructions")).toBe(
      false,
    );
    await harness.close(context);
  });

  it("appends extra files after the inherited ones by default", async () => {
    makeTree({
      "/repo/AGENTS.md": "repo rules",
      "/shared/AGENTS.md": "other rules",
    });
    const { conversation, harness } = await openHarness(
      "/repo",
      createInheritedInstructionsExtension({
        extraFiles: [{ path: "/shared/AGENTS.md" }],
      }),
    );
    await submit(conversation, "hi");

    const sections = await systemSections(conversation);
    const instructions = sections.find(
      ([key]) => key === "project_instructions",
    )?.[1];
    expect(instructions?.indexOf("repo rules") ?? 0).toBeLessThan(
      instructions?.indexOf("other rules") ?? 0,
    );
    expect(instructions).toContain("/shared/AGENTS.md");
    await harness.close(context);
  });

  it("prepends extra files before the inherited ones", async () => {
    makeTree({
      "/repo/AGENTS.md": "repo rules",
      "/shared/AGENTS.md": "other rules",
    });
    const { conversation, harness } = await openHarness(
      "/repo",
      createInheritedInstructionsExtension({
        extraFiles: [{ path: "/shared/AGENTS.md", position: "prepend" }],
      }),
    );
    await submit(conversation, "hi");

    const sections = await systemSections(conversation);
    const instructions = sections.find(
      ([key]) => key === "project_instructions",
    )?.[1];
    expect(instructions?.indexOf("other rules") ?? 0).toBeLessThan(
      instructions?.indexOf("repo rules") ?? 0,
    );
    await harness.close(context);
  });

  it("skips extra files that do not exist", async () => {
    makeTree({ "/repo/AGENTS.md": "repo rules" });
    const { conversation, harness } = await openHarness(
      "/repo",
      createInheritedInstructionsExtension({
        extraFiles: [{ path: "/repo/missing.md" }],
      }),
    );
    await submit(conversation, "hi");

    const sections = await systemSections(conversation);
    const instructions = sections.find(
      ([key]) => key === "project_instructions",
    )?.[1];
    expect(instructions).toContain("repo rules");
    expect(instructions).not.toContain("missing.md");
    await harness.close(context);
  });

  it("merges per-file positions and renders a shared file once", async () => {
    makeTree({
      "/repo/AGENTS.md": "repo rules",
      "/shared/global/AGENTS.md": "global rules",
      "/shared/style/AGENTS.md": "style rules",
    });
    const { conversation, harness } = await openHarness(
      "/repo",
      createInheritedInstructionsExtension({
        extraFiles: [
          { path: "/shared/global/AGENTS.md", position: "prepend" },
          { path: "/repo/AGENTS.md", position: "prepend" },
          { path: "/shared/style/AGENTS.md" },
        ],
      }),
    );
    await submit(conversation, "hi");

    const sections = await systemSections(conversation);
    const instructions = sections.find(
      ([key]) => key === "project_instructions",
    )?.[1];
    const indexOf = (rules: string) => instructions?.indexOf(rules) ?? -1;
    expect(indexOf("global rules")).toBeLessThan(indexOf("repo rules"));
    expect(indexOf("repo rules")).toBeLessThan(indexOf("style rules"));
    expect(instructions?.match(/repo rules/g)?.length).toBe(1);
    await harness.close(context);
  });

  it("respects custom candidates and header", async () => {
    makeTree({ "/repo/NOTES.md": "note rules" });
    const { conversation, harness } = await openHarness(
      "/repo",
      createInheritedInstructionsExtension({
        candidates: ["NOTES.md"],
        header: "Notes:",
      }),
    );
    await submit(conversation, "hi");

    const sections = await systemSections(conversation);
    const instructions = sections.find(
      ([key]) => key === "project_instructions",
    )?.[1];
    expect(instructions).toContain("Notes:");
    expect(instructions).toContain("note rules");
    await harness.close(context);
  });
});
