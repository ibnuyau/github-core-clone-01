// rest.ts — REST v3 handlers. Each handler returns {status, body} and the
// router in app.ts adds the JSON content type and X-GitHub-Request-Id.
import {
  VIEWER_LOGIN, VIEWER_NAME, blobAtPath, branchTip, commitFile, commitTree,
  createIssue, createPull, defaultTip, dirEntries, getObject,
  listCommits, resolveRef, squashMerge, store, diffTrees, type Issue, type Pull, type Repo,
} from './store.ts';

export interface RestResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

const ok = (body: unknown, status = 200, headers?: Record<string, string>): RestResult => ({ status, body, headers });
const notFound = (message = 'Not Found'): RestResult => ({ status: 404, body: { message } });
const unprocessable = (message: string): RestResult => ({ status: 422, body: { message } });
const conflict = (message: string): RestResult => ({ status: 409, body: { message } });
const badRequest = (message: string): RestResult => ({ status: 400, body: { message } });

function repoOr404(owner: string, name: string): Repo | RestResult {
  const repo = store.getRepo(owner, name);
  if (!repo) return notFound();
  return repo;
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: repo.owner === VIEWER_LOGIN ? 1000 : 1002, type: 'User' },
    description: repo.description,
    private: repo.private,
    default_branch: repo.defaultBranch,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    clone_url: `https://example.invalid/${repo.owner}/${repo.name}.git`,
    git_url: `https://example.invalid/${repo.owner}/${repo.name}.git`,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name, color: repo.labels.get(name)?.color ?? '000000' })),
    user: { login: VIEWER_LOGIN, id: 1000, type: 'User' },
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  const headSha = branchTip(repo, pull.headRef) ?? pull.headSha;
  const baseSha = branchTip(repo, pull.baseRef) ?? pull.baseSha;
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: headSha, repo: { full_name: `${repo.owner}/${repo.name}` } },
    base: { ref: pull.baseRef, sha: baseSha, repo: { full_name: `${repo.owner}/${repo.name}` } },
    user: { login: VIEWER_LOGIN, id: 1000, type: 'User' },
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
}

/** Parse ?per_page=&page= with defaults, clamping per_page to [1, 100]. */
function pageParams(query: URLSearchParams): { perPage: number; page: number } {
  const perPage = Math.min(100, Math.max(1, parseInt(query.get('per_page') ?? '30', 10) || 30));
  const page = Math.max(1, parseInt(query.get('page') ?? '1', 10) || 1);
  return { perPage, page };
}

function paginate<T>(items: T[], perPage: number, page: number): { page: T[]; totalPages: number } {
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  return { page: items.slice(start, start + perPage), totalPages };
}

/** Build a Link header for pagination (absolute same-origin URLs). */
function linkHeader(base: string, page: number, totalPages: number, perPage: number): string | null {
  const links: string[] = [];
  if (page < totalPages) links.push(`<${base}?per_page=${perPage}&page=${page + 1}>; rel="next"`);
  if (page > 1) links.push(`<${base}?per_page=${perPage}&page=${page - 1}>; rel="prev"`);
  if (totalPages > 1) {
    links.push(`<${base}?per_page=${perPage}&page=1>; rel="first"`);
    links.push(`<${base}?per_page=${perPage}&page=${totalPages}>; rel="last"`);
  }
  return links.length > 0 ? links.join(', ') : null;
}

export interface RestContext {
  method: string;
  path: string;
  query: URLSearchParams;
  body: Record<string, unknown> | null;
  origin: string;
}

/** Route a REST request. Returns null when the path is not a REST route. */
export function handleRest(ctx: RestContext): RestResult | null {
  const { method, path, query, body } = ctx;
  const segments = path.split('/').filter((s) => s !== '');

  // GET /api/v3/
  if (segments.length === 0) {
    if (method !== 'GET') return notFound();
    return ok(
      { current_user_url: `${ctx.origin}/api/v3/user`, repository_url: `${ctx.origin}/api/v3/repos/{owner}/{repo}` },
      200,
      { 'X-OAuth-Scopes': 'repo, read:org' },
    );
  }

  // GET /api/v3/meta
  if (segments.length === 1 && segments[0] === 'meta') {
    if (method !== 'GET') return notFound();
    return ok({ installed_version: '1.0.0', verifiable_password_authentication: true });
  }

  // GET /api/v3/user, GET/POST /api/v3/user/repos
  if (segments.length >= 1 && segments[0] === 'user') {
    if (segments.length === 1) {
      if (method !== 'GET') return notFound();
      return ok({ login: VIEWER_LOGIN, id: 1000, type: 'User', name: VIEWER_NAME, email: VIEWER_EMAIL });
    }
    if (segments.length === 2 && segments[1] === 'repos') {
      if (method === 'GET') {
        const { perPage, page } = pageParams(query);
        const repos = store.listViewerRepos();
        const { page: pageItems, totalPages } = paginate(repos, perPage, page);
        const link = linkHeader(`${ctx.origin}/api/v3/user/repos`, page, totalPages, perPage);
        return ok(pageItems.map(repoJson), 200, link ? { Link: link } : undefined);
      }
      if (method === 'POST') {
        const name = typeof body?.name === 'string' ? body.name : '';
        if (name === '') return badRequest('name is required');
        const result = store.createRepo(name, {
          description: typeof body?.description === 'string' ? body.description : undefined,
          private: typeof body?.private === 'boolean' ? body.private : undefined,
        });
        if ('error' in result) return unprocessable(result.error);
        return ok(repoJson(result), 201);
      }
      return notFound();
    }
    return notFound();
  }

  // /api/v3/repos/{owner}/{repo}[...]
  if (segments.length >= 3 && segments[0] === 'repos') {
    const owner = segments[1]!;
    const repoName = segments[2]!;
    const rest = segments.slice(3);
    const repo = repoOr404(owner, repoName);
    if ('status' in repo) return repo;

    // GET/PATCH/DELETE /api/v3/repos/{o}/{r}
    if (rest.length === 0) {
      if (method === 'GET') return ok(repoJson(repo));
      if (method === 'PATCH') {
        if (typeof body?.description === 'string') repo.description = body.description;
        if (typeof body?.default_branch === 'string') repo.defaultBranch = body.default_branch;
        return ok(repoJson(repo));
      }
      if (method === 'DELETE') {
        store.deleteRepo(owner, repoName);
        return { status: 204, body: null };
      }
      return notFound();
    }

    // git refs: POST /git/refs, GET /git/refs/heads/{branch}
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (method === 'POST' && rest.length === 2) {
        const ref = typeof body?.ref === 'string' ? body.ref : '';
        const sha = typeof body?.sha === 'string' ? body.sha : '';
        if (!ref.startsWith('refs/') || !getObject(repo, sha)) return unprocessable('ref and sha are required');
        if (repo.refs.has(ref)) return unprocessable(`Reference '${ref}' already exists`);
        repo.refs.set(ref, sha);
        return ok({ ref, object: { sha } }, 201);
      }
      if (method === 'GET' && rest.length >= 4 && rest[2] === 'heads') {
        const branch = rest.slice(3).join('/');
        const tip = branchTip(repo, branch);
        if (tip === undefined) return notFound();
        return ok({ ref: `refs/heads/${branch}`, object: { sha: tip } });
      }
      return notFound();
    }

    // GET /branches, GET /branches/{branch}
    if (rest[0] === 'branches') {
      if (method === 'GET' && rest.length === 1) {
        const branches: Record<string, unknown>[] = [];
        for (const [ref, sha] of [...repo.refs.entries()].sort()) {
          if (!ref.startsWith('refs/heads/')) continue;
          branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha } });
        }
        return ok(branches);
      }
      if (method === 'GET' && rest.length === 2) {
        const tip = branchTip(repo, rest[1]!);
        if (tip === undefined) return notFound();
        return ok({ name: rest[1], commit: { sha: tip } });
      }
      return notFound();
    }

    // GET /commits[?sha=]
    if (rest[0] === 'commits') {
      if (method !== 'GET') return notFound();
      const ref = query.get('sha') ?? repo.defaultBranch;
      const tip = resolveRef(repo, ref);
      if (tip === undefined) return notFound();
      const { perPage, page } = pageParams(query);
      const commits = listCommits(repo, tip);
      const { page: pageItems, totalPages } = paginate(commits, perPage, page);
      const link = linkHeader(`${ctx.origin}/api/v3/repos/${owner}/${repoName}/commits`, page, totalPages, perPage);
      const out = pageItems.map((sha) => {
        const object = getObject(repo, sha)!;
        const data = object.data.toString('utf8');
        const message = data.split('\n\n').slice(1).join('\n\n').replace(/\n+$/, '');
        return { sha, commit: { message }, author: { login: VIEWER_LOGIN } };
      });
      return ok(out, 200, link ? { Link: link } : undefined);
    }

    // contents: GET/PUT/DELETE /contents/{path}
    if (rest[0] === 'contents') {
      const path = rest.slice(1).join('/');
      if (method === 'GET') {
        const ref = query.get('ref') ?? repo.defaultBranch;
        const tip = resolveRef(repo, ref);
        if (tip === undefined) return notFound();
        if (path === '') {
          const entries = dirEntries(repo, tip, '');
          if (entries === null) return notFound();
          return ok(entries.map((e) => ({
            type: e.type, name: e.name, path: e.path, sha: e.oid,
            size: e.type === 'file' ? (getObject(repo, e.oid)?.data.length ?? 0) : 0,
          })));
        }
        const blob = blobAtPath(repo, tip, path);
        if (blob !== null) {
          const object = getObject(repo, blob.oid)!;
          return ok({
            type: 'file', name: path.split('/').pop(), path, sha: blob.oid,
            size: object.data.length, encoding: 'base64',
            content: object.data.toString('base64'),
          });
        }
        const entries = dirEntries(repo, tip, path);
        if (entries !== null) {
          return ok(entries.map((e) => ({
            type: e.type, name: e.name, path: e.path, sha: e.oid,
            size: e.type === 'file' ? (getObject(repo, e.oid)?.data.length ?? 0) : 0,
          })));
        }
        return notFound();
      }
      if (method === 'PUT') {
        const message = typeof body?.message === 'string' ? body.message : 'Update file';
        const contentB64 = typeof body?.content === 'string' ? body.content : '';
        const branch = typeof body?.branch === 'string' ? body.branch : repo.defaultBranch;
        const sha = typeof body?.sha === 'string' ? body.sha : undefined;
        if (contentB64 === '') return badRequest('content is required');
        const tip = branchTip(repo, branch);
        const existing = tip !== undefined ? blobAtPath(repo, tip, path) : null;
        if (existing !== null && sha !== undefined && sha !== existing.oid) {
          return conflict('sha does not match the current file');
        }
        if (existing === null && sha !== undefined) {
          return conflict('sha does not match the current file');
        }
        const isUpdate = existing !== null;
        const content = Buffer.from(contentB64, 'base64');
        const { commitSha, blobSha } = commitFile(repo, branch, path, content, message);
        return ok({
          content: { sha: blobSha, encoding: 'base64', name: path.split('/').pop(), path },
          commit: { sha: commitSha },
        }, isUpdate ? 200 : 201);
      }
      if (method === 'DELETE') {
        const message = typeof body?.message === 'string' ? body.message : 'Delete file';
        const branch = typeof body?.branch === 'string' ? body.branch : repo.defaultBranch;
        const sha = typeof body?.sha === 'string' ? body.sha : undefined;
        const tip = branchTip(repo, branch);
        if (tip === undefined) return notFound();
        const existing = blobAtPath(repo, tip, path);
        if (existing === null) return notFound();
        if (sha !== undefined && sha !== existing.oid) return conflict('sha does not match the current file');
        const { commitSha } = commitFile(repo, branch, path, null, message);
        return ok({ commit: { sha: commitSha } }, 200);
      }
      return notFound();
    }

    // POST /labels
    if (rest[0] === 'labels') {
      if (method === 'POST' && rest.length === 1) {
        const name = typeof body?.name === 'string' ? body.name : '';
        const color = typeof body?.color === 'string' ? body.color : '000000';
        if (name === '') return badRequest('name is required');
        repo.labels.set(name, { name, color });
        return ok({ name, color }, 201);
      }
      if (method === 'GET' && rest.length === 1) {
        return ok([...repo.labels.values()]);
      }
      return notFound();
    }

    // issues: POST /issues, GET /issues, GET/PATCH /issues/{n}, comments
    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'POST') {
          const title = typeof body?.title === 'string' ? body.title : '';
          if (title === '') return badRequest('title is required');
          const labels = Array.isArray(body?.labels) ? (body.labels as string[]) : [];
          const result = createIssue(repo, {
            title,
            body: typeof body?.body === 'string' ? body.body : undefined,
            labels,
          });
          if ('error' in result) return unprocessable(result.error);
          return ok(issueJson(repo, result), 201);
        }
        if (method === 'GET') {
          const { perPage, page } = pageParams(query);
          const state = query.get('state') ?? 'open';
          let issues = [...repo.issues.values()];
          if (state !== 'all') issues = issues.filter((i) => i.state === state);
          const sort = query.get('sort') ?? 'created';
          const direction = query.get('direction') ?? 'desc';
          if (sort === 'created') {
            issues.sort((a, b) => direction === 'asc' ? a.number - b.number : b.number - a.number);
          }
          const { page: pageItems, totalPages } = paginate(issues, perPage, page);
          const link = linkHeader(`${ctx.origin}/api/v3/repos/${owner}/${repoName}/issues`, page, totalPages, perPage);
          return ok(pageItems.map((i) => issueJson(repo, i)), 200, link ? { Link: link } : undefined);
        }
        return notFound();
      }
      const number = parseInt(rest[1]!, 10);
      if (!Number.isInteger(number)) return notFound();
      const issue = repo.issues.get(number);
      if (rest.length === 2) {
        if (!issue) return notFound();
        if (method === 'GET') return ok(issueJson(repo, issue));
        if (method === 'PATCH') {
          if (typeof body?.state === 'string' && (body.state === 'open' || body.state === 'closed')) issue.state = body.state;
          if (typeof body?.title === 'string') issue.title = body.title;
          if (typeof body?.body === 'string') issue.body = body.body;
          return ok(issueJson(repo, issue));
        }
        return notFound();
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (!issue) return notFound();
        if (method === 'GET') {
          const comments = repo.comments
            .filter((c) => c.issueNumber === number)
            .map((c) => ({ id: c.id, body: c.body, user: { login: VIEWER_LOGIN, id: 1000 } }));
          return ok(comments);
        }
        if (method === 'POST') {
          const commentBody = typeof body?.body === 'string' ? body.body : '';
          if (commentBody === '') return badRequest('body is required');
          const comment = { id: store.nextGlobalId(), issueNumber: number, body: commentBody };
          repo.comments.push(comment);
          return ok({ id: comment.id, body: comment.body, user: { login: VIEWER_LOGIN, id: 1000 } }, 201);
        }
        return notFound();
      }
      return notFound();
    }

    // pulls: POST /pulls, GET /pulls, GET /pulls/{n}, GET /pulls/{n}/files, PUT /pulls/{n}/merge
    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'POST') {
          const title = typeof body?.title === 'string' ? body.title : '';
          const head = typeof body?.head === 'string' ? body.head : '';
          const base = typeof body?.base === 'string' ? body.base : repo.defaultBranch;
          if (title === '' || head === '') return badRequest('title and head are required');
          const result = createPull(repo, {
            title,
            body: typeof body?.body === 'string' ? body.body : undefined,
            head,
            base,
          });
          if ('error' in result) return unprocessable(result.error);
          return ok(pullJson(repo, result), 201);
        }
        if (method === 'GET') {
          const { perPage, page } = pageParams(query);
          const state = query.get('state') ?? 'open';
          let pulls = [...repo.pulls.values()];
          if (state !== 'all') pulls = pulls.filter((p) => p.state === state);
          pulls.sort((a, b) => b.number - a.number);
          const { page: pageItems, totalPages } = paginate(pulls, perPage, page);
          const link = linkHeader(`${ctx.origin}/api/v3/repos/${owner}/${repoName}/pulls`, page, totalPages, perPage);
          return ok(pageItems.map((p) => pullJson(repo, p)), 200, link ? { Link: link } : undefined);
        }
        return notFound();
      }
      const number = parseInt(rest[1]!, 10);
      if (!Number.isInteger(number)) return notFound();
      const pull = repo.pulls.get(number);
      if (rest.length === 2) {
        if (!pull) return notFound();
        if (method === 'GET') return ok(pullJson(repo, pull));
        if (method === 'PATCH') {
          if (typeof body?.state === 'string' && (body.state === 'open' || body.state === 'closed')) pull.state = body.state;
          if (typeof body?.title === 'string') pull.title = body.title;
          return ok(pullJson(repo, pull));
        }
        return notFound();
      }
      if (rest.length === 3 && rest[2] === 'files') {
        if (!pull) return notFound();
        if (method !== 'GET') return notFound();
        const headSha = branchTip(repo, pull.headRef) ?? pull.headSha;
        const baseSha = branchTip(repo, pull.baseRef) ?? pull.baseSha;
        return ok(diffTrees(repo, baseSha, headSha));
      }
      if (rest.length === 3 && rest[2] === 'merge') {
        if (!pull) return notFound();
        if (method !== 'PUT') return notFound();
        if (pull.state !== 'open') return conflict('Pull request is not open');
        const method_ = typeof body?.merge_method === 'string' ? body.merge_method : 'squash';
        void method_;
        const result = squashMerge(repo, pull);
        if ('error' in result) return { status: 405, body: { message: result.error } };
        return ok({ sha: result.commitSha, merged: true, message: `Pull request #${pull.number} merged` }, 200);
      }
      return notFound();
    }

    return notFound();
  }

  return null;
}
