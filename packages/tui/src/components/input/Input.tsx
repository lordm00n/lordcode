import { Box, Text } from "ink";

interface InputProps {
  value: string;
  isStreaming: boolean;
}

/**
 * Presentational prompt line for the TUI's command input.
 *
 * Pure render: key handling and input state live in the parent (`App`) via
 * `useInput`. While a stream is in flight we dim the prompt, swap the chevron
 * for an ellipsis, and hide the trailing cursor block — the user can't type
 * during streaming, and a blinking cursor would falsely suggest otherwise.
 */
export function Input({ value, isStreaming }: InputProps) {
  return (
    <Box>
      <Text color={isStreaming ? "gray" : "magenta"}>
        {isStreaming ? "…" : "›"}{" "}
      </Text>

      <Text>
        {value.split("").map((char, index) => (
          <Text key={index}>
            {char}
          </Text>
        ))}
        {!isStreaming ? <Text color="gray">█</Text> : null}
      </Text>
    </Box>
  );
}
