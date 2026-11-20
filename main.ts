// main.ts — lifecycle only: bind an ephemeral port, register with the
// environment, long-poll /done until the run ends, then exit 0.
import { createApp } from './app.ts';

const envUrl = process.env.MAKEFUN_ENV_URL ?? '';

async function register(port: number): Promise<void> {
  if (envUrl === '') return;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
      });
      if (response.ok) return;
    } catch {
      // Retry below.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Failed to register with the environment');
}

async function waitForDone(): Promise<void> {
  if (envUrl === '') {
    // No environment: serve forever (local development).
    await new Promise(() => undefined);
    return;
  }
  for (;;) {
    try {
      const response = await fetch(`${envUrl}/done`);
      if (response.ok) {
        const data = (await response.json()) as { done?: boolean };
        if (data.done === true) return;
      }
    } catch {
      // Retry below.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function main(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  console.error(`forge listening on 127.0.0.1:${port}`);
  await register(port);
  await waitForDone();
  server.close();
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
