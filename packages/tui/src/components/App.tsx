import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import type { ChatMessage, ModelsListResponse } from "@lordcode/shared";
import type { ApiClient } from "../api/client.js";
import { parseCommand } from "../lib/commands.js";

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

type Entry = ({ kind: "msg" } & ChatMessage) | SystemEntry;

export function App({ api, baseUrl, onExit }: AppProps) {
  const ink = useApp();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [input, setInput] = useState("");
  const [models, setModels] = useState<ModelsListResponse | null>(null);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [streaming, setStreaming] = useState<{ text: string } | null>(null);
  const abortRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const m = await api.listModels();
        setModels(m);
      } catch (err) {
        setModelsError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [api]);

  const pushSystem = useCallback(
    (tone: "info" | "error", content: string) => {
      setEntries((prev) => [...prev, { kind: "system", tone, content }]);
    },
    [],
  );

  const pushMessage = useCallback((msg: ChatMessage) => {
    setEntries((prev) => [...prev, { kind: "msg", ...msg }]);
  }, []);

  const handleModels = useCallback(async () => {
    try {
      const m = await api.listModels();
      setModels(m);
      pushSystem("info", formatModelsList(m));
    } catch (err) {
      pushSystem(
        "error",
        `failed to list models: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }, [api, pushSystem]);

  const handleSetModel = useCallback(
    async (name: string) => {
      try {
        const res = await api.setCurrentModel(name);
        setModels((prev) => (prev ? { ...prev, current: res.current } : prev));
        pushSystem("info", `switched to ${res.current}`);
      } catch (err) {
        pushSystem(
          "error",
          err instanceof Error ? err.message : String(err),
        );
      }
    },
    [api, pushSystem],
  );

  const handleSend = useCallback(
    async (text: string) => {
      const userMsg: ChatMessage = { role: "user", content: text };
      const baseEntries: Entry[] = [...entries, { kind: "msg", ...userMsg }];
      const messages: ChatMessage[] = baseEntries
        .filter((e): e is { kind: "msg" } & ChatMessage => e.kind === "msg")
        .map(({ kind: _kind, ...m }) => m);
      setEntries(baseEntries);

      const stream = api.chat({ messages });
      abortRef.current = stream.abort;
      setStreaming({ text: "" });

      let acc = "";
      let receivedStart = false;
      let errorMsg: string | null = null;

      try {
        for await (const ev of stream.events) {
          if (ev.type === "start") {
            receivedStart = true;
            setStreaming({ text: "" });
          } else if (ev.type === "delta") {
            acc += ev.text;
            setStreaming({ text: acc });
          } else if (ev.type === "finish") {
            const suffix = ev.aborted ? "\n[interrupted]" : "";
            pushMessage({ role: "assistant", content: acc + suffix });
            setStreaming(null);
            return;
          } else if (ev.type === "error") {
            errorMsg = ev.message;
            break;
          }
        }
      } catch (err) {
        errorMsg = err instanceof Error ? err.message : String(err);
      } finally {
        abortRef.current = null;
      }

      if (errorMsg != null) {
        if (acc.length > 0) {
          pushMessage({ role: "assistant", content: `${acc}\n[interrupted]` });
        }
        pushSystem("error", errorMsg);
        setStreaming(null);
        return;
      }

      if (acc.length > 0) {
        pushMessage({ role: "assistant", content: `${acc}\n[interrupted]` });
      } else if (!receivedStart) {
        pushSystem("error", "stream ended without any output");
      }
      setStreaming(null);
    },
    [api, entries, pushMessage, pushSystem],
  );

  useInput((char, key) => {
    if (key.ctrl && (char === "c" || char === "d")) {
      abortRef.current?.();
      ink.exit();
      onExit();
      return;
    }

    if (streaming != null) {
      if (key.escape) {
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
          <Box>
            <Text color="yellow">ai </Text>
            <Text> · </Text>
            <Text>{streaming.text}</Text>
            <Text color="gray">▌</Text>
          </Box>
        ) : null}
      </Box>

      <Box>
        <Text color={streaming != null ? "gray" : "magenta"}>
          {streaming != null ? "…" : "›"}{" "}
        </Text>
        <Text>{input}</Text>
        {streaming == null ? <Text color="gray">█</Text> : null}
      </Box>
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
  return (
    <Box>
      <Text color={entry.role === "user" ? "green" : "yellow"}>
        {entry.role === "user" ? "you" : "ai "}
      </Text>
      <Text> · </Text>
      <Text>{entry.content}</Text>
    </Box>
  );
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
