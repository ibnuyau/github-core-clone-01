// githttp.ts — git smart HTTP: info/refs (v0 + v2), upload-pack (v0 + v2
// fetch + ls-refs), receive-pack (v0). All packing done in TypeScript.
import {
  decodePktLines, encodePktLine, isObjectId, PKT_FLUSH, readPack, writePack,
  ZERO_OID, parseCommit, parseTree, type GitObject,
} from './gitcore.ts';
import {
  branchTip, getObject, isAncestor, peelToCommit, putObject, type Repo,
} from './store.ts';

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

const ok = (contentType: string, body: Buffer, status = 200): HttpResponse => ({
  status,
  headers: { 'content-type': contentType, 'cache-control': 'no-cache' },
  body,
});

const notFound = (): HttpResponse => ({
  status: 404,
  headers: { 'content-type': 'application/json' },
  body: Buffer.from(JSON.stringify({ message: 'Not Found' })),
});

/** pkt-line for a payload; pktFlush() is the flush packet. */
const pktLine = (payload: string | Buffer): Buffer => encodePktLine(payload);
const pktFlush = (): Buffer => PKT_FLUSH;

/**
 * Decode a request body into lines: data packets as strings, flush/delim
 * packets as null. Anything after the last decodable pkt-line (the raw
 * pack in a receive-pack) is returned as trailing bytes.
 */
function readPktLines(body: Buffer): { lines: (string | null)[]; trailing: Buffer } {
  const { packets, trailing } = decodePktLines(body);
  const lines: (string | null)[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
    else if (packet.kind === 'flush' || packet.kind === 'delim') lines.push(null);
  }
  return { lines, trailing };
}

/** The v0 advertisement capabilities (same first-line order the client expects). */
function uploadPackCaps(repo: Repo): string {
  return `symref=HEAD:refs/heads/${repo.defaultBranch} side-band-64k thin-pack ofs-delta shallow agent=forge/1.0`;
}

function receivePackCaps(repo: Repo): string {
  return `symref=HEAD:refs/heads/${repo.defaultBranch} report-status side-band-64k delete-refs ofs-delta agent=forge/1.0`;
}

interface RefLine { oid: string; name: string; peeled: string | null; }

/** All refs of the repo, sorted, with peeled tag targets. */
export function refLines(repo: Repo): RefLine[] {
  const names = [...repo.refs.keys()].sort();
  const out: RefLine[] = [];
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    const object = getObject(repo, oid);
    const peeled = object && object.type === 'tag' ? peelToCommit(repo, oid) : null;
    out.push({ oid, name, peeled });
  }
  return out;
}

function advertisedHead(repo: Repo): string | null {
  return branchTip(repo, repo.defaultBranch) ?? null;
}

/** GET /{owner}/{repo}.git/info/refs?service=git-upload-pack|git-receive-pack */
export function handleInfoRefs(
  repo: Repo | undefined,
  service: string,
  gitProtocol: string,
): HttpResponse {
  if (!repo) return notFound();
  if (service === 'git-upload-pack') {
    if (gitProtocol === 'version=2') {
      const body = Buffer.concat([
        pktLine('version 2'),
        pktLine('ls-refs=unborn'),
        pktLine('fetch=shallow filter'),
        pktLine('object-format=sha1'),
        pktLine('agent=forge/1.0'),
        pktFlush(),
      ]);
      return ok('application/x-git-upload-pack-advertisement', body);
    }
    const lines: Buffer[] = [];
    lines.push(pktLine('# service=git-upload-pack'));
    lines.push(pktFlush());
    const refs = refLines(repo);
    const head = advertisedHead(repo);
    if (refs.length === 0) {
      lines.push(pktLine(`${ZERO_OID} capabilities^{}\0${uploadPackCaps(repo)}`));
    } else {
      let first = true;
      if (head !== null) {
        lines.push(pktLine(`${head} HEAD\0${uploadPackCaps(repo)}`));
        first = false;
      }
      for (const ref of refs) {
        const caps = first ? `\0${uploadPackCaps(repo)}` : '';
        first = false;
        lines.push(pktLine(`${ref.oid} ${ref.name}${caps}`));
        if (ref.peeled !== null) lines.push(pktLine(`${ref.peeled} ${ref.name}^{}`));
      }
    }
    return ok('application/x-git-upload-pack-advertisement', Buffer.concat(lines));
  }
  if (service === 'git-receive-pack') {
    const lines: Buffer[] = [
      pktLine('# service=git-receive-pack'),
      pktFlush(),
    ];
    const refs = refLines(repo);
    const head = advertisedHead(repo);
    if (refs.length === 0) {
      lines.push(pktLine(`${ZERO_OID} capabilities^{}\0${receivePackCaps(repo)}`));
    } else {
      let first = true;
      if (head !== null) {
        lines.push(pktLine(`${head} HEAD\0${receivePackCaps(repo)}`));
        first = false;
      }
      for (const ref of refs) {
        const caps = first ? `\0${receivePackCaps(repo)}` : '';
        first = false;
        lines.push(pktLine(`${ref.oid} ${ref.name}${caps}`));
        if (ref.peeled !== null) lines.push(pktLine(`${ref.peeled} ${ref.name}^{}`));
      }
    }
    return ok('application/x-git-receive-pack-advertisement', Buffer.concat(lines));
  }
  return notFound();
}

// ---------------------------------------------------------------- upload-pack v2

/**
 * Parse a v2 request body into its command and arguments. A v2 request is a
 * single command: `command=<name>` first, then arguments on both sides of
 * the delim packet (delim and flush do not end the command). Arguments are
 * `key=value`, `key value`, or a bare word.
 */
function parseV2Request(body: Buffer): { command: string; args: Map<string, string[]> } {
  const { lines } = readPktLines(body);
  let command = '';
  const args = new Map<string, string[]>();
  for (const rawLine of lines) {
    if (rawLine === null) continue;
    // Clients send each line with a trailing newline; strip it.
    const line = rawLine.replace(/[\r\n]+$/, '');
    if (line === '') continue;
    if (line.startsWith('command=')) {
      command = line.slice('command='.length);
      continue;
    }
    let key: string;
    let value: string;
    const eq = line.indexOf('=');
    const space = line.indexOf(' ');
    if (eq !== -1 && (space === -1 || eq < space)) {
      key = line.slice(0, eq);
      value = line.slice(eq + 1);
    } else if (space !== -1) {
      key = line.slice(0, space);
      value = line.slice(space + 1);
    } else {
      key = line;
      value = '';
    }
    if (!args.has(key)) args.set(key, []);
    args.get(key)!.push(value);
  }
  return { command, args };
}

/** Objects to send for a fetch, following the shallow rules the suite expects. */
interface FetchPlan {
  send: Map<string, GitObject>;
  shallow: string[];
  unshallow: string[];
}

function planFetch(
  repo: Repo,
  wants: string[],
  haves: string[],
  depth: number | null,
  oldShallow: string[],
): FetchPlan {
  const shallowSet = new Set(oldShallow);
  // BFS from wants with depth. depth===null means unlimited.
  const wantDepth = new Map<string, number>();
  const queue: { oid: string; depth: number }[] = [];
  for (const want of wants) {
    if (wantDepth.has(want)) continue;
    wantDepth.set(want, 1);
    queue.push({ oid: want, depth: 1 });
  }
  const send = new Map<string, GitObject>();
  const newShallow: string[] = [];
  let head = 0;
  while (head < queue.length) {
    const { oid, depth: d } = queue[head++]!;
    const object = getObject(repo, oid);
    if (!object) continue;
    if (depth !== null && d > depth) continue;
    send.set(oid, object);
    if (object.type === 'commit') {
      const parsed = parseCommit(object.data);
      // The tree (and its blobs) belong to the commit at any depth; only
      // descending to parents stops at the boundary.
      queue.push({ oid: parsed.tree, depth: d });
      if (depth !== null && d === depth) {
        if (!newShallow.includes(oid)) newShallow.push(oid);
        continue; // do not descend past the depth boundary
      }
      for (const parent of parsed.parents) {
        if (!wantDepth.has(parent)) {
          wantDepth.set(parent, d + 1);
          queue.push({ oid: parent, depth: d + 1 });
        }
      }
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) queue.push({ oid: entry.oid, depth: d });
    } else if (object.type === 'tag') {
      const target = object.data.toString('utf8').split('\n').find((l) => l.startsWith('object '))?.slice(7).trim();
      if (target) queue.push({ oid: target, depth: d });
    }
  }
  // Client-held objects: the closure from haves, never descending past an
  // old-shallow commit (it contributes itself, its tree, and its blobs only).
  const held = new Set<string>();
  const holdQueue: string[] = [...haves];
  while (holdQueue.length) {
    const oid = holdQueue.pop()!;
    if (held.has(oid)) continue;
    held.add(oid);
    const object = getObject(repo, oid);
    if (!object) continue;
    if (object.type === 'commit') {
      const parsed = parseCommit(object.data);
      holdQueue.push(parsed.tree);
      if (shallowSet.has(oid)) continue; // boundary: tree + blobs only
      for (const parent of parsed.parents) holdQueue.push(parent);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) holdQueue.push(entry.oid);
    } else if (object.type === 'tag') {
      const target = object.data.toString('utf8').split('\n').find((l) => l.startsWith('object '))?.slice(7).trim();
      if (target) holdQueue.push(target);
    }
  }
  for (const oid of held) send.delete(oid);
  // Unshallow: old-shallow commits inside the walk at a depth below the boundary.
  const unshallow: string[] = [];
  for (const old of oldShallow) {
    const d = wantDepth.get(old);
    if (d !== undefined && (depth === null || d < depth)) unshallow.push(old);
  }
  return { send, shallow: newShallow.sort(), unshallow: unshallow.sort() };
}

/** Sideband-encode a pack into band-1 packets (≤ 65515 bytes of payload each). */
function sidebandPack(pack: Buffer): Buffer {
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < pack.length; offset += 65515) {
    const slice = pack.subarray(offset, Math.min(pack.length, offset + 65515));
    const payload = Buffer.concat([Buffer.from([1]), slice]);
    chunks.push(pktLine(payload));
  }
  chunks.push(pktFlush());
  return Buffer.concat(chunks);
}

/** Handle POST git-upload-pack: v2 when the request begins with `command=`, else v0. */
export function handleUploadPack(repo: Repo | undefined, body: Buffer, gitProtocol: string): HttpResponse {
  if (!repo) return notFound();
  const { command, args } = parseV2Request(body);
  const isV2 = command === 'ls-refs' || command === 'fetch';

  if (isV2 && command === 'ls-refs') {
    const prefix = args.get('ref-prefix') ?? [];
    const wantPeel = args.has('peel');
    const wantSymrefs = args.has('symrefs');
    const wantUnborn = args.has('unborn');
    const refs = refLines(repo);
    const lines: Buffer[] = [];
    const head = advertisedHead(repo);
    const matches = (name: string): boolean => prefix.length === 0 || prefix.some((p) => name.startsWith(p));
    if (head !== null && matches('HEAD')) {
      lines.push(pktLine(`${head} HEAD${wantSymrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`));
    }
    for (const ref of refs) {
      if (!matches(ref.name)) continue;
      lines.push(pktLine(`${ref.oid} ${ref.name}${ref.peeled !== null && wantPeel ? ` peeled:${ref.peeled}` : ''}\n`));
    }
    if (head === null && wantUnborn) {
      lines.push(pktLine(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
    }
    lines.push(pktFlush());
    return ok('application/x-git-upload-pack-result', Buffer.concat(lines));
  }

  if (isV2 && command === 'fetch') {
    const wants = args.get('want') ?? [];
    const haves = args.get('have') ?? [];
    const depthArg = args.get('deepen')?.[0] ?? args.get('depth')?.[0];
    const depth = depthArg !== undefined ? parseInt(depthArg, 10) : null;
    const oldShallow = args.get('shallow') ?? [];
    const plan = planFetch(repo, wants, haves, depth, oldShallow);
    const out: Buffer[] = [];
    // acknowledgments
    out.push(pktLine('acknowledgments\n'));
    const knownHaves = haves.filter((have) => repo.objects.has(have));
    if (knownHaves.length === 0) {
      out.push(pktLine('NAK\n'));
    } else {
      for (const have of knownHaves) out.push(pktLine(`ACK ${have}\n`));
      out.push(pktLine('ready\n'));
    }
    out.push(pktFlush());
    // shallow-info
    if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
      out.push(pktLine('shallow-info\n'));
      for (const oid of plan.shallow) out.push(pktLine(`shallow ${oid}\n`));
      for (const oid of plan.unshallow) out.push(pktLine(`unshallow ${oid}\n`));
      out.push(pktFlush());
    }
    // packfile
    if (plan.send.size > 0) {
      out.push(pktLine('packfile\n'));
      out.push(sidebandPack(writePack(plan.send.values())));
    }
    return ok('application/x-git-upload-pack-result', Buffer.concat(out));
  }

  // v0 fetch: wants + shallow/deepen lines, flush, haves + done, flush.
  const { lines } = readPktLines(body);
  const wants: string[] = [];
  const haves: string[] = [];
  let depth: number | null = null;
  const oldShallow: string[] = [];
  for (const line of lines) {
    if (line === null) continue;
    const clean = line.replace(/[^ -~]/g, '').trim();
    if (clean.startsWith('want ')) wants.push(clean.slice(5, 45));
    else if (clean.startsWith('have ')) haves.push(clean.slice(5, 45));
    else if (clean.startsWith('shallow ')) oldShallow.push(clean.slice(8, 48));
    else if (clean.startsWith('deepen ')) {
      const n = parseInt(clean.slice(7).trim(), 10);
      if (!Number.isNaN(n)) depth = n;
    } else if (clean.startsWith('deepen-since') || clean.startsWith('deepen-not')) {
      depth = null;
    }
  }
  const plan = planFetch(repo, wants, haves, depth, oldShallow);
  const out: Buffer[] = [];
  if (haves.length === 0) {
    out.push(pktLine('NAK'));
  } else {
    for (const have of haves) {
      if (repo.objects.has(have)) out.push(pktLine(`ACK ${have}`));
    }
  }
  for (const oid of plan.shallow) out.push(pktLine(`shallow ${oid}`));
  for (const oid of plan.unshallow) out.push(pktLine(`unshallow ${oid}`));
  if (plan.send.size > 0) {
    out.push(sidebandPack(writePack(plan.send.values())));
  }
  return ok('application/x-git-upload-pack-result', Buffer.concat(out));
}

// ---------------------------------------------------------------- receive-pack v0

interface RefCommand { oldOid: string; newOid: string; ref: string; }

/** Handle POST git-receive-pack (v0): unpack the pack, apply ref updates. */
export function handleReceivePack(repo: Repo | undefined, body: Buffer): HttpResponse {
  if (!repo) return notFound();
  const { lines, trailing } = readPktLines(body);
  const commands: RefCommand[] = [];
  for (const line of lines) {
    if (line === null) continue;
    // The first command line carries capabilities after a NUL byte; the ref
    // name ends at the NUL.
    const head = line.includes('\0') ? line.slice(0, line.indexOf('\0')) : line;
    const clean = head.replace(/[^ -~]/g, '').trim();
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (.+)$/.exec(clean);
    if (match) commands.push({ oldOid: match[1]!, newOid: match[2]!, ref: match[3]! });
  }
  // The pack is the trailing raw bytes after the pkt-lines (it starts with
  // "PACK", which is not a valid pkt-line length, so decodePktLines stops).
  const packBuf = trailing;
  // Store the pack's objects (if any). REF_DELTA bases resolve from the store.
  if (packBuf.length > 0) {
    const { objects } = readPack(packBuf, (oid) => getObject(repo, oid));
    for (const object of objects.values()) {
      putObject(repo, object.type, object.data);
    }
  }
  // Apply the ref updates.
  const results: { ref: string; ok: boolean; reason?: string }[] = [];
  for (const cmd of commands) {
    const current = repo.refs.get(cmd.ref);
    if (cmd.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        results.push({ ref: cmd.ref, ok: false, reason: 'reference does not exist' });
      } else if (current !== cmd.oldOid) {
        results.push({ ref: cmd.ref, ok: false, reason: 'old value does not match' });
      } else {
        repo.refs.delete(cmd.ref);
        results.push({ ref: cmd.ref, ok: true });
      }
      continue;
    }
    if (cmd.oldOid === ZERO_OID) {
      // Create.
      if (current !== undefined) {
        results.push({ ref: cmd.ref, ok: false, reason: 'reference already exists' });
        continue;
      }
      if (!repo.objects.has(cmd.newOid)) {
        results.push({ ref: cmd.ref, ok: false, reason: 'object not found' });
        continue;
      }
      repo.refs.set(cmd.ref, cmd.newOid);
      results.push({ ref: cmd.ref, ok: true });
      continue;
    }
    // Update.
    if (current === undefined) {
      results.push({ ref: cmd.ref, ok: false, reason: 'reference does not exist' });
    } else if (current !== cmd.oldOid) {
      results.push({ ref: cmd.ref, ok: false, reason: 'old value does not match' });
    } else if (!isAncestor(repo, cmd.oldOid, cmd.newOid)) {
      results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
    } else {
      repo.refs.set(cmd.ref, cmd.newOid);
      results.push({ ref: cmd.ref, ok: true });
    }
  }
  const textLines: string[] = ['unpack ok'];
  for (const result of results) {
    textLines.push(result.ok ? `ok ${result.ref}` : `ng ${result.ref} ${result.reason ?? 'rejected'}`);
  }
  const bodyText = textLines.join('\n') + '\n';
  const payload = Buffer.concat([Buffer.from([1]), Buffer.from(bodyText, 'utf8')]);
  const out = Buffer.concat([pktLine(payload), pktFlush()]);
  return ok('application/x-git-receive-pack-result', out);
}

export { isObjectId };
