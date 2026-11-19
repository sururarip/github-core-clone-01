// The forge's in-memory store: repositories, refs, git objects, issues,
// pull requests, labels and comments — plus the git operations the REST
// surface needs (file reads/writes as commits, tree diffs, squash merges).
// Everything is deterministic: created/updated stamps come from a logical
// clock (a fixed base plus a counter), never the wall clock, so two runs
// of the same trial produce identical responses.

import {
  buildCommit,
  buildTree,
  collectReachable,
  hashObject,
  isAncestor,
  parseCommit,
  parseTree,
  peelToCommit,
  ZERO_OID,
  type GitObject,
  type GitObjectType,
  type TreeEntry,
} from './gitcore.ts';
import { DEFAULT_BRANCH, VIEWER } from './scenario.ts';

/** The logical clock: 2025-01-01T00:00:00Z plus one second per event. */
const CLOCK_BASE_SEC = 1_735_689_600;

export interface Comment {
  readonly id: number;
  readonly body: string;
  readonly createdAt: string;
}

export interface Issue {
  /** The REST numeric id (stable across reads; GraphQL uses an opaque global id instead). */
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  readonly createdAt: string;
  updatedAt: string;
  readonly seq: number;
  readonly comments: Comment[];
}

export interface Pull {
  /** The REST numeric id (stable across reads; GraphQL uses an opaque global id instead). */
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  readonly head: { ref: string; sha: string };
  readonly base: { ref: string; sha: string };
  readonly createdAt: string;
  updatedAt: string;
  readonly seq: number;
}

export interface Label {
  readonly name: string;
  color: string;
}

export class Repo {
  /** The stable numeric database id, assigned in creation order (5000, 5001, ...). */
  readonly id: number;
  readonly name: string;
  readonly owner: string;
  description: string;
  readonly isPrivate: boolean;
  readonly defaultBranch: string;
  readonly refs = new Map<string, string>();
  readonly objects = new Map<string, GitObject>();
  readonly issues: Issue[] = [];
  readonly pulls: Pull[] = [];
  readonly labels = new Map<string, Label>();
  nextIssueNumber = 1;
  nextPullNumber = 1;
  nextCommentId = 1;
  seq = 0;
  readonly createdAt: string;

  constructor(id: number, name: string, owner: string, description: string, isPrivate: boolean) {
    this.id = id;
    this.name = name;
    this.owner = owner;
    this.description = description;
    this.isPrivate = isPrivate;
    this.defaultBranch = DEFAULT_BRANCH;
    this.createdAt = this.stamp();
  }

  /** The next deterministic timestamp (ISO, one second per call). */
  stamp(): string {
    this.seq += 1;
    return new Date((CLOCK_BASE_SEC + this.seq) * 1000).toISOString();
  }

  /** The epoch seconds matching the last stamp (for git commit authors). */
  stampEpoch(): number {
    return CLOCK_BASE_SEC + this.seq;
  }

  get key(): string {
    return `${this.owner}/${this.name}`;
  }

  lookup = (oid: string): GitObject | undefined => this.objects.get(oid);

  putObject(type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  refTip(ref: string): string | undefined {
    return this.refs.get(ref);
  }

  defaultTip(): string | undefined {
    return this.refs.get(`refs/heads/${this.defaultBranch}`);
  }

  /** The commit at a ref, or undefined when the ref is unborn. */
  commitAt(ref: string): { oid: string; commit: ReturnType<typeof parseCommit> } | undefined {
    const oid = this.refs.get(ref);
    if (!oid || oid === ZERO_OID) return undefined;
    const object = this.objects.get(oid);
    if (!object || object.type !== 'commit') return undefined;
    return { oid, commit: parseCommit(object.data) };
  }

  /** All refs sorted by name, with HEAD first when the default branch exists. */
  sortedRefs(): Array<{ name: string; oid: string }> {
    return [...this.refs.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, oid]) => ({ name, oid }));
  }

  /** The tree entries at a ref, flattened to path -> { oid, mode }. */
  treeEntriesAt(ref: string): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const tip = this.commitAt(ref);
    if (!tip) return out;
    const walk = (treeOid: string, prefix: string): void => {
      const tree = this.objects.get(treeOid);
      if (!tree || tree.type !== 'tree') return;
      for (const entry of parseTree(tree.data)) {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(tip.commit.tree, '');
    return out;
  }

  /** The blob at a path on a ref, or undefined. */
  fileAt(ref: string, path: string): { oid: string; data: Buffer } | undefined {
    const entry = this.treeEntriesAt(ref).get(path);
    if (!entry) return undefined;
    const object = this.objects.get(entry.oid);
    if (!object || object.type !== 'blob') return undefined;
    return { oid: entry.oid, data: object.data };
  }

  /**
   * Write (or delete, when `data` is null) a file on a branch, as one new
   * commit. Creates the branch when it does not exist yet (an unborn repo
   * gains its default branch this way). Returns the new commit and blob ids.
   */
  commitFile(args: {
    branch: string;
    path: string;
    data: Buffer | null;
    message: string;
  }): { commitOid: string; blobOid: string | null } {
    const ref = `refs/heads/${args.branch}`;
    const parent = this.refs.get(ref);
    const parentCommit = parent ? this.commitAt(ref) : undefined;
    // Start from the parent's tree, or an empty tree.
    const entries = new Map<string, TreeEntry>();
    if (parentCommit) {
      for (const [path, entry] of this.treeEntriesAt(ref)) {
        entries.set(path, { mode: entry.mode, name: path.split('/').pop() ?? path, oid: entry.oid });
      }
    }
    let blobOid: string | null = null;
    if (args.data === null) {
      entries.delete(args.path);
    } else {
      blobOid = this.putObject('blob', args.data);
      entries.set(args.path, { mode: '100644', name: args.path.split('/').pop() ?? args.path, oid: blobOid });
    }
    const treeOid = this.putObject('tree', buildNestedTree(this, entries));
    const author = `${VIEWER.name} <${VIEWER.email}>`;
    const timestamp = this.stampEpoch();
    const commitOid = this.putObject(
      'commit',
      buildCommit({
        tree: treeOid,
        parents: parent && parent !== ZERO_OID ? [parent] : [],
        author,
        committer: author,
        timestamp,
        message: args.message,
      }),
    );
    this.refs.set(ref, commitOid);
    return { commitOid, blobOid };
  }

  /** The ancestry of a ref, newest first (commit oids). */
  ancestry(ref: string): string[] {
    const tip = this.refs.get(ref);
    if (!tip || tip === ZERO_OID) return [];
    const out: string[] = [];
    const seen = new Set<string>();
    const queue = [tip];
    while (queue.length) {
      const oid = queue.shift()!;
      if (seen.has(oid) || oid === ZERO_OID) continue;
      seen.add(oid);
      const object = this.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      out.push(oid);
      queue.push(...parseCommit(object.data).parents);
    }
    return out;
  }

  /** True when `newOid` is a fast-forward from `oldOid` (or a create). */
  fastForwardOk(oldOid: string, newOid: string): boolean {
    if (oldOid === ZERO_OID) return true;
    if (newOid === ZERO_OID) return true;
    return isAncestor(oldOid, newOid, this.lookup);
  }

  /** Peel a ref's tip to its commit (tags included). */
  peeledTip(ref: string): string | undefined {
    const oid = this.refs.get(ref);
    if (!oid) return undefined;
    return peelToCommit(oid, this.lookup);
  }
}

/**
 * Build a nested tree from a flat path -> entry map: group by directory,
 * build subtrees bottom-up, then the root.
 */
export function buildNestedTree(repo: Repo, flat: Map<string, TreeEntry>): Buffer {
  interface Node {
    files: Map<string, TreeEntry>;
    dirs: Map<string, Node>;
  }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, entry] of flat) {
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
    return repo.putObject('tree', buildTree(entries));
  };
  return buildTree(
    [...root.files.entries()].map(([name, entry]) => ({ mode: entry.mode, name, oid: entry.oid })).concat(
      [...root.dirs.entries()].map(([name, child]) => ({ mode: '40000', name, oid: build(child) })),
    ),
  );
}

export interface DiffFile {
  readonly filename: string;
  readonly status: 'added' | 'modified' | 'removed';
  readonly additions: number;
  readonly deletions: number;
  readonly changes: number;
}

function lineCounts(data: Buffer | null): Map<string, number> {
  const counts = new Map<string, number>();
  if (!data) return counts;
  for (const line of data.toString('utf8').split('\n')) {
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  return counts;
}

/** Diff two flat trees: per-path status plus line additions/deletions. */
export function diffTrees(
  base: Map<string, { oid: string }>,
  head: Map<string, { oid: string }>,
  lookup: (oid: string) => GitObject | undefined,
): DiffFile[] {
  const out: DiffFile[] = [];
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b && h && b.oid === h.oid) continue;
    if (!b && h) {
      const data = lookup(h.oid)?.data ?? null;
      const lines = data ? data.toString('utf8').split('\n').length : 0;
      out.push({ filename: path, status: 'added', additions: lines, deletions: 0, changes: lines });
    } else if (b && !h) {
      const data = lookup(b.oid)?.data ?? null;
      const lines = data ? data.toString('utf8').split('\n').length : 0;
      out.push({ filename: path, status: 'removed', additions: 0, deletions: lines, changes: lines });
    } else if (b && h) {
      const oldCounts = lineCounts(lookup(b.oid)?.data ?? null);
      const newCounts = lineCounts(lookup(h.oid)?.data ?? null);
      let additions = 0;
      for (const [line, count] of newCounts) additions += Math.max(0, count - (oldCounts.get(line) ?? 0));
      let deletions = 0;
      for (const [line, count] of oldCounts) deletions += Math.max(0, count - (newCounts.get(line) ?? 0));
      if (additions === 0 && deletions === 0) {
        additions = 1; // the blobs differ but share every line: still a change
      }
      out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return out;
}

/** The store: every repository, keyed by owner/name. */
export class Store {
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 5000;

  createRepo(name: string, owner: string, description: string, isPrivate: boolean): Repo {
    const repo = new Repo(this.nextRepoId, name, owner, description, isPrivate);
    this.nextRepoId += 1;
    this.repos.set(repo.key, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(`${owner}/${name}`);
  }

  /** A repository by its numeric database id, or undefined. */
  getRepoById(id: number): Repo | undefined {
    for (const repo of this.repos.values()) {
      if (repo.id === id) return repo;
    }
    return undefined;
  }

  /** Repositories owned by `owner`, in creation order. */
  reposOf(owner: string): Repo[] {
    return [...this.repos.values()].filter((repo) => repo.owner === owner);
  }

  /** Everything reachable from a repo's refs (for the object store view). */
  reachable(repo: Repo): Set<string> {
    return collectReachable(repo.sortedRefs().map((ref) => ref.oid), repo.lookup);
  }
}

// ---------------------------------------------------------------------------------------------------------
// Merge support, shared by the REST, GraphQL and MCP surfaces.
// ---------------------------------------------------------------------------------------------------------

/** The merge base of two tips: the first commit in the head's ancestry that is also an ancestor of the base. */
export function findMergeBase(repo: Repo, headOid: string, baseOid: string): string | undefined {
  const baseAncestors = new Set<string>();
  const baseQueue = [baseOid];
  while (baseQueue.length) {
    const oid = baseQueue.shift()!;
    if (baseAncestors.has(oid) || oid === '0000000000000000000000000000000000000000') continue;
    baseAncestors.add(oid);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    baseQueue.push(...parseCommit(object.data).parents);
  }
  const headQueue = [headOid];
  const seen = new Set<string>();
  while (headQueue.length) {
    const oid = headQueue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (baseAncestors.has(oid)) return oid;
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    headQueue.push(...parseCommit(object.data).parents);
  }
  return undefined;
}

/** The flat tree entries at a commit oid (not a ref). */
function entriesAtCommit(repo: Repo, commitOid: string): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const object = repo.objects.get(commitOid);
  if (!object || object.type !== 'commit') return out;
  const walk = (treeOid: string, prefix: string): void => {
    const tree = repo.objects.get(treeOid);
    if (!tree || tree.type !== 'tree') return;
    for (const entry of parseTree(tree.data)) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(parseCommit(object.data).tree, '');
  return out;
}

/** True when the head's changes from the merge base conflict with the base tip. */
export function hasMergeConflict(repo: Repo, mergeBaseOid: string, baseRef: string, headRef: string): boolean {
  const baseEntries = entriesAtCommit(repo, mergeBaseOid);
  const headEntries = repo.treeEntriesAt(headRef);
  const changed = diffTrees(baseEntries, headEntries, repo.lookup);
  for (const file of changed) {
    const baseVersion = repo.fileAt(baseRef, file.filename)?.oid;
    const mergeBaseVersion = baseEntries.get(file.filename)?.oid;
    const headVersion = headEntries.get(file.filename)?.oid;
    if (baseVersion !== mergeBaseVersion && baseVersion !== headVersion) return true;
  }
  return false;
}

/**
 * Squash-merge an open pull request: one commit on the base branch carrying
 * the head's tree. Returns the outcome; on conflict nothing is written.
 * The caller checks the pull is open and both branch tips exist first.
 */
export function mergePullRequest(
  repo: Repo,
  pull: Pull,
  ownerLogin: string,
): { merged: boolean; conflict: boolean; sha: string | null } {
  const headTip = repo.refs.get(`refs/heads/${pull.head.ref}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.base.ref}`);
  if (!headTip || !baseTip) return { merged: false, conflict: false, sha: null };
  const mergeBaseOid = findMergeBase(repo, headTip, baseTip);
  const baseRef = `refs/heads/${pull.base.ref}`;
  const headRef = `refs/heads/${pull.head.ref}`;
  const conflict = mergeBaseOid ? hasMergeConflict(repo, mergeBaseOid, baseRef, headRef) : false;
  if (conflict) return { merged: false, conflict: true, sha: null };
  const headEntries = repo.treeEntriesAt(headRef);
  const treeEntries = new Map(
    [...headEntries.entries()].map(([path, entry]) => [
      path,
      { mode: entry.mode, name: path.split('/').pop() ?? path, oid: entry.oid },
    ]),
  );
  const treeOid = repo.putObject('tree', buildNestedTree(repo, treeEntries));
  const author = `${VIEWER.name} <${VIEWER.email}>`;
  const timestamp = repo.stampEpoch();
  const message = `Merge pull request #${pull.number} from ${ownerLogin}/${pull.head.ref}\n\n${pull.title}`;
  const mergeCommitOid = repo.putObject(
    'commit',
    buildCommit({ tree: treeOid, parents: [baseTip], author, committer: author, timestamp, message }),
  );
  repo.refs.set(baseRef, mergeCommitOid);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = repo.stamp();
  pull.mergeCommitSha = mergeCommitOid;
  pull.updatedAt = pull.mergedAt;
  return { merged: true, conflict: false, sha: mergeCommitOid };
}
