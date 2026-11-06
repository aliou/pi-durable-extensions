import { contentText } from "@earendil-works/pi-ai";
import {
  AssistantEntry,
  defineExtension,
  GenerationTask,
  hook,
  type ModelRef,
  runEndTask,
  UserEntry,
} from "@earendil-works/pi-durable";
import { SESSION_TITLE_EXTENSION_NAME } from "./names";
import { buildTitlePrompt, SESSION_TITLE_SYSTEM_PROMPT } from "./prompt";
import { SessionTitleDoc } from "./state";
import { createSessionTitleTasks } from "./tasks";
import { SetTitleTool } from "./tool";

export {
  SessionTitleDoc,
  type SessionTitleState,
  setSessionTitle,
} from "./state";

export type SessionTitleOptions = {
  model?: ModelRef;
  systemPrompt?: string;
  appendSystemPrompt?: string;
};

export function createSessionTitleExtension(options: SessionTitleOptions = {}) {
  const systemPrompt = options.systemPrompt ?? SESSION_TITLE_SYSTEM_PROMPT;
  const instructions =
    options.appendSystemPrompt === undefined
      ? systemPrompt
      : `${systemPrompt}\n\n${options.appendSystemPrompt}`;
  const { LaunchTitleTask, GenerateTitleTask } = createSessionTitleTasks({
    model: options.model ?? null,
    instructions,
  });
  return defineExtension({
    name: SESSION_TITLE_EXTENSION_NAME,
    tools: [SetTitleTool],
    tasks: [LaunchTitleTask, GenerateTitleTask],
    hooks: [
      hook(GenerationTask, {
        afterRun: async (run, api, context) => {
          if (run.reason !== "answer") return;
          const state = await api.snapshot(
            SessionTitleDoc,
            api.conversationId,
            context,
          );
          if (state !== undefined && state.status !== "idle") return;
          const user = await api.entry(UserEntry, run.first, context);
          const answer = await api.entry(AssistantEntry, run.answer, context);
          const userMessage = user?.model?.[0];
          const assistantMessage = answer?.model?.[0];
          if (
            userMessage?.role !== "user" ||
            assistantMessage?.role !== "assistant"
          ) {
            return;
          }
          const userText = contentText(userMessage.content).trim();
          const answerText = contentText(assistantMessage.content).trim();
          if (userText === "" || answerText === "") return;
          return {
            tasks: [
              runEndTask(LaunchTitleTask, {
                prompt: buildTitlePrompt(userText, answerText),
              }),
            ],
          };
        },
      }),
    ],
  });
}

export const SessionTitle = createSessionTitleExtension();
