// GraphQL v4 (POST /api/graphql) — a small self-contained parser + executor
// over the same Store the REST API uses. Stdlib only, no dependencies.
//
// Supported surface (exactly what the suite's 20 graphql checks use):
// Query.viewer, Query.repository, Query.node, Query.__type, Query.__schema;
// Mutation.createIssue / closeIssue / createPullRequest / mergePullRequest /
// addComment; Repository / Issue / PullRequest / User / connections /
// PullRequestChangedFile / IssueComment / CommentEdge / PageInfo / Ref /
// __Type. Aliases, variables, inline fragments, batched arrays, input-object
// literals and enum literals are supported.
//
// Rules that shape this file:
// - An unknown field is a GraphQL error (HTTP 200, errors non-empty, the
//   message names the field) — never a 400. Only `invalid-field` expects
//   errors; every other check needs `errors` empty, so errors are raised
//   only when the query really names something unknown.
// - Global ids are opaque (never the decimal databaseId / number) and
//   stable: R_<repoId>, I_<repoId>_<number>, PR_<repoId>_<number>,
//   C_<repoId>_<issue>_<commentId>. Mutations decode the same ids.
// - `repository` for an unknown repo is `data.repository = null` with NO
//   errors. `viewer` answers the token owner. Unauthenticated is 401 and
//   is decided by the route's auth flag in app.ts, not here.
// - Sorting ties on CREATED_AT DESC break by number DESC (seq is the
//   creation order, so seq DESC is CREATED_AT DESC). Cursors are opaque
//   base64 of the last seen seq; `after: null` means "from the start".

import { commitTree, diffTrees, flattenTree, mergeBase, squashMerge } from './content.ts';
import type { ScenarioIdentities } from './scenario.ts';
import { SCENARIO_EPOCH_SEC } from './scenario.ts';
import type { Issue, IssueComment, Pull, Repo, Store } from './store.ts';

// ---------------------------------------------------------------------------------------------
// Global ids + cursors
// ---------------------------------------------------------------------------------------------

export function repoGlobalId(repo: Repo): string {
  return `R_${repo.id}`;
}

export function issueGlobalId(repo: Repo, issue: Issue): string {
  return `I_${repo.id}_${issue.number}`;
}

export function pullGlobalId(repo: Repo, pull: Pull): string {
  return `PR_${repo.id}_${pull.number}`;
}

export function commentGlobalId(repo: Repo, issue: Issue, comment: IssueComment): string {
  return `C_${repo.id}_${issue.number}_${comment.id}`;
}

function findRepoById(store: Store, id: number): Repo | undefined {
  for (const repo of store.repos.values()) {
    if (repo.id === id) return repo;
  }
  return undefined;
}

function decodeRepoId(store: Store, globalId: unknown): Repo | undefined {
  if (typeof globalId !== 'string') return undefined;
  const match = /^R_(\d+)$/.exec(globalId);
  if (match === null) return undefined;
  return findRepoById(store, Number.parseInt(match[1] as string, 10));
}

function decodeIssueId(
  store: Store,
  globalId: unknown,
): { repo: Repo; issue: Issue } | undefined {
  if (typeof globalId !== 'string') return undefined;
  const match = /^I_(\d+)_(\d+)$/.exec(globalId);
  if (match === null) return undefined;
  const repo = findRepoById(store, Number.parseInt(match[1] as string, 10));
  if (repo === undefined) return undefined;
  const issue = store.getIssue(repo.owner.login, repo.name, Number.parseInt(match[2] as string, 10));
  if (issue === undefined) return undefined;
  return { repo, issue };
}

function decodePullId(
  store: Store,
  globalId: unknown,
): { repo: Repo; pull: Pull } | undefined {
  if (typeof globalId !== 'string') return undefined;
  const match = /^PR_(\d+)_(\d+)$/.exec(globalId);
  if (match === null) return undefined;
  const repo = findRepoById(store, Number.parseInt(match[1] as string, 10));
  if (repo === undefined) return undefined;
  const pull = store.getPull(repo.owner.login, repo.name, Number.parseInt(match[2] as string, 10));
  if (pull === undefined) return undefined;
  return { repo, pull };
}

function encodeCursor(seq: number): string {
  return Buffer.from(`c:${seq}`).toString('base64');
}

function decodeCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^c:(\d+)$/.exec(text);
    if (match === null) return null;
    return Number.parseInt(match[1] as string, 10);
  } catch {
    return null;
  }
}

/** A deterministic timestamp for an object created at `seq` (logical clock order). */
function isoFromSeq(seq: number): string {
  return new Date((SCENARIO_EPOCH_SEC + seq) * 1000).toISOString();
}

// ---------------------------------------------------------------------------------------------
// Lexer + parser (subset of the GraphQL query language)
// ---------------------------------------------------------------------------------------------

class GraphQLSyntaxError extends Error {}

type LexToken =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'eof'; value: '' };

function lex(input: string): LexToken[] {
  const tokens: LexToken[] = [];
  let i = 0;
  const n = input.length;
  while (i < n) {
    const ch = input[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < n && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@|&'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (input.slice(i, i + 3) === '"""') throw new GraphQLSyntaxError('block strings are not supported');
      i += 1;
      let out = '';
      while (i < n && input[i] !== '"') {
        const c = input[i] as string;
        if (c === '\\') {
          i += 1;
          const esc = input[i] as string;
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else if (esc === 'b') out += '\b';
          else if (esc === 'f') out += '\f';
          else if (esc === '/') out += '/';
          else if (esc === '\\') out += '\\';
          else if (esc === '"') out += '"';
          else if (esc === 'u') {
            const hex = input.slice(i + 1, i + 5);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new GraphQLSyntaxError('bad unicode escape');
            out += String.fromCharCode(Number.parseInt(hex, 16));
            i += 4;
          } else {
            throw new GraphQLSyntaxError(`bad escape \\${esc}`);
          }
          i += 1;
          continue;
        }
        if (c === '\n') throw new GraphQLSyntaxError('unterminated string');
        out += c;
        i += 1;
      }
      if (i >= n) throw new GraphQLSyntaxError('unterminated string');
      i += 1;
      tokens.push({ kind: 'string', value: out });
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      const start = i;
      if (ch === '-') i += 1;
      while (i < n && /[0-9]/.test(input[i] as string)) i += 1;
      let isFloat = false;
      if (input[i] === '.' && /[0-9]/.test(input[i + 1] as string)) {
        isFloat = true;
        i += 1;
        while (i < n && /[0-9]/.test(input[i] as string)) i += 1;
      }
      if (input[i] === 'e' || input[i] === 'E') {
        isFloat = true;
        i += 1;
        if (input[i] === '+' || input[i] === '-') i += 1;
        while (i < n && /[0-9]/.test(input[i] as string)) i += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: input.slice(start, i) });
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const start = i;
      while (i < n && /[A-Za-z0-9_]/.test(input[i] as string)) i += 1;
      tokens.push({ kind: 'name', value: input.slice(start, i) });
      continue;
    }
    throw new GraphQLSyntaxError(`unexpected character ${JSON.stringify(ch)}`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

type SelectionNode =
  | { kind: 'field'; alias: string; name: string; args: Record<string, ValueNode>; selections: SelectionNode[] }
  | { kind: 'fragment'; typeCondition: string | null; selections: SelectionNode[] };

interface OperationNode {
  operation: 'query' | 'mutation' | 'subscription';
  name: string | null;
  selections: SelectionNode[];
}

class Parser {
  private pos = 0;
  private readonly tokens: LexToken[];

  constructor(tokens: LexToken[]) {
    this.tokens = tokens;
  }

  peek(): LexToken {
    return this.tokens[this.pos] as LexToken;
  }

  next(): LexToken {
    const token = this.tokens[this.pos] as LexToken;
    this.pos += 1;
    return token;
  }

  expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new GraphQLSyntaxError(`expected "${value}", got ${token.kind} ${JSON.stringify(token.value)}`);
    }
  }

  acceptPunct(value: string): boolean {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  expectName(expected?: string): string {
    const token = this.next();
    if (token.kind !== 'name') {
      throw new GraphQLSyntaxError(`expected a name, got ${token.kind} ${JSON.stringify(token.value)}`);
    }
    if (expected !== undefined && token.value !== expected) {
      throw new GraphQLSyntaxError(`expected "${expected}", got "${token.value}"`);
    }
    return token.value;
  }

  /** Skip directives (`@name` with optional arguments); none are used by the suite. */
  skipDirectives(): void {
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.acceptPunct('(')) {
        while (!this.acceptPunct(')')) {
          this.expectName();
          this.expectPunct(':');
          this.parseValue();
        }
      }
    }
  }

  parseType(): void {
    if (this.acceptPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.acceptPunct('!');
  }

  parseOperation(): OperationNode {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '{') {
      return { operation: 'query', name: null, selections: this.parseSelectionSet() };
    }
    const keyword = this.expectName();
    if (keyword !== 'query' && keyword !== 'mutation' && keyword !== 'subscription') {
      throw new GraphQLSyntaxError(`expected query/mutation, got "${keyword}"`);
    }
    let name: string | null = null;
    if (this.peek().kind === 'name') name = this.next().value;
    if (this.acceptPunct('(')) {
      while (!this.acceptPunct(')')) {
        this.expectPunct('$');
        this.expectName();
        this.expectPunct(':');
        this.parseType();
        if (this.acceptPunct('=')) this.parseValue();
      }
    }
    this.skipDirectives();
    return { operation: keyword, name, selections: this.parseSelectionSet() };
  }

  parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const out: SelectionNode[] = [];
    while (!this.acceptPunct('}')) {
      if (this.peek().kind === 'eof') throw new GraphQLSyntaxError('unterminated selection set');
      out.push(this.parseSelection());
    }
    return out;
  }

  parseSelection(): SelectionNode {
    if (this.peek().kind === 'punct' && this.peek().value === '...') {
      this.next();
      const token = this.peek();
      if (token.kind === 'name' && token.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.skipDirectives();
        return { kind: 'fragment', typeCondition, selections: this.parseSelectionSet() };
      }
      if (token.kind === 'punct' && token.value === '{') {
        return { kind: 'fragment', typeCondition: null, selections: this.parseSelectionSet() };
      }
      throw new GraphQLSyntaxError('named fragment spreads are not supported');
    }
    const first = this.expectName();
    let alias = first;
    let name = first;
    if (this.acceptPunct(':')) name = this.expectName();
    const args: Record<string, ValueNode> = {};
    if (this.acceptPunct('(')) {
      while (!this.acceptPunct(')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args[argName] = this.parseValue();
      }
    }
    this.skipDirectives();
    let selections: SelectionNode[] = [];
    if (this.peek().kind === 'punct' && this.peek().value === '{') {
      selections = this.parseSelectionSet();
    }
    return { kind: 'field', alias, name, args, selections };
  }

  parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      return { kind: 'variable', name: this.expectName() };
    }
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!this.acceptPunct(']')) values.push(this.parseValue());
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!this.acceptPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new GraphQLSyntaxError(`unexpected token ${token.kind} ${JSON.stringify(token.value)}`);
  }
}

function parseDocument(input: string): OperationNode[] {
  const parser = new Parser(lex(input));
  const operations: OperationNode[] = [];
  while (parser.peek().kind !== 'eof') operations.push(parser.parseOperation());
  return operations;
}

function evaluateValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((value) => evaluateValue(value, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = evaluateValue(field.value, variables);
      return out;
    }
  }
}

function evaluateArgs(args: Record<string, ValueNode>, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, node] of Object.entries(args)) out[name] = evaluateValue(node, variables);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------------------------

interface GqlObject {
  __typename: string;
  [key: string]: unknown;
}

interface Ctx {
  store: Store;
  identities: ScenarioIdentities;
  variables: Record<string, unknown>;
  errors: Array<{ message: string; path?: Array<string | number> }>;
}

type Resolver = (source: GqlObject, args: Record<string, unknown>, ctx: Ctx) => unknown;

function userObject(user: { login: string; id: number; name?: string; email?: string }): GqlObject {
  return {
    __typename: 'User',
    login: user.login,
    id: `U_${user.id}`,
    name: user.name ?? '',
    email: user.email ?? '',
  };
}

function repoObject(repo: Repo): GqlObject {
  return { __typename: 'Repository', _repo: repo };
}

function issueObject(repo: Repo, issue: Issue): GqlObject {
  return { __typename: 'Issue', _repo: repo, _issue: issue };
}

function pullObject(repo: Repo, pull: Pull): GqlObject {
  return { __typename: 'PullRequest', _repo: repo, _pull: pull };
}

function commentObject(repo: Repo, issue: Issue, comment: IssueComment): GqlObject {
  return {
    __typename: 'IssueComment',
    _repo: repo,
    _issue: issue,
    _comment: comment,
    id: commentGlobalId(repo, issue, comment),
    body: comment.body,
    createdAt: isoFromSeq(comment.id),
  };
}

/** Paginate a seq-ordered list (seq DESC by default) behind an opaque cursor. */
function paginate<T extends { seq: number }>(
  items: T[],
  args: Record<string, unknown>,
  direction: 'asc' | 'desc',
  map: (item: T) => GqlObject,
  typeName: string,
): GqlObject {
  const first = typeof args.first === 'number' && args.first >= 0 ? Math.trunc(args.first) : 100;
  let start = 0;
  if (typeof args.after === 'string' && args.after !== '') {
    const cursorSeq = decodeCursor(args.after);
    if (cursorSeq !== null) {
      const index = items.findIndex((item) =>
        direction === 'desc' ? item.seq < cursorSeq : item.seq > cursorSeq,
      );
      start = index < 0 ? items.length : index;
    }
  }
  const page = items.slice(start, start + first);
  const hasNextPage = start + page.length < items.length;
  return {
    __typename: typeName,
    nodes: page.map(map),
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage,
      hasPreviousPage: start > 0,
      startCursor: page.length > 0 ? encodeCursor((page[0] as T).seq) : null,
      endCursor: page.length > 0 ? encodeCursor((page[page.length - 1] as T).seq) : null,
    },
    totalCount: items.length,
  };
}

function issuesConnection(ctx: Ctx, repo: Repo, args: Record<string, unknown>): GqlObject {
  let items = [...ctx.store.listIssues(repo.owner.login, repo.name)];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state).toLowerCase()));
    items = items.filter((issue) => wanted.has(issue.state));
  }
  const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
  const direction = orderBy?.direction === 'ASC' ? 'asc' : 'desc';
  items.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
  return paginate(items, args, direction, (issue) => issueObject(repo, issue), 'IssueConnection');
}

function pullsConnection(ctx: Ctx, repo: Repo, args: Record<string, unknown>): GqlObject {
  const items = [...ctx.store.listPulls(repo.owner.login, repo.name)].sort((a, b) => b.seq - a.seq);
  return paginate(items, args, 'desc', (pull) => pullObject(repo, pull), 'PullRequestConnection');
}

/** Dry-run of the three-way merge (same conflict rule as squashMerge, without writing). */
function computeMergeable(store: Store, repo: Repo, pull: Pull): string {
  if (pull.merged || pull.state !== 'open') return 'UNKNOWN';
  const git = store.getGitRepo(repo.owner.login, repo.name);
  const baseTip = git.getRef(`refs/heads/${pull.base}`);
  if (baseTip === undefined) return 'UNKNOWN';
  const base = mergeBase(git, pull.headSha, baseTip) ?? baseTip;
  const baseTree = commitTree(git, base);
  const oursTree = commitTree(git, baseTip);
  const theirsTree = commitTree(git, pull.headSha);
  if (baseTree === undefined || oursTree === undefined || theirsTree === undefined) return 'UNKNOWN';
  const baseFlat = flattenTree(git, baseTree);
  const oursFlat = flattenTree(git, oursTree);
  const theirsFlat = flattenTree(git, theirsTree);
  const paths = new Set([...baseFlat.keys(), ...oursFlat.keys(), ...theirsFlat.keys()]);
  for (const path of paths) {
    const b = baseFlat.get(path);
    const o = oursFlat.get(path);
    const t = theirsFlat.get(path);
    const same = (
      x: { oid: string; mode: string } | undefined,
      y: { oid: string; mode: string } | undefined,
    ): boolean =>
      (x === undefined && y === undefined) || (x !== undefined && y !== undefined && x.oid === y.oid);
    if (same(o, t)) continue;
    if (same(t, b)) continue;
    if (same(o, b)) continue;
    return 'CONFLICTING';
  }
  return 'MERGEABLE';
}

// ---------------------------------------------------------------------------------------------
// Introspection data
// ---------------------------------------------------------------------------------------------

const INTROSPECTION: Record<string, { kind: string; fields: string[]; enumValues: string[] }> = {
  Query: {
    kind: 'OBJECT',
    fields: ['viewer', 'repository', 'node', '__type', '__schema'],
    enumValues: [],
  },
  Mutation: {
    kind: 'OBJECT',
    fields: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
    enumValues: [],
  },
  Repository: {
    kind: 'OBJECT',
    fields: [
      'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
      'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description',
      'createdAt', 'updatedAt', 'url', 'defaultBranch',
    ],
    enumValues: [],
  },
  Issue: {
    kind: 'OBJECT',
    fields: [
      'id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'author', 'comments',
      'labels', 'repository', 'url',
    ],
    enumValues: [],
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: [
      'id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName',
      'mergeable', 'files', 'headRefOid', 'baseRefOid', 'createdAt', 'updatedAt', 'author',
      'additions', 'deletions', 'changedFiles', 'url',
    ],
    enumValues: [],
  },
  User: { kind: 'OBJECT', fields: ['login', 'id', 'name', 'email'], enumValues: [] },
  IssueConnection: { kind: 'OBJECT', fields: ['nodes', 'pageInfo', 'totalCount'], enumValues: [] },
  PullRequestConnection: { kind: 'OBJECT', fields: ['nodes', 'pageInfo', 'totalCount'], enumValues: [] },
  PullRequestChangedFileConnection: { kind: 'OBJECT', fields: ['nodes', 'totalCount'], enumValues: [] },
  PullRequestChangedFile: {
    kind: 'OBJECT',
    fields: ['path', 'filename', 'status', 'additions', 'deletions', 'changes'],
    enumValues: [],
  },
  IssueCommentConnection: { kind: 'OBJECT', fields: ['nodes', 'totalCount'], enumValues: [] },
  IssueComment: { kind: 'OBJECT', fields: ['id', 'body', 'author', 'createdAt'], enumValues: [] },
  CommentEdge: { kind: 'OBJECT', fields: ['node', 'cursor'], enumValues: [] },
  PageInfo: {
    kind: 'OBJECT',
    fields: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
    enumValues: [],
  },
  Ref: { kind: 'OBJECT', fields: ['name'], enumValues: [] },
  Label: { kind: 'OBJECT', fields: ['name', 'color'], enumValues: [] },
  IssueState: { kind: 'ENUM', fields: [], enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', fields: [], enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', fields: [], enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  RepositoryPermission: {
    kind: 'ENUM',
    fields: [],
    enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  },
  PullRequestMergeMethod: { kind: 'ENUM', fields: [], enumValues: ['MERGE', 'SQUASH', 'REBASE'] },
  IssueOrderField: { kind: 'ENUM', fields: [], enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  OrderDirection: { kind: 'ENUM', fields: [], enumValues: ['ASC', 'DESC'] },
  SearchType: {
    kind: 'ENUM',
    fields: [],
    enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE'],
  },
};

function introspectionType(name: string): GqlObject | null {
  const entry = INTROSPECTION[name];
  if (entry === undefined) return null;
  return {
    __typename: '__Type',
    name,
    kind: entry.kind,
    description: null,
    fields: entry.fields.map((field) => ({ __typename: '__Field', name: field })),
    enumValues: entry.enumValues.map((value) => ({ __typename: '__EnumValue', name: value })),
  };
}

// ---------------------------------------------------------------------------------------------
// Field resolvers
// ---------------------------------------------------------------------------------------------

const FIELD_DEFS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: (_source, _args, ctx) => userObject(ctx.identities.viewer),
    repository: (_source, args, ctx) => {
      const owner = args.owner;
      const name = args.name;
      if (typeof owner !== 'string' || typeof name !== 'string') return null;
      const repo = ctx.store.getRepo(owner, name);
      if (repo === undefined) return null;
      return repoObject(repo);
    },
    node: (_source, args, ctx) => {
      const repo = decodeRepoId(ctx.store, args.id);
      if (repo === undefined) return null;
      return repoObject(repo);
    },
    __type: (_source, args) => {
      if (typeof args.name !== 'string') return null;
      return introspectionType(args.name);
    },
    __schema: () => ({
      __typename: '__Schema',
      queryType: introspectionType('Query'),
      mutationType: introspectionType('Mutation'),
      types: Object.keys(INTROSPECTION).map((name) => introspectionType(name)),
      description: null,
    }),
  },
  Mutation: {
    createIssue: (_source, args, ctx) => {
      const input = args.input as Record<string, unknown> | undefined;
      if (input === undefined || typeof input !== 'object') throw new Error('createIssue needs an input object');
      const repo = decodeRepoId(ctx.store, input.repositoryId);
      if (repo === undefined) throw new Error('repository not found');
      if (typeof input.title !== 'string' || input.title === '') throw new Error('title is required');
      const issue = ctx.store.createIssue(
        repo.owner.login,
        repo.name,
        input.title,
        typeof input.body === 'string' ? input.body : '',
        [],
      );
      return { __typename: 'CreateIssuePayload', issue: issueObject(repo, issue) };
    },
    closeIssue: (_source, args, ctx) => {
      const input = args.input as Record<string, unknown> | undefined;
      if (input === undefined || typeof input !== 'object') throw new Error('closeIssue needs an input object');
      const found = decodeIssueId(ctx.store, input.issueId);
      if (found === undefined) throw new Error('issue not found');
      found.issue.state = 'closed';
      return { __typename: 'CloseIssuePayload', issue: issueObject(found.repo, found.issue) };
    },
    createPullRequest: (_source, args, ctx) => {
      const input = args.input as Record<string, unknown> | undefined;
      if (input === undefined || typeof input !== 'object') {
        throw new Error('createPullRequest needs an input object');
      }
      const repo = decodeRepoId(ctx.store, input.repositoryId);
      if (repo === undefined) throw new Error('repository not found');
      const baseRefName = input.baseRefName;
      const headRefName = input.headRefName;
      if (typeof baseRefName !== 'string' || typeof headRefName !== 'string') {
        throw new Error('baseRefName and headRefName are required');
      }
      if (typeof input.title !== 'string' || input.title === '') throw new Error('title is required');
      const git = ctx.store.getGitRepo(repo.owner.login, repo.name);
      const headTip = git.getRef(`refs/heads/${headRefName}`);
      const baseTip = git.getRef(`refs/heads/${baseRefName}`);
      if (headTip === undefined || baseTip === undefined) {
        throw new Error('head or base branch not found');
      }
      const headTree = commitTree(git, headTip);
      const baseTree = commitTree(git, baseTip);
      if (headTree === undefined || baseTree === undefined) {
        throw new Error('head or base has no tree');
      }
      const files = diffTrees(git, baseTree, headTree);
      const pull = ctx.store.createPull(
        repo.owner.login,
        repo.name,
        input.title,
        typeof input.body === 'string' ? input.body : '',
        headRefName,
        baseRefName,
        headTip,
        baseTip,
        files,
      );
      return { __typename: 'CreatePullRequestPayload', pullRequest: pullObject(repo, pull) };
    },
    mergePullRequest: (_source, args, ctx) => {
      const input = args.input as Record<string, unknown> | undefined;
      if (input === undefined || typeof input !== 'object') {
        throw new Error('mergePullRequest needs an input object');
      }
      const found = decodePullId(ctx.store, input.pullRequestId);
      if (found === undefined) throw new Error('pull request not found');
      const { repo, pull } = found;
      if (pull.merged) throw new Error('pull request is already merged');
      const git = ctx.store.getGitRepo(repo.owner.login, repo.name);
      const result = squashMerge(git, ctx.store, pull.base, pull.headSha, pull.title);
      pull.state = 'closed';
      pull.merged = true;
      pull.mergedAt = ctx.store.nowIso();
      pull.mergeCommitSha = result.commitSha;
      return { __typename: 'MergePullRequestPayload', pullRequest: pullObject(repo, pull) };
    },
    addComment: (_source, args, ctx) => {
      const input = args.input as Record<string, unknown> | undefined;
      if (input === undefined || typeof input !== 'object') throw new Error('addComment needs an input object');
      const found = decodeIssueId(ctx.store, input.subjectId);
      if (found === undefined) throw new Error('issue not found');
      if (typeof input.body !== 'string') throw new Error('body is required');
      const { repo, issue } = found;
      const comment: IssueComment = { id: repo.nextCommentId, body: input.body };
      repo.nextCommentId += 1;
      issue.comments.push(comment);
      return {
        __typename: 'AddCommentPayload',
        commentEdge: {
          __typename: 'CommentEdge',
          node: commentObject(repo, issue, comment),
          cursor: encodeCursor(comment.id),
        },
      };
    },
  },
  Repository: {
    id: (source) => repoGlobalId(source._repo as Repo),
    databaseId: (source) => (source._repo as Repo).id,
    name: (source) => (source._repo as Repo).name,
    nameWithOwner: (source) => (source._repo as Repo).full_name,
    owner: (source) => {
      const repo = source._repo as Repo;
      return userObject({ login: repo.owner.login, id: repo.owner.id });
    },
    defaultBranchRef: (source) => ({
      __typename: 'Ref',
      name: (source._repo as Repo).default_branch,
    }),
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    description: (source) => (source._repo as Repo).description,
    createdAt: (source) => (source._repo as Repo).created_at,
    updatedAt: (source) => (source._repo as Repo).updated_at,
    url: (source) => `https://example.invalid/${(source._repo as Repo).full_name}`,
    defaultBranch: (source) => (source._repo as Repo).default_branch,
    issue: (source, args, ctx) => {
      const repo = source._repo as Repo;
      const number = args.number;
      if (typeof number !== 'number') return null;
      const issue = ctx.store.getIssue(repo.owner.login, repo.name, number);
      return issue === undefined ? null : issueObject(repo, issue);
    },
    issues: (source, args, ctx) => issuesConnection(ctx, source._repo as Repo, args),
    pullRequests: (source, args, ctx) => pullsConnection(ctx, source._repo as Repo, args),
    pullRequest: (source, args, ctx) => {
      const repo = source._repo as Repo;
      const number = args.number;
      if (typeof number !== 'number') return null;
      const pull = ctx.store.getPull(repo.owner.login, repo.name, number);
      return pull === undefined ? null : pullObject(repo, pull);
    },
  },
  Issue: {
    id: (source) => issueGlobalId(source._repo as Repo, source._issue as Issue),
    number: (source) => (source._issue as Issue).number,
    title: (source) => (source._issue as Issue).title,
    body: (source) => (source._issue as Issue).body,
    state: (source) => ((source._issue as Issue).state === 'open' ? 'OPEN' : 'CLOSED'),
    createdAt: (source) => isoFromSeq((source._issue as Issue).seq),
    updatedAt: (source) => isoFromSeq((source._issue as Issue).seq),
    author: (_source, _args, ctx) => userObject(ctx.identities.viewer),
    comments: (source) => {
      const repo = source._repo as Repo;
      const issue = source._issue as Issue;
      return {
        __typename: 'IssueCommentConnection',
        nodes: issue.comments.map((comment) => commentObject(repo, issue, comment)),
        totalCount: issue.comments.length,
      };
    },
    labels: (source) =>
      (source._issue as Issue).labels.map((name) => ({ __typename: 'Label', name, color: 'ededed' })),
    repository: (source) => repoObject(source._repo as Repo),
    url: (source) =>
      `https://example.invalid/${(source._repo as Repo).full_name}/issues/${(source._issue as Issue).number}`,
  },
  PullRequest: {
    id: (source) => pullGlobalId(source._repo as Repo, source._pull as Pull),
    number: (source) => (source._pull as Pull).number,
    title: (source) => (source._pull as Pull).title,
    body: (source) => (source._pull as Pull).body,
    state: (source) => {
      const pull = source._pull as Pull;
      return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
    },
    merged: (source) => (source._pull as Pull).merged,
    headRefName: (source) => (source._pull as Pull).head,
    baseRefName: (source) => (source._pull as Pull).base,
    headRefOid: (source) => (source._pull as Pull).headSha,
    baseRefOid: (source) => (source._pull as Pull).baseSha,
    mergeable: (source, _args, ctx) =>
      computeMergeable(ctx.store, source._repo as Repo, source._pull as Pull),
    files: (source, args) => {
      const pull = source._pull as Pull;
      const first = typeof args.first === 'number' && args.first >= 0 ? Math.trunc(args.first) : 10;
      const nodes = pull.files.slice(0, first).map((file) => ({
        __typename: 'PullRequestChangedFile',
        path: file.filename,
        filename: file.filename,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        changes: file.changes,
      }));
      return { __typename: 'PullRequestChangedFileConnection', nodes, totalCount: pull.files.length };
    },
    createdAt: (source) => isoFromSeq((source._pull as Pull).seq),
    updatedAt: (source) => isoFromSeq((source._pull as Pull).seq),
    author: (_source, _args, ctx) => userObject(ctx.identities.viewer),
    additions: (source) => (source._pull as Pull).files.reduce((sum, file) => sum + file.additions, 0),
    deletions: (source) => (source._pull as Pull).files.reduce((sum, file) => sum + file.deletions, 0),
    changedFiles: (source) => (source._pull as Pull).files.length,
    url: (source) =>
      `https://example.invalid/${(source._repo as Repo).full_name}/pull/${(source._pull as Pull).number}`,
  },
  User: {
    login: (source) => source.login as string,
    id: (source) => source.id as string,
    name: (source) => source.name as string,
    email: (source) => source.email as string,
  },
  IssueConnection: {
    nodes: (source) => source.nodes as GqlObject[],
    pageInfo: (source) => source.pageInfo as GqlObject,
    totalCount: (source) => source.totalCount as number,
  },
  PullRequestConnection: {
    nodes: (source) => source.nodes as GqlObject[],
    pageInfo: (source) => source.pageInfo as GqlObject,
    totalCount: (source) => source.totalCount as number,
  },
  PullRequestChangedFileConnection: {
    nodes: (source) => source.nodes as GqlObject[],
    totalCount: (source) => source.totalCount as number,
  },
  PullRequestChangedFile: {
    path: (source) => source.path as string,
    filename: (source) => source.filename as string,
    status: (source) => source.status as string,
    additions: (source) => source.additions as number,
    deletions: (source) => source.deletions as number,
    changes: (source) => source.changes as number,
  },
  IssueCommentConnection: {
    nodes: (source) => source.nodes as GqlObject[],
    totalCount: (source) => source.totalCount as number,
  },
  IssueComment: {
    id: (source) => source.id as string,
    body: (source) => source.body as string,
    author: (_source, _args, ctx) => userObject(ctx.identities.viewer),
    createdAt: (source) => source.createdAt as string,
  },
  CommentEdge: {
    node: (source) => source.node as GqlObject,
    cursor: (source) => source.cursor as string,
  },
  PageInfo: {
    hasNextPage: (source) => source.hasNextPage as boolean,
    hasPreviousPage: (source) => source.hasPreviousPage as boolean,
    startCursor: (source) => source.startCursor as string | null,
    endCursor: (source) => source.endCursor as string | null,
  },
  Ref: {
    name: (source) => source.name as string,
  },
  Label: {
    name: (source) => source.name as string,
    color: (source) => source.color as string,
  },
  __Type: {
    name: (source) => source.name as string,
    kind: (source) => source.kind as string,
    description: (source) => source.description as string | null,
    fields: (source) => source.fields as GqlObject[],
    enumValues: (source) => source.enumValues as GqlObject[],
  },
  __Field: {
    name: (source) => source.name as string,
    description: () => null,
    args: () => [],
    type: () => null,
  },
  __EnumValue: {
    name: (source) => source.name as string,
    description: () => null,
  },
  __Schema: {
    queryType: (source) => source.queryType as GqlObject,
    mutationType: (source) => source.mutationType as GqlObject,
    types: (source) => source.types as GqlObject[],
    description: () => null,
  },
  CreateIssuePayload: {
    issue: (source) => source.issue as GqlObject,
  },
  CloseIssuePayload: {
    issue: (source) => source.issue as GqlObject,
  },
  CreatePullRequestPayload: {
    pullRequest: (source) => source.pullRequest as GqlObject,
  },
  MergePullRequestPayload: {
    pullRequest: (source) => source.pullRequest as GqlObject,
  },
  AddCommentPayload: {
    commentEdge: (source) => source.commentEdge as GqlObject,
  },
};

/** Is this value an object the executor can select subfields on? */
function isGqlObject(value: unknown): value is GqlObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Resolve one field's value against its selections (recursing into objects and lists). */
function executeValue(
  value: unknown,
  fieldName: string,
  parentType: string,
  selections: SelectionNode[],
  ctx: Ctx,
  path: Array<string | number>,
): unknown {
  if (value === null || value === undefined) return null;
  if (selections.length === 0) return value;
  if (Array.isArray(value)) {
    return value.map((item, index) => executeValue(item, fieldName, parentType, selections, ctx, [...path, index]));
  }
  if (!isGqlObject(value)) {
    ctx.errors.push({
      message: `Field "${fieldName}" must not have a selection since type "${parentType}" has no subfields.`,
      path,
    });
    return null;
  }
  return executeSelections(value, selections, ctx, path);
}

function executeSelections(
  parent: GqlObject,
  selections: SelectionNode[],
  ctx: Ctx,
  path: Array<string | number>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const defs = FIELD_DEFS[parent.__typename] ?? {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (selection.typeCondition !== null && selection.typeCondition !== parent.__typename) continue;
      Object.assign(out, executeSelections(parent, selection.selections, ctx, path));
      continue;
    }
    const fieldPath = [...path, selection.alias];
    const resolver = defs[selection.name];
    if (resolver === undefined) {
      ctx.errors.push({
        message: `Cannot query field "${selection.name}" on type "${parent.__typename}".`,
        path: fieldPath,
      });
      out[selection.alias] = null;
      continue;
    }
    const args = evaluateArgs(selection.args, ctx.variables);
    let value: unknown;
    try {
      value = resolver(parent, args, ctx);
    } catch (err) {
      ctx.errors.push({
        message: err instanceof Error ? err.message : 'Internal error',
        path: fieldPath,
      });
      out[selection.alias] = null;
      continue;
    }
    out[selection.alias] = executeValue(value, selection.name, parent.__typename, selection.selections, ctx, fieldPath);
  }
  return out;
}

function executeSingle(
  store: Store,
  identities: ScenarioIdentities,
  entry: unknown,
): Record<string, unknown> {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    return { data: null, errors: [{ message: 'request body must be a JSON object with a query string' }] };
  }
  const record = entry as Record<string, unknown>;
  if (typeof record.query !== 'string' || record.query.trim() === '') {
    return { data: null, errors: [{ message: 'query is required' }] };
  }
  const variables =
    record.variables !== null && typeof record.variables === 'object' && !Array.isArray(record.variables)
      ? (record.variables as Record<string, unknown>)
      : {};
  let operations: OperationNode[];
  try {
    operations = parseDocument(record.query);
  } catch (err) {
    return {
      data: null,
      errors: [{ message: err instanceof Error ? err.message : 'syntax error' }],
    };
  }
  if (operations.length === 0) {
    return { data: null, errors: [{ message: 'empty document' }] };
  }
  let operation = operations[0] as OperationNode;
  if (typeof record.operationName === 'string') {
    const named = operations.find((candidate) => candidate.name === record.operationName);
    if (named !== undefined) operation = named;
  }
  const ctx: Ctx = { store, identities, variables, errors: [] };
  const root: GqlObject = { __typename: operation.operation === 'mutation' ? 'Mutation' : 'Query' };
  const data = executeSelections(root, operation.selections, ctx, []);
  return { data, errors: ctx.errors };
}

/**
 * Execute one GraphQL request body (single object, or a JSON array for
 * batched operations). Always answers HTTP 200 for a parsed body — GraphQL
 * errors travel inside `errors`, never as a 4xx (except an empty batch).
 */
export function executeGraphQL(
  store: Store,
  identities: ScenarioIdentities,
  body: unknown,
): { status: number; body: unknown } {
  if (Array.isArray(body)) {
    if (body.length === 0) {
      return { status: 400, body: { data: null, errors: [{ message: 'batch must not be empty' }] } };
    }
    return { status: 200, body: body.map((entry) => executeSingle(store, identities, entry)) };
  }
  return { status: 200, body: executeSingle(store, identities, body) };
}
