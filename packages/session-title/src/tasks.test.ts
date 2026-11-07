import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
  gate,
  idle,
  launch,
  openHarness,
  state,
  tasks,
  titleCall,
} from "./testing";

describe("title generation tasks", () => {
  it("accepts only the first title when the model calls the tool twice", async () => {
    const opened = await openHarness([
      fauxAssistantMessage(
        [
          fauxToolCall("set_title", { title: "First title" }, { id: "first" }),
          fauxToolCall(
            "set_title",
            { title: "Second title" },
            { id: "second" },
          ),
        ],
        { stopReason: "toolUse" },
      ),
    ]);
    try {
      await launch(opened);
      await idle(opened);
      await expect(state(opened)).resolves.toEqual({
        title: "First title",
        activeTaskId: null,
      });
      expect(opened.faux.state.callCount).toBe(1);
    } finally {
      await opened.harness.close(context);
    }
  });

  it("an older result cannot overwrite a completed replacement", async () => {
    const older = gate();
    const opened = await openHarness([
      async () => {
        await older.promise;
        return titleCall("Stale title");
      },
      titleCall("Replacement title"),
    ]);
    try {
      await launch(opened);
      await expect.poll(() => opened.faux.state.callCount).toBe(1);
      await launch(opened);
      await expect
        .poll(() => state(opened))
        .toMatchObject({ title: "Replacement title" });
      older.resolve();
      await idle(opened);
      await expect(state(opened)).resolves.toEqual({
        title: "Replacement title",
        activeTaskId: null,
      });
    } finally {
      older.resolve();
      await opened.harness.close(context);
    }
  });

  it("keeps the title visible while generating and preserves it on failure", async () => {
    const held = gate();
    const opened = await openHarness([
      titleCall("Existing title"),
      async () => {
        await held.promise;
        return fauxAssistantMessage("", {
          stopReason: "error",
          errorMessage: "Naming failed",
        });
      },
    ]);
    try {
      await launch(opened);
      await idle(opened);
      await launch(opened);
      await expect.poll(() => opened.faux.state.callCount).toBe(2);
      await expect(state(opened)).resolves.toEqual({
        title: "Existing title",
        activeTaskId: expect.any(Number),
      });
      held.resolve();
      await idle(opened);
      await expect(state(opened)).resolves.toEqual({
        title: "Existing title",
        activeTaskId: null,
      });
      const generated = await tasks(opened);
      expect(generated[1]?.state).toMatchObject({
        status: "terminal",
        outcome: { status: "failed", error: { detail: "Naming failed" } },
      });
    } finally {
      held.resolve();
      await opened.harness.close(context);
    }
  });

  it.each(["success", "failure"])(
    "a superseded %s cannot overwrite or clear a newer task",
    async (outcome) => {
      const older = gate();
      const newer = gate();
      const opened = await openHarness([
        async () => {
          await older.promise;
          return outcome === "success"
            ? titleCall("Stale title")
            : fauxAssistantMessage("No tool call");
        },
        async () => {
          await newer.promise;
          return titleCall("Current title");
        },
      ]);
      try {
        await launch(opened);
        await expect.poll(() => opened.faux.state.callCount).toBe(1);
        await launch(opened);
        await expect.poll(() => opened.faux.state.callCount).toBe(2);
        const current = await state(opened);
        older.resolve();
        await expect
          .poll(async () => {
            const generated = await tasks(opened);
            return generated[0]?.state.status;
          })
          .toBe("terminal");
        await expect(state(opened)).resolves.toEqual(current);
        newer.resolve();
        await idle(opened);
        await expect(state(opened)).resolves.toEqual({
          title: "Current title",
          activeTaskId: null,
        });
      } finally {
        older.resolve();
        newer.resolve();
        await opened.harness.close(context);
      }
    },
  );
});
