import type { Context } from "@earendil-works/chord/context";
import {
  AssistantEntry,
  type Cursor,
  defineExtension,
  type EntryId,
  GenerationTask,
  type HookApi,
  hook,
  type ModelRef,
  runEndTask,
} from "@earendil-works/pi-durable";
import {
  SESSION_TITLE_EXTENSION_NAME,
  SESSION_TITLE_REQUEST_KIND,
} from "./names";
import { buildTitlePrompt } from "./prompt";
import { createSessionTitleTasks } from "./tasks";
import { SetTitleTool } from "./tool";

export { SessionTitleDoc, type SessionTitleState } from "./state";

async function hasPriorAnswer(api: HookApi, answer: EntryId, context: Context) {
  let cursor: Cursor | undefined;
  do {
    const page = await api.entries(
      { maxEntryId: answer, order: "descending" },
      100,
      cursor,
      context,
    );
    if (
      page.items.some(
        (entry) =>
          entry.id !== answer &&
          entry.kind === AssistantEntry.kind &&
          entry.model?.some(
            (message) =>
              message.role === "assistant" && message.stopReason === "stop",
          ),
      )
    )
      return true;
    cursor = page.next;
  } while (cursor !== undefined);
  return false;
}

export function createSessionTitleExtension(
  options: { model?: ModelRef } = {},
) {
  const { LaunchTitleTask, GenerateTitleTask } = createSessionTitleTasks(
    options.model ?? null,
  );
  return defineExtension({
    name: SESSION_TITLE_EXTENSION_NAME,
    tools: [SetTitleTool],
    tasks: [LaunchTitleTask, GenerateTitleTask],
    hooks: [
      hook(GenerationTask, {
        afterRun: async (run, api, context) => {
          if (run.reason !== "answer") return;
          const first = await api.entry(run.first, context);
          if (first?.kind === SESSION_TITLE_REQUEST_KIND) return;
          if (await hasPriorAnswer(api, run.answer, context)) return;
          const recent = await api.entries(
            { maxEntryId: run.answer, order: "descending" },
            100,
            undefined,
            context,
          );
          return {
            tasks: [
              runEndTask(LaunchTitleTask, {
                prompt: buildTitlePrompt(recent.items),
              }),
            ],
          };
        },
      }),
    ],
  });
}
