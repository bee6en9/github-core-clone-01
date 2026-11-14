// The HTTP server: routing, JSON plumbing, auth and the M1 route set.
// Every response — success or error — is JSON with `application/json` and a
// non-empty `X-GitHub-Request-Id`. Auth is one bearer token = the scenario
// viewer: any non-empty `Authorization: Bearer <token>` authenticates as the
// viewer derived at boot; no (or an empty) token is a 401.
//
// M1 routes: GET /healthz, GET /api/v3/ (root), GET /api/v3/meta,
// POST /api/v3/user/repos, GET /api/v3/user/repos (paginated),
// GET /api/v3/repos/:owner/:name, GET /api/v3/repos/:owner/:name/issues.
// M2: git smart HTTP (`/{owner}/{repo}.git/...`) via git.ts, dispatched
// before the REST routes. M3: repos PATCH/DELETE, branches, commits,
// git/refs, contents (PUT/GET/DELETE), labels, issues (+comments), pulls
// (+files, merge). Everything else is a JSON 404. M4: GraphQL v4
// (`POST /api/graphql`). M5: MCP (`POST /mcp`) via mcp.ts, dispatched
// before the REST routes.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  commitFile,
  commitTree,
  ConflictError,
  deleteFile,
  diffTrees,
  listCommits,
  lookupPath,
  NotFoundError,
  resolveCommit,
  squashMerge,
  StaleShaError,
} from './content.ts';
import { handleGit } from './git.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { buildIdentities, type ScenarioIdentities } from './scenario.ts';
import { Store, type Issue, type Pull, type Repo } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
/** The largest request body accepted (16 MiB); larger is a 413. */
const MAX_BODY_BYTES = 16 * 1024 * 1024;
/** The API root answers without a token, like api.github.com. */
const ROOT_BODY = { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' };

class JsonParseError extends Error {}
class BodyTooLargeError extends Error {}

interface RequestContext {
  store: Store;
  identities: ScenarioIdentities;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  requestId: string;
  req: IncomingMessage;
}

type Handler = (ctx: RequestContext, res: ServerResponse) => void | Promise<void>;

interface Route {
  method: string;
  segments: string[];
  auth: boolean;
  handler: Handler;
}

/** Answer one request with a JSON body; the request-id header is always set. */
function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  requestId: string,
  extraHeaders: Readonly<Record<string, string>> = {},
): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId,
    ...extraHeaders,
  });
  res.end(text);
}

/** The standard error body: `{message: string non-empty}`. */
function sendError(res: ServerResponse, status: number, message: string, requestId: string): void {
  sendJson(res, status, { message }, requestId);
}

/** The path segments of a request URL, decoded, or null when it does not parse. */
function pathSegments(req: IncomingMessage): string[] | null {
  try {
    const url = new URL(req.url ?? '/', 'http://entry');
    const trimmed = url.pathname.replace(/\/+$/, '');
    const path = trimmed === '' ? '/' : trimmed;
    return path
      .split('/')
      .filter((part) => part !== '')
      .map((part) => decodeURIComponent(part));
  } catch {
    return null;
  }
}

/** Match route segments against path segments; `:name` captures one segment, a trailing `*name` captures the rest joined by '/'. */
function matchSegments(route: string[], path: string[]): Record<string, string> | null {
  const params: Record<string, string> = {};
  for (let i = 0; i < route.length; i += 1) {
    const want = route[i] as string;
    if (want.startsWith('*')) {
      params[want.slice(1)] = path.slice(i).join('/');
      return params;
    }
    if (i >= path.length) return null;
    const got = path[i] as string;
    if (want.startsWith(':')) {
      params[want.slice(1)] = got;
    } else if (want !== got) {
      return null;
    }
  }
  if (path.length !== route.length) return null;
  return params;
}

function queryInt(query: URLSearchParams, name: string, fallback: number): number {
  const raw = query.get(name);
  if (raw === null) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
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

/** Read the whole request body as bytes (for git smart HTTP, where packs are binary). */
function readRawBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
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
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', (err: Error) => reject(err));
  });
}

/** Parse a request body as JSON; empty means no body (undefined). */
function parseJsonBody(text: string): unknown {
  if (text.trim() === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new JsonParseError('Problems parsing JSON');
  }
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

/** The public shape of a repository (extra fields are allowed by the suite). */
function repoJson(repo: Repo): Record<string, unknown> {
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

/** The public shape of an issue (labels are objects with a name). */
function issueJson(issue: Issue): Record<string, unknown> {
  return {
    id: issue.number,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
  };
}

/** The public shape of a pull request (merge fields only once merged). */
function pullJson(pull: Pull): Record<string, unknown> {
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

/** A request body as an object, or null when it is not one. */
function bodyObject(body: unknown): Record<string, unknown> | null {
  return typeof body === 'object' && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null;
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const identities = buildIdentities();
  const store = new Store(identities.users);
  let requestCounter = 0;

  /** The repo for an owner/name pair, or null when the owner is not the viewer or the repo is missing. */
  function requireRepo(owner: string, name: string): Repo | null {
    if (owner !== identities.viewer.login) return null;
    return store.getRepo(owner, name) ?? null;
  }

  const routes: Route[] = [
    {
      method: 'GET',
      segments: ['healthz'],
      auth: false,
      handler: ({ requestId }, res) => sendJson(res, 200, { ok: true }, requestId),
    },
    {
      method: 'GET',
      segments: ['api', 'v3'],
      auth: false,
      handler: ({ requestId }, res) =>
        sendJson(res, 200, ROOT_BODY, requestId, { 'x-oauth-scopes': 'repo, read:org' }),
    },
    {
      method: 'POST',
      segments: ['api', 'graphql'],
      auth: true,
      handler: ({ store: st, identities: idn, body, requestId }, res) => {
        const result = executeGraphQL(st, idn, body);
        sendJson(res, result.status, result.body, requestId);
      },
    },
    {
      method: 'GET',
      segments: ['api', 'v3', 'meta'],
      auth: true,
      handler: ({ requestId }, res) => sendJson(res, 200, { installed_version: '1.0.0' }, requestId),
    },
    {
      method: 'POST',
      segments: ['api', 'v3', 'user', 'repos'],
      auth: true,
      handler: ({ store: st, identities: idn, body, requestId }, res) => {
        if (typeof body !== 'object' || body === null || Array.isArray(body)) {
          sendError(res, 422, 'Invalid request body', requestId);
          return;
        }
        const input = body as Record<string, unknown>;
        if (!isValidRepoName(input.name)) {
          sendError(res, 422, 'name is required', requestId);
          return;
        }
        const name = input.name as string;
        if (st.getRepo(idn.viewer.login, name) !== undefined) {
          sendError(res, 422, 'name already exists on this account', requestId);
          return;
        }
        const repo = st.createRepo(
          idn.viewer,
          name,
          input.private === true,
          typeof input.description === 'string' ? input.description : null,
        );
        sendJson(res, 201, repoJson(repo), requestId);
      },
    },
    {
      method: 'GET',
      segments: ['api', 'v3', 'user', 'repos'],
      auth: true,
      handler: ({ store: st, identities: idn, query, requestId, req }, res) => {
        const perPage = Math.min(100, Math.max(1, queryInt(query, 'per_page', 30)));
        const page = Math.max(1, queryInt(query, 'page', 1));
        const all = st.listReposByOwner(idn.viewer.login);
        const start = (page - 1) * perPage;
        const items = all.slice(start, start + perPage);
        const headers: Record<string, string> = {};
        const lastPage = Math.max(1, Math.ceil(all.length / perPage));
        if (page < lastPage) {
          const host = req.headers.host ?? '127.0.0.1';
          const base = `http://${host}/api/v3/user/repos?per_page=${perPage}`;
          headers.link = `<${base}&page=${page + 1}>; rel="next", <${base}&page=${lastPage}>; rel="last"`;
        }
        sendJson(res, 200, items.map((repo) => repoJson(repo)), requestId, headers);
      },
    },
    {
      method: 'GET',
      segments: ['api', 'v3', 'repos', ':owner', ':name'],
      auth: true,
      handler: ({ store: st, identities: idn, params, requestId }, res) => {
        const owner = params.owner as string;
        const name = params.name as string;
        if (owner !== idn.viewer.login) {
          sendError(res, 404, 'Not Found', requestId);
          return;
        }
        const repo = st.getRepo(owner, name);
        if (repo === undefined) {
          sendError(res, 404, 'Not Found', requestId);
          return;
        }
        sendJson(res, 200, repoJson(repo), requestId);
      },
    },
    {
      method: 'PATCH',
      segments: ['api', 'v3', 'repos', ':owner', ':name'],
      auth: true,
      handler: ({ params, body, requestId }, res) => {
        const repo = requireRepo(params.owner as string, params.name as string);
        if (repo === null) {
          sendError(res, 404, 'Not Found', requestId);
          return;
        }
        const input = bodyObject(body);
        if (input !== null && typeof input.description === 'string') {
          repo.description = input.description;
        }
        sendJson(res, 200, repoJson(repo), requestId);
      },
    },
    {
      method: 'DELETE',
      segments: ['api', 'v3', 'repos', ':owner', ':name'],
      auth: true,
      handler: ({ store: st, params, requestId }, res) => {
        const repo = requireRepo(params.owner as string, params.name as string);
        if (repo === null) {
          sendError(res, 404, 'Not Found', requestId);
          return;
        }
        st.deleteRepo(params.owner as string, params.name as string);
        res.writeHead(204, { 'x-github-request-id': requestId });
        res.end();
      },
    },
    {
      method: 'GET',
      segments: ['api', 'v3', 'repos', ':owner', ':name', 'branches'],
      auth: true,
      handler: ({ store: st, params, requestId }, res) => {
        const repo = requireRepo(params.owner as string, params.name as string);
        if (repo === null) {
          sendError(res, 404, 'Not Found', requestId);
          return;
        }
        const git = st.getGitRepo(params.owner as string, params.name as string);
        const branches = git
          .listRefs()
          .filter((ref) => ref.name.startsWith('refs/heads/'))
          .map((ref) => ({
            name: ref.name.slice('refs/heads/'.length),
            commit: { sha: ref.oid },
          }));
        sendJson(res, 200, branches, requestId);
      },
    },
    {
      method: 'GET',
      segments: ['api', 'v3', 'repos', ':owner', ':name', 'commits'],
      auth: true,
      handler: ({ store: st, params, query, requestId }, res) => {
        const repo = requireRepo(params.owner as string, params.name as string);
        if (repo === null) {
          sendError(res, 404, 'Not Found', requestId);
          return;
        }
        const git = st.getGitRepo(params.owner as string, params.name as string);
        const ref = query.get('sha') ?? repo.default_branch;
        const commits = listCommits(git, ref).map((commit) => ({
          sha: commit.sha,
          commit: { message: commit.message },
        }));
        sendJson(res, 200, commits, requestId);
      },
    },
    {
      method: 'POST',
      segments: ['api', 'v3', 'repos', ':owner', ':name', 'git', 'refs'],
      auth: true,
      handler: ({ store: st, params, body, requestId }, res) => {
        const repo = requireRepo(params.owner as string, params.name as string);
        if (repo === null) {
          sendError(res, 404, 'Not Found', requestId);
          return;
        }
        const input = bodyObject(body);
        if (input === null) {
          sendError(res, 422, 'Invalid request body', requestId);
          return;
        }
        const ref = input.ref;
        const sha = input.sha;
        if (
          typeof ref !== 'string' ||
          !ref.startsWith('refs/heads/') ||
          typeof sha !== 'string' ||
          !/^[0-9a-f]{40}$/i.test(sha)
        ) {
          sendError(res, 422, 'Invalid ref or sha', requestId);
          return;
        }
        const git = st.getGitRepo(params.owner as string, params.name as string);
        if (git.getObject(sha.toLowerCase()) === undefined) {
          sendError(res, 422, 'object not found', requestId);
          return;
        }
        git.setRef(ref, sha.toLowerCase());
        sendJson(res, 201, { ref, object: { sha: sha.toLowerCase() } }, requestId);
      },
    },
    {
      method: 'PUT',
      segments: ['api', 'v3', 'repos', ':owner', ':name', 'contents', '*path'],
      auth: true,
      handler: ({ store: st, params, body, requestId }, res) => {
        const repo = requireRepo(params.owner as string, params.name as string);
        if (repo === null) {
          sendError(res, 404, 'Not Found', requestId);
          return;
        }
        const path = params.path as string;
        const input = bodyObject(body);
        if (input === null || typeof input.message !== 'string' || typeof input.content !== 'string') {
          sendError(res, 422, 'message and content are required', requestId);
          return;
        }
        const branch = typeof input.branch === 'string' ? input.branch : repo.default_branch;
        const git = st.getGitRepo(params.owner as string, params.name as string);
        const content = Buffer.from(input.content, 'base64');
        try {
          const result = commitFile(
            git,
            st,
            branch,
            path,
            content,
            input.message,
            typeof input.sha === 'string' ? input.sha : undefined,
          );
          sendJson(
            res,
            result.updated ? 200 : 201,
            { content: { sha: result.contentSha, encoding: 'base64' }, commit: { sha: result.commitSha } },
            requestId,
          );
        } catch (err) {
          if (err instanceof StaleShaError) sendError(res, 409, err.message, requestId);
          else throw err;
        }
      },
    },
    {
      method: 'GET',
      segments: ['api', 'v3', 'repos', ':owner', ':name', 'contents', '*path'],
      auth: true,
      handler: ({ store: st, params, query, requestId }, res) => {
        const repo = requireRepo(params.owner as string, params.name as string);
        if (repo === null) {
          sendError(res, 404, 'Not Found', requestId);
          return;
        }
        const path = params.path as string;
        const git = st.getGitRepo(params.owner as string, params.name as string);
        const ref = query.get('ref') ?? repo.default_branch;
        const tip = resolveCommit(git, ref);
        if (tip === undefined) {
          sendError(res, 404, 'Not Found', requestId);
          return;
        }
        const tree = commitTree(git, tip);
        if (tree === undefined) {
          sendError(res, 404, 'Not Found', requestId);
          return;
        }
        const found = lookupPath(git, tree, path);
        if (found === undefined) {
          sendError(res, 404, 'Not Found', requestId);
          return;
        }
        if (found.kind === 'blob') {
          const obj = git.getObject(found.oid);
          if (obj === undefined) {
            sendError(res, 404, 'Not Found', requestId);
            return;
          }
          sendJson(
            res,
            200,
            {
              type: 'file',
              encoding: 'base64',
              content: obj.data.toString('base64'),
              sha: found.oid,
              size: obj.data.length,
              name: path.split('/').pop() ?? path,
              path,
            },
            requestId,
          );
          return;
        }
        const entries = found.entries.map((entry) => ({
          type: entry.mode === '40000' ? 'dir' : 'file',
          name: entry.name,
          path: path === '' ? entry.name : `${path}/${entry.name}`,
          sha: entry.oid,
        }));
        sendJson(res, 200, entries, requestId);
      },
    },
    {
      method: 'DELETE',
      segments: ['api', 'v3', 'repos', ':owner', ':name', 'contents', '*path'],
      auth: true,
      handler: ({ store: st, params, body, requestId }, res) => {
        const repo = requireRepo(params.owner as string, params.name as string);
        if (repo === null) {
          sendError(res, 404, 'Not Found', requestId);
          return;
        }
        const path = params.path as string;
        const input = bodyObject(body);
        if (input === null || typeof input.message !== 'string' || typeof input.sha !== 'string') {
          sendError(res, 422, 'message and sha are required', requestId);
          return;
        }
        const git = st.getGitRepo(params.owner as string, params.name as string);
        try {
          const result = deleteFile(git, st, repo.default_branch, path, input.message, input.sha);
          sendJson(res, 200, { commit: { sha: result.commitSha } }, requestId);
        } catch (err) {
          if (err instanceof NotFoundError) sendError(res, 404, err.message, requestId);
          else if (err instanceof StaleShaError) sendError(res, 409, err.message, requestId);
          else throw err;
        }
      },
    },
    {
      method: 'POST',
      segments: ['api', 'v3', 'repos', ':owner', ':name', 'labels'],
      auth: true,
      handler: ({ store: st, params, body, requestId }, res) => {
        const repo = requireRepo(params.owner as string, params.name as string);
        if (repo === null) {
          sendError(res, 404, 'Not Found', requestId);
          return;
        }
        const input = bodyObject(body);
        if (input === null || typeof input.name !== 'string' || input.name === '') {
          sendError(res, 422, 'name is required', requestId);
          return;
        }
        const label = st.createLabel(
          params.owner as string,
          params.name as string,
          input.name,
          typeof input.color === 'string' ? input.color : 'ededed',
        );
        sendJson(res, 201, { name: label.name, color: label.color }, requestId);
      },
    },
    {
      method: 'POST',
      segments: ['api', 'v3', 'repos', ':owner', ':name', 'issues'],
      auth: true,
      handler: ({ store: st, params, body, requestId }, res) => {
        const repo = requireRepo(params.owner as string, params.name as string);
        if (repo === null) {
          sendError(res, 404, 'Not Found', requestId);
          return;
        }
        const input = bodyObject(body);
        if (input === null || typeof input.title !== 'string') {
          sendError(res, 422, 'title is required', requestId);
          return;
        }
        const labels: string[] = [];
        if (input.labels !== undefined) {
          if (!Array.isArray(input.labels) || input.labels.some((label) => typeof label !== 'string')) {
            sendError(res, 422, 'labels must be an array of strings', requestId);
            return;
          }
          for (const label of input.labels as string[]) {
            if (st.getLabel(params.owner as string, params.name as string, label) === undefined) {
              sendError(res, 422, `label ${label} does not exist`, requestId);
              return;
            }
            labels.push(label);
          }
        }
        const issue = st.createIssue(
          params.owner as string,
          params.name as string,
          input.title,
          typeof input.body === 'string' ? input.body : '',
          labels,
        );
        sendJson(res, 201, issueJson(issue), requestId);
      },
    },
    {
      method: 'GET',
      segments: ['api', 'v3', 'repos', ':owner', ':name', 'issues'],
      auth: true,
      handler: ({ store: st, params, query, requestId }, res) => {
        const repo = requireRepo(params.owner as string, params.name as string);
        if (repo === null) {
          sendError(res, 404, 'Not Found', requestId);
          return;
        }
        const state = query.get('state') ?? 'open';
        let issues = st.listIssues(params.owner as string, params.name as string);
        if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
        else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
        const direction = query.get('direction') ?? 'desc';
        const sorted = [...issues].sort((a, b) =>
          direction === 'asc' ? a.seq - b.seq : b.seq - a.seq,
        );
        sendJson(res, 200, sorted.map((issue) => issueJson(issue)), requestId);
      },
    },
    {
      method: 'GET',
      segments: ['api', 'v3', 'repos', ':owner', ':name', 'issues', ':number'],
      auth: true,
      handler: ({ store: st, params, requestId }, res) => {
        const repo = requireRepo(params.owner as string, params.name as string);
        if (repo === null) {
          sendError(res, 404, 'Not Found', requestId);
          return;
        }
        const issue = st.getIssue(
          params.owner as string,
          params.name as string,
          Number.parseInt(params.number as string, 10),
        );
        if (issue === undefined) {
          sendError(res, 404, 'Not Found', requestId);
          return;
        }
        sendJson(res, 200, issueJson(issue), requestId);
      },
    },
    {
      method: 'PATCH',
      segments: ['api', 'v3', 'repos', ':owner', ':name', 'issues', ':number'],
      auth: true,
      handler: ({ store: st, params, body, requestId }, res) => {
        const repo = requireRepo(params.owner as string, params.name as string);
        if (repo === null) {
          sendError(res, 404, 'Not Found', requestId);
          return;
        }
        const issue = st.getIssue(
          params.owner as string,
          params.name as string,
          Number.parseInt(params.number as string, 10),
        );
        if (issue === undefined) {
          sendError(res, 404, 'Not Found', requestId);
          return;
        }
        const input = bodyObject(body);
        if (input !== null) {
          if (input.state === 'open' || input.state === 'closed') issue.state = input.state;
          if (typeof input.title === 'string') issue.title = input.title;
          if (typeof input.body === 'string') issue.body = input.body;
        }
        sendJson(res, 200, issueJson(issue), requestId);
      },
    },
    {
      method: 'POST',
      segments: ['api', 'v3', 'repos', ':owner', ':name', 'issues', ':number', 'comments'],
      auth: true,
      handler: ({ store: st, params, body, requestId }, res) => {
        const repo = requireRepo(params.owner as string, params.name as string);
        if (repo === null) {
          sendError(res, 404, 'Not Found', requestId);
          return;
        }
        const issue = st.getIssue(
          params.owner as string,
          params.name as string,
          Number.parseInt(params.number as string, 10),
        );
        if (issue === undefined) {
          sendError(res, 404, 'Not Found', requestId);
          return;
        }
        const input = bodyObject(body);
        if (input === null || typeof input.body !== 'string') {
          sendError(res, 422, 'body is required', requestId);
          return;
        }
        const comment = { id: repo.nextCommentId, body: input.body };
        repo.nextCommentId += 1;
        issue.comments.push(comment);
        sendJson(res, 201, comment, requestId);
      },
    },
    {
      method: 'GET',
      segments: ['api', 'v3', 'repos', ':owner', ':name', 'issues', ':number', 'comments'],
      auth: true,
      handler: ({ store: st, params, requestId }, res) => {
        const repo = requireRepo(params.owner as string, params.name as string);
        if (repo === null) {
          sendError(res, 404, 'Not Found', requestId);
          return;
        }
        const issue = st.getIssue(
          params.owner as string,
          params.name as string,
          Number.parseInt(params.number as string, 10),
        );
        if (issue === undefined) {
          sendError(res, 404, 'Not Found', requestId);
          return;
        }
        sendJson(res, 200, issue.comments, requestId);
      },
    },
    {
      method: 'POST',
      segments: ['api', 'v3', 'repos', ':owner', ':name', 'pulls'],
      auth: true,
      handler: ({ store: st, params, body, requestId }, res) => {
        const repo = requireRepo(params.owner as string, params.name as string);
        if (repo === null) {
          sendError(res, 404, 'Not Found', requestId);
          return;
        }
        const input = bodyObject(body);
        if (
          input === null ||
          typeof input.head !== 'string' ||
          typeof input.base !== 'string' ||
          typeof input.title !== 'string'
        ) {
          sendError(res, 422, 'head, base and title are required', requestId);
          return;
        }
        const git = st.getGitRepo(params.owner as string, params.name as string);
        const headTip = git.getRef(`refs/heads/${input.head}`);
        const baseTip = git.getRef(`refs/heads/${input.base}`);
        if (headTip === undefined || baseTip === undefined) {
          sendError(res, 422, 'head or base branch not found', requestId);
          return;
        }
        const headTree = commitTree(git, headTip);
        const baseTree = commitTree(git, baseTip);
        if (headTree === undefined || baseTree === undefined) {
          sendError(res, 422, 'head or base has no tree', requestId);
          return;
        }
        const files = diffTrees(git, baseTree, headTree);
        const pull = st.createPull(
          params.owner as string,
          params.name as string,
          input.title,
          typeof input.body === 'string' ? input.body : '',
          input.head,
          input.base,
          headTip,
          baseTip,
          files,
        );
        sendJson(res, 201, pullJson(pull), requestId);
      },
    },
    {
      method: 'GET',
      segments: ['api', 'v3', 'repos', ':owner', ':name', 'pulls'],
      auth: true,
      handler: ({ store: st, params, query, requestId }, res) => {
        const repo = requireRepo(params.owner as string, params.name as string);
        if (repo === null) {
          sendError(res, 404, 'Not Found', requestId);
          return;
        }
        const state = query.get('state') ?? 'open';
        let pulls = st.listPulls(params.owner as string, params.name as string);
        if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
        else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
        const sorted = [...pulls].sort((a, b) => b.seq - a.seq);
        sendJson(res, 200, sorted.map((pull) => pullJson(pull)), requestId);
      },
    },
    {
      method: 'GET',
      segments: ['api', 'v3', 'repos', ':owner', ':name', 'pulls', ':number'],
      auth: true,
      handler: ({ store: st, params, requestId }, res) => {
        const repo = requireRepo(params.owner as string, params.name as string);
        if (repo === null) {
          sendError(res, 404, 'Not Found', requestId);
          return;
        }
        const pull = st.getPull(
          params.owner as string,
          params.name as string,
          Number.parseInt(params.number as string, 10),
        );
        if (pull === undefined) {
          sendError(res, 404, 'Not Found', requestId);
          return;
        }
        sendJson(res, 200, pullJson(pull), requestId);
      },
    },
    {
      method: 'GET',
      segments: ['api', 'v3', 'repos', ':owner', ':name', 'pulls', ':number', 'files'],
      auth: true,
      handler: ({ store: st, params, requestId }, res) => {
        const repo = requireRepo(params.owner as string, params.name as string);
        if (repo === null) {
          sendError(res, 404, 'Not Found', requestId);
          return;
        }
        const pull = st.getPull(
          params.owner as string,
          params.name as string,
          Number.parseInt(params.number as string, 10),
        );
        if (pull === undefined) {
          sendError(res, 404, 'Not Found', requestId);
          return;
        }
        sendJson(res, 200, pull.files, requestId);
      },
    },
    {
      method: 'PUT',
      segments: ['api', 'v3', 'repos', ':owner', ':name', 'pulls', ':number', 'merge'],
      auth: true,
      handler: ({ store: st, params, requestId }, res) => {
        const repo = requireRepo(params.owner as string, params.name as string);
        if (repo === null) {
          sendError(res, 404, 'Not Found', requestId);
          return;
        }
        const pull = st.getPull(
          params.owner as string,
          params.name as string,
          Number.parseInt(params.number as string, 10),
        );
        if (pull === undefined) {
          sendError(res, 404, 'Not Found', requestId);
          return;
        }
        if (pull.merged || pull.state === 'closed') {
          sendError(res, 405, 'Pull request is already merged', requestId);
          return;
        }
        const git = st.getGitRepo(params.owner as string, params.name as string);
        try {
          const result = squashMerge(git, st, pull.base, pull.headSha, pull.title);
          pull.state = 'closed';
          pull.merged = true;
          pull.mergedAt = st.nowIso();
          pull.mergeCommitSha = result.commitSha;
          sendJson(
            res,
            200,
            { merged: true, sha: result.commitSha, message: `Merged pull request #${pull.number}` },
            requestId,
          );
        } catch (err) {
          if (err instanceof ConflictError) sendError(res, 405, err.message, requestId);
          else if (err instanceof NotFoundError) sendError(res, 404, err.message, requestId);
          else throw err;
        }
      },
    },
  ];

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      requestCounter += 1;
      const requestId = `req-${String(requestCounter).padStart(6, '0')}`;
      try {
        const segments = pathSegments(req);
        const method = req.method ?? 'GET';
        if (segments === null) {
          sendError(res, 404, 'Not Found', requestId);
          return;
        }
        // Git smart HTTP (`/{owner}/{repo}.git/info/refs`, `git-upload-pack`,
        // `git-receive-pack`) is served before the REST routes: it has its
        // own binary framing and needs no bearer token.
        if (segments.length >= 3 && (segments[1] as string).endsWith('.git')) {
          const owner = segments[0] as string;
          const repoName = (segments[1] as string).slice(0, -'.git'.length);
          const tail = segments.slice(2);
          const query = new URL(req.url ?? '/', 'http://entry').searchParams;
          const rawBody = method === 'POST' ? await readRawBody(req) : Buffer.alloc(0);
          const handled = await handleGit(
            store,
            owner,
            repoName,
            tail,
            query,
            method,
            req.headers,
            rawBody,
            res,
            requestId,
          );
          if (handled) return;
        }
        // MCP (`POST /mcp`): JSON-RPC 2.0 over Streamable HTTP. It needs its
        // own body handling (a malformed body is HTTP 400 + JSON-RPC -32700,
        // not the generic REST 400, and auth is decided before any tool
        // lookup), so it is dispatched before the REST routes, like git.
        if (segments.length === 1 && segments[0] === 'mcp') {
          const handled = await handleMcp(store, identities, req, res, requestId);
          if (handled) return;
        }
        let matched: { route: Route; params: Record<string, string> } | null = null;
        for (const route of routes) {
          if (route.method !== method) continue;
          const params = matchSegments(route.segments, segments);
          if (params !== null) {
            matched = { route, params };
            break;
          }
        }
        if (matched === null) {
          sendError(res, 404, 'Not Found', requestId);
          return;
        }
        const { route } = matched;
        if (route.auth && bearerToken(req) === null) {
          sendError(res, 401, 'Requires authentication', requestId);
          return;
        }
        let body: unknown;
        if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
          const text = await readBody(req);
          body = parseJsonBody(text);
        }
        const query = new URL(req.url ?? '/', 'http://entry').searchParams;
        const ctx: RequestContext = {
          store,
          identities,
          params: matched.params,
          query,
          body,
          requestId,
          req,
        };
        // Handlers receive (ctx, res): keep the response beside the context.
        await route.handler(ctx, res);
      } catch (err) {
        if (res.writableEnded) return;
        if (err instanceof JsonParseError) {
          sendError(res, 400, err.message, requestId);
        } else if (err instanceof BodyTooLargeError) {
          sendError(res, 413, err.message, requestId);
        } else {
          sendError(res, 500, err instanceof Error ? err.message : 'Internal Server Error', requestId);
        }
      }
    })();
  });
}
