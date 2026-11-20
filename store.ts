// store.ts — the forge's in-memory store: repositories, git objects, refs,
// issues, pull requests, labels, comments. Deterministic: fixed commit
// timestamps, sequential numeric ids, no wall clock in any stored value.
import {
  buildCommit, buildTree, collectReachable, hashObject, isObjectId, parseCommit,
  parseTag, parseTree, type GitObject, type TreeEntry,
} from './gitcore.ts';

/** The login the bearer token names (the scenario's viewer, a fixed seed). */
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const VIEWER_NAME = 'ada iversen';
export const STRANGER_LOGIN = 'olgabauer';

/** Fixed author identity and timestamp for every commit this forge creates. */
export const FORGE_AUTHOR = `${VIEWER_LOGIN} <${VIEWER_EMAIL}>`;
export const FORGE_EPOCH = 1_700_000_000;
export const MERGED_AT = '2025-01-01T00:00:00Z';
export const FIXED_DATE = '2025-01-01T00:00:00Z';

export interface Label { name: string; color: string; }

export interface Issue {
  id: number; number: number; title: string; body: string;
  state: 'open' | 'closed'; labels: string[]; createdSeq: number;
}

export interface Pull {
  id: number; number: number; title: string; body: string;
  state: 'open' | 'closed'; merged: boolean; mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string; baseRef: string; headSha: string; baseSha: string;
  createdSeq: number;
}

export interface Comment { id: number; issueNumber: number; body: string; }

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  comments: Comment[];
  seq: number; // next shared issue/PR number
  commentSeq: number;
}

export class Store {
  repos = new Map<string, Repo>();
  nextRepoId = 1;
  nextObjectId = 1; // global numeric ids for issues/PRs/comments
  seqCounter = 0;

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  createRepo(name: string, opts: { description?: string; private?: boolean }): Repo | { error: string } {
    if (this.repos.has(this.key(VIEWER_LOGIN, name))) return { error: `Repository '${name}' already exists` };
    const repo: Repo = {
      id: this.nextRepoId++,
      name,
      owner: VIEWER_LOGIN,
      description: opts.description ?? '',
      private: opts.private ?? false,
      defaultBranch: 'main',
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      comments: [],
      seq: 1,
      commentSeq: 1,
    };
    this.repos.set(this.key(VIEWER_LOGIN, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  listViewerRepos(): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === VIEWER_LOGIN) out.push(repo);
    return out;
  }

  nextGlobalId(): number {
    this.nextObjectId += 1;
    return this.nextObjectId;
  }
}

export const store = new Store();

// ---------------------------------------------------------------- git object helpers

export function putObject(repo: Repo, type: GitObject['type'], data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

export function getObject(repo: Repo, oid: string): GitObject | undefined {
  return repo.objects.get(oid);
}

export function refTip(repo: Repo, ref: string): string | undefined {
  return repo.refs.get(ref);
}

export function branchTip(repo: Repo, branch: string): string | undefined {
  return repo.refs.get(`refs/heads/${branch}`);
}

export function resolveRef(repo: Repo, ref: string): string | undefined {
  // A branch name, a full ref, or a commit oid.
  if (isObjectId(ref)) return repo.objects.has(ref) ? ref : undefined;
  if (ref.startsWith('refs/')) return repo.refs.get(ref);
  return repo.refs.get(`refs/heads/${ref}`);
}

export function defaultTip(repo: Repo): string | undefined {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
}

/** Is `ancestor` an ancestor of `commit` (or equal)? Walks parents. */
export function isAncestor(repo: Repo, ancestor: string, commit: string): boolean {
  if (ancestor === commit) return true;
  const seen = new Set<string>();
  const queue = [commit];
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    const parsed = parseCommit(object.data);
    for (const parent of parsed.parents) {
      if (parent === ancestor) return true;
      queue.push(parent);
    }
  }
  return false;
}

/** The merge-base of two commits: the nearest common ancestor (first found by BFS). */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  if (a === b) return a;
  const ancestorsA = new Set<string>();
  const queueA = [a];
  while (queueA.length) {
    const oid = queueA.pop()!;
    if (ancestorsA.has(oid)) continue;
    ancestorsA.add(oid);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queueA.push(parent);
  }
  const queueB = [b];
  const seenB = new Set<string>();
  while (queueB.length) {
    const oid = queueB.pop()!;
    if (seenB.has(oid)) continue;
    seenB.add(oid);
    if (ancestorsA.has(oid)) return oid;
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queueB.push(parent);
  }
  return null;
}

/** Flatten a tree to path -> {oid, mode}. */
export function flattenTree(repo: Repo, treeOid: string, prefix = ''): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const walk = (oid: string, base: string): void => {
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = base === '' ? entry.name : `${base}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(treeOid, prefix);
  return out;
}

/** Build a tree object from a flat path map, creating intermediate trees. */
export function buildTreeFromMap(repo: Repo, files: Map<string, { oid: string; mode: string }>): string {
  interface Node { files: Map<string, { oid: string; mode: string }>; dirs: Map<string, Node> }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, entry] of files) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const name = segments[i]!;
      if (!node.dirs.has(name)) node.dirs.set(name, make());
      node = node.dirs.get(name)!;
    }
    node.files.set(segments[segments.length - 1]!, entry);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return putObject(repo, 'tree', buildTree(entries));
  };
  return build(root);
}

/** The tree oid of a commit, or null. */
export function commitTree(repo: Repo, commitOid: string): string | null {
  const object = repo.objects.get(commitOid);
  if (!object || object.type !== 'commit') return null;
  return parseCommit(object.data).tree;
}

/** Create a commit object on `branch` (creating the branch from the default tip when missing). */
export function commitOnBranch(
  repo: Repo,
  branch: string,
  files: Map<string, { oid: string; mode: string }>,
  message: string,
): string {
  const treeOid = buildTreeFromMap(repo, files);
  const parent = branchTip(repo, branch) ?? defaultTip(repo) ?? null;
  const commitOid = putObject(
    repo,
    'commit',
    buildCommit({
      tree: treeOid,
      parents: parent === null ? [] : [parent],
      message: message.endsWith('\n') ? message : `${message}\n`,
      author: FORGE_AUTHOR,
      committer: FORGE_AUTHOR,
      timestamp: FORGE_EPOCH,
    }),
  );
  repo.refs.set(`refs/heads/${branch}`, commitOid);
  return commitOid;
}

/** Commit one file change on a branch: returns the new commit oid. */
export function commitFile(
  repo: Repo,
  branch: string,
  path: string,
  content: Buffer | null,
  message: string,
): { commitSha: string; blobSha: string | null } {
  const tip = branchTip(repo, branch) ?? defaultTip(repo) ?? null;
  let files = new Map<string, { oid: string; mode: string }>();
  if (tip !== null) {
    const tree = commitTree(repo, tip);
    if (tree !== null) files = flattenTree(repo, tree);
  }
  let blobSha: string | null = null;
  if (content !== null) {
    blobSha = putObject(repo, 'blob', content);
    files.set(path, { oid: blobSha, mode: '100644' });
  } else {
    files.delete(path);
  }
  const commitSha = commitOnBranch(repo, branch, files, message);
  return { commitSha, blobSha };
}

/** The blob oid at `path` in the tree of `commitOid` (or of a tree oid). */
export function blobAtPath(repo: Repo, commitOid: string, path: string): { oid: string; mode: string } | null {
  const tree = commitTree(repo, commitOid);
  if (tree === null) return null;
  return flattenTree(repo, tree).get(path) ?? null;
}

/** List the entries of a directory ('' = root) in the tree of `commitOid`. */
export function dirEntries(
  repo: Repo,
  commitOid: string,
  dir: string,
): { name: string; path: string; oid: string; mode: string; type: 'file' | 'dir' }[] | null {
  const tree = commitTree(repo, commitOid);
  if (tree === null) return null;
  const segments = dir === '' ? [] : dir.split('/');
  let current = tree;
  for (const segment of segments) {
    const object = repo.objects.get(current);
    if (!object || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((e) => e.name === segment && e.mode === '40000');
    if (!entry) return null;
    current = entry.oid;
  }
  const object = repo.objects.get(current);
  if (!object || object.type !== 'tree') return null;
  return parseTree(object.data).map((entry) => ({
    name: entry.name,
    path: dir === '' ? entry.name : `${dir}/${entry.name}`,
    oid: entry.oid,
    mode: entry.mode,
    type: entry.mode === '40000' ? 'dir' as const : 'file' as const,
  }));
}

/** Every commit reachable from `tip`, newest-first by traversal order. */
export function listCommits(repo: Repo, tip: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    out.push(oid);
    const parents = parseCommit(object.data).parents;
    for (let i = parents.length - 1; i >= 0; i -= 1) stack.push(parents[i]!);
  }
  return out;
}

/** Objects reachable from `roots` that the store holds. */
export function reachableObjects(repo: Repo, roots: Iterable<string>): Set<string> {
  return collectReachable(roots, (oid) => repo.objects.get(oid));
}

// ---------------------------------------------------------------- global ids (GraphQL Relay ids, opaque + stable)

function b64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

export function repoGlobalId(owner: string, name: string): string {
  return `R_${b64url(`repo:${owner}/${name}`)}`;
}

export function issueGlobalId(owner: string, name: string, number: number): string {
  return `I_${b64url(`issue:${owner}/${name}:${number}`)}`;
}

export function pullGlobalId(owner: string, name: string, number: number): string {
  return `PR_${b64url(`pr:${owner}/${name}:${number}`)}`;
}

export function commentGlobalId(owner: string, name: string, id: number): string {
  return `C_${b64url(`comment:${owner}/${name}:${id}`)}`;
}

/** Decode a global id into its kind + parts, or null. Encoded form is
 *  `<kind>:<owner>/<name>` or `<kind>:<owner>/<name>:<num>`. */
export function decodeGlobalId(id: string): { kind: string; owner: string; name: string; num: number } | null {
  const match = /^(R|I|PR|C)_([A-Za-z0-9_-]+)$/.exec(id);
  if (!match) return null;
  let text: string;
  try {
    text = Buffer.from(match[2]!, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const colon = text.indexOf(':');
  if (colon === -1) return null;
  const kind = text.slice(0, colon);
  const rest = text.slice(colon + 1);
  const slash = rest.indexOf('/');
  if (slash === -1) return null;
  const owner = rest.slice(0, slash);
  const tail = rest.slice(slash + 1);
  const numColon = tail.lastIndexOf(':');
  const name = numColon === -1 ? tail : tail.slice(0, numColon);
  const num = numColon === -1 ? 0 : Number(tail.slice(numColon + 1));
  if (owner === '' || name === '') return null;
  if (kind === 'repo') return { kind, owner, name, num: 0 };
  if (!Number.isInteger(num)) return null;
  return { kind, owner, name, num };
}

// ---------------------------------------------------------------- issues / pulls

export function createIssue(
  repo: Repo,
  input: { title: string; body?: string; labels?: string[] },
): Issue | { error: string } {
  const labels = input.labels ?? [];
  for (const label of labels) {
    if (!repo.labels.has(label)) return { error: `Label '${label}' does not exist` };
  }
  const number = repo.seq++;
  const issue: Issue = {
    id: store.nextGlobalId(),
    number,
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    labels: [...labels],
    createdSeq: number,
  };
  repo.issues.set(number, issue);
  return issue;
}

export function createPull(
  repo: Repo,
  input: { title: string; body?: string; head: string; base: string },
): Pull | { error: string } {
  const headSha = branchTip(repo, input.head);
  const baseSha = branchTip(repo, input.base);
  if (headSha === undefined) return { error: `Head branch '${input.head}' does not exist` };
  if (baseSha === undefined) return { error: `Base branch '${input.base}' does not exist` };
  const number = repo.seq++;
  const pull: Pull = {
    id: store.nextGlobalId(),
    number,
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    headRef: input.head,
    baseRef: input.base,
    headSha,
    baseSha,
    createdSeq: number,
  };
  repo.pulls.set(number, pull);
  return pull;
}

/** Three-way merge of head into base. Returns the merge commit or a conflict. */
export function squashMerge(repo: Repo, pull: Pull): { commitSha: string } | { error: string } {
  const headTip = branchTip(repo, pull.headRef);
  const baseTip = branchTip(repo, pull.baseRef);
  if (headTip === undefined || baseTip === undefined) return { error: 'head or base branch is gone' };
  const headTree = commitTree(repo, headTip);
  const baseTree = commitTree(repo, baseTip);
  if (headTree === null || baseTree === null) return { error: 'head or base has no tree' };
  const base = mergeBase(repo, headTip, baseTip);
  const baseFiles = base === null ? new Map() : flattenTree(repo, commitTree(repo, base) ?? '');
  const headFiles = flattenTree(repo, headTree);
  const currentFiles = flattenTree(repo, baseTree);
  const merged = new Map(currentFiles);
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys(), ...currentFiles.keys()]);
  for (const path of paths) {
    const m = baseFiles.get(path);
    const h = headFiles.get(path);
    const c = currentFiles.get(path);
    const same = (x?: { oid: string }, y?: { oid: string }): boolean =>
      (x === undefined && y === undefined) || (x !== undefined && y !== undefined && x.oid === y.oid);
    if (same(h, m)) {
      // Head unchanged: keep current.
    } else if (same(c, m)) {
      // Current unchanged: take head.
      if (h === undefined) merged.delete(path);
      else merged.set(path, h);
    } else if (same(c, h)) {
      // Both changed the same way: keep.
    } else {
      return { error: `Merge conflict in ${path}` };
    }
  }
  const treeOid = buildTreeFromMap(repo, merged);
  const commitSha = putObject(
    repo,
    'commit',
    buildCommit({
      tree: treeOid,
      parents: [baseTip],
      message: `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}\n\n${pull.title}\n`,
      author: FORGE_AUTHOR,
      committer: FORGE_AUTHOR,
      timestamp: FORGE_EPOCH,
    }),
  );
  repo.refs.set(`refs/heads/${pull.baseRef}`, commitSha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = MERGED_AT;
  pull.mergeCommitSha = commitSha;
  pull.baseSha = commitSha;
  return { commitSha };
}

/** Is this pull request mergeable right now (no three-way conflict)? */
export function pullMergeable(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  if (pull.state !== 'open') return 'UNKNOWN';
  const headTip = branchTip(repo, pull.headRef);
  const baseTip = branchTip(repo, pull.baseRef);
  if (headTip === undefined || baseTip === undefined) return 'UNKNOWN';
  const headTree = commitTree(repo, headTip);
  const baseTree = commitTree(repo, baseTip);
  if (headTree === null || baseTree === null) return 'UNKNOWN';
  const base = mergeBase(repo, headTip, baseTip);
  const baseFiles = base === null ? new Map() : flattenTree(repo, commitTree(repo, base) ?? '');
  const headFiles = flattenTree(repo, headTree);
  const currentFiles = flattenTree(repo, baseTree);
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys(), ...currentFiles.keys()]);
  for (const path of paths) {
    const m = baseFiles.get(path);
    const h = headFiles.get(path);
    const c = currentFiles.get(path);
    const same = (x?: { oid: string }, y?: { oid: string }): boolean =>
      (x === undefined && y === undefined) || (x !== undefined && y !== undefined && x.oid === y.oid);
    if (same(h, m) || same(c, m) || same(c, h)) continue;
    return 'CONFLICTING';
  }
  return 'MERGEABLE';
}

/** Diff base tree vs head tree: per-path change records. */
export function diffTrees(
  repo: Repo,
  baseCommit: string,
  headCommit: string,
): { filename: string; status: string; additions: number; deletions: number; changes: number }[] {
  const baseTree = commitTree(repo, baseCommit);
  const headTree = commitTree(repo, headCommit);
  const baseFiles = baseTree === null ? new Map() : flattenTree(repo, baseTree);
  const headFiles = headTree === null ? new Map() : flattenTree(repo, headTree);
  const out: { filename: string; status: string; additions: number; deletions: number; changes: number }[] = [];
  const countLines = (oid: string | undefined): number => {
    if (oid === undefined) return 0;
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'blob') return 0;
    const text = object.data.toString('utf8');
    if (text === '') return 0;
    return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  };
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of [...paths].sort()) {
    const b = baseFiles.get(path);
    const h = headFiles.get(path);
    if (b !== undefined && h !== undefined && b.oid === h.oid) continue;
    if (b === undefined && h !== undefined) {
      const additions = Math.max(1, countLines(h.oid));
      out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (b !== undefined && h === undefined) {
      const deletions = Math.max(1, countLines(b.oid));
      out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (b !== undefined && h !== undefined) {
      const additions = countLines(h.oid);
      const deletions = countLines(b.oid);
      out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return out;
}

/** Decode a Relay global id back to its repo. */
export function repoFromGlobalId(id: string): Repo | null {
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.kind !== 'repo') return null;
  return store.getRepo(decoded.owner, decoded.name) ?? null;
}

/** Peel a tag oid to its commit oid (or itself when not a tag). */
export function peelToCommit(repo: Repo, oid: string): string {
  const object = repo.objects.get(oid);
  if (object && object.type === 'tag') return parseTag(object.data).object;
  return oid;
}
