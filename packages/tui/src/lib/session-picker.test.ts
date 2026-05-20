import { describe, expect, it } from "vitest";
import type { SessionSummary } from "@lordcode/shared";
import {
  activateSelectedSession,
  closeSessionPicker,
  deleteSelectedSession,
  formatSessionLogFileName,
  selectedSessionDetails,
  moveSessionPickerSelection,
  openSessionPicker,
} from "./session-picker.js";

const sessions: SessionSummary[] = [
  summary("newer", 300),
  summary("middle", 200),
  summary("older", 100),
];

describe("session picker state", () => {
  it("[UT-10] opens with current project sessions sorted by updatedAt", () => {
    const state = openSessionPicker([sessions[2]!, sessions[0]!, sessions[1]!]);

    expect(state.sessions.map((session) => session.id)).toEqual([
      "newer",
      "middle",
      "older",
    ]);
    expect(state.selectedIndex).toBe(0);
  });

  it("[UT-11] activates the selected session on Enter", () => {
    const state = moveSessionPickerSelection(openSessionPicker(sessions), 1);

    expect(activateSelectedSession(state, false)).toEqual({
      kind: "activate",
      sessionId: "middle",
    });
  });

  it("[UT-12] closes without switching on Esc", () => {
    expect(closeSessionPicker(openSessionPicker(sessions))).toBeNull();
  });

  it("[UT-13] refuses activation while a response is streaming", () => {
    expect(activateSelectedSession(openSessionPicker(sessions), true)).toEqual({
      kind: "refuse",
      reason: "press Esc to cancel the current response before switching sessions",
    });
  });

  it("formats the log file name from the visible session id", () => {
    expect(formatSessionLogFileName("ses_123")).toBe("ses_123.log");
  });

  it("returns details for only the currently selected session", () => {
    const state = moveSessionPickerSelection(openSessionPicker(sessions), 1);

    expect(selectedSessionDetails(state)).toEqual({
      id: "middle",
      logFileName: "middle.log",
    });
  });

  it("deletes the currently selected session on d", () => {
    const state = moveSessionPickerSelection(openSessionPicker(sessions), 2);

    expect(deleteSelectedSession(state)).toEqual({
      kind: "delete",
      sessionId: "older",
    });
  });
});

function summary(id: string, updatedAt: number): SessionSummary {
  return {
    id,
    title: id,
    titleSource: "auto",
    projectPath: "/tmp/project",
    updatedAt,
    messageCount: 1,
    model: "gpt-4o",
  };
}
