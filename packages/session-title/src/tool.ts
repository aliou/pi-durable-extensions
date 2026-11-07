import {
  defineTool,
  type ToolExecutionApi,
  type Tx,
} from "@earendil-works/pi-durable";
import { obj } from "@earendil-works/pi-schema";
import { GENERATE_TITLE_TASK_NAME } from "./names";
import { TitleResultDoc } from "./result";
import { SessionTitleDoc } from "./state";
import { parseTitle, Title } from "./title";

async function titleTarget(tx: Tx, api: ToolExecutionApi) {
  const naming = await tx.conversation(api.conversationId);
  if (naming?.owner === undefined)
    throw new Error("The naming conversation has no owning task");
  const task = await tx.task(naming.owner.taskId);
  if (task?.kind !== GENERATE_TITLE_TASK_NAME)
    throw new Error("The naming conversation has no title task");
  return task;
}

export const SetTitleTool = defineTool({
  name: "set_title",
  description: "Store a concise title for the source conversation",
  parameters: obj({ title: Title }),
  deferred: true,
  executionMode: "sequential",
  replay: "safe",
  execute: async (args, api, context) => {
    const title = parseTitle(args.title);
    let stored = false;
    await api.commit(async (tx) => {
      const task = await titleTarget(tx, api);
      const state = await tx.doc(SessionTitleDoc, task.conversationId);
      const result = await tx.doc(TitleResultDoc, task.id);
      if (result.stored) {
        stored = true;
        return;
      }
      if (state.activeTaskId !== task.id) return;
      state.title = title;
      state.activeTaskId = null;
      result.stored = true;
      stored = true;
    }, context);
    return {
      output: [
        { type: "text", text: stored ? "Title stored" : "Title unchanged" },
      ],
      details: { title, stored },
      control: { terminate: true },
    };
  },
});
