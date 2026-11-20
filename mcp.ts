// mcp.ts — Model Context Protocol over Streamable HTTP (JSON-RPC 2.0,
// plain JSON responses). Era 2026-07-28: server/discover first, initialize
// as legacy insurance, tools/list + tools/call for the six forge tools.
import {
  branchTip, createIssue, createPull, repoGlobalId, squashMerge, store,
  type Repo,
} from './store.ts';

export interface McpResult {
  status: number;
  body: unknown;
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: Record<string, unknown>;
}

const SERVER_NAME = 'github-forge';
const SERVER_VERSION = '1.0.0';

function toolsList(): Record<string, unknown>[] {
  return [
    {
      name: 'create_repo',
      description: 'Create a new repository owned by the authenticated user.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Repository name' },
          description: { type: 'string', description: 'Repository description' },
          private: { type: 'boolean', description: 'Whether the repository is private' },
        },
        required: ['name'],
      },
    },
    {
      name: 'get_repo',
      description: 'Get a repository by owner and name.',
      inputSchema: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'Repository owner login' },
          repo: { type: 'string', description: 'Repository name' },
        },
        required: ['owner', 'repo'],
      },
    },
    {
      name: 'create_issue',
      description: 'Create an issue in a repository.',
      inputSchema: {
        type: 'object',
        properties: {
          owner: { type: 'string' },
          repo: { type: 'string' },
          title: { type: 'string' },
          body: { type: 'string' },
        },
        required: ['owner', 'repo', 'title'],
      },
    },
    {
      name: 'list_issues',
      description: 'List issues in a repository.',
      inputSchema: {
        type: 'object',
        properties: {
          owner: { type: 'string' },
          repo: { type: 'string' },
          state: { type: 'string', enum: ['open', 'closed', 'all'] },
        },
        required: ['owner', 'repo'],
      },
    },
    {
      name: 'create_pull_request',
      description: 'Create a pull request in a repository.',
      inputSchema: {
        type: 'object',
        properties: {
          owner: { type: 'string' },
          repo: { type: 'string' },
          title: { type: 'string' },
          head: { type: 'string', description: 'Head branch name' },
          base: { type: 'string', description: 'Base branch name' },
          body: { type: 'string' },
        },
        required: ['owner', 'repo', 'title', 'head', 'base'],
      },
    },
    {
      name: 'merge_pull_request',
      description: 'Merge a pull request with a squash merge.',
      inputSchema: {
        type: 'object',
        properties: {
          owner: { type: 'string' },
          repo: { type: 'string' },
          pull_number: { type: 'integer', description: 'Pull request number' },
        },
        required: ['owner', 'repo', 'pull_number'],
      },
    },
  ];
}

function serverInfo(): Record<string, unknown> {
  return { name: SERVER_NAME, version: SERVER_VERSION };
}

function result(id: unknown, value: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result: value };
}

function error(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function textResult(data: unknown, isError = false): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }],
    structuredContent: data,
    ...(isError ? { isError: true } : {}),
  };
}

function missingArg(name: string): Record<string, unknown> {
  return textResult({ error: `Missing required argument: ${name}` }, true);
}

function repoOf(args: Record<string, unknown>): Repo | null {
  const owner = String(args.owner ?? '');
  const repo = String(args.repo ?? '');
  if (!owner || !repo) return null;
  return store.getRepo(owner, repo) ?? null;
}

function callTool(name: string, args: Record<string, unknown>): Record<string, unknown> {
  switch (name) {
    case 'create_repo': {
      const repoName = args.name;
      if (typeof repoName !== 'string' || repoName === '') return missingArg('name');
      const result = store.createRepo(repoName, {
        description: typeof args.description === 'string' ? args.description : undefined,
        private: typeof args.private === 'boolean' ? args.private : undefined,
      });
      if ('error' in result) return textResult({ error: result.error }, true);
      return textResult({
        id: result.id,
        name: result.name,
        full_name: `${result.owner}/${result.name}`,
        owner: { login: result.owner },
        description: result.description,
        private: result.private,
        default_branch: result.defaultBranch,
      });
    }
    case 'get_repo': {
      if (typeof args.owner !== 'string' || args.owner === '') return missingArg('owner');
      if (typeof args.repo !== 'string' || args.repo === '') return missingArg('repo');
      const repo = repoOf(args);
      if (!repo) return textResult({ error: 'Repository not found' }, true);
      return textResult({
        id: repo.id,
        name: repo.name,
        full_name: `${repo.owner}/${repo.name}`,
        owner: { login: repo.owner },
        description: repo.description,
        private: repo.private,
        default_branch: repo.defaultBranch,
      });
    }
    case 'create_issue': {
      if (typeof args.owner !== 'string' || args.owner === '') return missingArg('owner');
      if (typeof args.repo !== 'string' || args.repo === '') return missingArg('repo');
      if (typeof args.title !== 'string' || args.title === '') return missingArg('title');
      const repo = repoOf(args);
      if (!repo) return textResult({ error: 'Repository not found' }, true);
      const issue = createIssue(repo, {
        title: args.title,
        body: typeof args.body === 'string' ? args.body : undefined,
      });
      if ('error' in issue) return textResult({ error: issue.error }, true);
      return textResult({
        id: issue.id,
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
        labels: issue.labels,
      });
    }
    case 'list_issues': {
      if (typeof args.owner !== 'string' || args.owner === '') return missingArg('owner');
      if (typeof args.repo !== 'string' || args.repo === '') return missingArg('repo');
      const repo = repoOf(args);
      if (!repo) return textResult({ error: 'Repository not found' }, true);
      const state = typeof args.state === 'string' ? args.state : 'open';
      let issues = [...repo.issues.values()];
      if (state !== 'all') issues = issues.filter((i) => i.state === state);
      issues.sort((a, b) => b.number - a.number);
      return textResult(issues.map((i) => ({
        id: i.id,
        number: i.number,
        title: i.title,
        body: i.body,
        state: i.state,
        labels: i.labels,
      })));
    }
    case 'create_pull_request': {
      for (const field of ['owner', 'repo', 'title', 'head', 'base'] as const) {
        if (typeof args[field] !== 'string' || args[field] === '') return missingArg(field);
      }
      const repo = repoOf(args);
      if (!repo) return textResult({ error: 'Repository not found' }, true);
      const pull = createPull(repo, {
        title: args.title as string,
        body: typeof args.body === 'string' ? args.body : undefined,
        head: args.head as string,
        base: args.base as string,
      });
      if ('error' in pull) return textResult({ error: pull.error }, true);
      return textResult({
        id: pull.id,
        number: pull.number,
        title: pull.title,
        body: pull.body,
        state: pull.state,
        head: { ref: pull.headRef, sha: branchTip(repo, pull.headRef) ?? pull.headSha },
        base: { ref: pull.baseRef, sha: branchTip(repo, pull.baseRef) ?? pull.baseSha },
      });
    }
    case 'merge_pull_request': {
      if (typeof args.owner !== 'string' || args.owner === '') return missingArg('owner');
      if (typeof args.repo !== 'string' || args.repo === '') return missingArg('repo');
      if (typeof args.pull_number !== 'number') return missingArg('pull_number');
      const repo = repoOf(args);
      if (!repo) return textResult({ error: 'Repository not found' }, true);
      const pull = repo.pulls.get(args.pull_number);
      if (!pull) return textResult({ error: 'Pull request not found' }, true);
      if (pull.state !== 'open') return textResult({ error: 'Pull request is not open' }, true);
      const merged = squashMerge(repo, pull);
      if ('error' in merged) return textResult({ error: merged.error }, true);
      return textResult({ sha: merged.commitSha, merged: true, message: `Pull request #${pull.number} merged` });
    }
    default:
      return textResult({ error: `Unknown tool: ${name}` }, true);
  }
}

/** Handle one JSON-RPC request object. */
export function handleMcpRequest(request: JsonRpcRequest): Record<string, unknown> {
  const id = request.id ?? null;
  const method = request.method ?? '';
  const params = (request.params ?? {}) as Record<string, unknown>;

  if (method === 'server/discover') {
    const value = {
      supportedVersions: ['2026-07-28', '2025-06-18', '2025-03-26'],
      capabilities: { tools: {} },
      serverInfo: serverInfo(),
      _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo() },
    };
    return result(id, value);
  }
  if (method === 'initialize') {
    return result(id, {
      protocolVersion: '2026-07-28',
      capabilities: { tools: {} },
      serverInfo: serverInfo(),
    });
  }
  if (method === 'tools/list') {
    return result(id, { tools: toolsList() });
  }
  if (method === 'tools/call') {
    const name = params.name;
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    if (typeof name !== 'string' || name === '') {
      return error(id, -32602, 'Tool name is required');
    }
    const known = toolsList().some((tool) => tool.name === name);
    if (!known) {
      return error(id, -32602, `Unknown tool: ${name}`);
    }
    return result(id, callTool(name, args));
  }
  if (method === 'ping') {
    return result(id, {});
  }
  return error(id, -32601, `Method not found: ${method}`);
}

/** Handle the POST /mcp body: a single request or a batch array. */
export function handleMcp(body: unknown): McpResult {
  if (Array.isArray(body)) {
    return { status: 200, body: body.map((entry) => handleMcpRequest(entry as JsonRpcRequest)) };
  }
  if (body === null || typeof body !== 'object') {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  return { status: 200, body: handleMcpRequest(body as JsonRpcRequest) };
}

/** The repo global id helper, re-exported for callers that need it. */
export { repoGlobalId };
