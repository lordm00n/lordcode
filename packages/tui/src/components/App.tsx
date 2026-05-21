import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdout, usePaste } from "ink";
import type {
  ModelMessage,
  ModelsListResponse,
  SessionSummary,
  UserContent,
  UserModelMessage,
} from "@lordcode/shared";
import type { ApiClient } from "../api/client.js";
import {
  type Entry,
  type SystemEntry,
  type ToolEntry,
} from "../lib/chat-entries.js";
import {
  accumulate,
  appendUserMessage,
  dropPending,
  initialAccumulatorState,
  snapshotForRender,
  type AccumulatorState,
} from "../lib/history-accumulator.js";
import { deriveEntriesWithBoundaries } from "../lib/derive-entries.js";
import { repairOrphanToolCalls } from "../lib/repair-history.js";
import {
  COMMAND_DEFINITIONS,
  parseCommand,
  type SlashCommandDefinition,
} from "../lib/commands.js";
import {
  activateSelectedCommand,
  closeCommandPalette,
  COMMAND_PALETTE_MAX_ROWS,
  filterCommandPalette,
  moveCommandPaletteSelection,
  openCommandPalette,
  type CommandPaletteState,
} from "../lib/command-palette.js";
import { tryParsePastedImage } from "../lib/clipboard-image.js";
import type { PastedImage } from "../lib/clipboard-image.js";
import {
  composeContent,
  consumedImageIds,
  renderContent,
} from "../lib/compose-message.js";
import {
  formatLiveToolInput,
  formatToolCall,
  formatToolError,
  formatToolResult,
} from "../lib/format-tool-call.js";
import {
  applyLiveToolInputEvent,
  type LiveToolInput,
} from "../lib/live-tool-inputs.js";
import {
  activateSelectedSession,
  closeSessionPicker,
  deleteSelectedSession,
  moveSessionPickerSelection,
  openSessionPicker,
  selectedSessionDetails,
  type SessionPickerState,
} from "../lib/session-picker.js";
import {
  deleteAt,
  deleteBefore,
  insert,
  moveDown,
  moveLeft,
  moveRight,
  moveUp,
  moveWordLeft,
  moveWordRight,
  type InputState,
} from "../lib/input-buffer.js";
import { useLogger } from "../lib/logger-context.js";
import { Input } from "./input/Input.js";

const EMPTY_INPUT: InputState = { value: "", cursor: 0 };

interface AppProps {
  api: ApiClient;
  baseUrl: string;
  onExit: () => void;
}

interface StreamingState {
  text: string;
  reasoning: string;
  toolInputs: LiveToolInput[];
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
 * TUI-local note pinned to a position in the canonical history. Tracked
 * separately from `ModelMessage[]` because system notes (errors, `/model`
 * output, …) are UI chrome and must NOT be replayed on the wire.
 */
interface PinnedSystemNote {
  /** Value of `accState.history.length` at the moment this note was pushed. */
  afterHistoryLen: number;
  entry: SystemEntry;
}

/**
 * Once the in-progress reasoning would render taller than this many wrapped
 * terminal rows, collapse it to a single "Thinking..." line so it stops
 * dominating the viewport while the model keeps thinking.
 */
const REASONING_COLLAPSE_LINES = 8;

export function App({ api, baseUrl, onExit }: AppProps) {
  const ink = useApp();
  const { stdout } = useStdout();
  const baseLog = useLogger();
  // Stable child loggers — avoid re-deriving on every render so that effects
  // / callbacks can use them in dep arrays without resubscribing.
  const log = useMemo(() => baseLog.child("ui"), [baseLog]);
  const cmdLog = useMemo(() => baseLog.child("cmd"), [baseLog]);
  // Canonical conversation state. `history` lives inside `accState` and is
  // the SOURCE OF TRUTH for the wire payload. The UI's `entries` are derived
  // by `deriveEntriesWithBoundaries` below.
  const [accState, setAccState] = useState<AccumulatorState>(
    initialAccumulatorState,
  );
  const [sideNotes, setSideNotes] = useState<PinnedSystemNote[]>([]);
  // Single-buffer input state. The cursor tracks character offsets into
  // `input.value`; all key/paste handlers go through the pure transitions in
  // `lib/input-buffer.ts` so the rules are testable without Ink in the loop.
  const [input, setInput] = useState<InputState>(EMPTY_INPUT);
  const [models, setModels] = useState<ModelsListResponse | null>(null);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [streaming, setStreaming] = useState<StreamingState | null>(null);
  const [sessionPicker, setSessionPicker] = useState<SessionPickerState | null>(
    null,
  );
  const [commandPalette, setCommandPalette] =
    useState<CommandPaletteState | null>(null);
  const abortRef = useRef<(() => void) | null>(null);
  const skillCommands = useMemo<SlashCommandDefinition[]>(() => [], []);
  const allCommands = useMemo<readonly SlashCommandDefinition[]>(
    () => [...COMMAND_DEFINITIONS, ...skillCommands],
    [skillCommands],
  );

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
      setSideNotes((prev) => [
        ...prev,
        {
          afterHistoryLen: accStateRef.current.history.length,
          entry: { kind: "system", tone, content },
        },
      ]);
    },
    [],
  );

  // Mirror accState into a ref so pushSystem can sample the current
  // history length without depending on accState (which would invalidate
  // every callback that uses pushSystem on every history update).
  const accStateRef = useRef(accState);
  useEffect(() => {
    accStateRef.current = accState;
  }, [accState]);

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

  const handleSessions = useCallback(async () => {
    log.debug("/sessions requested");
    try {
      const res = await api.listSessions();
      setSessionPicker(openSessionPicker(res.sessions));
    } catch (err) {
      log.error("/sessions failed", err);
      pushSystem(
        "error",
        `failed to list sessions: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }, [api, log, pushSystem]);

  const handleNewSession = useCallback(async () => {
    log.info("/new requested");
    try {
      const res = await api.createSession();
      setAccState({ ...initialAccumulatorState, history: res.history });
      setSideNotes([
        {
          afterHistoryLen: res.history.length,
          entry: { kind: "system", tone: "info", content: "Started new session" },
        },
      ]);
      setSessionPicker(null);
    } catch (err) {
      log.error("/new failed", err);
      pushSystem(
        "error",
        `failed to create session: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }, [api, log, pushSystem]);

  const handleRenameSession = useCallback(
    async (title: string) => {
      log.info("/rename requested");
      try {
        await api.renameSession(title);
        pushSystem("info", `Renamed session: ${title}`);
      } catch (err) {
        log.error("/rename failed", err);
        pushSystem(
          "error",
          `failed to rename session: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
    [api, log, pushSystem],
  );

  const handleActivateSession = useCallback(
    async (sessionId: string) => {
      try {
        const res = await api.activateSession(sessionId);
        setAccState({ ...initialAccumulatorState, history: res.history });
        setSideNotes([
          {
            afterHistoryLen: res.history.length,
            entry: {
              kind: "system",
              tone: "info",
              content: `Resumed session: ${res.session.title ?? "Untitled session"}`,
            },
          },
        ]);
        setSessionPicker(null);
      } catch (err) {
        log.error("session activation failed", err);
        pushSystem(
          "error",
          `failed to resume session: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
    [api, log, pushSystem],
  );

  const handleDeleteSession = useCallback(
    async (sessionId: string) => {
      try {
        await api.deleteSession(sessionId);
        const res = await api.listSessions();
        setSessionPicker(openSessionPicker(res.sessions));
        pushSystem("info", `Deleted session: ${sessionId}`);
      } catch (err) {
        log.error("session deletion failed", err);
        pushSystem(
          "error",
          `failed to delete session: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
    [api, log, pushSystem],
  );

  // Pasted images stored out-of-band: keeping their base64 in React state would
  // re-render the whole tree on every keystroke. The input field shows a short
  // `[image:<mime>#<id>]` placeholder; resolution back to the actual base64
  // happens at send time via `composeContent(text, pendingImagesRef.current)`.
  const pendingImagesRef = useRef<Map<string, PastedImage>>(new Map());

  const handleSend = useCallback(
    async (text: string) => {
      const pending = pendingImagesRef.current;
      const usedImageIds = consumedImageIds(text, pending);
      const content: UserContent = composeContent(text, pending);
      // Drop the images we just baked into the outgoing turn so the next send
      // doesn't re-attach them. Images whose placeholder the user accidentally
      // deleted before sending stay in the ref — they may re-paste / re-type.
      for (const id of usedImageIds) pending.delete(id);

      const userMsg: UserModelMessage = { role: "user", content };
      const nextState = appendUserMessage(accStateRef.current, userMsg);
      setAccState(nextState);

      // Repair any orphan tool-calls from a prior interrupted turn before
      // shipping; some providers reject unmatched `tool-call` parts. In the
      // steady-state accumulator this is a no-op.
      const messages: ModelMessage[] = repairOrphanToolCalls(
        nextState.history,
      );

      const imageCount =
        typeof content === "string"
          ? 0
          : content.reduce(
              (n, p) => (p.type === "image" ? n + 1 : n),
              0,
            );
      log.debug("send", {
        messages: messages.length,
        len: text.length,
        ...(imageCount > 0 ? { images: imageCount } : {}),
      });

      const stream = api.chat({ messages });
      abortRef.current = stream.abort;
      setStreaming({
        text: "",
        reasoning: "",
        toolInputs: [],
        reasoningStartedAt: null,
        reasoningDurationMs: null,
      });

      // Reasoning state lives outside accState — it's UI-only metadata
      // intentionally not preserved on the wire (spec §3 decision #12).
      let accText = "";
      let accReasoning = "";
      let toolInputs: LiveToolInput[] = [];
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
        text: accText,
        reasoning: accReasoning,
        toolInputs,
        reasoningStartedAt,
        reasoningDurationMs,
      });

      try {
        for await (const ev of stream.events) {
          // Feed every event into the accumulator — it knows which ones
          // affect history and which are UI-only. The result lands in
          // `accState.history` for the next turn's wire payload.
          setAccState((s) => accumulate(s, ev));

          if (ev.type === "start") {
            receivedStart = true;
            accText = "";
            accReasoning = "";
            toolInputs = [];
            reasoningStartedAt = null;
            reasoningDurationMs = null;
            log.debug("stream: start", { model: ev.model });
            setStreaming(snapshot());
          } else if (ev.type === "delta") {
            accText += ev.text;
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
          } else if (ev.type === "tool-input-start") {
            closeReasoning();
            toolInputs = applyLiveToolInputEvent(toolInputs, ev);
            setStreaming(snapshot());
          } else if (
            ev.type === "tool-input-progress" ||
            ev.type === "tool-input-end"
          ) {
            toolInputs = applyLiveToolInputEvent(toolInputs, ev);
            setStreaming(snapshot());
          } else if (ev.type === "tool-call") {
            log.debug("stream: tool-call", {
              toolCallId: ev.toolCallId,
              toolName: ev.toolName,
            });
            // Visually reset the streaming text panel so the NEXT delta starts
            // below the tool call instead of stacking under the prior prose.
            // The accumulator already folded the prior text into history.
            accText = "";
            accReasoning = "";
            toolInputs = applyLiveToolInputEvent(toolInputs, ev);
            closeReasoning();
            reasoningDurationMs = null;
            setStreaming(snapshot());
          } else if (ev.type === "tool-result") {
            log.debug("stream: tool-result", {
              toolCallId: ev.toolCallId,
              toolName: ev.toolName,
            });
            toolInputs = applyLiveToolInputEvent(toolInputs, ev);
            setStreaming(snapshot());
          } else if (ev.type === "tool-error") {
            log.warn("stream: tool-error", {
              toolCallId: ev.toolCallId,
              toolName: ev.toolName,
              message: ev.message,
            });
            toolInputs = applyLiveToolInputEvent(toolInputs, ev);
            setStreaming(snapshot());
          } else if (ev.type === "finish") {
            closeReasoning();
            log.debug("stream: finish", {
              len: accText.length,
              ...(ev.finishReason ? { finishReason: ev.finishReason } : {}),
              ...(reasoningDurationMs != null
                ? { reasoningMs: reasoningDurationMs }
                : {}),
            });
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

      if (errorMsg != null) {
        // The error frame already terminated the stream. Anything still in
        // flight in the accumulator (e.g. a half-finished assistant text) is
        // structurally invalid — drop it before exposing history to the next
        // turn so we don't ship a partial message back to the provider.
        setAccState((s) => dropPending(s));
        if (accText.length > 0) {
          // Surface the partial draft in the UI only (spec §3 decision #8 —
          // never replay an unterminated assistant turn to the model).
          pushSystem("info", `[interrupted draft] ${accText}`);
        }
        pushSystem("error", errorMsg);
        setStreaming(null);
        return;
      }

      // Stream ended without `finish` (ESC abort or server hangup). Discard
      // any in-flight content the accumulator may still hold — only fully
      // flushed step boundaries should make it into the next turn.
      setAccState((s) => dropPending(s));
      if (accText.length > 0) {
        pushSystem("info", `[interrupted draft] ${accText}`);
      } else if (!receivedStart) {
        log.warn("stream ended without any output");
        pushSystem("error", "stream ended without any output");
      }
      setStreaming(null);
    },
    [api, log, pushSystem],
  );

  const executeSubmittedInput = useCallback(
    (submittedInput: string) => {
      const trimmed = submittedInput.trim();
      if (!trimmed) return;
      const cmd = parseCommand(trimmed);
      setInput(EMPTY_INPUT);
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
        case "sessions":
          void handleSessions();
          break;
        case "new-session":
          void handleNewSession();
          break;
        case "rename-session":
          void handleRenameSession(cmd.title);
          break;
        case "invalid":
          cmdLog.warn("invalid command", { reason: cmd.reason });
          pushSystem("error", cmd.reason);
          break;
      }
    },
    [
      cmdLog,
      handleModels,
      handleNewSession,
      handleRenameSession,
      handleSend,
      handleSessions,
      handleSetModel,
      pushSystem,
    ],
  );

  usePaste((text) => {
    void (async () => {
      const img = await tryParsePastedImage(text, { fallbackToClipboard: true });
      if (img == null) {
        setInput((prev) => insert(prev, text));
        return;
      }
      const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      pendingImagesRef.current.set(id, img);
      const approxBytes = Math.floor((img.base64.length * 3) / 4);
      log.debug("pasted image", {
        id,
        mime: img.mimeType,
        source: img.source,
        bytes: approxBytes,
      });
      setInput((prev) => insert(prev, `[image:${img.mimeType}#${id}]`));
    })();
  });

  useEffect(() => {
    setCommandPalette((prev) =>
      prev == null
        ? prev
        : !input.value.startsWith("/")
          ? null
        : filterCommandPalette({ ...prev, allCommands }, input.value),
    );
  }, [allCommands, input.value]);

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

    if (sessionPicker != null) {
      if (key.escape) {
        setSessionPicker(closeSessionPicker(sessionPicker));
        return;
      }
      if (key.upArrow) {
        setSessionPicker((prev) =>
          prev == null ? prev : moveSessionPickerSelection(prev, -1),
        );
        return;
      }
      if (key.downArrow) {
        setSessionPicker((prev) =>
          prev == null ? prev : moveSessionPickerSelection(prev, 1),
        );
        return;
      }
      if (key.return) {
        const action = activateSelectedSession(sessionPicker, streaming != null);
        if (action.kind === "refuse") {
          pushSystem("error", action.reason);
        } else if (action.kind === "activate") {
          void handleActivateSession(action.sessionId);
        }
        return;
      }
      if (char === "d" && !key.ctrl && !key.meta) {
        const action = deleteSelectedSession(sessionPicker);
        if (action.kind === "delete") {
          void handleDeleteSession(action.sessionId);
        }
        return;
      }
    }

    if (commandPalette != null) {
      if (key.escape) {
        cmdLog.debug("command palette closed");
        setCommandPalette(closeCommandPalette(commandPalette));
        return;
      }
      if (key.upArrow) {
        setCommandPalette((prev) =>
          prev == null ? prev : moveCommandPaletteSelection(prev, -1),
        );
        return;
      }
      if (key.downArrow) {
        setCommandPalette((prev) =>
          prev == null ? prev : moveCommandPaletteSelection(prev, 1),
        );
        return;
      }
      if (key.return) {
        const action = activateSelectedCommand(commandPalette);
        setCommandPalette(null);
        if (action.kind === "execute") {
          cmdLog.debug("command palette execute", { input: action.input });
          executeSubmittedInput(action.input);
        } else if (action.kind === "complete-input") {
          cmdLog.debug("command palette complete", { input: action.input });
          setInput({ value: action.input, cursor: action.input.length });
        } else {
          cmdLog.warn("command palette activation without selection");
          executeSubmittedInput(input.value);
        }
        return;
      }
      if (key.leftArrow) {
        setInput((prev) => (key.meta ? moveWordLeft(prev) : moveLeft(prev)));
        return;
      }
      if (key.rightArrow) {
        setInput((prev) => (key.meta ? moveWordRight(prev) : moveRight(prev)));
        return;
      }
      if (key.backspace) {
        setInput((prev) => deleteBefore(prev));
        return;
      }
      if (key.delete) {
        setInput((prev) => deleteAt(prev));
        return;
      }
      if (char && !key.ctrl && !key.meta) {
        setInput((prev) => insert(prev, char));
      }
      return;
    }

    if (key.return) {
      executeSubmittedInput(input.value);
      return;
    }

    // Arrow-key navigation. Option/Alt + horizontal jumps a word; on macOS,
    // terminals report Option as `key.meta`. Vertical arrows always step a
    // single line — multi-line text only enters the buffer via paste today.
    if (key.leftArrow) { 
      // FIXME: 这样子检测整个单词移动是不行的, 后面要修
      setInput((prev) => (key.meta ? moveWordLeft(prev) : moveLeft(prev)));
      return;
    }
    if (key.rightArrow) { 
      // FIXME: 这样子检测整个单词移动是不行的, 后面要修
      setInput((prev) => (key.meta ? moveWordRight(prev) : moveRight(prev)));
      return;
    }
    if (key.upArrow) {
      setInput((prev) => moveUp(prev));
      return;
    }
    if (key.downArrow) {
      setInput((prev) => moveDown(prev));
      return;
    }

    if (key.backspace) {
      setInput((prev) => deleteBefore(prev));
      return;
    }
    if (key.delete) {
      setInput((prev) => deleteAt(prev));
      return;
    }

    if (char && !key.ctrl && !key.meta) {
      const next = insert(input, char);
      if (next.value.startsWith("/") && !input.value.startsWith("/")) {
        cmdLog.debug("command palette opened");
        setInput(next);
        setCommandPalette(openCommandPalette(next.value, allCommands));
        return;
      }
      setInput(next);
    }
  });

  // Derive UI entries from canonical history PLUS any in-flight pending
  // content (so a tool-call rendered while its result is still streaming
  // shows up immediately), then interleave the TUI-local system notes at the
  // conversational positions they were pinned to.
  const renderHistory = useMemo(
    () => snapshotForRender(accState),
    [accState],
  );
  const entries = useMemo<Entry[]>(
    () => mergeEntries(renderHistory, sideNotes),
    [renderHistory, sideNotes],
  );

  const noModels = !modelsError && models != null && models.models.length === 0;
  const currentName = models?.current ?? null;

  const terminalRows = stdout?.rows ?? 24;
  const terminalColumns = stdout?.columns ?? 80;

  return (
    <Box
      flexDirection="column"
      padding={1}
      minHeight={terminalRows}
      width={terminalColumns}
    >
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
        {sessionPicker != null ? (
          <SessionPickerView state={sessionPicker} />
        ) : null}
        {entries.length === 0 && streaming == null ? (
          <Text dimColor>
            type something and press enter · /sessions · /new · /rename &lt;title&gt; · /models · esc to cancel · ctrl+c to exit
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
            {streaming.text.length > 0 ? (
              <Box>
                <Text color="yellow">ai </Text>
                <Text> · </Text>
                <Text>{streaming.text}</Text>
                <Text color="gray">▌</Text>
              </Box>
            ) : null}
            {streaming.toolInputs.map((input) => (
              <LiveToolInputView key={input.toolCallId} input={input} />
            ))}
          </Box>
        ) : null}
      </Box>

      <Input
        value={input.value}
        cursor={input.cursor}
        isStreaming={streaming != null}
      />
      <CommandPaletteOverlay state={commandPalette} />
    </Box>
  );
}

function LiveToolInputView({ input }: { input: LiveToolInput }) {
  return (
    <Box>
      <Text color="cyan" dimColor>
        → {formatLiveToolInput(input)}
      </Text>
    </Box>
  );
}

function SessionPickerView({ state }: { state: SessionPickerState }) {
  const details = selectedSessionDetails(state);
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color="cyan" bold>
        Sessions
      </Text>
      {state.sessions.length === 0 ? (
        <Text dimColor>No sessions for this project</Text>
      ) : (
        state.sessions.map((session, index) => (
          <SessionPickerRow
            key={session.id}
            session={session}
            selected={index === state.selectedIndex}
          />
        ))
      )}
      {details != null ? (
        <Text dimColor>
          selected id {details.id.split("_")[1]}
        </Text>
      ) : null}
      <Text dimColor>Up/Down select · Enter resume · d delete · Esc close</Text>
    </Box>
  );
}

function SessionPickerRow({
  session,
  selected,
}: {
  session: SessionSummary;
  selected: boolean;
}) {
  return (
    <Box>
      <Text color={selected ? "cyan" : undefined}>{selected ? "> " : "  "}</Text>
      <Text>{session.title ?? "Untitled session"}</Text>
      <Text dimColor>
        {" "}
        · {session.messageCount} messages
        {session.model ? ` · ${session.model}` : ""}
      </Text>
    </Box>
  );
}

function CommandPaletteOverlay({
  state,
}: {
  state: CommandPaletteState | null;
}) {
  const { stdout } = useStdout();
  if (state == null) return null;

  const columns = stdout?.columns ?? 80;
  const rows = stdout?.rows ?? 24;
  const panelWidth = Math.max(36, Math.min(72, columns - 4));
  const firstVisibleIndex =
    state.selectedIndex >= COMMAND_PALETTE_MAX_ROWS
      ? state.selectedIndex - COMMAND_PALETTE_MAX_ROWS + 1
      : 0;
  const visibleCommands = state.visibleCommands.slice(
    firstVisibleIndex,
    firstVisibleIndex + COMMAND_PALETTE_MAX_ROWS,
  );

  return (
    <Box
      position="absolute"
      left={0}
      top={0}
      width={columns}
      height={rows}
      alignItems="center"
      justifyContent="center"
    >
      <Box
        flexDirection="column"
        width={panelWidth}
        borderStyle="round"
        borderColor="gray"
        paddingX={1}
      >
        <Box justifyContent="space-between">
          <Text color="cyan" bold>
            Commands
          </Text>
          <Text dimColor>/{state.query}</Text>
        </Box>
        {visibleCommands.length === 0 ? (
          <Text dimColor>
            {state.allCommands.length === 0
              ? "No commands"
              : "No matching commands"}
          </Text>
        ) : (
          visibleCommands.map((command, index) => (
            <CommandPaletteRow
              key={`${command.source}:${command.name}`}
              command={command}
              selected={firstVisibleIndex + index === state.selectedIndex}
            />
          ))
        )}
        <Text dimColor>Up/Down select · Enter · Esc</Text>
      </Box>
    </Box>
  );
}

function CommandPaletteRow({
  command,
  selected,
}: {
  command: SlashCommandDefinition;
  selected: boolean;
}) {
  return (
    <Box>
      <Text color={selected ? "cyan" : undefined}>{selected ? "> " : "  "}</Text>
      <Text color={selected ? "cyan" : undefined}>{command.usage}</Text>
      <Text dimColor> · {command.description}</Text>
    </Box>
  );
}

/**
 * Merge entries derived from `history` with the chronologically-pinned
 * `sideNotes`. Notes pinned at `afterHistoryLen === N` render AFTER all
 * derived entries originating from `history[0..N-1]` and BEFORE any from
 * `history[N..]`.
 */
function mergeEntries(
  history: ModelMessage[],
  sideNotes: PinnedSystemNote[],
): Entry[] {
  const { entries, entriesPerMessage } = deriveEntriesWithBoundaries(history);
  if (sideNotes.length === 0) return entries;

  // Group notes by their pin position for O(1) lookup per boundary.
  const notesByPin = new Map<number, SystemEntry[]>();
  for (const n of sideNotes) {
    const list = notesByPin.get(n.afterHistoryLen);
    if (list == null) notesByPin.set(n.afterHistoryLen, [n.entry]);
    else list.push(n.entry);
  }

  const out: Entry[] = [];
  let derivedCursor = 0;
  for (let boundary = 0; boundary <= history.length; boundary++) {
    const pinned = notesByPin.get(boundary);
    if (pinned != null) {
      for (const n of pinned) out.push(n);
    }
    if (boundary === history.length) break;
    const count = entriesPerMessage[boundary] ?? 0;
    for (let k = 0; k < count; k++) {
      const e = entries[derivedCursor++];
      if (e != null) out.push(e);
    }
  }
  return out;
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
  if (entry.kind === "tool") {
    return <ToolEntryView entry={entry} />;
  }
  const reasoningSummary =
    entry.role === "assistant" && entry.reasoningDurationMs != null
      ? `Thought for ${formatThinkingDuration(entry.reasoningDurationMs)}`
      : null;
  const rendered = renderContent(entry.content);
  // Suppress the "ai · " row when this segment only carries reasoning (e.g.
  // a turn that thought, then immediately called a tool with no preceding
  // prose). Without this guard we'd render a naked "ai · " line above the
  // tool entry, which looks like a broken empty message.
  const showBody = rendered.length > 0 || entry.role !== "assistant";
  return (
    <Box flexDirection="column">
      {reasoningSummary != null ? (
        <Text color="gray" italic>
          {reasoningSummary}
        </Text>
      ) : null}
      {showBody ? (
        <Box>
          <Text color={entry.role === "user" ? "green" : "yellow"}>
            {entry.role === "user" ? "you" : "ai "}
          </Text>
          <Text> · </Text>
          <Text>{rendered}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

function ToolEntryView({ entry }: { entry: ToolEntry }) {
  // Color and prefix encode the lifecycle phase at a glance:
  //   →  cyan/dim  : invoked, awaiting result
  //   ←  cyan      : completed successfully
  //   ×  red       : tool errored (model can recover; this is not a turn-ending error)
  if (entry.phase === "call") {
    return (
      <Box>
        <Text color="cyan" dimColor>
          → {formatToolCall(entry.toolName, entry.input)}
        </Text>
      </Box>
    );
  }
  if (entry.phase === "result") {
    return (
      <Box flexDirection="column">
        <Text color="cyan" dimColor>
          → {formatToolCall(entry.toolName, entry.input)}
        </Text>
        <Text color="cyan">
          ← {formatToolResult(entry.toolName, entry.output)}
        </Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      <Text color="cyan" dimColor>
        → {formatToolCall(entry.toolName, entry.input)}
      </Text>
      <Text color="red">
        × {formatToolError(entry.toolName, entry.errorMessage ?? "")}
      </Text>
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
