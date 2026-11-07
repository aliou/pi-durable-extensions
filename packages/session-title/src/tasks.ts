import type { Context } from "@earendil-works/chord/context";
import {
  type ConversationId,
  configure,
  defineTask,
  type ModelRef,
  type TaskOutcome,
  type TaskRuntime,
} from "@earendil-works/pi-durable";
import {
  GENERATE_TITLE_TASK_NAME,
  SESSION_TITLE_EXTENSION_NAME,
  SESSION_TITLE_REQUEST_KIND,
} from "./names";
import { SESSION_TITLE_SYSTEM_PROMPT } from "./prompt";
import { TitleResultDoc } from "./result";
import { SessionTitleDoc } from "./state";
import { SetTitleTool } from "./tool";

const COMPLETED = { status: "completed", result: null } as const;
type GenerateInput = { prompt: string; model: ModelRef | null };
type GenerateState = { phase: "run" };
type GenerateRuntime = TaskRuntime<GenerateInput, GenerateState, null, object>;

async function namingConversation(
  runtime: GenerateRuntime,
  input: GenerateInput,
  context: Context,
) {
  const agent = await runtime.agent(context);
  let id: ConversationId | undefined;
  await runtime.commit(async (tx) => {
    const existing = await tx.scanConversations(
      { ownerTaskId: runtime.taskId },
      1,
    );
    if (existing.items[0] !== undefined) {
      id = existing.items[0].id;
      return;
    }
    const state = await tx.doc(SessionTitleDoc, runtime.conversationId);
    if (state.activeTaskId !== runtime.taskId) return;
    const child = await tx.createConversation({
      ownership: { kind: "task", taskId: runtime.taskId },
    });
    await configure(tx, child.id, {
      model: input.model ?? agent.model ?? null,
      thinkingLevel: "off",
      extensions: [{ name: SESSION_TITLE_EXTENSION_NAME }],
      tools: [SetTitleTool],
      modelTools: [SetTitleTool],
      instructions: SESSION_TITLE_SYSTEM_PROMPT,
      maxTurns: 1,
    });
    id = child.id;
    return undefined;
  }, context);
  return id;
}

async function finish(
  runtime: GenerateRuntime,
  outcome: TaskOutcome<null>,
  context: Context,
) {
  await runtime.commit(async (tx) => {
    const state = await tx.doc(SessionTitleDoc, runtime.conversationId);
    if (state.activeTaskId === runtime.taskId) state.activeTaskId = null;
    return { status: "terminal", outcome };
  }, context);
}

export function createSessionTitleTasks(model: ModelRef | null) {
  const GenerateTitleTask = defineTask<GenerateInput, GenerateState, null>({
    name: GENERATE_TITLE_TASK_NAME,
    version: 1,
    initial: () => ({ phase: "run" }),
    phases: {
      run: async (task, runtime, context) => {
        const id = await namingConversation(runtime, task.input, context);
        if (id === undefined) return finish(runtime, COMPLETED, context);
        const child = await runtime.conversation(id, context);
        if (child === undefined) {
          return finish(
            runtime,
            {
              status: "failed",
              error: { message: "The naming conversation is unavailable" },
            },
            context,
          );
        }
        const submission = await child.submit(
          {
            type: "input",
            content: task.input.prompt,
            requestId: `session-title:${task.id}`,
            entry: { kind: SESSION_TITLE_REQUEST_KIND },
          },
          context,
        );
        const settled = await submission.wait(context);
        const result = await runtime.snapshot(
          TitleResultDoc,
          runtime.taskId,
          context,
        );
        if (result?.stored) return finish(runtime, COMPLETED, context);
        const error =
          settled.status === "unanswered"
            ? {
                message: `Title generation failed: ${settled.reason}`,
                detail: settled.detail ?? null,
              }
            : { message: "Naming run ended without storing a title" };
        await finish(runtime, { status: "failed", error }, context);
      },
    },
    abort: async (_task, runtime, context) =>
      finish(runtime, { status: "aborted" }, context),
  });

  const LaunchTitleTask = defineTask<
    { prompt: string },
    { phase: "launch" },
    null
  >({
    name: "session-title.launch",
    version: 1,
    initial: () => ({ phase: "launch" }),
    phases: {
      launch: async (task, runtime, context) => {
        await runtime.commit(async (tx) => {
          const state = await tx.doc(SessionTitleDoc, runtime.conversationId);
          state.activeTaskId = await tx.createTask(
            GenerateTitleTask,
            { prompt: task.input.prompt, model },
            {
              ownership: { kind: "conversation" },
              conversationId: runtime.conversationId,
              background: true,
            },
          );
          return { status: "terminal", outcome: COMPLETED };
        }, context);
      },
    },
    abort: async (_task, runtime, context) => {
      await runtime.commit(
        () => ({ status: "terminal", outcome: { status: "aborted" } }),
        context,
      );
    },
  });
  return { GenerateTitleTask, LaunchTitleTask };
}
