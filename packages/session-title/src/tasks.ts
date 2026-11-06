import type { Context } from "@earendil-works/chord/context";
import {
  type ConversationId,
  configure,
  defineTask,
  type ModelRef,
  type SettledSubmissionRecord,
  type TaskRuntime,
} from "@earendil-works/pi-durable";
import {
  GENERATE_TITLE_TASK_NAME,
  SESSION_TITLE_EXTENSION_NAME,
  SESSION_TITLE_REQUEST_KIND,
} from "./names";
import { SessionTitleDoc } from "./state";
import { SetTitleTool } from "./tool";

const COMPLETED = {
  status: "terminal",
  outcome: { status: "completed", result: null },
} as const;

const ABORTED = {
  status: "terminal",
  outcome: { status: "aborted" },
} as const;

const NamingExtension = { name: SESSION_TITLE_EXTENSION_NAME };

type LaunchInput = { prompt: string };
type LaunchState = { phase: "launch" };
type GenerateInput = { prompt: string; model: ModelRef | null };
type GenerateState = { phase: "run" };
type GenerateRuntime = TaskRuntime<GenerateInput, GenerateState, null, object>;

function sameModel(left: ModelRef, right: ModelRef): boolean {
  return left.provider === right.provider && left.modelId === right.modelId;
}

function fallbackModel(
  configured: ModelRef | null,
  session: ModelRef | undefined,
): ModelRef | null {
  if (configured === null || session === undefined) return null;
  if (sameModel(configured, session)) return null;
  return session;
}

function failedModelRequest(settled: SettledSubmissionRecord): boolean {
  if (settled.status !== "unanswered") return false;
  return settled.reason === "model_error" || settled.reason === "no_model";
}

async function createOrRecoverNamingConversation(
  task: { id: GenerateRuntime["taskId"]; input: GenerateInput },
  runtime: GenerateRuntime,
  agent: { model: ModelRef | undefined; instructions: string },
  context: Context,
): Promise<ConversationId | undefined> {
  let conversationId: ConversationId | undefined;
  await runtime.commit(async (tx) => {
    const state = await tx.doc(SessionTitleDoc, runtime.conversationId);
    if (state.status !== "pending" || state.taskId !== task.id) return;
    const conversations = await tx.scanConversations(
      { ownerTaskId: task.id },
      1,
    );
    const existing = conversations.items[0];
    if (existing !== undefined) {
      conversationId = existing.id;
      return;
    }
    const child = await tx.createConversation({
      ownership: { kind: "task", taskId: task.id },
    });
    await configure(tx, child.id, {
      model: agent.model ?? null,
      thinkingLevel: "off",
      extensions: [NamingExtension],
      tools: [SetTitleTool],
      modelTools: [SetTitleTool],
      instructions: agent.instructions,
      maxTurns: 1,
    });
    conversationId = child.id;
    return undefined;
  }, context);
  return conversationId;
}

async function finishGeneration(
  runtime: GenerateRuntime,
  context: Context,
): Promise<void> {
  await runtime.commit(async (tx) => {
    const state = await tx.doc(SessionTitleDoc, runtime.conversationId);
    if (state.status === "pending" && state.taskId === runtime.taskId) {
      state.status = "idle";
      state.taskId = null;
    }
    return COMPLETED;
  }, context);
}

export function createSessionTitleTasks(options: {
  model: ModelRef | null;
  instructions: string;
}) {
  const GenerateTitleTask = defineTask<GenerateInput, GenerateState, null>({
    name: GENERATE_TITLE_TASK_NAME,
    version: 1,
    initial: () => ({ phase: "run" }),
    phases: {
      run: async (task, runtime, context) => {
        const parentAgent = await runtime.agent(context);
        const conversationId = await createOrRecoverNamingConversation(
          task,
          runtime,
          {
            model: task.input.model ?? parentAgent.model,
            instructions: options.instructions,
          },
          context,
        );
        if (conversationId === undefined) {
          await runtime.commit(() => COMPLETED, context);
          return;
        }
        const child = await runtime.conversation(conversationId, context);
        if (child === undefined) {
          throw new Error("The naming conversation is unavailable");
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
        let settled = await submission.wait(context);
        const current = await runtime.snapshot(
          SessionTitleDoc,
          runtime.conversationId,
          context,
        );
        const fallback =
          current?.status === "ready"
            ? null
            : fallbackModel(task.input.model, parentAgent.model);
        if (fallback !== null && failedModelRequest(settled)) {
          await runtime.commit(async (tx) => {
            await configure(tx, conversationId, { model: fallback });
            return undefined;
          }, context);
          const retry = await child.submit(
            {
              type: "continue",
              requestId: `session-title:${task.id}:fallback`,
            },
            context,
          );
          settled = await retry.wait(context);
        }
        await finishGeneration(runtime, context);
      },
    },
    abort: async (_task, runtime, context) => {
      await runtime.commit(async (tx) => {
        const state = await tx.doc(SessionTitleDoc, runtime.conversationId);
        if (state.status === "pending" && state.taskId === runtime.taskId) {
          state.status = "idle";
          state.taskId = null;
        }
        return ABORTED;
      }, context);
    },
  });

  const LaunchTitleTask = defineTask<LaunchInput, LaunchState, null>({
    name: "session-title.launch",
    version: 1,
    initial: () => ({ phase: "launch" }),
    phases: {
      launch: async (task, runtime, context) => {
        await runtime.commit(async (tx) => {
          const state = await tx.doc(SessionTitleDoc, runtime.conversationId);
          if (state.status !== "idle") return COMPLETED;
          const taskId = await tx.createTask(
            GenerateTitleTask,
            { prompt: task.input.prompt, model: options.model },
            {
              ownership: { kind: "conversation" },
              conversationId: runtime.conversationId,
              background: true,
            },
          );
          state.status = "pending";
          state.taskId = taskId;
          state.attempts += 1;
          return COMPLETED;
        }, context);
      },
    },
    abort: async (_task, runtime, context) => {
      await runtime.commit(() => ABORTED, context);
    },
  });

  return { GenerateTitleTask, LaunchTitleTask };
}
