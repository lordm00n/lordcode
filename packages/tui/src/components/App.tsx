import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import type { ChatMessage, ModelsListResponse } from "@lordcode/shared";
import type { ApiClient } from "../api/client.js";
import { parseCommand } from "../lib/commands.js";
import { useLogger } from "../lib/logger-context.js";
import { Input } from "./input/Input.js";

interface AppProps {
  api: ApiClient;
  baseUrl: string;
  onExit: () => void;
}

interface SystemEntry {
  kind: "system";
  tone: "info" | "error";
  content: string;
}

interface MessageEntry extends ChatMessage {
  kind: "msg";
  /**
   * Total wall-clock time the model spent in reasoning blocks during this turn.
   * Only set on assistant entries that had at least one reasoning chunk; absent
   * for plain text-only turns.
   */
  reasoningDurationMs?: number;
}

type Entry = MessageEntry | SystemEntry;

interface StreamingState {
  text: string;
  reasoning: string;
  /**
   * `Date.now()` when the current (in-flight) reasoning block started, or null
   * when no reasoning is currently in progress.
   */
  reasoningStartedAt: number | null;
  /**
   * Accumulated wall-clock duration of reasoning blocks that have already
   * ended this turn. Null until we've observed at least one reasoning block.
   */
  reasoningDurationMs: number | null;
}

/**
 * Once the in-progress reasoning would render taller than this many wrapped
 * terminal rows, collapse it to a single "Thinking..." line so it stops
 * dominating the viewport while the model keeps thinking.
 */
const REASONING_COLLAPSE_LINES = 8;

export function App({ api, baseUrl, onExit }: AppProps) {
  const ink = useApp();
  const baseLog = useLogger();
  // Stable child loggers — avoid re-deriving on every render so that effects
  // / callbacks can use them in dep arrays without resubscribing.
  const log = useMemo(() => baseLog.child("ui"), [baseLog]);
  const cmdLog = useMemo(() => baseLog.child("cmd"), [baseLog]);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [input, setInput] = useState("");
  const [models, setModels] = useState<ModelsListResponse | null>(null);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [streaming, setStreaming] = useState<StreamingState | null>(null);
  const abortRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const m = await api.listModels();
        setModels(m);
        log.debug("initial models loaded", {
          count: m.models.length,
          current: m.current ?? null,
        });
      } catch (err) {
        setModelsError(err instanceof Error ? err.message : String(err));
        log.error("initial models load failed", err);
      }
    })();
  }, [api, log]);

  const pushSystem = useCallback(
    (tone: "info" | "error", content: string) => {
      setEntries((prev) => [...prev, { kind: "system", tone, content }]);
    },
    [],
  );

  const pushMessage = useCallback(
    (msg: ChatMessage, opts?: { reasoningDurationMs?: number }) => {
      setEntries((prev) => [
        ...prev,
        {
          kind: "msg",
          ...msg,
          ...(opts?.reasoningDurationMs != null
            ? { reasoningDurationMs: opts.reasoningDurationMs }
            : {}),
        },
      ]);
    },
    [],
  );

  const handleModels = useCallback(async () => {
    log.debug("/models requested");
    try {
      const m = await api.listModels();
      setModels(m);
      pushSystem("info", formatModelsList(m));
    } catch (err) {
      log.error("/models failed", err);
      pushSystem(
        "error",
        `failed to list models: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }, [api, log, pushSystem]);

  const handleSetModel = useCallback(
    async (name: string) => {
      log.info("/model requested", { name });
      try {
        const res = await api.setCurrentModel(name);
        setModels((prev) => (prev ? { ...prev, current: res.current } : prev));
        pushSystem("info", `switched to ${res.current}`);
      } catch (err) {
        log.warn("/model failed", {
          name,
          err: err instanceof Error ? err.message : String(err),
        });
        pushSystem(
          "error",
          err instanceof Error ? err.message : String(err),
        );
      }
    },
    [api, log, pushSystem],
  );

  const handleSend = useCallback(
    async (text: string) => {
      const userMsg: ChatMessage = { role: "user", content: text };
      const baseEntries: Entry[] = [...entries, { kind: "msg", ...userMsg }];
      // Strip UI-only fields (kind, reasoningDurationMs) before sending; the
      // server contract only carries role + content.
      const messages: ChatMessage[] = baseEntries
        .filter((e): e is MessageEntry => e.kind === "msg")
        .map((e) => ({ role: e.role, content: e.content }));
      setEntries(baseEntries);

      log.debug("send", {
        messages: messages.length,
        len: text.length,
      });

      const stream = api.chat({ messages });
      abortRef.current = stream.abort;
      setStreaming({
        text: "",
        reasoning: "",
        reasoningStartedAt: null,
        reasoningDurationMs: null,
      });

      let acc = "";
      let accReasoning = "";
      let reasoningStartedAt: number | null = null;
      let reasoningDurationMs: number | null = null;
      let receivedStart = false;
      let errorMsg: string | null = null;

      // Closes any in-flight reasoning block, folding its elapsed time into the
      // running total. Safe to call multiple times — a no-op if reasoning isn't
      // currently in progress.
      const closeReasoning = () => {
        if (reasoningStartedAt == null) return;
        const elapsed = Date.now() - reasoningStartedAt;
        reasoningDurationMs = (reasoningDurationMs ?? 0) + elapsed;
        reasoningStartedAt = null;
      };

      const snapshot = (): StreamingState => ({
        text: acc,
        reasoning: accReasoning,
        reasoningStartedAt,
        reasoningDurationMs,
      });

      try {
        for await (const ev of stream.events) {
          if (ev.type === "start") {
            receivedStart = true;
            acc = "";
            accReasoning = "";
            reasoningStartedAt = null;
            reasoningDurationMs = null;
            log.debug("stream: start", { model: ev.model });
            setStreaming(snapshot());
          } else if (ev.type === "delta") {
            acc += ev.text;
            setStreaming(snapshot());
          } else if (ev.type === "reasoning-start") {
            // If a previous block somehow didn't get its end event, fold its
            // time in before opening a new one so durations stay additive.
            closeReasoning();
            reasoningStartedAt = Date.now();
            setStreaming(snapshot());
          } else if (ev.type === "reasoning-delta") {
            accReasoning += ev.text;
            // Tolerate providers that emit reasoning content without a wrapping
            // start event: lazily start the timer on first delta.
            if (
              reasoningStartedAt == null &&
              reasoningDurationMs == null
            ) {
              reasoningStartedAt = Date.now();
            }
            setStreaming(snapshot());
          } else if (ev.type === "reasoning-end") {
            closeReasoning();
            setStreaming(snapshot());
          } else if (ev.type === "finish") {
            closeReasoning();
            const suffix = ev.aborted ? "\n[interrupted]" : "";
            log.debug("stream: finish", {
              len: acc.length,
              ...(ev.finishReason ? { finishReason: ev.finishReason } : {}),
              ...(reasoningDurationMs != null
                ? { reasoningMs: reasoningDurationMs }
                : {}),
            });
            pushMessage(
              { role: "assistant", content: acc + suffix },
              reasoningDurationMs != null ? { reasoningDurationMs } : undefined,
            );
            setStreaming(null);
            return;
          } else if (ev.type === "error") {
            errorMsg = ev.message;
            log.warn("stream: error frame", { message: ev.message });
            break;
          }
        }
      } catch (err) {
        errorMsg = err instanceof Error ? err.message : String(err);
        log.error("stream: threw", err);
      } finally {
        abortRef.current = null;
      }

      closeReasoning();
      const reasoningOpts =
        reasoningDurationMs != null ? { reasoningDurationMs } : undefined;

      if (errorMsg != null) {
        if (acc.length > 0) {
          pushMessage(
            { role: "assistant", content: `${acc}\n[interrupted]` },
            reasoningOpts,
          );
        }
        pushSystem("error", errorMsg);
        setStreaming(null);
        return;
      }

      if (acc.length > 0) {
        pushMessage(
          { role: "assistant", content: `${acc}\n[interrupted]` },
          reasoningOpts,
        );
      } else if (!receivedStart) {
        log.warn("stream ended without any output");
        pushSystem("error", "stream ended without any output");
      }
      setStreaming(null);
    },
    [api, entries, log, pushMessage, pushSystem],
  );

  useInput((char, key) => {
    if (key.ctrl && (char === "c" || char === "d")) {
      log.info("ctrl-c/d pressed; exiting");
      abortRef.current?.();
      ink.exit();
      onExit();
      return;
    }

    if (streaming != null) {
      if (key.escape) {
        log.info("esc pressed during stream; aborting");
        abortRef.current?.();
      }
      return;
    }

    if (key.return) {
      const trimmed = input.trim();
      if (!trimmed) return;
      const cmd = parseCommand(trimmed);
      setInput("");
      switch (cmd.kind) {
        case "send":
          void handleSend(cmd.text);
          break;
        case "models":
          void handleModels();
          break;
        case "set-model":
          void handleSetModel(cmd.name);
          break;
        case "invalid":
          cmdLog.warn("invalid command", { reason: cmd.reason });
          pushSystem("error", cmd.reason);
          break;
      }
      return;
    }

    if (key.backspace || key.delete) {
      setInput((v) => v.slice(0, -1));
      return;
    }

    if (char && !key.ctrl && !key.meta) {
      setInput((v) => v + char);
    }
  });

  const noModels = !modelsError && models != null && models.models.length === 0;
  const currentName = models?.current ?? null;

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text color="cyan" bold>
          lordcode
        </Text>
        <Text dimColor> · server </Text>
        <Text>{baseUrl}</Text>
      </Box>

      {modelsError ? (
        <Box marginBottom={1}>
          <Text color="red">
            failed to load models: {modelsError}
          </Text>
        </Box>
      ) : noModels ? (
        <Box marginBottom={1}>
          <Text color="red">
            no models configured. edit ~/.lordcode/config.json
          </Text>
        </Box>
      ) : (
        <Box marginBottom={1}>
          <Text dimColor>model: </Text>
          <Text color="cyan">{currentName ?? "<none>"}</Text>
        </Box>
      )}

      <Box flexDirection="column" marginBottom={1}>
        {entries.length === 0 && streaming == null ? (
          <Text dimColor>
            type something and press enter · /models · /model &lt;name&gt; · esc to cancel · ctrl+c to exit
          </Text>
        ) : (
          entries.map((e, i) => <EntryView key={i} entry={e} />)
        )}
        {streaming != null ? (
          <Box flexDirection="column">
            {streaming.reasoningStartedAt != null ||
            streaming.reasoningDurationMs != null ||
            streaming.reasoning.length > 0 ? (
              <ThinkingPanel
                reasoning={streaming.reasoning}
                startedAt={streaming.reasoningStartedAt}
                durationMs={streaming.reasoningDurationMs}
              />
            ) : null}
            <Box>
              <Text color="yellow">ai </Text>
              <Text> · </Text>
              <Text>{streaming.text}</Text>
              <Text color="gray">▌</Text>
            </Box>
          </Box>
        ) : null}
      </Box>

      <Input value={input} isStreaming={streaming != null} />
    </Box>
  );
}

function EntryView({ entry }: { entry: Entry }) {
  if (entry.kind === "system") {
    return (
      <Box>
        <Text color={entry.tone === "error" ? "red" : "gray"}>· </Text>
        <Text color={entry.tone === "error" ? "red" : "gray"}>
          {entry.content}
        </Text>
      </Box>
    );
  }
  const reasoningSummary =
    entry.role === "assistant" && entry.reasoningDurationMs != null
      ? `Thought for ${formatThinkingDuration(entry.reasoningDurationMs)}`
      : null;
  return (
    <Box flexDirection="column">
      {reasoningSummary != null ? (
        <Text color="gray" italic>
          {reasoningSummary}
        </Text>
      ) : null}
      <Box>
        <Text color={entry.role === "user" ? "green" : "yellow"}>
          {entry.role === "user" ? "you" : "ai "}
        </Text>
        <Text> · </Text>
        <Text>{entry.content}</Text>
      </Box>
    </Box>
  );
}

function ThinkingPanel({
  reasoning,
  startedAt,
  durationMs,
}: {
  reasoning: string;
  startedAt: number | null;
  durationMs: number | null;
}) {
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;
  // The reasoning body is rendered with a 2-col left indent; subtract that
  // (and a small safety margin) when estimating wrapped row count.
  const usable = Math.max(20, cols - 4);
  const lines = countWrappedLines(reasoning, usable);

  // A reasoning block is "done" when no block is currently in flight AND we
  // already have a non-zero accumulated duration to display.
  const isDone = startedAt == null && durationMs != null;
  const label = isDone
    ? `Thought for ${formatThinkingDuration(durationMs)}`
    : "Thinking...";

  // While the model is actively thinking, show the streaming reasoning body so
  // the user can follow along (auto-collapsed if it gets too tall). Once the
  // reasoning block has ended, hide the body and keep just the summary line —
  // the user no longer needs the running narration.
  const showBody = !isDone && lines > 0 && lines <= REASONING_COLLAPSE_LINES;

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color="gray" italic>
        {label}
      </Text>
      {showBody ? (
        <Box paddingLeft={2}>
          <Text color="gray">{reasoning}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

/**
 * Approximate visible row count for a string rendered into a fixed-width column.
 * Empty source lines still occupy one row; non-empty lines are divided by `width`
 * and rounded up. Good enough to drive a "collapse when tall" heuristic.
 */
function countWrappedLines(text: string, width: number): number {
  if (text.length === 0) return 0;
  const w = Math.max(1, width);
  return text.split("\n").reduce((sum, line) => {
    if (line.length === 0) return sum + 1;
    return sum + Math.ceil(line.length / w);
  }, 0);
}

/**
 * Render a wall-clock duration as a compact human-readable string suitable for
 * "Thinking..." / "Thought for X" labels.
 *
 * - sub-second → "<1s" (round-tripping to "0s" feels wrong for a thought that
 *   actually happened)
 * - under a minute → integer seconds
 * - a minute or more → "Nm" or "Nm Ks"
 */
function formatThinkingDuration(ms: number): string {
  if (ms < 1000) return "<1s";
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

function formatModelsList(m: ModelsListResponse): string {
  if (m.models.length === 0) {
    return "no models configured. edit ~/.lordcode/config.json";
  }
  return m.models
    .map((mod) => {
      const isCurrent = mod.name === m.current ? " · current" : "";
      const keyHint =
        mod.apiKeySource === "env"
          ? `key:env(${mod.apiKeyEnv ?? "?"})`
          : mod.apiKeySource === "plain"
            ? "key:plain"
            : "key:missing";
      return `${mod.name} (${mod.provider} · ${mod.model}${isCurrent} · ${keyHint})`;
    })
    .join("\n");
}
