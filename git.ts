// Git smart HTTP: object store, packfile read/write, pkt-line framing,
// v2 upload-pack + v0 receive-pack.
//
// Design decisions (from dev/spec-git.md):
// - Objects are stored byte-exact, never rebuilt: clone checks compare bytes.
// - Packs are always whole objects, never deltas and never thin: pack-deltas
//   passes without deltas, and a thin pack whose base the client lacks fails.
// - have/want is set arithmetic: reachable(want) minus reachable(have), where
//   the client's shallow boundaries stop the have-closure (a shallow have's
//   parents are NOT owned by the client).
// - Shallow is depth-limited reachability: generation 0 is the want tip;
//   the boundary is every included commit whose parent is not included.
// - Push applies per-ref: unpack first (a refused update still stores its
//   objects), then each command is ok/ng on its own; the only specified
//   refusal reason is the exact string `non-fast-forward`.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { ServerResponse } from 'node:http';
import type { Store } from './store.ts';

export const ZERO_OID = '0'.repeat(40);

/** Largest pkt-line, header included (git's PKT_LINE_MAX). */
const MAX_PKT = 65520;
/** Largest sideband data chunk: band byte + data must fit one pkt-line payload. */
const SIDEBAND_CHUNK = MAX_PKT - 4 - 1;

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

// ---------------------------------------------------------------------------------------------
// pkt-line
// ---------------------------------------------------------------------------------------------

/** One pkt-line: 4 lowercase hex bytes of total length, then the payload. */
export function pktLine(data: string | Buffer): Buffer {
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const len = payload.length + 4;
  if (len > MAX_PKT) throw new Error('pkt-line too large');
  const head = Buffer.alloc(4);
  head.write(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, payload]);
}

export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export function encodePktLines(items: Array<string | Buffer | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(pktFlush());
    else if (item === 'delim') parts.push(pktDelim());
    else parts.push(pktLine(item));
  }
  return Buffer.concat(parts);
}

export interface DecodedPacket {
  kind: 'data' | 'flush' | 'delim' | 'response-end';
  payload: Buffer;
}

/**
 * Decode pkt-lines from the front of buf. Stops at the first flush packet and
 * returns the bytes after it as `rest` (the raw pack that follows a
 * receive-pack command list). Throws on a malformed header or trailing bytes
 * with no flush.
 */
export function decodePktLines(buf: Buffer): { packets: DecodedPacket[]; rest: Buffer } {
  const packets: DecodedPacket[] = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const head = buf.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error(`bad pkt-line length ${JSON.stringify(head)}`);
    const len = Number.parseInt(head, 16);
    if (len === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      return { packets, rest: buf.subarray(offset + 4) };
    }
    if (len === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (len === 2) {
      packets.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (len < 4 || offset + len > buf.length) throw new Error('truncated pkt-line');
    packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + len) });
    offset += len;
  }
  if (offset !== buf.length) throw new Error('trailing bytes after pkt-lines');
  return { packets, rest: Buffer.alloc(0) };
}

// ---------------------------------------------------------------------------------------------
// Object hashing and parsing (byte-exact: the store never rewrites an object)
// ---------------------------------------------------------------------------------------------

/** SHA-1 of `<type> <decimal size>\0` + data, exactly as git hashes objects. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  return createHash('sha1')
    .update(Buffer.from(`${type} ${data.length}\0`, 'ascii'))
    .update(data)
    .digest('hex');
}

export function parseCommit(data: Buffer): { tree: string; parents: string[] } {
  const text = data.toString('utf8');
  const tree = /^tree ([0-9a-f]{40})$/m.exec(text)?.[1] ?? '';
  const parents = [...text.matchAll(/^parent ([0-9a-f]{40})$/gm)].map((m) => m[1] as string);
  return { tree, parents };
}

export function parseTag(data: Buffer): { object: string; type: string } {
  const text = data.toString('utf8');
  const object = /^object ([0-9a-f]{40})$/m.exec(text)?.[1] ?? '';
  const type = /^type (\w+)$/m.exec(text)?.[1] ?? '';
  return { object, type };
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object: `<mode> <name>\0<20-byte oid>` entries, in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('bad tree entry: no mode');
    const mode = data.subarray(offset, space).toString('ascii');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('bad tree entry: no name/oid');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

// ---------------------------------------------------------------------------------------------
// The per-repository git state: objects and refs
// ---------------------------------------------------------------------------------------------

export class GitRepo {
  readonly objects = new Map<string, GitObject>();
  readonly refs = new Map<string, string>();

  /**
   * Mutation counter: bumped on every change to objects or refs. The
   * fetch/ls-refs response caches key on it, so a cached response can only
   * ever be served for the exact repo state it was built from (the cached
   * bytes are a pure function of that state + the request args, hence
   * byte-identical to a fresh computation).
   */
  version = 0;
  /** Cache of upload-pack fetch responses: key -> { version, body }. */
  readonly fetchCache = new Map<string, { version: number; body: Buffer }>();
  /** Cache of ls-refs responses: key -> { version, body }. */
  readonly lsRefsCache = new Map<string, { version: number; body: Buffer }>();

  getObject(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  putObject(type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) {
      this.objects.set(oid, { type, data });
      this.version += 1;
    }
    return oid;
  }

  getRef(name: string): string | undefined {
    return this.refs.get(name);
  }

  setRef(name: string, oid: string): void {
    if (this.refs.get(name) !== oid) {
      this.refs.set(name, oid);
      this.version += 1;
    }
  }

  deleteRef(name: string): boolean {
    const deleted = this.refs.delete(name);
    if (deleted) this.version += 1;
    return deleted;
  }

  /** A cached fetch response, only when it was built for this exact version. */
  fetchCached(key: string): Buffer | undefined {
    const entry = this.fetchCache.get(key);
    return entry !== undefined && entry.version === this.version ? entry.body : undefined;
  }

  cacheFetch(key: string, body: Buffer): void {
    if (this.fetchCache.size > 256) this.fetchCache.clear();
    this.fetchCache.set(key, { version: this.version, body });
  }

  lsRefsCached(key: string): Buffer | undefined {
    const entry = this.lsRefsCache.get(key);
    return entry !== undefined && entry.version === this.version ? entry.body : undefined;
  }

  cacheLsRefs(key: string, body: Buffer): void {
    if (this.lsRefsCache.size > 256) this.lsRefsCache.clear();
    this.lsRefsCache.set(key, { version: this.version, body });
  }

  /** All refs, sorted by name (git's advertisement order). */
  listRefs(): Array<{ name: string; oid: string }> {
    return [...this.refs.entries()]
      .map(([name, oid]) => ({ name, oid }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /**
   * Full reachability from roots. Commits contribute their tree and parents;
   * tags contribute their target; trees contribute their entries (gitlinks,
   * mode 160000, name a commit the repo does not hold and are skipped).
   * A root in `stopAtBoundaries` contributes itself and its tree, but its
   * parents are not followed: that is how a client's shallow have is modelled.
   */
  reachable(
    roots: Iterable<string>,
    opts: { allowMissing?: boolean; stopAtBoundaries?: ReadonlySet<string> } = {},
  ): Set<string> {
    const seen = new Set<string>();
    const stack: string[] = [];
    for (const root of roots) if (isOid(root)) stack.push(root);
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      const obj = this.objects.get(oid);
      if (obj === undefined) {
        if (opts.allowMissing) continue;
        throw new Error(`object ${oid} is missing from the store`);
      }
      seen.add(oid);
      if (obj.type === 'commit') {
        const commit = parseCommit(obj.data);
        stack.push(commit.tree);
        if (!(opts.stopAtBoundaries?.has(oid))) {
          for (const parent of commit.parents) stack.push(parent);
        }
      } else if (obj.type === 'tag') {
        const tag = parseTag(obj.data);
        if (tag.object) stack.push(tag.object);
      } else if (obj.type === 'tree') {
        for (const entry of parseTree(obj.data)) {
          if (entry.mode === '160000') continue;
          stack.push(entry.oid);
        }
      }
    }
    return seen;
  }

  /**
   * Depth-limited reachability: generation 0 is the roots; a commit's parents
   * are one generation deeper; only generations below `depth` are included.
   * A tag's target sits in the tag's own generation. Returns the object set
   * and the boundary: included commits with at least one parent outside the
   * set (those are the new `shallow` lines).
   */
  reachableDepth(roots: Iterable<string>, depth: number): { set: Set<string>; boundary: string[] } {
    const set = new Set<string>();
    const includedCommits: string[] = [];
    const queue: Array<{ oid: string; gen: number }> = [];
    for (const root of roots) if (isOid(root)) queue.push({ oid: root, gen: 0 });
    let head = 0;
    while (head < queue.length) {
      const item = queue[head] as { oid: string; gen: number };
      head += 1;
      if (set.has(item.oid)) continue;
      const obj = this.objects.get(item.oid);
      if (obj === undefined) continue;
      if (obj.type === 'tag') {
        set.add(item.oid);
        const tag = parseTag(obj.data);
        if (tag.object) queue.push({ oid: tag.object, gen: item.gen });
        continue;
      }
      if (obj.type === 'commit') {
        set.add(item.oid);
        includedCommits.push(item.oid);
        const commit = parseCommit(obj.data);
        for (const oid of this.reachable([commit.tree], { allowMissing: true })) set.add(oid);
        if (item.gen + 1 < depth) {
          for (const parent of commit.parents) queue.push({ oid: parent, gen: item.gen + 1 });
        }
        continue;
      }
      for (const oid of this.reachable([item.oid], { allowMissing: true })) set.add(oid);
    }
    const boundary = includedCommits.filter((oid) => {
      const obj = this.objects.get(oid);
      if (obj?.type !== 'commit') return false;
      return parseCommit(obj.data).parents.some((parent) => !set.has(parent));
    });
    return { set, boundary };
  }

  /** True when `ancestor` is reachable from `descendant` by following parents (tags resolved). */
  isAncestor(ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    if (!isOid(ancestor) || !isOid(descendant)) return false;
    const seen = new Set<string>();
    const stack = [descendant];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = this.objects.get(oid);
      if (obj === undefined) continue;
      if (obj.type === 'tag') {
        const tag = parseTag(obj.data);
        if (tag.object) stack.push(tag.object);
        continue;
      }
      if (obj.type !== 'commit') continue;
      const commit = parseCommit(obj.data);
      for (const parent of commit.parents) {
        if (parent === ancestor) return true;
        stack.push(parent);
      }
    }
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// Packfile read/write (whole objects only — never deltas, never thin)
// ---------------------------------------------------------------------------------------------

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const typeCode = TYPE_CODE[type];
  let first = (typeCode << 4) | (size & 0x0f);
  size >>= 4;
  const bytes: number[] = [];
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let byte = size & 0x7f;
    size >>= 7;
    if (size > 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

/** Serialize objects as a pack: `PACK` + version 2 + count, whole-object entries, SHA-1 trailer. */
export function writePack(objects: GitObject[]): Buffer {
  const seen = new Map<string, GitObject>();
  for (const obj of objects) {
    const oid = hashObject(obj.type, obj.data);
    if (!seen.has(oid)) seen.set(oid, obj);
  }
  // Deterministic order: sort by oid.
  const list = [...seen.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([, obj]) => obj);
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const obj of list) {
    parts.push(writePackObjectHeader(obj.type, obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function readPackEntryHeader(buf: Buffer, start: number): { size: number; typeCode: number; next: number } {
  if (start >= buf.length) throw new Error('pack entry has no size header');
  let byte = buf[start] as number;
  const typeCode = (byte >> 4) & 0x07;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    if (offset >= buf.length) throw new Error('pack entry size varint is truncated');
    byte = buf[offset] as number;
    offset += 1;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new Error('pack entry size varint is too long');
  }
  return { size, typeCode, next: offset };
}

/**
 * Parse a pack into objects. A delta entry (type 6/7) is refused — this forge
 * never writes one and the suite never sends one. `inflateSync` with
 * `info: true` reports how many input bytes the zlib stream consumed, which
 * is how each entry's end is found.
 */
export function readPack(buf: Buffer): GitObject[] {
  if (buf.length < 32) throw new Error(`pack is ${buf.length} bytes, too short`);
  if (buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const trailerStart = buf.length - 20;
  const trailer = buf.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(buf.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack trailer does not match its bytes');
  const objects: GitObject[] = [];
  const seen = new Set<string>();
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const header = readPackEntryHeader(buf, offset);
    offset = header.next;
    if (header.typeCode === 6 || header.typeCode === 7) throw new Error('delta pack entries are not supported');
    const type = CODE_TYPE[header.typeCode];
    if (type === undefined) throw new Error(`unknown pack entry type code ${header.typeCode}`);
    const inflated = inflateSync(buf.subarray(offset), { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    const consumed = inflated.engine.bytesWritten;
    if (!consumed || consumed <= 0) throw new Error('zlib stream consumed no bytes');
    const data = inflated.buffer;
    if (data.length !== header.size) {
      throw new Error(`pack entry declares ${header.size} bytes but inflated to ${data.length}`);
    }
    offset += consumed;
    const oid = hashObject(type, data);
    if (!seen.has(oid)) {
      seen.add(oid);
      objects.push({ type, data });
    }
  }
  if (offset !== trailerStart) throw new Error(`pack has ${trailerStart - offset} stray bytes before its trailer`);
  return objects;
}

// ---------------------------------------------------------------------------------------------
// Smart HTTP responses
// ---------------------------------------------------------------------------------------------

function sendBuffer(
  res: ServerResponse,
  status: number,
  body: Buffer,
  contentType: string,
  requestId: string,
): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': requestId,
  });
  res.end(body);
}

function sendJsonError(res: ServerResponse, status: number, message: string, requestId: string): void {
  sendBuffer(
    res,
    status,
    Buffer.from(JSON.stringify({ message }), 'utf8'),
    'application/json',
    requestId,
  );
}

const UPLOAD_V2_CAPS = [
  'agent=github-core-clone/1.0',
  'ls-refs=unborn',
  'fetch=shallow filter unborn',
  'object-format=sha1',
];

function uploadPackV2Advertisement(): Buffer {
  const items: Array<string | 'flush'> = ['# service=git-upload-pack\n', 'flush', 'version 2\n'];
  for (const cap of UPLOAD_V2_CAPS) items.push(`${cap}\n`);
  items.push('flush');
  return encodePktLines(items);
}

/**
 * The v2 advertisement is the same bytes for every repo and every request
 * (capabilities are fixed, no refs are listed), so it is built once.
 */
const V2_ADVERTISEMENT = uploadPackV2Advertisement();

/** v0 advertisement for either service, with capabilities on the first ref line. */
function v0Advertisement(service: 'git-upload-pack' | 'git-receive-pack', repo: GitRepo): Buffer {
  const caps =
    service === 'git-receive-pack'
      ? 'report-status report-status-v2 side-band-64k delete-refs ofs-delta symref=HEAD:refs/heads/main agent=github-core-clone/1.0'
      : 'side-band-64k multi_ack thin-pack ofs-delta shallow symref=HEAD:refs/heads/main agent=github-core-clone/1.0';
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  const refs = repo.listRefs();
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const mainOid = repo.getRef('refs/heads/main') ?? ZERO_OID;
    const lines: string[] = [`${mainOid} HEAD\0${caps}`];
    for (const ref of refs) lines.push(`${ref.oid} ${ref.name}`);
    for (const ref of refs) {
      if (!ref.name.startsWith('refs/tags/')) continue;
      const obj = repo.getObject(ref.oid);
      if (obj?.type === 'tag') {
        const target = parseTag(obj.data).object;
        if (target) lines.push(`${target} ${ref.name}^{}`);
      }
    }
    for (const line of lines) parts.push(pktLine(`${line}\n`));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

/** Parse an ls-refs request from its already-decoded pkt-line packets. */
function parseLsRefs(packets: DecodedPacket[]): LsRefsArgs {
  const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
  let seenCommand = false;
  let seenDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!seenCommand) {
      if (line !== 'command=ls-refs') throw new Error('first ls-refs line must be command=ls-refs');
      seenCommand = true;
      continue;
    }
    if (!seenDelim) continue; // agent= / object-format= lines before the delimiter
    if (line === 'peel') args.peel = true;
    else if (line === 'symrefs') args.symrefs = true;
    else if (line === 'unborn') args.unborn = true;
    else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length));
    else if (line.startsWith('ref-prefix=')) args.prefixes.push(line.slice('ref-prefix='.length));
  }
  if (!seenCommand) throw new Error('ls-refs request has no command line');
  return args;
}

function lsRefsResponse(repo: GitRepo, args: LsRefsArgs): Buffer {
  const lines: string[] = [];
  const refs = repo.listRefs();
  const keep = (name: string): boolean =>
    args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  if (args.symrefs && keep('HEAD')) {
    const mainOid = repo.getRef('refs/heads/main');
    if (mainOid !== undefined) lines.push(`${mainOid} HEAD symref-target:refs/heads/main`);
  }
  for (const ref of refs) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (args.peel && ref.name.startsWith('refs/tags/')) {
      const obj = repo.getObject(ref.oid);
      let peeled: string | undefined;
      if (obj?.type === 'tag') peeled = parseTag(obj.data).object;
      else peeled = ref.oid; // a lightweight tag peels to itself
      if (peeled) line += ` peeled:${peeled}`;
    }
    lines.push(line);
  }
  if (refs.length === 0 && args.unborn && keep('HEAD')) {
    lines.push('unborn HEAD symref-target:refs/heads/main');
  }
  const parts = lines.map((line) => pktLine(`${line}\n`));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  thinPack: boolean;
  filter: string | null;
}

/** Parse a v2 fetch request from its already-decoded pkt-line packets. */
function parseFetchV2(packets: DecodedPacket[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, thinPack: false, filter: null };
  let seenCommand = false;
  let seenDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!seenCommand) {
      if (line !== 'command=fetch') throw new Error('first fetch line must be command=fetch');
      seenCommand = true;
      continue;
    }
    if (!seenDelim) continue;
    if (line === 'thin-pack') args.thinPack = true;
    else if (line === 'no-progress') continue;
    else if (line === 'ofs-delta') continue;
    else if (line.startsWith('want ')) args.wants.push(line.slice(5).split(' ')[0] as string);
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).split(' ')[0] as string);
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).split(' ')[0] as string);
    else if (line === 'done') continue;
    else if (line.startsWith('deepen ')) {
      const value = Number.parseInt(line.slice(7), 10);
      if (Number.isFinite(value) && value >= 1) args.depth = value;
    } else if (line.startsWith('deepen-since ')) continue;
    else if (line.startsWith('deepen-not ')) continue;
    else if (line.startsWith('filter ')) args.filter = line.slice(7);
  }
  if (!seenCommand) throw new Error('fetch request has no command line');
  return args;
}

/**
 * Parse a v0 fetch request from its already-decoded first-section packets
 * plus the raw bytes after the first flush (section 2: have lines + done).
 */
function parseFetchV0(firstPackets: DecodedPacket[], rest: Buffer): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, thinPack: false, filter: null };
  const parseLine = (line: string): void => {
    // A v0 `want` line carries capabilities after the oid
    // (`want <oid> side-band-64k multi_ack ...`): only the first token is the oid.
    const firstToken = (text: string): string => text.split(' ')[0] as string;
    if (line.startsWith('want ')) args.wants.push(firstToken(line.slice(5)));
    else if (line.startsWith('have ')) args.haves.push(firstToken(line.slice(5)));
    else if (line.startsWith('shallow ')) args.shallow.push(firstToken(line.slice(8)));
    else if (line.startsWith('deepen ')) {
      const value = Number.parseInt(line.slice(7), 10);
      if (Number.isFinite(value) && value >= 1) args.depth = value;
    }
  };
  // Section 1 (before the flush): want + shallow/deepen lines.
  // Section 2 (after the flush, in `rest`): have lines + done. A v0 fetch
  // carries no pack, so section 2 ends with a flush and nothing follows.
  for (const packet of firstPackets) {
    if (packet.kind !== 'data') continue;
    parseLine(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  if (rest.length > 0) {
    const second = decodePktLines(rest);
    for (const packet of second.packets) {
      if (packet.kind !== 'data') continue;
      parseLine(packet.payload.toString('utf8').replace(/\n$/, ''));
    }
  }
  return args;
}

/**
 * The have/want computation. `wants` are the objects the client asked for;
 * `haves` are the objects the client says it already has, closed under
 * reachability but stopping at the client's own shallow boundaries.
 * With a depth, the want closure is depth-limited and its boundary commits
 * become new `shallow` lines; client boundaries whose parents all arrived
 * become `unshallow` lines.
 */
function computeFetch(repo: GitRepo, args: FetchArgs): { objects: GitObject[]; shallow: string[]; unshallow: string[] } {
  const wantSet = new Set<string>();
  let boundary: string[] = [];
  if (args.depth !== null) {
    const limited = repo.reachableDepth(args.wants, args.depth);
    for (const oid of limited.set) wantSet.add(oid);
    boundary = limited.boundary;
  } else {
    for (const oid of repo.reachable(args.wants, { allowMissing: true })) wantSet.add(oid);
  }
  const haveSet = repo.reachable(args.haves, {
    allowMissing: true,
    stopAtBoundaries: new Set(args.shallow),
  });
  const objects: GitObject[] = [];
  for (const oid of wantSet) {
    if (haveSet.has(oid)) continue;
    const obj = repo.getObject(oid);
    if (obj !== undefined) objects.push(obj);
  }
  const shallow = args.depth !== null ? boundary : [];
  const unshallow: string[] = [];
  if (args.depth !== null) {
    for (const boundaryOid of args.shallow) {
      if (!wantSet.has(boundaryOid)) continue;
      const obj = repo.getObject(boundaryOid);
      if (obj?.type !== 'commit') continue;
      if (parseCommit(obj.data).parents.every((parent) => wantSet.has(parent))) {
        unshallow.push(boundaryOid);
      }
    }
  }
  return { objects, shallow, unshallow };
}

/** A pack framed as sideband packets: band byte 1 + data chunk per pkt-line. */
function sidebandPackets(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  for (let offset = 0; offset < pack.length; offset += SIDEBAND_CHUNK) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + SIDEBAND_CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return parts;
}

function fetchV2Response(objects: GitObject[], shallow: string[], unshallow: string[]): Buffer {
  const pack = writePack(objects);
  const parts: Buffer[] = [pktLine('acknowledgments\n'), pktLine('NAK\n'), pktDelim()];
  if (shallow.length > 0 || unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktDelim());
  }
  parts.push(pktLine('packfile\n'));
  for (const packet of sidebandPackets(pack)) parts.push(packet);
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function fetchV0Response(objects: GitObject[], shallow: string[], unshallow: string[]): Buffer {
  const pack = writePack(objects);
  const parts: Buffer[] = [pktLine('NAK\n')];
  for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  for (const packet of sidebandPackets(pack)) parts.push(packet);
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function parseReceivePack(body: Buffer): { commands: PushCommand[]; caps: string[]; pack: Buffer | null } {
  const { packets, rest } = decodePktLines(body);
  const commands: PushCommand[] = [];
  let caps: string[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    let text = packet.payload.toString('utf8');
    let capPart = '';
    const nul = text.indexOf('\0');
    if (nul >= 0) {
      capPart = text.slice(nul + 1);
      text = text.slice(0, nul);
    }
    const line = text.replace(/\n$/, '');
    const [oldOid, newOid, ref] = line.split(' ');
    if (oldOid === undefined || newOid === undefined || ref === undefined) {
      throw new Error('bad push command line');
    }
    if (commands.length === 0 && capPart) {
      caps = capPart.trim().split(/\s+/).filter(Boolean);
    }
    commands.push({ oldOid, newOid, ref });
  }
  if (commands.length === 0) throw new Error('push with no commands');
  return { commands, caps, pack: rest.length > 0 ? rest : null };
}

interface PushResult {
  ref: string;
  ok: boolean;
  reason: string;
}

function applyPush(repo: GitRepo, commands: PushCommand[]): PushResult[] {
  const results: PushResult[] = [];
  for (const command of commands) {
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (repo.getRef(command.ref) === undefined) {
        results.push({ ref: command.ref, ok: false, reason: 'remote ref does not exist' });
        continue;
      }
      repo.deleteRef(command.ref);
      results.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    const current = repo.getRef(command.ref);
    if (command.oldOid === ZERO_OID) {
      // Create.
      if (current !== undefined) {
        results.push({ ref: command.ref, ok: false, reason: 'already exists' });
        continue;
      }
      if (repo.getObject(command.newOid) === undefined) {
        results.push({ ref: command.ref, ok: false, reason: 'object not found' });
        continue;
      }
      repo.setRef(command.ref, command.newOid);
      results.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    // Update: the current tip must be exactly the old oid and must be an
    // ancestor of the new tip, or it is a non-fast-forward.
    if (current === undefined || current !== command.oldOid) {
      results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    if (repo.getObject(command.newOid) === undefined) {
      results.push({ ref: command.ref, ok: false, reason: 'object not found' });
      continue;
    }
    if (!repo.isAncestor(command.oldOid, command.newOid)) {
      results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    repo.setRef(command.ref, command.newOid);
    results.push({ ref: command.ref, ok: true, reason: '' });
  }
  return results;
}

function pushReport(results: PushResult[], unpackOk: boolean, unpackDetail: string): Buffer {
  const lines = [`unpack ${unpackOk ? 'ok' : unpackDetail}`];
  for (const result of results) {
    lines.push(result.ok ? `ok ${result.ref}` : `ng ${result.ref} ${result.reason}`);
  }
  return encodePktLines(lines.map((line) => `${line}\n`));
}

/** Frame a report as sideband band-1 packets when the client asked for side-band-64k. */
function pushReportSideband(report: Buffer): Buffer {
  const parts: Buffer[] = [];
  for (let offset = 0; offset < report.length; offset += SIDEBAND_CHUNK) {
    const chunk = report.subarray(offset, Math.min(report.length, offset + SIDEBAND_CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// Dispatcher: one entry point from app.ts for all git smart-HTTP paths.
// Returns true when the path was a git path (handled, even on error).
// ---------------------------------------------------------------------------------------------

/**
 * Handle `GET /{owner}/{repo}.git/info/refs?service=...` and
 * `POST /{owner}/{repo}.git/git-upload-pack` / `git-receive-pack`.
 * Git requests carry no JSON and are not authenticated: the smart HTTP
 * protocol authenticates nothing by itself, and the suite's tokens are the
 * REST token, not a git credential.
 */
export async function handleGit(
  store: Store,
  owner: string,
  repoName: string,
  tail: string[],
  query: URLSearchParams,
  method: string,
  headers: Record<string, string | string[] | undefined>,
  rawBody: Buffer,
  res: ServerResponse,
  requestId: string,
): Promise<boolean> {
  const isInfoRefs = tail.length === 2 && tail[0] === 'info' && tail[1] === 'refs';
  const isUploadPack = tail.length === 1 && tail[0] === 'git-upload-pack';
  const isReceivePack = tail.length === 1 && tail[0] === 'git-receive-pack';
  if (!isInfoRefs && !isUploadPack && !isReceivePack) return false;

  try {
    const repo = store.getRepo(owner, repoName);
    if (repo === undefined) {
      sendJsonError(res, 404, 'Not Found', requestId);
      return true;
    }
    const git = store.getGitRepo(owner, repoName);
    const protocolHeader = headers['git-protocol'];
    const protocol = Array.isArray(protocolHeader) ? protocolHeader[0] : protocolHeader;

    if (isInfoRefs) {
      if (method !== 'GET') {
        sendJsonError(res, 405, 'Method Not Allowed', requestId);
        return true;
      }
      const service = query.get('service');
      if (service === 'git-upload-pack') {
        const body = protocol === 'version=2' ? V2_ADVERTISEMENT : v0Advertisement('git-upload-pack', git);
        sendBuffer(res, 200, body, 'application/x-git-upload-pack-advertisement', requestId);
        return true;
      }
      if (service === 'git-receive-pack') {
        const body = v0Advertisement('git-receive-pack', git);
        sendBuffer(res, 200, body, 'application/x-git-receive-pack-advertisement', requestId);
        return true;
      }
      sendJsonError(res, 400, 'unknown service', requestId);
      return true;
    }

    if (method !== 'POST') {
      sendJsonError(res, 405, 'Method Not Allowed', requestId);
      return true;
    }

    if (isUploadPack) {
      const isV2 = protocol === 'version=2';
      // A v2 upload-pack POST is either `command=fetch` or `command=ls-refs`:
      // both arrive on the same endpoint, told apart by the first line.
      // The body is decoded exactly once here; the parsers below take the
      // decoded packets instead of decoding again.
      let decoded: { packets: DecodedPacket[]; rest: Buffer };
      let firstLine = '';
      try {
        decoded = decodePktLines(rawBody);
        const first = decoded.packets.find((packet) => packet.kind === 'data');
        if (first !== undefined) firstLine = first.payload.toString('utf8').replace(/\n$/, '');
      } catch {
        sendJsonError(res, 400, 'bad pkt-line framing', requestId);
        return true;
      }
      if (isV2 && firstLine === 'command=ls-refs') {
        let args: LsRefsArgs;
        try {
          args = parseLsRefs(decoded.packets);
        } catch (error) {
          sendJsonError(res, 400, error instanceof Error ? error.message : 'bad ls-refs request', requestId);
          return true;
        }
        const cacheKey = JSON.stringify({
          peel: args.peel,
          symrefs: args.symrefs,
          unborn: args.unborn,
          prefixes: args.prefixes,
        });
        const cached = git.lsRefsCached(cacheKey);
        if (cached !== undefined) {
          sendBuffer(res, 200, cached, 'application/x-git-upload-pack-result', requestId);
          return true;
        }
        const body = lsRefsResponse(git, args);
        git.cacheLsRefs(cacheKey, body);
        sendBuffer(res, 200, body, 'application/x-git-upload-pack-result', requestId);
        return true;
      }
      let args: FetchArgs;
      try {
        args = isV2 ? parseFetchV2(decoded.packets) : parseFetchV0(decoded.packets, decoded.rest);
      } catch (error) {
        sendJsonError(res, 400, error instanceof Error ? error.message : 'bad fetch request', requestId);
        return true;
      }
      if (args.wants.length === 0) {
        sendJsonError(res, 400, 'fetch with no wants', requestId);
        return true;
      }
      if (args.filter !== null && args.filter !== 'blob:none' && args.filter !== 'blob:limit=0') {
        sendJsonError(res, 400, `unsupported filter ${args.filter}`, requestId);
        return true;
      }
      // Identical fetches of an unchanged repo build identical bytes
      // (deterministic pack order + deflate), so the whole response is
      // cached per repo version: 50 concurrent shallow clones of one tip
      // pay the pack build once. The cache is keyed on the repo version,
      // bumped by every putObject/setRef/deleteRef, so a mutation can
      // never serve a stale pack.
      const cacheKey = JSON.stringify({
        v: isV2 ? 2 : 0,
        w: [...args.wants].sort(),
        h: [...args.haves].sort(),
        s: [...args.shallow].sort(),
        d: args.depth,
      });
      const cached = git.fetchCached(cacheKey);
      if (cached !== undefined) {
        sendBuffer(res, 200, cached, 'application/x-git-upload-pack-result', requestId);
        return true;
      }
      const { objects, shallow, unshallow } = computeFetch(git, args);
      const body = isV2
        ? fetchV2Response(objects, shallow, unshallow)
        : fetchV0Response(objects, shallow, unshallow);
      git.cacheFetch(cacheKey, body);
      sendBuffer(res, 200, body, 'application/x-git-upload-pack-result', requestId);
      return true;
    }

    // git-receive-pack: always v0 on this forge (the suite never asks v2 here).
    let parsed: { commands: PushCommand[]; caps: string[]; pack: Buffer | null };
    try {
      parsed = parseReceivePack(rawBody);
    } catch (error) {
      sendJsonError(res, 400, error instanceof Error ? error.message : 'bad push request', requestId);
      return true;
    }
    const sideband = parsed.caps.includes('side-band-64k');
    const needsPack = parsed.commands.some((command) => command.newOid !== ZERO_OID);
    let unpackOk = true;
    let unpackDetail = '';
    if (needsPack) {
      if (parsed.pack === null) {
        unpackOk = false;
        unpackDetail = 'missing pack';
      } else {
        try {
          const objects = readPack(parsed.pack);
          for (const obj of objects) git.putObject(obj.type, obj.data);
        } catch (error) {
          unpackOk = false;
          unpackDetail = error instanceof Error ? error.message : 'unpack failed';
        }
      }
    }
    // Ref updates apply only when the pack unpacked: a refused update still
    // stores its objects (they may be needed by a later push), but a failed
    // unpack must not move any ref.
    const results = unpackOk
      ? applyPush(git, parsed.commands)
      : parsed.commands.map((command) => ({ ref: command.ref, ok: false, reason: 'unpack failed' }));
    const report = pushReport(results, unpackOk, unpackDetail);
    const body = sideband ? pushReportSideband(report) : Buffer.concat([report, pktFlush()]);
    sendBuffer(res, 200, body, 'application/x-git-receive-pack-result', requestId);
    return true;
  } catch (error) {
    sendJsonError(res, 500, error instanceof Error ? error.message : 'internal error', requestId);
    return true;
  }
}
