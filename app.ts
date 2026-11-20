// app.ts — HTTP server: routing, auth, request ids, JSON helpers.
// Routes:
//   GET  /healthz                                  (no auth)
//   GET  /{owner}/{repo}.git/info/refs             (git advertisement, no auth)
//   POST /{owner}/{repo}.git/git-upload-pack       (no auth)
//   POST /{owner}/{repo}.git/git-receive-pack      (no auth)
//   /api/v3/*                                      (Bearer auth)
//   POST /api/graphql                              (Bearer auth)
//   POST /mcp                                      (Bearer auth)
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './githttp.ts';
import { handleRest } from './rest.ts';
import { executeGraphQL, executeGraphQLBatch } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { store } from './store.ts';

export function shopToken(): string {
  return process.env.MAKEFUN_SHOP_TOKEN ?? '';
}

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function sendJson(response: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const payload = body === null ? '' : JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    'x-github-request-id': nextRequestId(),
    ...extraHeaders,
  });
  response.end(payload);
}

function sendRaw(response: ServerResponse, status: number, contentType: string, body: Buffer): void {
  response.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': nextRequestId(),
  });
  response.end(body);
}

function authorized(request: IncomingMessage): boolean {
  const header = request.headers.authorization ?? '';
  const token = shopToken();
  if (token === '') {
    // Dev convenience: no token configured — accept any non-empty Bearer.
    return /^Bearer \S+$/.test(header);
  }
  return header === `Bearer ${token}`;
}

function unauthorized(response: ServerResponse): void {
  sendJson(response, 401, { message: 'Bad credentials' });
}

export function createApp(): ReturnType<typeof createServer> {
  const server = createServer(async (request, response) => {
    try {
      await handleRequest(request, response);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Internal Server Error';
      if (!response.headersSent) sendJson(response, 500, { message });
      else response.end();
    }
  });
  return server;
}

async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  const path = url.pathname;
  const method = request.method ?? 'GET';

  // Health check (no auth).
  if (path === '/healthz') {
    sendJson(response, 200, { ok: true });
    return;
  }

  // Git smart HTTP (no auth — the git client carries no token).
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
  if (gitMatch) {
    const owner = gitMatch[1]!;
    const repoName = gitMatch[2]!;
    const action = gitMatch[3]!;
    const repo = store.getRepo(owner, repoName);
    if (action === 'info/refs') {
      if (method !== 'GET') { sendJson(response, 404, { message: 'Not Found' }); return; }
      const service = url.searchParams.get('service') ?? '';
      const gitProtocol = request.headers['git-protocol'] ?? '';
      const result = handleInfoRefs(repo, service, gitProtocol);
      if (result.status === 404) {
        sendJson(response, 404, { message: 'Not Found' });
        return;
      }
      sendRaw(response, result.status, result.headers['content-type']!, result.body);
      return;
    }
    const body = await readBody(request);
    const result = action === 'git-upload-pack'
      ? handleUploadPack(repo, body, request.headers['git-protocol'] ?? '')
      : handleReceivePack(repo, body);
    if (result.status === 404) {
      sendJson(response, 404, { message: 'Not Found' });
      return;
    }
    sendRaw(response, result.status, result.headers['content-type']!, result.body);
    return;
  }

  // REST v3 (Bearer auth).
  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    if (!authorized(request)) { unauthorized(response); return; }
    const restPath = path === '/api/v3' ? '/' : path.slice('/api/v3'.length);
    let body: Record<string, unknown> | null = null;
    if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
      const raw = await readBody(request);
      if (raw.length > 0) {
        try {
          body = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
        } catch {
          sendJson(response, 400, { message: 'Problems parsing JSON' });
          return;
        }
      }
    }
    const result = handleRest({
      method,
      path: restPath,
      query: url.searchParams,
      body,
      origin: `http://${request.headers.host ?? '127.0.0.1'}`,
    });
    if (result === null) {
      sendJson(response, 404, { message: 'Not Found' });
      return;
    }
    if (result.status === 204) {
      response.writeHead(204, { 'x-github-request-id': nextRequestId() });
      response.end();
      return;
    }
    sendJson(response, result.status, result.body, result.headers ?? {});
    return;
  }

  // GraphQL (Bearer auth).
  if (path === '/api/graphql') {
    if (method !== 'POST') { sendJson(response, 404, { message: 'Not Found' }); return; }
    if (!authorized(request)) { unauthorized(response); return; }
    const raw = await readBody(request);
    let body: unknown;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      sendJson(response, 400, { message: 'Problems parsing JSON' });
      return;
    }
    const result = Array.isArray(body) ? executeGraphQLBatch(body) : executeGraphQL(body);
    sendJson(response, 200, result);
    return;
  }

  // MCP (Bearer auth).
  if (path === '/mcp') {
    if (method !== 'POST') { sendJson(response, 404, { message: 'Not Found' }); return; }
    if (!authorized(request)) { unauthorized(response); return; }
    const raw = await readBody(request);
    let body: unknown = null;
    if (raw.length > 0) {
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch {
        sendJson(response, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
        return;
      }
    }
    const result = handleMcp(body);
    sendJson(response, result.status, result.body);
    return;
  }

  sendJson(response, 404, { message: 'Not Found' });
}
