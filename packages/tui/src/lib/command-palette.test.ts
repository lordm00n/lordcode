import { describe, expect, it } from "vitest";
import {
  COMMAND_DEFINITIONS,
  type SlashCommandDefinition,
} from "./commands.js";
import {
  activateSelectedCommand,
  closeCommandPalette,
  filterCommandPalette,
  moveCommandPaletteSelection,
  openCommandPalette,
} from "./command-palette.js";

describe("command palette state", () => {
  it("[UT-5] opens with all built-in commands visible", () => {
    const state = openCommandPalette("/", COMMAND_DEFINITIONS);

    expect(state.selectedIndex).toBe(0);
    expect(state.visibleCommands.map((command) => command.usage)).toEqual([
      "/models",
      "/model <name>",
      "/sessions",
      "/new",
      "/rename <title>",
    ]);
  });

  it("[UT-6] filters by partial command name", () => {
    const state = filterCommandPalette(
      openCommandPalette("/", COMMAND_DEFINITIONS),
      "/mo",
    );

    expect(state.visibleCommands.map((command) => command.usage)).toEqual([
      "/models",
      "/model <name>",
    ]);
  });

  it("[UT-7] keeps an empty result selectable without crashing", () => {
    const state = filterCommandPalette(
      openCommandPalette("/", COMMAND_DEFINITIONS),
      "/zzz",
    );

    expect(state.visibleCommands).toEqual([]);
    expect(state.selectedIndex).toBe(0);
  });

  it("[UT-8] clamps selection at the top", () => {
    const state = moveCommandPaletteSelection(
      openCommandPalette("/", threeCommands()),
      -1,
    );

    expect(state.selectedIndex).toBe(0);
  });

  it("[UT-9] moves selection down through visible commands", () => {
    const state = moveCommandPaletteSelection(
      openCommandPalette("/", threeCommands()),
      1,
    );

    expect(state.selectedIndex).toBe(1);
  });

  it("[UT-10] activates executable commands through submitted input", () => {
    const state = openCommandPalette("/", COMMAND_DEFINITIONS);

    expect(activateSelectedCommand(state)).toEqual({
      kind: "execute",
      input: "/models",
    });
  });

  it("[UT-11] completes template commands instead of executing them", () => {
    const state = moveCommandPaletteSelection(
      openCommandPalette("/", COMMAND_DEFINITIONS),
      1,
    );

    expect(activateSelectedCommand(state)).toEqual({
      kind: "complete-input",
      input: "/model ",
    });
  });

  it("[UT-12] accepts future skill commands in the same metadata contract", () => {
    const skillCommand: SlashCommandDefinition = {
      name: "review",
      usage: "/review",
      description: "Review current changes.",
      source: "skill",
      completion: "execute",
      template: "/review",
    };

    const state = openCommandPalette("/", [
      ...COMMAND_DEFINITIONS,
      skillCommand,
    ]);

    expect(state.visibleCommands.map((command) => command.usage)).toContain(
      "/review",
    );
  });

  it("closes to null", () => {
    expect(closeCommandPalette(openCommandPalette("/", COMMAND_DEFINITIONS))).toBeNull();
  });
});

function threeCommands(): SlashCommandDefinition[] {
  return COMMAND_DEFINITIONS.slice(0, 3);
}
