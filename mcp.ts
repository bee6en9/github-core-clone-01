// The MCP endpoint: JSON-RPC 2.0 over Streamable HTTP at POST /mcp.
//
// Two protocol eras, one endpoint (the suite's client negotiates):
//   modern  2026-07-28 — `server/discover` answers the server's identity,
//           capabilities and `supportedVersions` in one request; no handshake,
//           no session. This is the era every check uses when discover works.
//   legacy  <= 2025-11-25 — `initialize` (offering revisions newest first)
//           + `notifications/initialized`, kept as fallback.
//
// One JSON body answers each request; no SSE, no sessions, no state beyond
// the shared store. Auth: any non-empty Bearer token authenticates as the
// scenario viewer (the same rule as the REST routes); a tools/call with no
// token is HTTP 401, decided before any tool lookup or argument validation.
//
// Tools (6) share the REST/GraphQL store, so anything created over MCP is
// the same object over REST (rest-parity) and vice versa. Tool results carry
// both a text block and `structuredContent`, because the suite reads the
// number/title from whichever it can parse first.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  commitTree,
  ConflictError,
  diffTrees,
  NotFoundError,
  squashMerge,
} from './content.ts';
import type { ScenarioIdentities } from './scenario.ts';
import { type Issue, type Pull, type Repo, type Store } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
/** The largest request body accepted (16 MiB); larger is a 400 parse error. */
const MAX_BODY_BYTES = 16 * 1024 * 1024;
/** The modern protocol revision this server speaks. */
const MCP_PROTOCOL_VERSION = '2026-07-28';
const SERVER_NAME = 'github-core-clone';
const SERVER_VERSION = '1.0.0';

class BodyTooLargeError extends Error {}

/** A JSON-RPC protocol error: answered as an `error` object, HTTP 200. */
class RpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

/** A tool execution error: answered as a `result` with `isError: true`. */
class ToolError extends Error {}

interface ToolSchemaProp {
  type: string;
  description: string;
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, ToolSchemaProp>;
    required: string[];
  };
}

/**
 * The six required tools, in a fixed order, as one module-level constant:
 * `tools/list` must serialize byte-identical over two calls, so the array is
 * never rebuilt. Property names are the suite's semantic names exactly
 * (owner, repo, title, body, head, base, pull_number, name, description,
 * private, state) so its argument mapping finds them directly. `required`
 * lists only what the suite can always fill; a required property the suite
 * cannot fill fails the check outright.
 */
const TOOLS: readonly ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Login of the repository owner.' },
        name: { type: 'string', description: 'Name of the repository to create.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
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
        owner: { type: 'string', description: 'Login of the repository owner.' },
        repo: { type: 'string', description: 'Name of the repository.' },
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
        owner: { type: 'string', description: 'Login of the repository owner.' },
        repo: { type: 'string', description: 'Name of the repository.' },
        title: { type: 'string', description: 'Title of the issue.' },
        body: { type: 'string', description: 'Body of the issue.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Login of the repository owner.' },
        repo: { type: 'string', description: 'Name of the repository.' },
        state: { type: 'string', description: 'Issue state filter: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Login of the repository owner.' },
        repo: { type: 'string', description: 'Name of the repository.' },
        title: { type: 'string', description: 'Title of the pull request.' },
        body: { type: 'string', description: 'Body of the pull request.' },
        head: { type: 'string', description: 'Name of the head branch.' },
        base: { type: 'string', description: 'Name of the base branch.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number with a squash merge.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Login of the repository owner.' },
        repo: { type: 'string', description: 'Name of the repository.' },
        pull_number: { type: 'integer', description: 'Number of the pull request.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

/** A value as a record, or null when it is not one. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The bearer token of a request, or null when there is none. */
function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (match === null) return null;
  const token = (match[1] as string).trim();
  return token === '' ? null : token;
}

/** Read the whole request body (empty string when there is none). */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new BodyTooLargeError('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', (err: Error) => reject(err));
  });
}

/** The JSON-RPC id of a raw body, read leniently (null when unparseable). */
function lenientId(raw: string): unknown {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (isRecord(parsed) && ('id' in parsed)) return parsed.id;
    return null;
  } catch {
    return null;
  }
}

/** Answer one MCP request with a JSON body; the request-id header is always set. */
function sendRpc(
  res: ServerResponse,
  status: number,
  requestId: string,
  payload: unknown,
): void {
  const text = `${JSON.stringify(payload)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId,
  });
  res.end(text);
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

/** The public shape of a repository (same fields as the REST route). */
function mcpRepoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: repo.full_name,
    owner: { login: repo.owner.login, id: repo.owner.id, type: repo.owner.type },
    private: repo.private,
    description: repo.description,
    default_branch: repo.default_branch,
    created_at: repo.created_at,
    updated_at: repo.updated_at,
    pushed_at: repo.pushed_at,
    fork: repo.fork,
    forks_count: repo.forks_count,
    stargazers_count: repo.stargazers_count,
    watchers_count: repo.watchers_count,
    open_issues_count: repo.open_issues_count,
    size: repo.size,
  };
}

/** The public shape of an issue (same fields as the REST route). */
function mcpIssueJson(issue: Issue): Record<string, unknown> {
  return {
    id: issue.number,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
  };
}

/** The public shape of a pull request (same fields as the REST route). */
function mcpPullJson(pull: Pull): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: pull.number,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.head, sha: pull.headSha },
    base: { ref: pull.base, sha: pull.baseSha },
    merged: pull.merged,
  };
  if (pull.merged) {
    out.merged_at = pull.mergedAt;
    out.merge_commit_sha = pull.mergeCommitSha;
  }
  return out;
}

function isValidRepoName(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    !/[/\\]/.test(name) &&
    name !== '.' &&
    name !== '..' &&
    !/[\u0000-\u001f\u007f]/.test(name)
  );
}

/** A tool result: one text block plus the same value as structuredContent. */
function toolResult(structured: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(structured) }],
    structuredContent: structured,
  };
}

/** A required string argument, or a -32602 (missing arguments are never guessed). */
function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new RpcError(-32602, `Invalid params: ${key} is required`);
  }
  return value;
}

/** An optional string argument. */
function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' ? value : undefined;
}

/** A required integer argument; a digit string is accepted, like the suite does. */
function requiredNumber(args: Record<string, unknown>, key: string): number {
  const value = args[key];
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number.parseInt(value, 10);
  throw new RpcError(-32602, `Invalid params: ${key} is required`);
}

/** The repo for an owner/name pair, or a tool error when it is not the viewer's. */
function requireMcpRepo(store: Store, identities: ScenarioIdentities, owner: string, name: string): Repo {
  if (owner !== identities.viewer.login) throw new ToolError('Repository not found');
  const repo = store.getRepo(owner, name);
  if (repo === undefined) throw new ToolError('Repository not found');
  return repo;
}

function createRepoTool(
  store: Store,
  identities: ScenarioIdentities,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const name = requiredString(args, 'name');
  if (!isValidRepoName(name)) throw new ToolError('Invalid repository name');
  if (store.getRepo(identities.viewer.login, name) !== undefined) {
    throw new ToolError('Repository already exists');
  }
  const repo = store.createRepo(
    identities.viewer,
    name,
    args.private === true,
    typeof args.description === 'string' ? args.description : null,
  );
  return toolResult(mcpRepoJson(repo));
}

function getRepoTool(
  store: Store,
  identities: ScenarioIdentities,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const owner = requiredString(args, 'owner');
  const name = requiredString(args, 'repo');
  const repo = requireMcpRepo(store, identities, owner, name);
  return toolResult(mcpRepoJson(repo));
}

function createIssueTool(
  store: Store,
  identities: ScenarioIdentities,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const owner = requiredString(args, 'owner');
  const name = requiredString(args, 'repo');
  const title = requiredString(args, 'title');
  const body = optionalString(args, 'body') ?? '';
  requireMcpRepo(store, identities, owner, name);
  const issue = store.createIssue(owner, name, title, body, []);
  return toolResult(mcpIssueJson(issue));
}

function listIssuesTool(
  store: Store,
  identities: ScenarioIdentities,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const owner = requiredString(args, 'owner');
  const name = requiredString(args, 'repo');
  const state = optionalString(args, 'state') ?? 'open';
  requireMcpRepo(store, identities, owner, name);
  let issues = store.listIssues(owner, name);
  if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
  else if (state === 'all') { /* keep all */ }
  else issues = issues.filter((issue) => issue.state === 'open');
  const sorted = [...issues].sort((a, b) => b.seq - a.seq);
  return toolResult({ issues: sorted.map((issue) => mcpIssueJson(issue)) });
}

function createPullRequestTool(
  store: Store,
  identities: ScenarioIdentities,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const owner = requiredString(args, 'owner');
  const name = requiredString(args, 'repo');
  const title = requiredString(args, 'title');
  const head = requiredString(args, 'head');
  const base = requiredString(args, 'base');
  const body = optionalString(args, 'body') ?? '';
  requireMcpRepo(store, identities, owner, name);
  const git = store.getGitRepo(owner, name);
  const headTip = git.getRef(`refs/heads/${head}`);
  const baseTip = git.getRef(`refs/heads/${base}`);
  if (headTip === undefined || baseTip === undefined) {
    throw new ToolError('head or base branch not found');
  }
  const headTree = commitTree(git, headTip);
  const baseTree = commitTree(git, baseTip);
  if (headTree === undefined || baseTree === undefined) {
    throw new ToolError('head or base has no tree');
  }
  const files = diffTrees(git, baseTree, headTree);
  const pull = store.createPull(owner, name, title, body, head, base, headTip, baseTip, files);
  return toolResult(mcpPullJson(pull));
}

function mergePullRequestTool(
  store: Store,
  identities: ScenarioIdentities,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const owner = requiredString(args, 'owner');
  const name = requiredString(args, 'repo');
  const pullNumber = requiredNumber(args, 'pull_number');
  requireMcpRepo(store, identities, owner, name);
  const pull = store.getPull(owner, name, pullNumber);
  if (pull === undefined) throw new ToolError('Pull request not found');
  if (pull.merged || pull.state === 'closed') {
    throw new ToolError('Pull request is already merged');
  }
  const git = store.getGitRepo(owner, name);
  try {
    const result = squashMerge(git, store, pull.base, pull.headSha, pull.title);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = store.nowIso();
    pull.mergeCommitSha = result.commitSha;
    return toolResult({
      merged: true,
      number: pull.number,
      sha: result.commitSha,
      message: `Merged pull request #${pull.number}`,
    });
  } catch (err) {
    if (err instanceof ConflictError || err instanceof NotFoundError) {
      throw new ToolError(err.message);
    }
    throw err;
  }
}

/** Run one tools/call: JSON-RPC errors for bad params/unknown tools, isError for domain failures. */
function executeTool(
  store: Store,
  identities: ScenarioIdentities,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const name = params.name;
  if (typeof name !== 'string' || name === '') {
    throw new RpcError(-32602, 'Invalid params: tool name is required');
  }
  const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
  switch (name) {
    case 'create_repo':
      return createRepoTool(store, identities, args);
    case 'get_repo':
      return getRepoTool(store, identities, args);
    case 'create_issue':
      return createIssueTool(store, identities, args);
    case 'list_issues':
      return listIssuesTool(store, identities, args);
    case 'create_pull_request':
      return createPullRequestTool(store, identities, args);
    case 'merge_pull_request':
      return mergePullRequestTool(store, identities, args);
    default:
      throw new RpcError(-32602, `Unknown tool: ${name}`);
  }
}

/**
 * Handle one request to /mcp. Returns true when the request was answered
 * (POST or DELETE); other methods fall through to the REST routes (404).
 */
export async function handleMcp(
  store: Store,
  identities: ScenarioIdentities,
  req: IncomingMessage,
  res: ServerResponse,
  requestId: string,
): Promise<boolean> {
  // A legacy session close is best-effort; nothing is held server-side.
  if (req.method === 'DELETE') {
    sendRpc(res, 200, requestId, {});
    return true;
  }
  if (req.method !== 'POST') return false;

  let raw: string;
  try {
    raw = await readBody(req);
  } catch {
    sendRpc(res, 400, requestId, rpcError(null, -32700, 'Parse error'));
    return true;
  }

  // Auth is decided before any tool exists: no token is a 401 even for an
  // unknown tool or missing arguments.
  if (bearerToken(req) === null) {
    sendRpc(res, 401, requestId, rpcError(lenientId(raw), -32000, 'Requires authentication'));
    return true;
  }

  let body: unknown;
  try {
    body = JSON.parse(raw) as unknown;
  } catch {
    sendRpc(res, 400, requestId, rpcError(null, -32700, 'Parse error'));
    return true;
  }
  if (Array.isArray(body) || !isRecord(body)) {
    sendRpc(res, 200, requestId, rpcError(null, -32600, 'Invalid Request'));
    return true;
  }
  const id = 'id' in body ? body.id : null;
  const method = body.method;
  if (typeof method !== 'string') {
    sendRpc(res, 200, requestId, rpcError(id, -32600, 'Invalid Request'));
    return true;
  }
  // Notifications carry no id and expect no answer.
  if (method.startsWith('notifications/')) {
    res.writeHead(202, { 'x-github-request-id': requestId });
    res.end();
    return true;
  }

  try {
    switch (method) {
      case 'server/discover': {
        sendRpc(
          res,
          200,
          requestId,
          rpcResult(id, {
            supportedVersions: [MCP_PROTOCOL_VERSION],
            serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
            capabilities: { tools: {} },
            _meta: {
              'io.modelcontextprotocol/serverInfo': {
                name: SERVER_NAME,
                version: SERVER_VERSION,
              },
            },
          }),
        );
        return true;
      }
      case 'initialize': {
        const params = isRecord(body.params) ? (body.params as Record<string, unknown>) : {};
        const offered =
          typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
        sendRpc(
          res,
          200,
          requestId,
          rpcResult(id, {
            protocolVersion: offered,
            serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
            capabilities: { tools: {} },
          }),
        );
        return true;
      }
      case 'ping': {
        sendRpc(res, 200, requestId, rpcResult(id, {}));
        return true;
      }
      case 'tools/list': {
        sendRpc(res, 200, requestId, rpcResult(id, { tools: TOOLS }));
        return true;
      }
      case 'tools/call': {
        const params = isRecord(body.params) ? (body.params as Record<string, unknown>) : {};
        try {
          const result = executeTool(store, identities, params);
          sendRpc(res, 200, requestId, rpcResult(id, result));
        } catch (err) {
          if (err instanceof RpcError) {
            sendRpc(res, 200, requestId, rpcError(id, err.code, err.message));
          } else if (err instanceof ToolError) {
            sendRpc(
              res,
              200,
              requestId,
              rpcResult(id, {
                content: [{ type: 'text', text: err.message }],
                isError: true,
              }),
            );
          } else {
            sendRpc(
              res,
              200,
              requestId,
              rpcResult(id, {
                content: [
                  { type: 'text', text: err instanceof Error ? err.message : 'Internal error' },
                ],
                isError: true,
              }),
            );
          }
        }
        return true;
      }
      default: {
        sendRpc(res, 200, requestId, rpcError(id, -32601, `Method not found: ${method}`));
        return true;
      }
    }
  } catch (err) {
    // Never answer 500 for a JSON-RPC request: the client judges the
    // JSON-RPC error, and a 500 fails checks outright (unknown-tool).
    if (!res.writableEnded) {
      sendRpc(
        res,
        200,
        requestId,
        rpcError(id, -32603, err instanceof Error ? err.message : 'Internal error'),
      );
    }
    return true;
  }
}
