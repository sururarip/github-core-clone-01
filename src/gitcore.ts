// The git object model and wire codec, written from the git formats
// themselves (object headers, tree/commit/tag bytes, pkt-lines, packfiles).
// No git binary, no library: SHA-1 and zlib come from Node's stdlib.

import { createHash } from 'node:crypto';
import { deflateSync as zlibDeflate, inflateSync as zlibInflate } from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

export function isObjectId(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

/** The SHA-1 id of an object: sha1("<type> <size>\0" + data). */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

/** Build a tree object from entries, sorted the way git sorts them. */
export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Parse a tree object's bytes into entries, in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space);
    if (space < 0 || nul < 0 || nul + 21 > data.length) break;
    const mode = data.subarray(offset, space).toString('utf8');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

export interface ParsedCommit {
  readonly tree: string;
  readonly parents: string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
}

/** Parse a commit object's bytes. */
export function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const head = text.split('\n\n')[0] ?? '';
  const message = text.includes('\n\n') ? text.slice(text.indexOf('\n\n') + 2) : '';
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

/** Build a commit object's bytes. */
export function buildCommit(args: {
  tree: string;
  parents: readonly string[];
  author: string;
  committer: string;
  timestamp: number;
  message: string;
}): Buffer {
  const lines: string[] = [`tree ${args.tree}`];
  for (const parent of args.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${args.author} ${args.timestamp} +0000`);
  lines.push(`committer ${args.committer} ${args.timestamp} +0000`);
  const head = `${lines.join('\n')}\n\n`;
  const message = args.message.endsWith('\n') ? args.message : `${args.message}\n`;
  return Buffer.concat([Buffer.from(head, 'utf8'), Buffer.from(message, 'utf8')]);
}

export interface ParsedTag {
  readonly object: string;
  readonly type: string;
  readonly tag: string;
  readonly tagger: string;
  readonly message: string;
}

/** Parse a tag object's bytes. */
export function parseTag(data: Buffer): ParsedTag {
  const text = data.toString('utf8');
  const head = text.split('\n\n')[0] ?? '';
  const message = text.includes('\n\n') ? text.slice(text.indexOf('\n\n') + 2) : '';
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

// ---------------------------------------------------------------------------------------------
// pkt-lines
// ---------------------------------------------------------------------------------------------

export type PktLine = { readonly kind: 'data'; readonly payload: Buffer } | { readonly kind: 'flush' } | { readonly kind: 'delim' };

export const PKT_LINE_MAX = 65520;

/** Encode one data line: 4 hex digits of (length + 4) + payload. */
export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  if (length > PKT_LINE_MAX) throw new Error(`pkt-line of ${length} bytes exceeds ${PKT_LINE_MAX}`);
  const head = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

/** Encode a list of lines ('flush' / 'delim' for the control packets). */
export function encodePktLines(lines: readonly (string | Buffer | 'flush' | 'delim')[]): Buffer {
  const parts: Buffer[] = [];
  for (const line of lines) {
    if (line === 'flush') parts.push(PKT_FLUSH);
    else if (line === 'delim') parts.push(PKT_DELIM);
    else parts.push(pktLine(line));
  }
  return Buffer.concat(parts);
}

/** Decode a whole buffer of pkt-lines. Throws on a malformed length. */
export function decodePktLines(buffer: Buffer): PktLine[] {
  const out: PktLine[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error('truncated pkt-line length');
    const length = parseInt(buffer.subarray(offset, offset + 4).toString('ascii'), 16);
    if (Number.isNaN(length) || length < 0) throw new Error('malformed pkt-line length');
    if (length === 0) {
      out.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (length === 1) {
      out.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > buffer.length) throw new Error('malformed pkt-line');
    out.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// packfiles (v2; plain objects on write, deltas resolved on read)
// ---------------------------------------------------------------------------------------------

const PACK_TYPE_NAMES: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** Apply a delta to a base object, per the git delta format. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset++] ?? 0;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) return value;
    }
  };
  const sourceSize = readVarint();
  const targetSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const parts: Buffer[] = [];
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++] ?? 0;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let i = 0; i < 4; i += 1) if (op & (1 << i)) copyOffset |= (delta[offset++] ?? 0) << (8 * i);
      for (let i = 0; i < 3; i += 1) if (op & (0x10 << i)) copySize |= (delta[offset++] ?? 0) << (8 * i);
      if (copySize === 0) copySize = 0x10000;
      parts.push(base.subarray(copyOffset, copyOffset + copySize));
      written += copySize;
    } else if (op > 0) {
      parts.push(delta.subarray(offset, offset + op));
      offset += op;
      written += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const out = Buffer.concat(parts);
  if (written !== targetSize || out.length !== targetSize) throw new Error('delta target size mismatch');
  return out;
}

export interface ReadPackResult {
  readonly objects: Map<string, GitObject>;
  readonly deltaCount: number;
  readonly declaredCount: number;
  readonly version: number;
}

/**
 * Inflate the zlib stream starting at `start` and return its bytes plus the
 * offset just past the stream. Node's inflateSync ignores trailing bytes and
 * reports no consumed length, so the stream end is found by binary search:
 * a prefix shorter than the stream throws (or yields the wrong size), a
 * prefix at or past the end inflates to exactly `expectedSize`.
 */
function inflateAt(pack: Buffer, start: number, expectedSize: number): { data: Buffer; next: number } {
  const limit = pack.length - 20; // the 20-byte trailer is never part of a stream
  const holds = (end: number): boolean => {
    try {
      return zlibInflate(pack.subarray(start, end)).length === expectedSize;
    } catch {
      return false;
    }
  };
  if (!holds(limit)) throw new Error('pack entry does not inflate to its declared size');
  let low = start;
  let high = limit;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (holds(mid)) high = mid;
    else low = mid + 1;
  }
  return { data: zlibInflate(pack.subarray(start, low)), next: low };
}

/** Read a packfile: inflate every entry, resolve deltas, index by id. */
export function readPack(pack: Buffer): ReadPackResult {
  if (pack.length < 12 || pack.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = pack.readUInt32BE(4);
  const declaredCount = pack.readUInt32BE(8);
  interface RawEntry {
    readonly type: GitObjectType | 'ofs-delta' | 'ref-delta';
    readonly data: Buffer;
    readonly byteOffset: number;
    readonly ofsBase?: number;
    readonly refBase?: string;
  }
  const raw: RawEntry[] = [];
  let deltaCount = 0;
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryStart = offset;
    // Entry header: varint with the type in bits 4-6 and the size spread over 7-bit groups.
    const first = pack[offset++] ?? 0;
    const typeCode = (first >> 4) & 0x7;
    let size = first & 0x0f;
    let shift = 4;
    let byte = first;
    while (byte & 0x80) {
      byte = pack[offset++] ?? 0;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    if (typeCode === 6) {
      // OFS_DELTA: a negative-offset varint follows the header.
      let b = pack[offset++] ?? 0;
      let baseOffset = b & 0x7f;
      while (b & 0x80) {
        b = pack[offset++] ?? 0;
        baseOffset = ((baseOffset + 1) << 7) | (b & 0x7f);
      }
      const inflated = inflateAt(pack, offset, size);
      offset = inflated.next;
      raw.push({ type: 'ofs-delta', data: inflated.data, byteOffset: entryStart, ofsBase: entryStart - baseOffset });
      deltaCount += 1;
    } else if (typeCode === 7) {
      const refBase = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      const inflated = inflateAt(pack, offset, size);
      offset = inflated.next;
      raw.push({ type: 'ref-delta', data: inflated.data, byteOffset: entryStart, refBase });
      deltaCount += 1;
    } else {
      const type = PACK_TYPE_NAMES[typeCode];
      if (!type) throw new Error(`unknown pack object type ${typeCode}`);
      const inflated = inflateAt(pack, offset, size);
      offset = inflated.next;
      if (inflated.data.length !== size) throw new Error('pack object size mismatch');
      raw.push({ type, data: inflated.data, byteOffset: entryStart });
    }
  }
  // Resolve: plain objects first, then deltas (a delta's base may itself be a delta).
  const byByteOffset = new Map<number, RawEntry>();
  for (const entry of raw) byByteOffset.set(entry.byteOffset, entry);
  const resolved = new Map<string, GitObject>();
  const resolve = (entry: RawEntry, depth = 0): GitObject => {
    if (depth > 100) throw new Error('delta chain too deep');
    if (entry.type !== 'ofs-delta' && entry.type !== 'ref-delta') {
      const obj: GitObject = { type: entry.type, data: entry.data };
      resolved.set(hashObject(entry.type, entry.data), obj);
      return obj;
    }
    let base: GitObject | undefined;
    if (entry.type === 'ofs-delta' && entry.ofsBase !== undefined) {
      const baseEntry = byByteOffset.get(entry.ofsBase);
      if (baseEntry) base = resolve(baseEntry, depth + 1);
    } else if (entry.type === 'ref-delta' && entry.refBase) {
      base = resolved.get(entry.refBase);
      if (!base) {
        const baseEntry = raw.find(
          (candidate) =>
            candidate.type !== 'ofs-delta' &&
            candidate.type !== 'ref-delta' &&
            hashObject(candidate.type, candidate.data) === entry.refBase,
        );
        if (baseEntry) base = resolve(baseEntry, depth + 1);
      }
    }
    if (!base) throw new Error('delta base not found in pack');
    const data = applyDelta(base.data, entry.data);
    const obj: GitObject = { type: base.type, data };
    resolved.set(hashObject(base.type, data), obj);
    return obj;
  };
  for (const entry of raw) resolve(entry);
  // Verify the trailer checksum.
  const trailer = pack.subarray(pack.length - 20).toString('hex');
  const expected = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest('hex');
  if (trailer !== expected) throw new Error('pack trailer checksum mismatch');
  return { objects: resolved, deltaCount, declaredCount, version };
}

/** Write a packfile (v2, plain objects only, no deltas). */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  const typeCodes: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
  for (const object of objects) {
    const typeCode = typeCodes[object.type];
    const size = object.data.length;
    const headerBytes: number[] = [];
    let remaining = size;
    let first = (typeCode << 4) | (remaining & 0x0f);
    remaining >>= 4;
    if (remaining > 0) first |= 0x80;
    headerBytes.push(first);
    while (remaining > 0) {
      let byte = remaining & 0x7f;
      remaining >>= 7;
      if (remaining > 0) byte |= 0x80;
      headerBytes.push(byte);
    }
    parts.push(Buffer.from(headerBytes));
    parts.push(zlibDeflate(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** Verify a pack's trailer checksum without parsing it. */
export function verifyPackChecksum(pack: Buffer): { ok: boolean; actual: string; expected: string } {
  if (pack.length < 20) return { ok: false, actual: '', expected: '' };
  const actual = pack.subarray(pack.length - 20).toString('hex');
  const expected = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest('hex');
  return { ok: actual === expected, actual, expected };
}

// ---------------------------------------------------------------------------------------------
// reachability
// ---------------------------------------------------------------------------------------------

export type ObjectLookup = (oid: string) => GitObject | undefined;

/** Everything reachable from `tips`, following commits, trees and tags. */
export function collectReachable(tips: Iterable<string>, lookup: ObjectLookup): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [...tips];
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid) || oid === ZERO_OID) continue;
    const object = lookup(oid);
    if (!object) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const parsed = parseCommit(object.data);
      queue.push(parsed.tree, ...parsed.parents);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) queue.push(entry.oid);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    }
  }
  return seen;
}

/** The commits reachable from `tips`, with their generation (distance from a tip). */
export function commitGenerations(tips: readonly string[], lookup: ObjectLookup): Map<string, number> {
  const generations = new Map<string, number>();
  const queue: Array<{ oid: string; gen: number }> = tips.map((oid) => ({ oid, gen: 0 }));
  while (queue.length) {
    const { oid, gen } = queue.shift()!;
    if (oid === ZERO_OID) continue;
    const known = generations.get(oid);
    if (known !== undefined && known <= gen) continue;
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    generations.set(oid, gen);
    for (const parent of parseCommit(object.data).parents) {
      queue.push({ oid: parent, gen: gen + 1 });
    }
  }
  return generations;
}

/** True when `ancestor` is an ancestor of `descendant` (or equal). */
export function isAncestor(ancestor: string, descendant: string, lookup: ObjectLookup): boolean {
  if (ancestor === descendant) return true;
  if (ancestor === ZERO_OID) return true;
  const seen = new Set<string>();
  const queue = [descendant];
  while (queue.length) {
    const oid = queue.pop()!;
    if (oid === ancestor) return true;
    if (seen.has(oid) || oid === ZERO_OID) continue;
    seen.add(oid);
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    queue.push(...parseCommit(object.data).parents);
  }
  return false;
}

/** Peel a tag object to the commit it points at (following tag chains). */
export function peelToCommit(oid: string, lookup: ObjectLookup): string {
  let current = oid;
  for (let i = 0; i < 10; i += 1) {
    const object = lookup(current);
    if (!object) return current;
    if (object.type === 'tag') {
      current = parseTag(object.data).object;
      continue;
    }
    return current;
  }
  return current;
}
