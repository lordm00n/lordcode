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
  | { kind: "invalid"; reason: string };

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

  return { kind: "invalid", reason: `unknown command: /${head}` };
}
