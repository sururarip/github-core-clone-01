// Smart-HTTP git endpoints: info/refs advertisements (v0 and v2),
// ls-refs and fetch over protocol v2 (with a v0 fallback), and receive-pack
// pushes with report-status. Written from the git wire formats and the
// kit's client behaviour, not from any existing server.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  collectReachable,
  commitGenerations,
  decodePktLines,
  encodePktLines,
  hashObject,
  isAncestor,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  peelToCommit,
  pktLine,
  readPack,
  verifyPackChecksum,
  writePack,
  ZERO_OID,
  type GitObject,
} from './gitcore.ts';
import { authenticate, readBody, sendBuffer, sendJson } from './httpkit.ts';
import { DEFAULT_BRANCH, VIEWER } from './scenario.ts';
import type { Repo, Store } from './store.ts';

const AGENT = 'forge/1.0';
const UPLOAD_AD = 'application/x-git-upload-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_AD = 'application/x-git-receive-pack-advertisement';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';

/** Split a sideband payload into pkt-lines of at most 65515 payload bytes. */
function sidebandPackets(band: number, data: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 65515;
  if (data.length === 0) {
    out.push(pktLine(Buffer.concat([Buffer.from([band]), Buffer.alloc(0)])));
    return out;
  }
  for (let offset = 0; offset < data.length; offset += CHUNK) {
    const piece = data.subarray(offset, offset + CHUNK);
    out.push(pktLine(Buffer.concat([Buffer.from([band]), piece])));
  }
  return out;
}

function notFound(res: ServerResponse): void {
  sendJson(res, 404, { message: 'Not Found' });
}

function unauthorized(res: ServerResponse): void {
  sendJson(res, 401, { message: 'Requires authentication' });
}

/** The repo for a git path, or null when the owner/repo does not exist. */
function repoFor(store: Store, owner: string, name: string): Repo | null {
  if (owner !== VIEWER.login) return null;
  return store.getRepo(owner, name) ?? null;
}

function v2Capabilities(): Buffer {
  return encodePktLines([
    'version 2\n',
    'ls-refs=unborn\n',
    'fetch=shallow\n',
    'object-format=sha1\n',
    `agent=${AGENT}\n`,
    'flush',
  ]);
}

function v0Capabilities(service: 'upload' | 'receive', repo: Repo): string {
  const base =
    service === 'upload'
      ? 'side-band-64k thin-pack ofs-delta shallow multi_ack'
      : 'report-status side-band-64k delete-refs ofs-delta';
  const main = repo.refTip(`refs/heads/${DEFAULT_BRANCH}`);
  const symref = main ? ` symref=HEAD:refs/heads/${DEFAULT_BRANCH}` : '';
  return `${base} agent=${AGENT}${symref}`;
}

/** A v0 ref advertisement body for one service. */
function v0Advertisement(service: 'upload' | 'receive', repo: Repo): Buffer {
  const serviceName = service === 'upload' ? 'git-upload-pack' : 'git-receive-pack';
  const lines: Array<string | 'flush'> = [`# service=${serviceName}\n`, 'flush'];
  const caps = v0Capabilities(service, repo);
  const refs = repo.sortedRefs();
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    refs.forEach((ref, index) => {
      const suffix = index === 0 ? `\0${caps}` : '';
      lines.push(`${ref.oid} ${ref.name}${suffix}\n`);
      const object = repo.objects.get(ref.oid);
      if (object && object.type === 'tag') {
        const peeled = peelToCommit(ref.oid, repo.lookup);
        if (peeled !== ref.oid) lines.push(`${peeled} ${ref.name}^{}\n`);
      }
    });
    // A HEAD line, so a v0 reader learns the default branch.
    const main = repo.refTip(`refs/heads/${DEFAULT_BRANCH}`);
    if (main) lines.push(`${main} HEAD\n`);
  }
  lines.push('flush');
  return encodePktLines(lines);
}

/** The peeled commit for a tag ref, or the ref's own oid. */
function peeledOf(repo: Repo, oid: string): string | undefined {
  const object = repo.objects.get(oid);
  if (!object) return undefined;
  if (object.type === 'tag') return peelToCommit(oid, repo.lookup);
  return undefined;
}

/** Handle a v2 ls-refs request body. */
function handleLsRefs(repo: Repo, body: Buffer): Buffer {
  const packets = decodePktLines(body);
  let peel = false;
  let symrefs = false;
  const prefixes: string[] = [];
  let seenDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    if (packet.kind !== 'data' || !seenDelim) continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const matches = (name: string): boolean =>
    prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const out: string[] = [];
  const main = repo.refTip(`refs/heads/${DEFAULT_BRANCH}`);
  if (symrefs && main && matches('HEAD')) {
    out.push(`${main} HEAD symref-target:refs/heads/${DEFAULT_BRANCH}\n`);
  }
  for (const ref of repo.sortedRefs()) {
    if (!matches(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (peel) {
      const peeled = peeledOf(repo, ref.oid);
      if (peeled) line += ` peeled:${peeled}`;
    }
    out.push(`${line}\n`);
  }
  out.push('flush');
  return encodePktLines(out as unknown as (string | 'flush')[]);
}

export interface FetchCompute {
  readonly objects: GitObject[];
  readonly shallow: string[];
  readonly unshallow: string[];
  readonly wantedRefs: Array<{ oid: string; ref: string }>;
}

/**
 * What a shallow clone actually holds for a commit: the commit, its tree
 * and its blobs — but NOT its parents. A full closure follows parents, so
 * it would wrongly claim the client already holds the very generation a
 * deepen is asking for.
 */
function shallowHeld(haves: readonly string[], lookup: (oid: string) => GitObject | undefined): Set<string> {
  const held = new Set<string>();
  for (const have of haves) {
    const object = lookup(have);
    if (!object) continue;
    if (object.type === 'commit') {
      held.add(have);
      const treeOid = parseCommit(object.data).tree;
      const stack = [treeOid];
      while (stack.length) {
        const current = stack.pop()!;
        if (held.has(current)) continue;
        const treeObject = lookup(current);
        if (!treeObject || treeObject.type !== 'tree') continue;
        held.add(current);
        for (const entry of parseTree(treeObject.data)) {
          if (entry.mode === '40000') stack.push(entry.oid);
          else held.add(entry.oid);
        }
      }
    } else if (object.type === 'tree') {
      held.add(have);
      const stack = [have];
      while (stack.length) {
        const current = stack.pop()!;
        const treeObject = lookup(current);
        if (!treeObject || treeObject.type !== 'tree') continue;
        for (const entry of parseTree(treeObject.data)) {
          if (entry.mode === '40000') stack.push(entry.oid);
          else held.add(entry.oid);
        }
      }
    } else if (object.type === 'tag') {
      held.add(have);
      const target = peelToCommit(have, lookup);
      if (target !== have) {
        for (const oid of shallowHeld([target], lookup)) held.add(oid);
      }
    } else {
      held.add(have);
    }
  }
  return held;
}

/** Which objects a fetch sends, and the shallow bookkeeping that goes with it. */
export function computeFetch(
  repo: Repo,
  wants: string[],
  haves: string[],
  priorShallow: string[],
  depth: number | undefined,
): FetchCompute {
  const lookup = repo.lookup;
  const haveSet = new Set(haves);
  const haveClosure = collectReachable(haves, lookup);
  const wantedRefs: Array<{ oid: string; ref: string }> = [];
  for (const ref of repo.sortedRefs()) {
    if (wants.includes(ref.oid)) wantedRefs.push({ oid: ref.oid, ref: ref.name });
  }
  const send = new Set<string>();
  // Tag wants travel as themselves; their targets join the commit walk.
  const peeledWants: string[] = [];
  for (const want of wants) {
    const object = lookup(want);
    if (object && object.type === 'tag') {
      send.add(want);
      peeledWants.push(peelToCommit(want, lookup));
    } else {
      peeledWants.push(want);
    }
  }
  let shallow: string[] = [];
  let unshallow: string[] = [];
  if (depth === undefined) {
    for (const oid of collectReachable(peeledWants, lookup)) {
      if (!haveClosure.has(oid)) send.add(oid);
    }
    unshallow = [...priorShallow];
  } else {
    const generations = commitGenerations(peeledWants, lookup, depth);
    const included = new Set<string>();
    for (const [oid, gen] of generations) {
      if (gen < depth && !haveSet.has(oid)) included.add(oid);
    }
    // Trees and blobs of the included commits only — never their parents.
    // Exclude only what the client shallow-holds, not the full closure:
    // the full closure follows parents, which would hide the generation
    // a deepen is asking for.
    const held = shallowHeld(haves, lookup);
    for (const oid of included) {
      send.add(oid);
      const object = lookup(oid);
      if (!object || object.type !== 'commit') continue;
      const treeOid = parseCommit(object.data).tree;
      const stack = [treeOid];
      while (stack.length) {
        const current = stack.pop()!;
        if (held.has(current)) continue;
        const treeObject = lookup(current);
        if (!treeObject || treeObject.type !== 'tree') continue;
        send.add(current);
        for (const entry of parseTree(treeObject.data)) {
          if (entry.mode === '40000') stack.push(entry.oid);
          else if (!held.has(entry.oid)) send.add(entry.oid);
        }
      }
    }
    // A boundary is an included commit with a parent that is not included.
    const boundaries: string[] = [];
    for (const oid of included) {
      const object = lookup(oid);
      if (!object || object.type !== 'commit') continue;
      const parents = parseCommit(object.data).parents;
      if (parents.some((parent) => !included.has(parent))) boundaries.push(oid);
    }
    shallow = [...boundaries];
    // Prior boundaries: resolved when every parent is now available.
    for (const boundary of priorShallow) {
      const object = lookup(boundary);
      if (!object || object.type !== 'commit') {
        unshallow.push(boundary);
        continue;
      }
      const parents = parseCommit(object.data).parents;
      const available = (oid: string): boolean => included.has(oid) || haveSet.has(oid);
      if (parents.every(available)) unshallow.push(boundary);
      else if (!shallow.includes(boundary)) shallow.push(boundary);
    }
  }
  const objects: GitObject[] = [];
  for (const oid of [...send].sort()) {
    const object = lookup(oid);
    if (object) objects.push(object);
  }
  return { objects, shallow, unshallow, wantedRefs };
}

/** Handle a v2 fetch request body. */
function handleFetchV2(repo: Repo, body: Buffer): Buffer {
  const packets = decodePktLines(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const priorShallow: string[] = [];
  let depth: number | undefined;
  let seenDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    if (packet.kind !== 'data' || !seenDelim) continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) priorShallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) depth = parseInt(line.slice(7).trim(), 10);
  }
  const computed = computeFetch(repo, wants, haves, priorShallow, depth);
  const pack = writePack(computed.objects);
  const parts: Buffer[] = [];
  // acknowledgments
  const ackLines: string[] = [];
  if (haves.length === 0) {
    ackLines.push('NAK\n');
  } else {
    for (const have of haves) if (repo.objects.has(have)) ackLines.push(`ACK ${have}\n`);
    ackLines.push('ready\n');
  }
  parts.push(encodePktLines(['acknowledgments\n', ...ackLines, 'delim']));
  // shallow-info
  if (computed.shallow.length || computed.unshallow.length) {
    const lines: string[] = ['shallow-info\n'];
    for (const oid of computed.shallow) lines.push(`shallow ${oid}\n`);
    for (const oid of computed.unshallow) lines.push(`unshallow ${oid}\n`);
    lines.push('delim');
    parts.push(encodePktLines(lines as unknown as (string | 'delim')[]));
  }
  // wanted-refs
  if (computed.wantedRefs.length) {
    const lines: string[] = ['wanted-refs\n'];
    for (const ref of computed.wantedRefs) lines.push(`${ref.oid} ${ref.ref}\n`);
    lines.push('delim');
    parts.push(encodePktLines(lines as unknown as (string | 'delim')[]));
  }
  // packfile
  parts.push(encodePktLines(['packfile\n']));
  for (const packet of sidebandPackets(1, pack)) parts.push(packet);
  parts.push(Buffer.from('0000', 'ascii'));
  return Buffer.concat(parts);
}

/** Handle a v0 fetch request body (the fallback when v2 is not advertised). */
function handleFetchV0(repo: Repo, body: Buffer): Buffer {
  const packets = decodePktLines(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const priorShallow: string[] = [];
  let depth: number | undefined;
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) wants.push(line.split(' ')[1] ?? '');
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) priorShallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) depth = parseInt(line.slice(7).trim(), 10);
  }
  const computed = computeFetch(repo, wants, haves, priorShallow, depth);
  const pack = writePack(computed.objects);
  const parts: Buffer[] = [];
  const textLines: string[] = [];
  if (haves.length === 0) textLines.push('NAK\n');
  else {
    for (const have of haves) if (repo.objects.has(have)) textLines.push(`ACK ${have}\n`);
    textLines.push('ready\n');
  }
  for (const oid of computed.shallow) textLines.push(`shallow ${oid}\n`);
  for (const oid of computed.unshallow) textLines.push(`unshallow ${oid}\n`);
  parts.push(encodePktLines(textLines));
  for (const packet of sidebandPackets(1, pack)) parts.push(packet);
  parts.push(Buffer.from('0000', 'ascii'));
  return Buffer.concat(parts);
}

interface PushCommand {
  readonly oldOid: string;
  readonly newOid: string;
  readonly ref: string;
}

/** Handle a receive-pack (push) request body. */
async function handleReceivePack(repo: Repo, body: Buffer): Promise<Buffer> {
  let commands: PushCommand[] = [];
  let packBytes = Buffer.alloc(0);
  // Parse pkt-lines one at a time from the start; the pack begins right
  // after the first flush. The pack bytes are binary and must never be
  // read as pkt-lines.
  let offset = 0;
  const commandLines: string[] = [];
  let sawFlush = false;
  while (offset + 4 <= body.length) {
    const length = parseInt(body.subarray(offset, offset + 4).toString('ascii'), 16);
    if (Number.isNaN(length) || length < 0) break;
    if (length === 0) {
      offset += 4;
      sawFlush = true;
      break;
    }
    if (length === 1 || length === 2) {
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > body.length) break;
    commandLines.push(body.subarray(offset + 4, offset + length).toString('utf8'));
    offset += length;
  }
  if (sawFlush) packBytes = body.subarray(offset);
  for (const text of commandLines) {
    const line = text.replace(/\n$/, '');
    const nul = line.indexOf('\0');
    const head = nul >= 0 ? line.slice(0, nul) : line;
    const parts = head.split(' ');
    if (parts.length >= 3) {
      commands.push({ oldOid: parts[0] ?? '', newOid: parts[1] ?? '', ref: parts.slice(2).join(' ') });
    }
  }
  const reportLines: string[] = [];
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (commands.length === 0) {
    unpackOk = false;
    unpackDetail = 'no commands';
  } else {
    const needsPack = commands.some((command) => command.newOid !== ZERO_OID);
    if (needsPack && packBytes.length > 0) {
      try {
        const read = await readPack(packBytes);
        for (const [oid, object] of read.objects) {
          if (!repo.objects.has(oid)) repo.objects.set(oid, object);
        }
      } catch (err) {
        unpackOk = false;
        unpackDetail = err instanceof Error ? err.message : 'unpack failed';
      }
    }
  }
  if (unpackOk) {
    for (const command of commands) {
      const reason = applyPushCommand(repo, command);
      if (reason === null) reportLines.push(`ok ${command.ref}\n`);
      else reportLines.push(`ng ${command.ref} ${reason}\n`);
    }
  } else {
    for (const command of commands) reportLines.push(`ng ${command.ref} unpack failed\n`);
  }
  const report = encodePktLines([`unpack ${unpackOk ? 'ok' : unpackDetail}\n`, ...reportLines]);
  const parts: Buffer[] = [];
  for (const packet of sidebandPackets(1, report)) parts.push(packet);
  parts.push(Buffer.from('0000', 'ascii'));
  return Buffer.concat(parts);
}

/** Validate and apply one push command; null means ok, else the ng reason. */
function applyPushCommand(repo: Repo, command: PushCommand): string | null {
  if (!isObjectId(command.oldOid) || !isObjectId(command.newOid)) return 'bad object id';
  if (!command.ref.startsWith('refs/')) return 'invalid ref';
  const current = repo.refs.get(command.ref);
  if (command.newOid === ZERO_OID) {
    // Delete.
    if (current === undefined) return 'no such ref';
    if (command.oldOid !== ZERO_OID && command.oldOid !== current) return 'non-fast-forward';
    repo.refs.delete(command.ref);
    return null;
  }
  const object = repo.objects.get(command.newOid);
  if (!object) return 'missing object';
  if (command.oldOid === ZERO_OID) {
    // Create.
    if (current !== undefined) return 'already exists';
    repo.refs.set(command.ref, command.newOid);
    return null;
  }
  // Update: the old tip must match, and the new tip must descend from it
  // (tags update by replacing, so they skip the ancestry check).
  if (current === undefined) return 'no such ref';
  if (command.oldOid !== current) return 'non-fast-forward';
  if (object.type !== 'tag' && !isAncestor(command.oldOid, command.newOid, repo.lookup)) {
    return 'non-fast-forward';
  }
  repo.refs.set(command.ref, command.newOid);
  return null;
}

/**
 * Route a git smart-HTTP request. Returns true when the path was a git
 * route (handled or 404'd); false when it is not a git path at all.
 */
export async function handleGit(req: IncomingMessage, res: ServerResponse, store: Store): Promise<boolean> {
  let path = '';
  try {
    path = new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return false;
  }
  const match = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
  if (!match) return false;
  const owner = decodeURIComponent(match[1] ?? '');
  const repoName = decodeURIComponent(match[2] ?? '');
  const service = match[3] as 'info/refs' | 'git-upload-pack' | 'git-receive-pack';
  const method = req.method ?? 'GET';
  const repo = repoFor(store, owner, repoName);
  if (!repo) {
    notFound(res);
    return true;
  }
  const auth = authenticate(req);
  if (!auth.viewerLogin) {
    unauthorized(res);
    return true;
  }
  if (service === 'info/refs' && method === 'GET') {
    let serviceParam = '';
    try {
      serviceParam = new URL(req.url ?? '/', 'http://entry').searchParams.get('service') ?? '';
    } catch {
      serviceParam = '';
    }
    const version2 = (req.headers['git-protocol'] ?? '') === 'version=2';
    if (serviceParam === 'git-upload-pack') {
      const body = version2 ? v2Capabilities() : v0Advertisement('upload', repo);
      sendBuffer(res, 200, body, UPLOAD_AD);
      return true;
    }
    if (serviceParam === 'git-receive-pack') {
      sendBuffer(res, 200, v0Advertisement('receive', repo), RECEIVE_AD);
      return true;
    }
    notFound(res);
    return true;
  }
  if (service === 'git-upload-pack' && method === 'POST') {
    let body: Buffer;
    try {
      body = await readBody(req);
    } catch {
      sendJson(res, 400, { message: 'request body too large' });
      return true;
    }
    try {
      const packets = decodePktLines(body);
      const first = packets.find((packet) => packet.kind === 'data');
      const firstLine = first && first.kind === 'data' ? first.payload.toString('utf8') : '';
      if (firstLine.startsWith('command=ls-refs')) {
        sendBuffer(res, 200, handleLsRefs(repo, body), UPLOAD_RESULT);
      } else if (firstLine.startsWith('command=fetch')) {
        sendBuffer(res, 200, handleFetchV2(repo, body), UPLOAD_RESULT);
      } else if (firstLine.startsWith('want ')) {
        sendBuffer(res, 200, handleFetchV0(repo, body), UPLOAD_RESULT);
      } else {
        // Not a request this server understands: stay up, answer 400.
        sendJson(res, 400, { message: 'malformed git request' });
      }
    } catch {
      sendJson(res, 400, { message: 'malformed git request' });
    }
    return true;
  }
  if (service === 'git-receive-pack' && method === 'POST') {
    let body: Buffer;
    try {
      body = await readBody(req);
    } catch {
      sendJson(res, 400, { message: 'request body too large' });
      return true;
    }
    try {
      sendBuffer(res, 200, await handleReceivePack(repo, body), RECEIVE_RESULT);
    } catch {
      sendJson(res, 400, { message: 'malformed git request' });
    }
    return true;
  }
  sendJson(res, 404, { message: 'Not Found' });
  return true;
}
