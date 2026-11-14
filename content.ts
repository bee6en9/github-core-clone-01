// Contents, commits and merges on top of the git object store (git.ts).
//
// Every contents/merge operation is a real git operation: files are blobs,
// directories are trees, and each change is a commit whose parent is the
// branch tip. The suite reads the same state back through both the REST
// API and the git smart-HTTP clone, so the two surfaces must agree exactly.
//
// Determinism: commit author/committer timestamps come from the store's
// logical clock, never from Date.now().

import { GitRepo, ZERO_OID, parseCommit, parseTree, type TreeEntry } from './git.ts';
import type { PullFile, Store } from './store.ts';

export class NotFoundError extends Error {}
export class StaleShaError extends Error {}
export class ConflictError extends Error {}

const AUTHOR_NAME = 'github-core-clone';
const AUTHOR_EMAIL = 'forge@example.invalid';

/** A file or directory found while walking a tree. */
export interface TreeLookup {
  kind: 'blob' | 'tree';
  oid: string;
  /** Entries when kind is 'tree'. */
  entries: TreeEntry[];
}

/** Resolve a ref name or raw oid to a commit oid, or undefined when unknown. */
export function resolveCommit(git: GitRepo, ref: string): string | undefined {
  const asRef = git.getRef(`refs/heads/${ref}`);
  if (asRef !== undefined) return asRef;
  const fullRef = git.getRef(ref);
  if (fullRef !== undefined) return fullRef;
  if (/^[0-9a-f]{40}$/.test(ref)) {
    const obj = git.getObject(ref);
    if (obj?.type === 'commit') return ref;
  }
  return undefined;
}

/** The tree oid of a commit, or undefined when the commit is unknown. */
export function commitTree(git: GitRepo, commitOid: string): string | undefined {
  const obj = git.getObject(commitOid);
  if (obj?.type !== 'commit') return undefined;
  const tree = parseCommit(obj.data).tree;
  return tree === '' ? undefined : tree;
}

/** Walk a tree by path segments; undefined when any segment is missing. */
export function lookupPath(git: GitRepo, treeOid: string, path: string): TreeLookup | undefined {
  const segments = path.split('/').filter((part) => part !== '');
  let currentOid = treeOid;
  for (let i = 0; i < segments.length; i += 1) {
    const obj = git.getObject(currentOid);
    if (obj?.type !== 'tree') return undefined;
    const entries = parseTree(obj.data);
    const entry = entries.find((item) => item.name === segments[i]);
    if (entry === undefined) return undefined;
    const isLast = i === segments.length - 1;
    if (isLast) {
      if (entry.mode === '40000') {
        const child = git.getObject(entry.oid);
        if (child?.type !== 'tree') return undefined;
        return { kind: 'tree', oid: entry.oid, entries: parseTree(child.data) };
      }
      return { kind: 'blob', oid: entry.oid, entries: [] };
    }
    if (entry.mode !== '40000') return undefined;
    currentOid = entry.oid;
  }
  // Empty path = the root tree itself.
  const root = git.getObject(currentOid);
  if (root?.type !== 'tree') return undefined;
  return { kind: 'tree', oid: currentOid, entries: parseTree(root.data) };
}

/** Flatten a tree into path -> {oid, mode} (files only; gitlinks skipped). */
export function flattenTree(git: GitRepo, treeOid: string): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const walk = (oid: string, prefix: string): void => {
    const obj = git.getObject(oid);
    if (obj?.type !== 'tree') return;
    for (const entry of parseTree(obj.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') {
        walk(entry.oid, path);
      } else if (entry.mode === '160000') {
        continue;
      } else {
        out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    }
  };
  walk(treeOid, '');
  return out;
}

/** Serialize one tree level; entries sort git-style (directories as name + '/'). */
function serializeTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = a.mode === '40000' ? `${a.name}/` : a.name;
    const kb = b.mode === '40000' ? `${b.name}/` : b.name;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Build nested trees bottom-up from a flat path map; returns the root tree oid. */
export function buildTree(git: GitRepo, flat: Map<string, { oid: string; mode: string }>): string {
  // Group paths by their first segment at each level, recursively.
  const buildLevel = (paths: Array<{ segments: string[]; oid: string; mode: string }>): string => {
    const files: TreeEntry[] = [];
    const dirs = new Map<string, Array<{ segments: string[]; oid: string; mode: string }>>();
    for (const item of paths) {
      if (item.segments.length === 1) {
        files.push({ mode: item.mode, name: item.segments[0] as string, oid: item.oid });
      } else {
        const head = item.segments[0] as string;
        const rest = dirs.get(head) ?? [];
        rest.push({ segments: item.segments.slice(1), oid: item.oid, mode: item.mode });
        dirs.set(head, rest);
      }
    }
    const entries: TreeEntry[] = [...files];
    for (const [name, children] of dirs) {
      entries.push({ mode: '40000', name, oid: buildLevel(children) });
    }
    return git.putObject('tree', serializeTree(entries));
  };
  const items = [...flat.entries()].map(([path, value]) => ({
    segments: path.split('/').filter((part) => part !== ''),
    oid: value.oid,
    mode: value.mode,
  }));
  if (items.length === 0) return git.putObject('tree', Buffer.alloc(0));
  return buildLevel(items);
}

/** Create a commit object; returns its oid. The message is stored verbatim. */
export function createCommit(
  git: GitRepo,
  treeOid: string,
  parents: string[],
  message: string,
  nowSec: number,
): string {
  const lines: string[] = [`tree ${treeOid}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  lines.push(`author ${AUTHOR_NAME} <${AUTHOR_EMAIL}> ${nowSec} +0000`);
  lines.push(`committer ${AUTHOR_NAME} <${AUTHOR_EMAIL}> ${nowSec} +0000`);
  lines.push('');
  lines.push(message);
  return git.putObject('commit', Buffer.from(`${lines.join('\n')}\n`, 'utf8'));
}

/** The message of a commit object, without its trailing newline. */
export function commitMessage(git: GitRepo, commitOid: string): string {
  const obj = git.getObject(commitOid);
  if (obj?.type !== 'commit') return '';
  const text = obj.data.toString('utf8');
  const blank = text.indexOf('\n\n');
  if (blank < 0) return '';
  return text.slice(blank + 2).replace(/\n$/, '');
}

/** Commits reachable from a ref tip, newest first (parent walk, no topo sort needed: linear + merges). */
export function listCommits(git: GitRepo, ref: string): Array<{ sha: string; message: string }> {
  const tip = resolveCommit(git, ref);
  if (tip === undefined) return [];
  const out: Array<{ sha: string; message: string }> = [];
  const seen = new Set<string>();
  const queue: string[] = [tip];
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = git.getObject(oid);
    if (obj?.type !== 'commit') continue;
    out.push({ sha: oid, message: commitMessage(git, oid) });
    const commit = parseCommit(obj.data);
    for (const parent of commit.parents) queue.push(parent);
  }
  return out;
}

export interface CommitFileResult {
  contentSha: string;
  commitSha: string;
  /** True when the path already had a blob (an update, not a first create). */
  updated: boolean;
}

/**
 * Write one file on a branch: blob + new tree + new commit + move the ref.
 * `expectedSha` (when given) must equal the blob currently at the path, or
 * the write is refused as stale. A repo with no commits yet accepts the
 * first write on its default branch.
 */
export function commitFile(
  git: GitRepo,
  store: Store,
  branch: string,
  path: string,
  content: Buffer,
  message: string,
  expectedSha?: string,
): CommitFileResult {
  const refName = `refs/heads/${branch}`;
  const tip = git.getRef(refName);
  const currentTree = tip !== undefined ? commitTree(git, tip) : undefined;
  const flat = currentTree !== undefined ? flattenTree(git, currentTree) : new Map();
  const current = flat.get(path);
  if (expectedSha !== undefined) {
    if (current === undefined || current.oid.toLowerCase() !== expectedSha.toLowerCase()) {
      throw new StaleShaError(`sha ${expectedSha} does not match the current blob at ${path}`);
    }
  }
  const blobOid = git.putObject('blob', content);
  flat.set(path, { oid: blobOid, mode: '100644' });
  const treeOid = buildTree(git, flat);
  const parents = tip !== undefined && tip !== ZERO_OID ? [tip] : [];
  const commitOid = createCommit(git, treeOid, parents, message, store.nowSec());
  git.setRef(refName, commitOid);
  return { contentSha: blobOid, commitSha: commitOid, updated: current !== undefined };
}

export interface DeleteFileResult {
  commitSha: string;
}

/** Delete one file on a branch: new tree + new commit + move the ref. */
export function deleteFile(
  git: GitRepo,
  store: Store,
  branch: string,
  path: string,
  message: string,
  expectedSha?: string,
): DeleteFileResult {
  const refName = `refs/heads/${branch}`;
  const tip = git.getRef(refName);
  if (tip === undefined) throw new NotFoundError(`branch ${branch} has no commits`);
  const tree = commitTree(git, tip);
  if (tree === undefined) throw new NotFoundError(`branch ${branch} has no tree`);
  const flat = flattenTree(git, tree);
  const current = flat.get(path);
  if (current === undefined) throw new NotFoundError(`no file at ${path}`);
  if (expectedSha !== undefined && current.oid.toLowerCase() !== expectedSha.toLowerCase()) {
    throw new StaleShaError(`sha ${expectedSha} does not match the current blob at ${path}`);
  }
  flat.delete(path);
  const treeOid = buildTree(git, flat);
  const commitOid = createCommit(git, treeOid, [tip], message, store.nowSec());
  git.setRef(refName, commitOid);
  return { commitSha: commitOid };
}

// ---------------------------------------------------------------------------------------------
// Line diff (for pull-request file stats)
// ---------------------------------------------------------------------------------------------

function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Additions/deletions between two texts, by longest-common-subsequence on lines. */
export function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  if (a.length === 0) return { additions: b.length, deletions: 0 };
  if (b.length === 0) return { additions: 0, deletions: a.length };
  // Classic DP LCS; fixture files are tiny, so the O(n*m) table is fine.
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dp = new Uint32Array(rows * cols);
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      dp[i * cols + j] =
        a[i - 1] === b[j - 1]
          ? (dp[(i - 1) * cols + (j - 1)] as number) + 1
          : Math.max(dp[(i - 1) * cols + j] as number, dp[i * cols + (j - 1)] as number);
    }
  }
  const lcs = dp[a.length * cols + b.length] as number;
  return { additions: b.length - lcs, deletions: a.length - lcs };
}

/** Compare two trees; returns one PullFile per changed path, sorted by filename. */
export function diffTrees(git: GitRepo, baseTreeOid: string, headTreeOid: string): PullFile[] {
  const base = flattenTree(git, baseTreeOid);
  const head = flattenTree(git, headTreeOid);
  const paths = new Set([...base.keys(), ...head.keys()]);
  const files: PullFile[] = [];
  for (const path of paths) {
    const b = base.get(path);
    const h = head.get(path);
    if (b !== undefined && h !== undefined && b.oid === h.oid) continue;
    const oldText =
      b === undefined ? '' : (git.getObject(b.oid)?.data.toString('utf8') ?? '');
    const newText =
      h === undefined ? '' : (git.getObject(h.oid)?.data.toString('utf8') ?? '');
    const { additions, deletions } = lineDiff(oldText, newText);
    const status = b === undefined ? 'added' : h === undefined ? 'removed' : 'modified';
    files.push({
      filename: path,
      status,
      additions,
      deletions,
      changes: additions + deletions,
    });
  }
  files.sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0));
  return files;
}

// ---------------------------------------------------------------------------------------------
// Three-way merge (squash)
// ---------------------------------------------------------------------------------------------

export interface MergeResult {
  commitSha: string;
  treeOid: string;
}

/** The merge-base of two commits: first common ancestor found walking from `a`. */
export function mergeBase(git: GitRepo, a: string, b: string): string | undefined {
  const ancestorsB = new Set<string>();
  const stackB = [b];
  while (stackB.length > 0) {
    const oid = stackB.pop() as string;
    if (ancestorsB.has(oid)) continue;
    ancestorsB.add(oid);
    const obj = git.getObject(oid);
    if (obj?.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) stackB.push(parent);
  }
  const stackA = [a];
  const seenA = new Set<string>();
  while (stackA.length > 0) {
    const oid = stackA.pop() as string;
    if (seenA.has(oid)) continue;
    seenA.add(oid);
    if (ancestorsB.has(oid)) return oid;
    const obj = git.getObject(oid);
    if (obj?.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) stackA.push(parent);
  }
  return undefined;
}

/**
 * Squash-merge a head commit onto a base branch: three-way merge of
 * base-tree / current-base-tip-tree / head-tree, one new commit on the base
 * branch. Throws ConflictError when both sides changed the same path
 * differently. Returns the new merge commit's oid and tree.
 */
export function squashMerge(
  git: GitRepo,
  store: Store,
  baseBranch: string,
  headCommit: string,
  message: string,
): MergeResult {
  const baseRef = `refs/heads/${baseBranch}`;
  const baseTip = git.getRef(baseRef);
  if (baseTip === undefined) throw new NotFoundError(`base branch ${baseBranch} has no commits`);
  const base = mergeBase(git, headCommit, baseTip) ?? baseTip;
  const baseTree = commitTree(git, base);
  const oursTree = commitTree(git, baseTip);
  const theirsTree = commitTree(git, headCommit);
  if (baseTree === undefined || oursTree === undefined || theirsTree === undefined) {
    throw new NotFoundError('merge needs a tree on every side');
  }
  const baseFlat = flattenTree(git, baseTree);
  const oursFlat = flattenTree(git, oursTree);
  const theirsFlat = flattenTree(git, theirsTree);
  const merged = new Map<string, { oid: string; mode: string }>();
  const paths = new Set([...baseFlat.keys(), ...oursFlat.keys(), ...theirsFlat.keys()]);
  for (const path of paths) {
    const b = baseFlat.get(path);
    const o = oursFlat.get(path);
    const t = theirsFlat.get(path);
    const same = (x: { oid: string; mode: string } | undefined, y: { oid: string; mode: string } | undefined): boolean =>
      (x === undefined && y === undefined) || (x !== undefined && y !== undefined && x.oid === y.oid);
    if (same(o, t)) {
      if (o !== undefined) merged.set(path, o);
    } else if (same(t, b)) {
      if (o !== undefined) merged.set(path, o);
    } else if (same(o, b)) {
      if (t !== undefined) merged.set(path, t);
    } else {
      throw new ConflictError(`merge conflict at ${path}`);
    }
  }
  const treeOid = buildTree(git, merged);
  const commitOid = createCommit(git, treeOid, [baseTip], message, store.nowSec());
  git.setRef(baseRef, commitOid);
  return { commitSha: commitOid, treeOid };
}
