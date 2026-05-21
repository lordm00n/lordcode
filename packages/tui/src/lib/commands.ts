/**
 * Pure slash-command parser.
 *
 * Contract (per test-category §1):
 * - Input is assumed to be already trimmed and non-empty (App layer's job).
 * - Slash commands are case-sensitive (Q3): `/Models` → invalid.
 * - Extra tokens are silently dropped (Q2): `/models extra` → `models`.
 */

export type Command =
  | { kind: "send"; text: string }
  | { kind: "models" }
  | { kind: "set-model"; name: string }
  | { kind: "sessions" }
  | { kind: "new-session" }
  | { kind: "rename-session"; title: string }
  | { kind: "invalid"; reason: string };

export type SlashCommandSource = "builtin" | "skill";

export interface SlashCommandDefinition {
  name: string;
  usage: string;
  description: string;
  source: SlashCommandSource;
  completion: "execute" | "insert-template";
  template: string;
}

export const COMMAND_DEFINITIONS = [
  {
    name: "models",
    usage: "/models",
    description: "List configured models.",
    source: "builtin",
    completion: "execute",
    template: "/models",
  },
  {
    name: "model",
    usage: "/model <name>",
    description: "Switch current model.",
    source: "builtin",
    completion: "insert-template",
    template: "/model ",
  },
  {
    name: "sessions",
    usage: "/sessions",
    description: "Show sessions for the current project.",
    source: "builtin",
    completion: "execute",
    template: "/sessions",
  },
  {
    name: "new",
    usage: "/new",
    description: "Start a new session.",
    source: "builtin",
    completion: "execute",
    template: "/new",
  },
  {
    name: "rename",
    usage: "/rename <title>",
    description: "Rename the current session.",
    source: "builtin",
    completion: "insert-template",
    template: "/rename ",
  },
] as const satisfies readonly SlashCommandDefinition[];

export function parseCommand(input: string): Command {
  if (!input.startsWith("/")) {
    return { kind: "send", text: input };
  }

  const rest = input.slice(1);
  const head = rest.split(/\s+/)[0] ?? "";

  if (head === "") {
    return { kind: "invalid", reason: "empty command after `/`" };
  }

  if (head === "models") {
    return { kind: "models" };
  }

  if (head === "sessions") {
    return { kind: "sessions" };
  }

  if (head === "new") {
    return { kind: "new-session" };
  }

  if (head === "model") {
    const after = rest.slice("model".length);
    const args = after.trim().split(/\s+/).filter((s) => s.length > 0);
    const name = args[0];
    if (!name) {
      return {
        kind: "invalid",
        reason: "usage: /model <name>",
      };
    }
    return { kind: "set-model", name };
  }

  if (head === "rename") {
    const title = rest.slice("rename".length).trim();
    if (!title) {
      return {
        kind: "invalid",
        reason: "usage: /rename <title>",
      };
    }
    return { kind: "rename-session", title };
  }

  return { kind: "invalid", reason: `unknown command: /${head}` };
}
