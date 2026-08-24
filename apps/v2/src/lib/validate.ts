export const TRACE_LEN = 20;
export const NODE_KINDS = ['workspace', 'architect', 'builder'] as const;
export const FRAME_TYPES = ['snapshot', 'node', 'gone', 'counts', 'tick', 'dark', 'resumed'] as const;

export type NodeKind = (typeof NODE_KINDS)[number];
export type FrameType = (typeof FRAME_TYPES)[number];

export type ClientNode = {
  id: string;
  kind: NodeKind;
  parentId: string | null;
  name: string;
  status: string;
  flags: { heldMail: boolean };
  lastDataAt: string | null;
  buckets?: number[];
};

export type ClientCounts = {
  workspaces: number;
  builders: { total: number; byStatus: Record<string, number> };
  gateWaiting: number;
};

export type ValidatedSnapshot = {
  seq: number;
  type: 'snapshot';
  streamId: string;
  resumed: boolean;
  nodes: ClientNode[];
  counts: ClientCounts;
};

export type ValidatedNode = { seq: number; type: 'node'; node: ClientNode };
export type ValidatedGone = { seq: number; type: 'gone'; id: string };
export type ValidatedCounts = { seq: number; type: 'counts'; counts: ClientCounts };
export type ValidatedTick = { seq: number; type: 'tick'; at: string; buckets: Record<string, number> };
export type ValidatedDark = { seq: number; type: 'dark'; id: string; reason: string; path: string };
export type ValidatedResumed = { seq: number; type: 'resumed'; from: number };

export type ValidatedFrame =
  | ValidatedSnapshot
  | ValidatedNode
  | ValidatedGone
  | ValidatedCounts
  | ValidatedTick
  | ValidatedDark
  | ValidatedResumed;

export type Mismatch = {
  how: 'invalid-json' | 'unknown-type' | 'bad-field';
  afterSeq: number;
  preview?: string;
  seq?: number;
  type?: string;
  field?: string;
};

export type ValidateOk = { ok: true; frame: ValidatedFrame };
export type ValidateErr = { ok: false; mismatch: Mismatch };
export type ValidateResult = ValidateOk | ValidateErr;

function isSafeNonNegInt(n: unknown): n is number {
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
}

function isNonNegInt(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 && Number.isFinite(n);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function fail(afterSeq: number, field: string, obj: Record<string, unknown>): ValidateErr {
  return {
    ok: false,
    mismatch: {
      how: 'bad-field',
      afterSeq,
      type: typeof obj.type === 'string' ? obj.type : undefined,
      seq: typeof obj.seq === 'number' ? obj.seq : undefined,
      field,
    },
  };
}

function escapePreview(s: string): string {
  return s.slice(0, 120).replace(/[^\x20-\x7e]/g, (ch) => {
    const hex = ch.charCodeAt(0).toString(16).padStart(2, '0');
    return `\\x${hex}`;
  });
}

function validateCounts(raw: unknown): ClientCounts | string {
  if (!isPlainObject(raw)) return 'counts';
  if (!isNonNegInt(raw.workspaces)) return 'counts.workspaces';
  if (!isPlainObject(raw.builders)) return 'counts.builders';
  if (!isNonNegInt(raw.builders.total)) return 'counts.builders.total';
  if (!isPlainObject(raw.builders.byStatus)) return 'counts.builders.byStatus';
  for (const v of Object.values(raw.builders.byStatus)) {
    if (!isNonNegInt(v)) return 'counts.builders.byStatus';
  }
  if (!isNonNegInt(raw.gateWaiting)) return 'counts.gateWaiting';
  const byStatus: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw.builders.byStatus)) {
    byStatus[k] = v as number;
  }
  return {
    workspaces: raw.workspaces,
    builders: { total: raw.builders.total, byStatus },
    gateWaiting: raw.gateWaiting,
  };
}

function validateNode(raw: unknown): ClientNode | string {
  if (!isPlainObject(raw)) return 'node';
  if (typeof raw.id !== 'string' || raw.id === '') return 'id';
  if (raw.kind !== 'workspace' && raw.kind !== 'architect' && raw.kind !== 'builder') return 'kind';
  if (!(typeof raw.parentId === 'string' || raw.parentId === null)) return 'parentId';
  if (typeof raw.name !== 'string') return 'name';
  if (typeof raw.status !== 'string') return 'status';
  if (!isPlainObject(raw.flags) || typeof raw.flags.heldMail !== 'boolean') return 'flags.heldMail';
  if (!(typeof raw.lastDataAt === 'string' || raw.lastDataAt === null)) return 'lastDataAt';
  if (raw.buckets !== undefined) {
    if (!Array.isArray(raw.buckets) || raw.buckets.some((n) => typeof n !== 'number' || !Number.isFinite(n))) {
      return 'buckets';
    }
  }
  return {
    id: raw.id,
    kind: raw.kind,
    parentId: raw.parentId,
    name: raw.name,
    status: raw.status,
    flags: { heldMail: raw.flags.heldMail },
    lastDataAt: raw.lastDataAt,
    buckets: raw.buckets as number[] | undefined,
  };
}

function parseDarkId(id: string): string | null {
  if (!id.startsWith('workspace:')) return null;
  const path = id.slice('workspace:'.length);
  return path === '' ? null : path;
}

export function validateFrame(obj: unknown, afterSeq: number): ValidateResult {
  if (!isPlainObject(obj)) {
    return { ok: false, mismatch: { how: 'bad-field', afterSeq, field: 'type' } };
  }
  if (!isSafeNonNegInt(obj.seq)) {
    return fail(afterSeq, 'seq', obj);
  }
  if (typeof obj.type !== 'string') {
    return fail(afterSeq, 'type', obj);
  }
  if (!(FRAME_TYPES as readonly string[]).includes(obj.type)) {
    return {
      ok: false,
      mismatch: {
        how: 'unknown-type',
        afterSeq,
        type: obj.type,
        seq: obj.seq,
      },
    };
  }

  switch (obj.type) {
    case 'snapshot': {
      if (typeof obj.streamId !== 'string' || obj.streamId === '') return fail(afterSeq, 'streamId', obj);
      if (typeof obj.resumed !== 'boolean') return fail(afterSeq, 'resumed', obj);
      if (!Array.isArray(obj.nodes)) return fail(afterSeq, 'nodes', obj);
      const nodes: ClientNode[] = [];
      for (const el of obj.nodes) {
        const n = validateNode(el);
        if (typeof n === 'string') return fail(afterSeq, `nodes.${n}`, obj);
        nodes.push(n);
      }
      const counts = validateCounts(obj.counts);
      if (typeof counts === 'string') return fail(afterSeq, counts, obj);
      return {
        ok: true,
        frame: {
          seq: obj.seq,
          type: 'snapshot',
          streamId: obj.streamId,
          resumed: obj.resumed,
          nodes,
          counts,
        },
      };
    }
    case 'node': {
      const n = validateNode(obj.node);
      if (typeof n === 'string') return fail(afterSeq, `node.${n}`, obj);
      return { ok: true, frame: { seq: obj.seq, type: 'node', node: n } };
    }
    case 'gone': {
      if (typeof obj.id !== 'string' || obj.id === '') return fail(afterSeq, 'id', obj);
      return { ok: true, frame: { seq: obj.seq, type: 'gone', id: obj.id } };
    }
    case 'counts': {
      const counts = validateCounts(obj.counts);
      if (typeof counts === 'string') return fail(afterSeq, counts, obj);
      return { ok: true, frame: { seq: obj.seq, type: 'counts', counts } };
    }
    case 'tick': {
      if (typeof obj.at !== 'string') return fail(afterSeq, 'at', obj);
      if (!isPlainObject(obj.buckets)) return fail(afterSeq, 'buckets', obj);
      const buckets: Record<string, number> = {};
      for (const [k, v] of Object.entries(obj.buckets)) {
        if (typeof v !== 'number' || !Number.isFinite(v)) return fail(afterSeq, 'buckets', obj);
        buckets[k] = v;
      }
      return { ok: true, frame: { seq: obj.seq, type: 'tick', at: obj.at, buckets } };
    }
    case 'dark': {
      if (typeof obj.id !== 'string') return fail(afterSeq, 'id', obj);
      const path = parseDarkId(obj.id);
      if (path === null) return fail(afterSeq, 'id', obj);
      if (typeof obj.reason !== 'string') return fail(afterSeq, 'reason', obj);
      return { ok: true, frame: { seq: obj.seq, type: 'dark', id: obj.id, reason: obj.reason, path } };
    }
    case 'resumed': {
      if (!isSafeNonNegInt(obj.from)) return fail(afterSeq, 'from', obj);
      return { ok: true, frame: { seq: obj.seq, type: 'resumed', from: obj.from } };
    }
    default:
      return {
        ok: false,
        mismatch: { how: 'unknown-type', afterSeq, type: obj.type, seq: obj.seq },
      };
  }
}

export function parseAndValidate(line: string, afterSeq: number): ValidateResult {
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return {
      ok: false,
      mismatch: {
        how: 'invalid-json',
        afterSeq,
        preview: escapePreview(line),
      },
    };
  }
  return validateFrame(obj, afterSeq);
}
