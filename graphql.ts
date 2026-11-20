// graphql.ts — a small GraphQL executor for the forge's surface: viewer,
// repository, issues, pull requests, node(), __type introspection, and the
// five mutations the suite uses. No external dependency.
import {
  VIEWER_LOGIN, commentGlobalId, createIssue, createPull, decodeGlobalId,
  diffTrees, issueGlobalId, pullGlobalId, pullMergeable, repoGlobalId,
  repoFromGlobalId, squashMerge, store, type Issue, type Pull, type Repo,
} from './store.ts';

// ---------------------------------------------------------------- tokenizer + parser

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'eof' };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (/\s/.test(ch) || ch === ',') { i += 1; continue; }
    if (ch === '#') { while (i < source.length && source[i] !== '\n') i += 1; continue; }
    if (ch === '"') {
      let value = '';
      i += 1;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\' && i + 1 < source.length) {
          const next = source[i + 1]!;
          if (next === 'n') value += '\n';
          else if (next === 't') value += '\t';
          else if (next === 'r') value += '\r';
          else value += next;
          i += 2;
        } else {
          value += source[i];
          i += 1;
        }
      }
      i += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(ch) && /[0-9]/.test(source[i + 1] ?? '')) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j]!)) j += 1;
      let isFloat = false;
      if (source[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j]!)) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j]!)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    tokens.push({ kind: 'punct', value: ch });
    i += 1;
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

type ValueNode =
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'variable'; name: string }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

interface Argument { name: string; value: ValueNode; }

interface Selection {
  kind: 'field' | 'fragment';
  alias?: string;
  name?: string;
  args?: Argument[];
  selections?: Selection[];
  typeCondition?: string;
}

interface Operation {
  type: 'query' | 'mutation' | 'subscription';
  name?: string;
  variableDefinitions?: { name: string; defaultValue?: ValueNode }[];
  selections: Selection[];
}

interface Document {
  operations: Operation[];
  fragments: Map<string, Selection[]>;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token { return this.tokens[this.pos]!; }
  private next(): Token { return this.tokens[this.pos++]!; }
  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`Expected '${value}'`);
  }
  private isPunct(value: string): boolean {
    const token = this.peek();
    return token.kind === 'punct' && token.value === value;
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, Selection[]>();
    while (this.peek().kind !== 'eof') {
      if (this.isPunct('{')) {
        operations.push({ type: 'query', selections: this.parseSelectionSet() });
        continue;
      }
      const token = this.next();
      if (token.kind !== 'name') throw new Error('Unexpected token in document');
      if (token.value === 'fragment') {
        const nameToken = this.next();
        if (nameToken.kind !== 'name') throw new Error('Expected fragment name');
        const onToken = this.next();
        if (onToken.kind !== 'name' || onToken.value !== 'on') throw new Error('Expected "on"');
        const typeToken = this.next();
        if (typeToken.kind !== 'name') throw new Error('Expected type name');
        fragments.set(nameToken.value, this.parseSelectionSet());
        continue;
      }
      if (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription') {
        const type = token.value as Operation['type'];
        let name: string | undefined;
        const nameToken = this.peek();
        if (nameToken.kind === 'name') { this.next(); name = nameToken.value; }
        let variableDefinitions: Operation['variableDefinitions'];
        if (this.isPunct('(')) {
          variableDefinitions = this.parseVariableDefinitions();
        }
        const selections = this.parseSelectionSet();
        operations.push({ type, name, variableDefinitions, selections });
        continue;
      }
      throw new Error(`Unexpected keyword ${token.value}`);
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): { name: string; defaultValue?: ValueNode }[] {
    this.expectPunct('(');
    const defs: { name: string; defaultValue?: ValueNode }[] = [];
    while (!this.isPunct(')')) {
      const dollar = this.next();
      if (dollar.kind !== 'punct' || dollar.value !== '$') throw new Error('Expected $');
      const nameToken = this.next();
      if (nameToken.kind !== 'name') throw new Error('Expected variable name');
      this.expectPunct(':');
      // Skip the type: a name possibly wrapped in [] and/or suffixed with !.
      // Stop at a default (=), the closing paren, or the next definition ($).
      while (this.peek().kind !== 'eof') {
        const token = this.peek();
        if (token.kind === 'punct' && (token.value === '=' || token.value === ')' || token.value === '$')) break;
        this.next();
      }
      let defaultValue: ValueNode | undefined;
      if (this.isPunct('=')) {
        this.next();
        defaultValue = this.parseValue();
      }
      defs.push({ name: nameToken.value, defaultValue });
    }
    this.expectPunct(')');
    return defs;
  }

  private parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    while (!this.isPunct('}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): Selection {
    if (this.isPunct('...')) {
      this.next();
      const token = this.peek();
      if (token.kind === 'name' && token.value === 'on') {
        this.next();
        const typeToken = this.next();
        if (typeToken.kind !== 'name') throw new Error('Expected type condition');
        return { kind: 'fragment', typeCondition: typeToken.value, selections: this.parseSelectionSet() };
      }
      if (token.kind === 'name') {
        this.next();
        return { kind: 'fragment', name: token.value };
      }
      throw new Error('Expected fragment name or "on"');
    }
    const first = this.next();
    if (first.kind !== 'name') throw new Error('Expected field name');
    let alias: string | undefined;
    let name = first.value;
    if (this.isPunct(':')) {
      this.next();
      alias = name;
      const nameToken = this.next();
      if (nameToken.kind !== 'name') throw new Error('Expected field name after alias');
      name = nameToken.value;
    }
    let args: Argument[] | undefined;
    if (this.isPunct('(')) args = this.parseArguments();
    let selections: Selection[] | undefined;
    if (this.isPunct('{')) selections = this.parseSelectionSet();
    return { kind: 'field', alias, name, args, selections };
  }

  private parseArguments(): Argument[] {
    this.expectPunct('(');
    const args: Argument[] = [];
    while (!this.isPunct(')')) {
      const nameToken = this.next();
      if (nameToken.kind !== 'name') throw new Error('Expected argument name');
      this.expectPunct(':');
      args.push({ name: nameToken.value, value: this.parseValue() });
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    switch (token.kind) {
      case 'int': return { kind: 'int', value: parseInt(token.value, 10) };
      case 'float': return { kind: 'float', value: parseFloat(token.value) };
      case 'string': return { kind: 'string', value: token.value };
      case 'punct':
        if (token.value === '$') {
          const nameToken = this.next();
          if (nameToken.kind !== 'name') throw new Error('Expected variable name');
          return { kind: 'variable', name: nameToken.value };
        }
        if (token.value === '[') {
          const items: ValueNode[] = [];
          while (!this.isPunct(']')) items.push(this.parseValue());
          this.expectPunct(']');
          return { kind: 'list', items };
        }
        if (token.value === '{') {
          const fields: { name: string; value: ValueNode }[] = [];
          while (!this.isPunct('}')) {
            const nameToken = this.next();
            if (nameToken.kind !== 'name') throw new Error('Expected object field name');
            this.expectPunct(':');
            fields.push({ name: nameToken.value, value: this.parseValue() });
          }
          this.expectPunct('}');
          return { kind: 'object', fields };
        }
        throw new Error(`Unexpected punctuation ${token.value}`);
      case 'name':
        if (token.value === 'true') return { kind: 'bool', value: true };
        if (token.value === 'false') return { kind: 'bool', value: false };
        if (token.value === 'null') return { kind: 'null' };
        return { kind: 'enum', value: token.value };
      default:
        throw new Error('Unexpected value token');
    }
  }
}

// ---------------------------------------------------------------- executor

type Variables = Record<string, unknown>;

function valueOf(node: ValueNode, variables: Variables): unknown {
  switch (node.kind) {
    case 'int': case 'float': case 'string': case 'bool': return node.value;
    case 'null': return null;
    case 'enum': return node.value;
    case 'variable': return variables[node.name];
    case 'list': return node.items.map((item) => valueOf(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = valueOf(field.value, variables);
      return out;
    }
  }
}

function argValue(args: Argument[] | undefined, name: string, variables: Variables): unknown {
  const arg = args?.find((a) => a.name === name);
  return arg ? valueOf(arg.value, variables) : undefined;
}

// --- schema introspection data (the fields the suite asks about) ---

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body'],
  PullRequest: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
  Viewer: ['login'],
  User: ['login'],
  IssueConnection: ['nodes', 'pageInfo'],
  PullRequestConnection: ['nodes', 'pageInfo'],
  PageInfo: ['hasNextPage', 'endCursor'],
  Comment: ['id', 'body'],
  BranchRef: ['name'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
};

// --- runtime types ---

interface IssueNode { repo: Repo; issue: Issue; }
interface PullNode { repo: Repo; pull: Pull; }
interface RepoNode { repo: Repo; }
type AnyNode =
  | { __type: 'Query' }
  | { __type: 'Mutation' }
  | { __type: 'Viewer'; login: string }
  | { __type: 'Repository'; repo: Repo }
  | { __type: 'Issue'; repo: Repo; issue: Issue }
  | { __type: 'PullRequest'; repo: Repo; pull: Pull }
  | { __type: 'IssueConnection'; items: Issue[]; repo: Repo; after?: string; first?: number }
  | { __type: 'PullRequestConnection'; items: Pull[]; repo: Repo; after?: string; first?: number }
  | { __type: 'User'; login: string }
  | { __type: 'BranchRef'; name: string }
  | { __type: 'Comment'; repo: Repo; comment: { id: number; body: string } }
  | { __type: 'PageInfo'; hasNextPage: boolean; endCursor: string | null };

class GraphQLError extends Error {
  constructor(message: string) { super(message); this.name = 'GraphQLError'; }
}

/** Cursor encoding: base64url of the issue/PR number. */
function encodeCursor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64url');
}
function decodeCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    if (!text.startsWith('cursor:')) return null;
    const n = parseInt(text.slice(7), 10);
    return Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
}

function paginateConnection<T extends { number: number }>(
  items: T[],
  first: number | undefined,
  after: string | undefined,
): { page: T[]; hasNextPage: boolean; endCursor: string | null } {
  let start = 0;
  if (after !== undefined) {
    const n = decodeCursor(after);
    if (n !== null) {
      const index = items.findIndex((item) => item.number === n);
      if (index >= 0) start = index + 1;
    }
  }
  const page = first === undefined ? items.slice(start) : items.slice(start, start + first);
  const hasNextPage = start + page.length < items.length;
  const endCursor = page.length > 0 ? encodeCursor(page[page.length - 1]!.number) : null;
  return { page, hasNextPage, endCursor };
}

interface Executor {
  errors: { message: string }[];
  variables: Variables;
  document: Document;
}

function executeSelections(
  executor: Executor,
  parent: AnyNode,
  selections: Selection[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (selection.name) {
        const fragment = executor.document.fragments.get(selection.name);
        if (fragment) Object.assign(out, executeSelections(executor, parent, fragment));
        continue;
      }
      if (selection.typeCondition && !typeMatches(parent, selection.typeCondition)) continue;
      Object.assign(out, executeSelections(executor, parent, selection.selections ?? []));
      continue;
    }
    const key = selection.alias ?? selection.name!;
    out[key] = executeField(executor, parent, selection);
  }
  return out;
}

function typeMatches(parent: AnyNode, condition: string): boolean {
  if (condition === 'Repository') return parent.__type === 'Repository';
  if (condition === 'Issue') return parent.__type === 'Issue';
  if (condition === 'PullRequest') return parent.__type === 'PullRequest';
  if (condition === 'User') return parent.__type === 'User';
  if (condition === 'Viewer') return parent.__type === 'Viewer';
  return false;
}

function executeField(executor: Executor, parent: AnyNode, selection: Selection): unknown {
  const name = selection.name!;
  const args = selection.args;
  const vars = executor.variables;
  const sub = selection.selections ?? [];

  // __type introspection (on Query and on any node via __typename-less queries)
  if (name === '__type') {
    const typeName = argValue(args, 'name', vars) as string | undefined;
    if (!typeName) return null;
    const fields = TYPE_FIELDS[typeName];
    const enumValues = ENUM_VALUES[typeName];
    if (!fields && !enumValues) return null;
    return {
      name: typeName,
      kind: enumValues ? 'ENUM' : 'OBJECT',
      fields: fields
        ? fields.map((field) => ({ name: field, description: null, type: { name: 'String', kind: 'SCALAR' } }))
        : null,
      enumValues: enumValues
        ? enumValues.map((value) => ({ name: value, description: null }))
        : null,
    };
  }
  if (name === '__typename') {
    return parent.__type;
  }

  switch (parent.__type) {
    case 'Query': {
      if (name === 'viewer') {
        return executeSelections(executor, { __type: 'Viewer', login: VIEWER_LOGIN }, sub);
      }
      if (name === 'repository') {
        const owner = argValue(args, 'owner', vars) as string | undefined;
        const repoName = argValue(args, 'name', vars) as string | undefined;
        if (!owner || !repoName) return null;
        const repo = store.getRepo(owner, repoName);
        if (!repo) return null;
        return executeSelections(executor, { __type: 'Repository', repo }, sub);
      }
      if (name === 'node') {
        const id = argValue(args, 'id', vars) as string | undefined;
        if (!id) return null;
        const decoded = decodeGlobalId(id);
        if (!decoded) return null;
        if (decoded.kind === 'repo') {
          const repo = store.getRepo(decoded.owner, decoded.name);
          if (!repo) return null;
          return executeSelections(executor, { __type: 'Repository', repo }, sub);
        }
        if (decoded.kind === 'issue') {
          const repo = store.getRepo(decoded.owner, decoded.name);
          const issue = repo?.issues.get(decoded.num);
          if (!repo || !issue) return null;
          return executeSelections(executor, { __type: 'Issue', repo, issue }, sub);
        }
        if (decoded.kind === 'pr') {
          const repo = store.getRepo(decoded.owner, decoded.name);
          const pull = repo?.pulls.get(decoded.num);
          if (!repo || !pull) return null;
          return executeSelections(executor, { __type: 'PullRequest', repo, pull }, sub);
        }
        return null;
      }
      throw new GraphQLError(`Cannot query field "${name}" on type "Query".`);
    }
    case 'Mutation': {
      if (name === 'createIssue') {
        const input = argValue(args, 'input', vars) as Record<string, unknown> | undefined;
        const repo = input ? repoFromGlobalId(String(input.repositoryId ?? '')) : null;
        if (!repo) throw new GraphQLError('Repository not found');
        const result = createIssue(repo, {
          title: String(input?.title ?? ''),
          body: typeof input?.body === 'string' ? input.body : undefined,
        });
        if ('error' in result) throw new GraphQLError(result.error);
        return { issue: executeSelections(executor, { __type: 'Issue', repo, issue: result }, sub[0]?.selections ?? []) };
      }
      if (name === 'closeIssue') {
        const input = argValue(args, 'input', vars) as Record<string, unknown> | undefined;
        const decoded = input ? decodeGlobalId(String(input.issueId ?? '')) : null;
        const repo = decoded ? store.getRepo(decoded.owner, decoded.name) : undefined;
        const issue = decoded && decoded.kind === 'issue' ? repo?.issues.get(decoded.num) : undefined;
        if (!repo || !issue) throw new GraphQLError('Issue not found');
        issue.state = 'closed';
        return { issue: executeSelections(executor, { __type: 'Issue', repo, issue }, sub[0]?.selections ?? []) };
      }
      if (name === 'createPullRequest') {
        const input = argValue(args, 'input', vars) as Record<string, unknown> | undefined;
        const repo = input ? repoFromGlobalId(String(input.repositoryId ?? '')) : null;
        if (!repo) throw new GraphQLError('Repository not found');
        const result = createPull(repo, {
          title: String(input?.title ?? ''),
          body: typeof input?.body === 'string' ? input.body : undefined,
          head: String(input?.headRefName ?? ''),
          base: String(input?.baseRefName ?? ''),
        });
        if ('error' in result) throw new GraphQLError(result.error);
        return { pullRequest: executeSelections(executor, { __type: 'PullRequest', repo, pull: result }, sub[0]?.selections ?? []) };
      }
      if (name === 'mergePullRequest') {
        const input = argValue(args, 'input', vars) as Record<string, unknown> | undefined;
        const decoded = input ? decodeGlobalId(String(input.pullRequestId ?? '')) : null;
        const repo = decoded ? store.getRepo(decoded.owner, decoded.name) : undefined;
        const pull = decoded && decoded.kind === 'pr' ? repo?.pulls.get(decoded.num) : undefined;
        if (!repo || !pull) throw new GraphQLError('Pull request not found');
        const result = squashMerge(repo, pull);
        if ('error' in result) throw new GraphQLError(result.error);
        return { pullRequest: executeSelections(executor, { __type: 'PullRequest', repo, pull }, sub[0]?.selections ?? []) };
      }
      if (name === 'addComment') {
        const input = argValue(args, 'input', vars) as Record<string, unknown> | undefined;
        const decoded = input ? decodeGlobalId(String(input.subjectId ?? '')) : null;
        const repo = decoded ? store.getRepo(decoded.owner, decoded.name) : undefined;
        const issue = decoded && decoded.kind === 'issue' ? repo?.issues.get(decoded.num) : undefined;
        if (!repo || !issue) throw new GraphQLError('Subject not found');
        const comment = { id: store.nextGlobalId(), issueNumber: issue.number, body: String(input?.body ?? '') };
        repo.comments.push(comment);
        const node = executeSelections(executor, { __type: 'Comment', repo, comment }, sub[0]?.selections?.[0]?.selections ?? []);
        return { commentEdge: { node } };
      }
      throw new GraphQLError(`Cannot query field "${name}" on type "Mutation".`);
    }
    case 'Viewer': {
      if (name === 'login') return parent.login;
      throw new GraphQLError(`Cannot query field "${name}" on type "Viewer".`);
    }
    case 'User': {
      if (name === 'login') return parent.login;
      throw new GraphQLError(`Cannot query field "${name}" on type "User".`);
    }
    case 'BranchRef': {
      if (name === 'name') return parent.name;
      throw new GraphQLError(`Cannot query field "${name}" on type "BranchRef".`);
    }
    case 'Repository': {
      const repo = parent.repo;
      if (name === 'id') return repoGlobalId(repo.owner, repo.name);
      if (name === 'databaseId') return repo.id;
      if (name === 'name') return repo.name;
      if (name === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
      if (name === 'owner') return executeSelections(executor, { __type: 'User', login: repo.owner }, sub);
      if (name === 'defaultBranchRef') return executeSelections(executor, { __type: 'BranchRef', name: repo.defaultBranch }, sub);
      if (name === 'viewerPermission') return 'ADMIN';
      if (name === 'hasIssuesEnabled') return true;
      if (name === 'issue') {
        const number = argValue(args, 'number', vars) as number | undefined;
        if (number === undefined) return null;
        const issue = repo.issues.get(number);
        if (!issue) return null;
        return executeSelections(executor, { __type: 'Issue', repo, issue }, sub);
      }
      if (name === 'issues') {
        const first = argValue(args, 'first', vars) as number | undefined;
        const after = argValue(args, 'after', vars) as string | undefined;
        const states = argValue(args, 'states', vars) as string[] | undefined;
        const orderBy = argValue(args, 'orderBy', vars) as { field?: string; direction?: string } | undefined;
        let issues = [...repo.issues.values()];
        if (states && states.length > 0) {
          const wanted = new Set(states.map((s) => s.toLowerCase()));
          issues = issues.filter((i) => wanted.has(i.state));
        }
        issues.sort((a, b) => b.number - a.number);
        if (orderBy?.direction === 'ASC') issues.sort((a, b) => a.number - b.number);
        const conn: AnyNode = { __type: 'IssueConnection', items: issues, repo, after, first };
        return executeSelections(executor, conn, sub);
      }
      if (name === 'pullRequests') {
        const first = argValue(args, 'first', vars) as number | undefined;
        const after = argValue(args, 'after', vars) as string | undefined;
        let pulls = [...repo.pulls.values()];
        pulls.sort((a, b) => b.number - a.number);
        const conn: AnyNode = { __type: 'PullRequestConnection', items: pulls, repo, after, first };
        return executeSelections(executor, conn, sub);
      }
      if (name === 'pullRequest') {
        const number = argValue(args, 'number', vars) as number | undefined;
        if (number === undefined) return null;
        const pull = repo.pulls.get(number);
        if (!pull) return null;
        return executeSelections(executor, { __type: 'PullRequest', repo, pull }, sub);
      }
      throw new GraphQLError(`Cannot query field "${name}" on type "Repository".`);
    }
    case 'Issue': {
      const { repo, issue } = parent;
      if (name === 'id') return issueGlobalId(repo.owner, repo.name, issue.number);
      if (name === 'number') return issue.number;
      if (name === 'title') return issue.title;
      if (name === 'body') return issue.body;
      if (name === 'state') return issue.state === 'open' ? 'OPEN' : 'CLOSED';
      throw new GraphQLError(`Cannot query field "${name}" on type "Issue".`);
    }
    case 'PullRequest': {
      const { repo, pull } = parent;
      if (name === 'id') return pullGlobalId(repo.owner, repo.name, pull.number);
      if (name === 'number') return pull.number;
      if (name === 'state') {
        if (pull.merged) return 'MERGED';
        return pull.state === 'open' ? 'OPEN' : 'CLOSED';
      }
      if (name === 'merged') return pull.merged;
      if (name === 'headRefName') return pull.headRef;
      if (name === 'baseRefName') return pull.baseRef;
      if (name === 'mergeable') return pullMergeable(repo, pull);
      if (name === 'files') {
        const first = argValue(args, 'first', vars) as number | undefined;
        const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
        const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
        const files = diffTrees(repo, baseSha, headSha);
        const nodes = (first === undefined ? files : files.slice(0, first)).map((f) => ({ path: f.filename }));
        return { nodes };
      }
      throw new GraphQLError(`Cannot query field "${name}" on type "PullRequest".`);
    }
    case 'IssueConnection': {
      const { items, repo, after, first } = parent;
      if (name === 'nodes') {
        const { page } = paginateConnection(items, first, after);
        return page.map((issue) => executeSelections(executor, { __type: 'Issue', repo, issue }, sub));
      }
      if (name === 'pageInfo') {
        const { hasNextPage, endCursor } = paginateConnection(items, first, after);
        return { hasNextPage, endCursor };
      }
      throw new GraphQLError(`Cannot query field "${name}" on type "IssueConnection".`);
    }
    case 'PullRequestConnection': {
      const { items, repo, after, first } = parent;
      if (name === 'nodes') {
        const { page } = paginateConnection(items, first, after);
        return page.map((pull) => executeSelections(executor, { __type: 'PullRequest', repo, pull }, sub));
      }
      if (name === 'pageInfo') {
        const { hasNextPage, endCursor } = paginateConnection(items, first, after);
        return { hasNextPage, endCursor };
      }
      throw new GraphQLError(`Cannot query field "${name}" on type "PullRequestConnection".`);
    }
    case 'Comment': {
      if (name === 'id') return commentGlobalId(parent.repo.owner, parent.repo.name, parent.comment.id);
      if (name === 'body') return parent.comment.body;
      throw new GraphQLError(`Cannot query field "${name}" on type "Comment".`);
    }
    case 'PageInfo': {
      if (name === 'hasNextPage') return parent.hasNextPage;
      if (name === 'endCursor') return parent.endCursor;
      throw new GraphQLError(`Cannot query field "${name}" on type "PageInfo".`);
    }
  }
}

/** Execute one GraphQL request body. Returns the JSON response object. */
export function executeGraphQL(body: unknown): Record<string, unknown> {
  if (Array.isArray(body)) {
    return { data: null, errors: [{ message: 'Batch must be handled by the caller' }] } as unknown as Record<string, unknown>;
  }
  const query = (body as Record<string, unknown>)?.query;
  const variables = ((body as Record<string, unknown>)?.variables ?? {}) as Variables;
  if (typeof query !== 'string') {
    return { data: null, errors: [{ message: 'query is required' }] };
  }
  let document: Document;
  try {
    document = new Parser(tokenize(query)).parseDocument();
  } catch (error) {
    return { data: null, errors: [{ message: error instanceof Error ? error.message : 'Parse error' }] };
  }
  const operation = document.operations[0];
  if (!operation) {
    return { data: null, errors: [{ message: 'No operation found' }] };
  }
  const vars: Variables = { ...variables };
  for (const def of operation.variableDefinitions ?? []) {
    if (vars[def.name] === undefined && def.defaultValue !== undefined) {
      vars[def.name] = valueOf(def.defaultValue, vars);
    }
  }
  const executor: Executor = { errors: [], variables: vars, document };
  const root: AnyNode = operation.type === 'mutation' ? { __type: 'Mutation' } : { __type: 'Query' };
  let data: Record<string, unknown> | null = null;
  try {
    data = executeSelections(executor, root, operation.selections);
  } catch (error) {
    if (error instanceof GraphQLError) {
      return { data: null, errors: [{ message: error.message }] };
    }
    throw error;
  }
  if (executor.errors.length > 0) {
    return { data, errors: executor.errors };
  }
  return { data };
}

/** Execute a batch (JSON array) — one result per entry, in order. */
export function executeGraphQLBatch(body: unknown[]): Record<string, unknown>[] {
  return body.map((entry) => executeGraphQL(entry));
}
