import { describe, expect, it } from "vitest";
import type { AgentStreamEvent } from "@lordcode/shared";
import { applyLiveToolInputEvent } from "./live-tool-inputs.js";

const applyAll = (events: AgentStreamEvent[]) =>
  events.reduce(applyLiveToolInputEvent, []);

describe("applyLiveToolInputEvent", () => {
  it("[UT-T1] adds a preparing placeholder on tool-input-start", () => {
    expect(
      applyAll([
        {
          type: "tool-input-start",
          toolCallId: "c1",
          toolName: "write_file",
        },
      ]),
    ).toEqual([
      {
        toolCallId: "c1",
        toolName: "write_file",
        phase: "preparing",
      },
    ]);
  });

  it("[UT-T2] updates aggregate bytes and elapsed time on tool-input-progress", () => {
    expect(
      applyAll([
        {
          type: "tool-input-start",
          toolCallId: "c1",
          toolName: "write_file",
        },
        {
          type: "tool-input-progress",
          toolCallId: "c1",
          toolName: "write_file",
          inputBytes: 1024,
          elapsedMs: 20,
        },
      ]),
    ).toEqual([
      {
        toolCallId: "c1",
        toolName: "write_file",
        phase: "preparing",
        inputBytes: 1024,
        elapsedMs: 20,
      },
    ]);
  });

  it("[UT-T3] marks the placeholder executing on tool-input-end", () => {
    expect(
      applyAll([
        {
          type: "tool-input-start",
          toolCallId: "c1",
          toolName: "write_file",
        },
        {
          type: "tool-input-end",
          toolCallId: "c1",
          toolName: "write_file",
          inputBytes: 2048,
          elapsedMs: 25,
        },
      ]),
    ).toEqual([
      {
        toolCallId: "c1",
        toolName: "write_file",
        phase: "executing",
        inputBytes: 2048,
        elapsedMs: 25,
      },
    ]);
  });

  it("[UT-T4] removes the placeholder when the formal tool-call arrives", () => {
    expect(
      applyAll([
        {
          type: "tool-input-start",
          toolCallId: "c1",
          toolName: "write_file",
        },
        {
          type: "tool-call",
          toolCallId: "c1",
          toolName: "write_file",
          input: { path: "a.ts" },
        },
      ]),
    ).toEqual([]);
  });

  it("[UT-T5] defensively removes stale placeholders on tool-result and tool-error", () => {
    expect(
      applyAll([
        {
          type: "tool-input-start",
          toolCallId: "c1",
          toolName: "write_file",
        },
        {
          type: "tool-result",
          toolCallId: "c1",
          toolName: "write_file",
          output: { ok: true },
        },
      ]),
    ).toEqual([]);

    expect(
      applyAll([
        {
          type: "tool-input-start",
          toolCallId: "c2",
          toolName: "write_file",
        },
        {
          type: "tool-error",
          toolCallId: "c2",
          toolName: "write_file",
          message: "failed",
        },
      ]),
    ).toEqual([]);
  });
});
