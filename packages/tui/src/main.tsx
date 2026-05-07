import React from "react";
import { render } from "ink";
import { startServerWorker } from "./server-host.js";
import { createApiClient } from "./api/client.js";
import { App } from "./components/App.js";

async function main() {
  const handle = await startServerWorker({
    port: Number(process.env.LORDCODE_PORT ?? 0),
    host: process.env.LORDCODE_HOST ?? "127.0.0.1",
    logLevel: "silent",
  });

  const api = createApiClient(handle.baseUrl);

  const ink = render(
    <App
      api={api}
      baseUrl={handle.baseUrl}
      onExit={() => {
        void handle.shutdown();
      }}
    />,
    { exitOnCtrlC: false },
  );

  const cleanup = async () => {
    ink.unmount();
    await handle.shutdown();
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  await ink.waitUntilExit();
  await handle.shutdown();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
