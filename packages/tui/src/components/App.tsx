import React, { useEffect, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import type { ChatMessage } from "@lordcode/shared";
import type { ApiClient } from "../api/client.js";

interface AppProps {
  api: ApiClient;
  baseUrl: string;
  onExit: () => void;
}

export function App({ api, baseUrl, onExit }: AppProps) {
  const ink = useApp();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useInput((char, key) => {
    if (busy) return;

    if (key.return) {
      const trimmed = input.trim();
      if (!trimmed) return;
      void send(trimmed);
      return;
    }

    if (key.ctrl && (char === "c" || char === "d")) {
      ink.exit();
      onExit();
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

  const send = async (content: string) => {
    setError(null);
    setBusy(true);
    const next: ChatMessage[] = [...messages, { role: "user", content }];
    setMessages(next);
    setInput("");
    try {
      const res = await api.chat({ messages: next });
      setMessages([...next, res.message]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text color="cyan" bold>
          lordcode
        </Text>
        <Text dimColor> · server </Text>
        <Text>{baseUrl}</Text>
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        {messages.length === 0 ? (
          <Text dimColor>type something and press enter · ctrl+c to exit</Text>
        ) : (
          messages.map((m, i) => (
            <Box key={i} marginBottom={0}>
              <Text color={m.role === "user" ? "green" : "yellow"}>
                {m.role === "user" ? "you" : "ai "}
              </Text>
              <Text> · </Text>
              <Text>{m.content}</Text>
            </Box>
          ))
        )}
      </Box>

      {error ? (
        <Box marginBottom={1}>
          <Text color="red">error: {error}</Text>
        </Box>
      ) : null}

      <Box>
        <Text color={busy ? "gray" : "magenta"}>{busy ? "…" : "›"} </Text>
        <Text>{input}</Text>
        {!busy ? <Text color="gray">█</Text> : null}
      </Box>
    </Box>
  );
}
