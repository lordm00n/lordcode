import type { SessionSummary } from "@lordcode/shared";

export interface SessionPickerState {
  sessions: SessionSummary[];
  selectedIndex: number;
}

export interface SelectedSessionDetails {
  id: string;
  logFileName: string;
}

export type SessionPickerActivation =
  | { kind: "activate"; sessionId: string }
  | { kind: "refuse"; reason: string }
  | { kind: "none" };

export type SessionPickerDeletion =
  | { kind: "delete"; sessionId: string }
  | { kind: "none" };

export function openSessionPicker(
  sessions: SessionSummary[],
): SessionPickerState {
  return {
    sessions: [...sessions].sort((a, b) => b.updatedAt - a.updatedAt),
    selectedIndex: 0,
  };
}

export function moveSessionPickerSelection(
  state: SessionPickerState,
  delta: number,
): SessionPickerState {
  if (state.sessions.length === 0) return state;
  const max = state.sessions.length - 1;
  const selectedIndex = Math.min(max, Math.max(0, state.selectedIndex + delta));
  return { ...state, selectedIndex };
}

export function closeSessionPicker(
  _state: SessionPickerState,
): SessionPickerState | null {
  return null;
}

export function activateSelectedSession(
  state: SessionPickerState,
  isStreaming: boolean,
): SessionPickerActivation {
  if (isStreaming) {
    return {
      kind: "refuse",
      reason: "press Esc to cancel the current response before switching sessions",
    };
  }
  const selected = state.sessions[state.selectedIndex];
  if (selected == null) return { kind: "none" };
  return { kind: "activate", sessionId: selected.id };
}

export function formatSessionLogFileName(sessionId: string): string {
  return `${sessionId}.log`;
}

export function deleteSelectedSession(
  state: SessionPickerState,
): SessionPickerDeletion {
  const selected = state.sessions[state.selectedIndex];
  if (selected == null) return { kind: "none" };
  return { kind: "delete", sessionId: selected.id };
}

export function selectedSessionDetails(
  state: SessionPickerState,
): SelectedSessionDetails | null {
  const selected = state.sessions[state.selectedIndex];
  if (selected == null) return null;
  return {
    id: selected.id,
    logFileName: formatSessionLogFileName(selected.id),
  };
}
