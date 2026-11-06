import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { ConversationId, TaskId, Tx } from "@earendil-works/pi-durable";
import { createMock } from "@golevelup/ts-vitest";
import { describe, expect, it } from "vitest";
import type { SessionTitleState } from "./state";
import { createSessionTitleTasks } from "./tasks";

const conversationId = createMock<ConversationId>();
const taskId = createMock<TaskId<null>>();
const otherTaskId = createMock<TaskId<null>>();
const model = { provider: "faux", modelId: "small" };
const { GenerateTitleTask, LaunchTitleTask } = createSessionTitleTasks({
  model,
  instructions: "Name this conversation",
});

type LaunchTask = Parameters<
  typeof LaunchTitleTask.definition.phases.launch
>[0];
type LaunchRuntime = Parameters<
  typeof LaunchTitleTask.definition.phases.launch
>[1];
type GenerateTask = Parameters<typeof GenerateTitleTask.definition.abort>[0];
type GenerateRuntime = Parameters<typeof GenerateTitleTask.definition.abort>[1];

function createTransaction(state: SessionTitleState) {
  const outcomes: unknown[] = [];
  const tx = createMock<Tx>(
    {
      doc: async () => state,
      createTask: async () => otherTaskId,
    },
    { strict: true },
  );
  return { outcomes, tx };
}

function createLaunchRuntime(state: SessionTitleState) {
  const { outcomes, tx } = createTransaction(state);
  const runtime = createMock<LaunchRuntime>(
    {
      conversationId,
      taskId,
      commit: async (change) => {
        const outcome = await change(tx, createMock<LaunchTask>());
        outcomes.push(outcome);
      },
    },
    { strict: true },
  );
  return { outcomes, runtime, tx };
}

function createGenerateRuntime(state: SessionTitleState) {
  const { outcomes, tx } = createTransaction(state);
  const runtime = createMock<GenerateRuntime>(
    {
      conversationId,
      taskId,
      commit: async (change) => {
        const outcome = await change(tx, createMock<GenerateTask>());
        outcomes.push(outcome);
      },
    },
    { strict: true },
  );
  return { outcomes, runtime };
}

function pendingState(
  overrides: Partial<SessionTitleState> = {},
): SessionTitleState {
  return {
    status: "pending",
    title: null,
    source: null,
    taskId,
    attempts: 1,
    ...overrides,
  };
}

describe("createSessionTitleTasks", () => {
  describe("LaunchTitleTask", () => {
    it("starts generation and marks the title pending", async () => {
      const state = pendingState({
        status: "idle",
        taskId: null,
        attempts: 0,
      });
      const { outcomes, runtime, tx } = createLaunchRuntime(state);
      const task = createMock<LaunchTask>(
        {
          id: taskId,
          input: { prompt: "Name this conversation" },
        },
        { strict: true },
      );

      await LaunchTitleTask.definition.phases.launch(task, runtime, context);

      expect(tx.createTask).toHaveBeenCalledWith(
        GenerateTitleTask,
        { prompt: "Name this conversation", model },
        {
          ownership: { kind: "conversation" },
          conversationId,
          background: true,
        },
      );
      expect(state).toEqual({
        status: "pending",
        title: null,
        source: null,
        taskId: otherTaskId,
        attempts: 1,
      });
      expect(outcomes).toEqual([
        { status: "terminal", outcome: { status: "completed", result: null } },
      ]);
    });

    it.each([
      ["pending", pendingState()],
      [
        "ready",
        pendingState({
          status: "ready",
          title: "Manual title",
          source: "manual",
          taskId: null,
        }),
      ],
    ])(
      "does not start generation while the title is %s",
      async (_case, state) => {
        const before = { ...state };
        const { runtime, tx } = createLaunchRuntime(state);
        const task = createMock<LaunchTask>(
          {
            id: taskId,
            input: { prompt: "Name this conversation" },
          },
          { strict: true },
        );

        await LaunchTitleTask.definition.phases.launch(task, runtime, context);

        expect(tx.createTask).not.toHaveBeenCalled();
        expect(state).toEqual(before);
      },
    );
  });

  describe("GenerateTitleTask", () => {
    it("makes a pending title retryable when aborted", async () => {
      const state = pendingState();
      const { outcomes, runtime } = createGenerateRuntime(state);
      const task = createMock<GenerateTask>({ id: taskId }, { strict: true });

      await GenerateTitleTask.definition.abort(task, runtime, context);

      expect(state).toEqual({
        status: "idle",
        title: null,
        source: null,
        taskId: null,
        attempts: 1,
      });
      expect(outcomes).toEqual([
        { status: "terminal", outcome: { status: "aborted" } },
      ]);
    });
  });
});
