import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  createModels,
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import {
  createRegistry,
  Harness,
  MemoryStorage,
} from "@earendil-works/pi-durable";
import { expect } from "vitest";
import { createSessionTitleExtension, SessionTitleDoc } from "./index";
import { createSessionTitleTasks } from "./tasks";

export const sourceModel = { provider: "faux", modelId: "source" };
export const namingModel = { provider: "faux", modelId: "naming" };
export const { LaunchTitleTask } = createSessionTitleTasks(null);

export class RestartableMemoryStorage extends MemoryStorage {
  override close() {
    return Promise.resolve();
  }
}

export async function openHarness(
  responses: FauxResponseStep[],
  {
    storage = new MemoryStorage(),
    model,
  }: { storage?: MemoryStorage; model?: typeof namingModel } = {},
) {
  const faux = fauxProvider({ models: [{ id: "source" }, { id: "naming" }] });
  faux.setResponses(responses);
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  registry.install(createSessionTitleExtension({ model }));
  const harness = await Harness.open(
    storage,
    { models, registry, settings: { retry: { enabled: false } } },
    context,
  );
  const root = await harness.root(context, { agent: { model: sourceModel } });
  return { harness, root, faux, storage };
}

export type Opened = Awaited<ReturnType<typeof openHarness>>;

export function titleCall(title: string) {
  return fauxAssistantMessage(fauxToolCall("set_title", { title }), {
    stopReason: "toolUse",
  });
}

export async function submit(
  opened: Opened,
  content = "Explain connection timeouts",
) {
  const submission = await opened.root.submit(
    { type: "input", content },
    context,
  );
  await submission.wait(context);
}

export async function idle(opened: Opened) {
  await expect
    .poll(async () => {
      const inspection = await opened.harness.inspect(context);
      return inspection.tasks.length;
    })
    .toBe(0);
}

export async function state(opened: Opened) {
  return opened.harness.snapshot(SessionTitleDoc, opened.root.id, context);
}

export async function launch(
  opened: Opened,
  prompt = "<conversation><user>Recent topic</user></conversation>",
) {
  await opened.root.commit(
    async (tx) =>
      tx.createTask(
        LaunchTitleTask,
        { prompt },
        {
          ownership: { kind: "conversation" },
          conversationId: opened.root.id,
        },
      ),
    context,
  );
  opened.harness.resume();
}

export async function tasks(opened: Opened) {
  return opened.root.commit(async (tx) => {
    const page = await tx.scanTasks(
      { conversationId: opened.root.id, kind: "session-title.generate" },
      100,
    );
    return page.items;
  }, context);
}

export async function namingConversations(opened: Opened) {
  return opened.root.commit(async (tx) => {
    const page = await tx.scanConversations(
      { ownerConversationId: opened.root.id },
      100,
    );
    return page.items;
  }, context);
}

export function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export async function waitForSignal(signal: AbortSignal | undefined) {
  await new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    signal?.addEventListener("abort", () => resolve(), { once: true });
  });
}
