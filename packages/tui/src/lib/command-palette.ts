import type {
  ModelSummary,
  ModelsListResponse,
  SessionSummary,
} from "@lordcode/shared";
import type { SlashCommandDefinition } from "./commands.js";

export const COMMAND_PALETTE_MAX_ROWS = 8;
export const COMMAND_PALETTE_PANEL_BACKGROUND = "black";

export interface CommandPaletteState {
  mode: "commands" | "models" | "sessions";
  allCommands: readonly SlashCommandDefinition[];
  query: string;
  visibleCommands: SlashCommandDefinition[];
  modelList: ModelSummary[];
  currentModel: string | null;
  sessionList: SessionSummary[];
  selectedIndex: number;
}

export type CommandPaletteActivation =
  | { kind: "execute"; input: string }
  | { kind: "complete-input"; input: string }
  | { kind: "none" };

export function openCommandPalette(
  input: string,
  commands: readonly SlashCommandDefinition[],
): CommandPaletteState {
  return filterCommandPalette(
    {
      allCommands: commands,
      mode: "commands",
      query: "",
      visibleCommands: [...commands],
      modelList: [],
      currentModel: null,
      sessionList: [],
      selectedIndex: 0,
    },
    input,
  );
}

export function openModelPalette(models: ModelsListResponse): CommandPaletteState {
  const selectedIndex = Math.max(
    0,
    models.models.findIndex((model) => model.name === models.current),
  );

  return {
    allCommands: [],
    mode: "models",
    query: "",
    visibleCommands: [],
    modelList: [...models.models],
    currentModel: models.current,
    sessionList: [],
    selectedIndex,
  };
}

export function openSessionPalette(
  sessions: SessionSummary[],
): CommandPaletteState {
  return {
    allCommands: [],
    mode: "sessions",
    query: "",
    visibleCommands: [],
    modelList: [],
    currentModel: null,
    sessionList: [...sessions].sort((a, b) => b.updatedAt - a.updatedAt),
    selectedIndex: 0,
  };
}

export function filterCommandPalette(
  state: CommandPaletteState,
  input: string,
): CommandPaletteState {
  if (state.mode !== "commands") return state;

  const query = commandQuery(input);
  const normalizedQuery = query.toLowerCase();
  const visibleCommands =
    normalizedQuery.length === 0
      ? [...state.allCommands]
      : state.allCommands.filter((command) =>
          matchesCommand(command, normalizedQuery),
        );
  const max = Math.max(0, visibleCommands.length - 1);
  const selectedIndex =
    visibleCommands.length === 0 ? 0 : Math.min(state.selectedIndex, max);

  return {
    ...state,
    query,
    visibleCommands,
    selectedIndex,
  };
}

export function moveCommandPaletteSelection(
  state: CommandPaletteState,
  delta: number,
): CommandPaletteState {
  const count = commandPaletteItemCount(state);
  if (count === 0) return state;
  const max = count - 1;
  const selectedIndex = Math.min(max, Math.max(0, state.selectedIndex + delta));
  return { ...state, selectedIndex };
}

export function closeCommandPalette(
  _state: CommandPaletteState,
): CommandPaletteState | null {
  return null;
}

export function activateSelectedCommand(
  state: CommandPaletteState,
): CommandPaletteActivation {
  if (state.mode !== "commands") return { kind: "none" };

  const selected = state.visibleCommands[state.selectedIndex];
  if (selected == null) return { kind: "none" };
  if (selected.completion === "execute") {
    return { kind: "execute", input: selected.template };
  }
  return { kind: "complete-input", input: selected.template };
}

export function commandPaletteItemCount(state: CommandPaletteState): number {
  switch (state.mode) {
    case "commands":
      return state.visibleCommands.length;
    case "models":
      return state.modelList.length;
    case "sessions":
      return state.sessionList.length;
  }
}

function commandQuery(input: string): string {
  if (!input.startsWith("/")) return "";
  const withoutSlash = input.slice(1);
  const firstWhitespace = withoutSlash.search(/\s/);
  return firstWhitespace === -1
    ? withoutSlash
    : withoutSlash.slice(0, firstWhitespace);
}

function matchesCommand(
  command: SlashCommandDefinition,
  normalizedQuery: string,
): boolean {
  return (
    command.name.toLowerCase().includes(normalizedQuery) ||
    command.usage.toLowerCase().includes(normalizedQuery) ||
    command.description.toLowerCase().includes(normalizedQuery)
  );
}
