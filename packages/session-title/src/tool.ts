import {
  defineTool,
  type ToolExecutionApi,
  type Tx,
} from "@earendil-works/pi-durable";
import { obj } from "@earendil-works/pi-schema";
import { GENERATE_TITLE_TASK_NAME } from "./names";
import { SessionTitleDoc } from "./state";
import { Title } from "./title";

async function titleTarget(tx: Tx, api: ToolExecutionApi) {
  const child = await tx.conversation(api.conversationId);
  const ownerTaskId = child?.owner?.taskId;
  if (ownerTaskId === undefined) {
    throw new Error("The naming conversation has no owning task");
  }
  const owner = await tx.task(ownerTaskId);
  if (owner?.kind !== GENERATE_TITLE_TASK_NAME) {
    throw new Error("The naming conversation has no title task");
  }
  return { conversationId: owner.conversationId, taskId: owner.id };
}

export const SetTitleTool = defineTool({
  name: "set_title",
  description: "Set the current conversation title",
  parameters: obj({ title: Title }),
  deferred: true,
  executionMode: "sequential",
  replay: "safe",
  execute: async (args, api, context) => {
    const title = args.title.trim();
    let stored = false;
    await api.commit(async (tx) => {
      const target = await titleTarget(tx, api);
      const state = await tx.doc(SessionTitleDoc, target.conversationId);
      if (state.status !== "pending" || state.taskId !== target.taskId) return;
      state.status = "ready";
      state.title = title;
      state.source = "generated";
      state.taskId = null;
      stored = true;
    }, context);
    return {
      output: [
        {
          type: "text",
          text: stored ? `Session title: ${title}` : "Session title unchanged",
        },
      ],
      details: { title, stored },
      control: { terminate: true },
    };
  },
});
