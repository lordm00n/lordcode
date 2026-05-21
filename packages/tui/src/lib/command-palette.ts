import type { SlashCommandDefinition } from "./commands.js";

export const COMMAND_PALETTE_MAX_ROWS = 8;

export interface CommandPaletteState {
  allCommands: readonly SlashCommandDefinition[];
  query: string;
  visibleCommands: SlashCommandDefinition[];
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
      query: "",
      visibleCommands: [...commands],
      selectedIndex: 0,
    },
    input,
  );
}

export function filterCommandPalette(
  state: CommandPaletteState,
  input: string,
): CommandPaletteState {
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
  if (state.visibleCommands.length === 0) return state;
  const max = state.visibleCommands.length - 1;
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
  const selected = state.visibleCommands[state.selectedIndex];
  if (selected == null) return { kind: "none" };
  if (selected.completion === "execute") {
    return { kind: "execute", input: selected.template };
  }
  return { kind: "complete-input", input: selected.template };
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
