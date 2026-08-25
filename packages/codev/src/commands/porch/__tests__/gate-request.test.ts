import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { approve, gate, parseGateArgs, rollback } from '../index.js';
import {
  GateRequestError,
  normalizeGateRequest,
  readGateRequestFile,
} from '../gate-request.js';
import { getStatusPath, readState, writeState } from '../state.js';
import type { ProjectState } from '../types.js';

const protocol = {
  name: 'gate-request-test',
  version: '1.0.0',
  phases: [
    { id: 'specify', name: 'Specify', gate: 'spec-approval' },
    { id: 'plan', name: 'Plan', gate: 'plan-approval' },
    { id: 'implement', name: 'Implement' },
  ],
};

const validRequest = {
  question: 'Delete the legacy table?',
  choices: [
    {
      label: 'Delete it',
      consequence: 'Migrate references, drop the table, and run checkout tests.',
      recommended: true,
    },
    {
      label: 'Keep it',
      consequence: 'Retain the table for audit access.',
    },
  ],
  terminalExcerpt: '\u001b[33mwarning\u001b[0m\r\n\tcheckout failed',
};

let testDir: string;
let statusPath: string;

function makeState(overrides: Partial<ProjectState> = {}): ProjectState {
  return {
    id: '128',
    title: 'gate-content',
    protocol: protocol.name,
    phase: 'plan',
    plan_phases: [],
    current_plan_phase: null,
    gates: {},
    iteration: 1,
    build_complete: false,
    history: [],
    started_at: '2026-08-25T00:00:00.000Z',
    updated_at: '2026-08-25T00:00:00.000Z',
    ...overrides,
  };
}

function writeRequest(value: unknown, name = 'request.json'): string {
  const file = path.join(testDir, name);
  fs.writeFileSync(file, JSON.stringify(value));
  return path.relative(testDir, file);
}

function requestAtSerializedBytes(target: number): unknown {
  const request = {
    question: 'x'.repeat(1024),
    choices: Array.from({ length: 5 }, () => ({
      label: 'x'.repeat(256),
      consequence: 'x'.repeat(2048),
    })),
    terminalExcerpt: 'x'.repeat(16 * 1024),
  };
  let extraEscapes = target - Buffer.byteLength(JSON.stringify(request));
  if (extraEscapes < 0) throw new Error('target is smaller than the maximum-field fixture');
  for (const choice of request.choices) {
    const count = Math.min(extraEscapes, choice.consequence.length);
    choice.consequence = '\\'.repeat(count) + choice.consequence.slice(count);
    extraEscapes -= count;
  }
  if (extraEscapes > 0) {
    request.terminalExcerpt = '\\'.repeat(extraEscapes) + request.terminalExcerpt.slice(extraEscapes);
    extraEscapes = 0;
  }
  expect(extraEscapes).toBe(0);
  expect(Buffer.byteLength(JSON.stringify(request))).toBe(target);
  return request;
}

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'porch-gate-request-'));
  const protocolDir = path.join(testDir, 'codev', 'protocols', protocol.name);
  fs.mkdirSync(protocolDir, { recursive: true });
  fs.writeFileSync(path.join(protocolDir, 'protocol.json'), JSON.stringify(protocol));
  statusPath = getStatusPath(testDir, '128', 'gate-content');
  fs.mkdirSync(path.dirname(statusPath), { recursive: true });
  writeState(statusPath, makeState());
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(testDir, { recursive: true, force: true });
});

describe('gate request normalization', () => {
  it('trims decision text and sanitizes terminal output into the persisted shape', () => {
    expect(normalizeGateRequest({
      question: '  Continue?  ',
      choices: [{ label: ' Yes ', consequence: ' Do it ', recommended: false }],
      terminalExcerpt: '\u001b]0;title\u0007\u001b[31mred\u001b[0m\r\n\tline',
    })).toEqual({
      question: 'Continue?',
      choices: [{ label: 'Yes', consequence: 'Do it', recommended: false }],
      terminalExcerpt: 'red\n\tline',
    });
  });

  it('strips each ST-terminated OSC sequence without deleting visible hyperlink text', () => {
    expect(normalizeGateRequest({
      question: 'Continue?',
      choices: [{ label: 'Yes', consequence: 'Do it' }],
      terminalExcerpt:
        '\u001b]8;;https://example.test\u001b\\visible label\u001b]8;;\u001b\\ after'
        + '\u001b]0;new title\u001b\\ text',
    }).terminalExcerpt).toBe('visible label after text');
  });

  it('strips charset escapes and ST-terminated ANSI string controls with their payloads', () => {
    expect(normalizeGateRequest({
      question: 'Continue?',
      choices: [{ label: 'Yes', consequence: 'Do it' }],
      terminalExcerpt:
        '\u001b(BASCII '
        + '\u001bP1;2|fabricated DCS payload\u001b\\visible '
        + '\u0098fabricated SOS payload\u009clast',
    }).terminalExcerpt).toBe('ASCII visible last');
  });

  it('rejects unterminated ANSI string controls instead of exposing their payloads', () => {
    expect(() => normalizeGateRequest({
      question: 'Continue?',
      choices: [{ label: 'Yes', consequence: 'Do it' }],
      terminalExcerpt: '\u001b]0;unterminated title',
    })).toThrow(/terminalExcerpt: contains a prohibited control character/);
  });

  it('accepts exactly five choices and at most one recommendation', () => {
    const choices = Array.from({ length: 5 }, (_, index) => ({
      label: `Choice ${index}`,
      consequence: `Consequence ${index}`,
      ...(index === 4 ? { recommended: true } : {}),
    }));
    expect(normalizeGateRequest({ question: 'Choose', choices }).choices).toHaveLength(5);
  });

  it.each([
    ['a non-object request', null],
    ['an empty question', { question: '  ', choices: [{ label: 'A', consequence: 'B' }] }],
    ['no choices', { question: 'Q', choices: [] }],
    ['six choices', {
      question: 'Q',
      choices: Array.from({ length: 6 }, () => ({ label: 'A', consequence: 'B' })),
    }],
    ['an empty label', { question: 'Q', choices: [{ label: '', consequence: 'B' }] }],
    ['an empty consequence', { question: 'Q', choices: [{ label: 'A', consequence: '' }] }],
    ['two recommendations', {
      question: 'Q',
      choices: [
        { label: 'A', consequence: 'B', recommended: true },
        { label: 'C', consequence: 'D', recommended: true },
      ],
    }],
    ['a nonboolean recommendation', {
      question: 'Q', choices: [{ label: 'A', consequence: 'B', recommended: 1 }],
    }],
    ['an unknown request field', {
      question: 'Q', choices: [{ label: 'A', consequence: 'B' }], context: 'hidden',
    }],
    ['an unknown choice field', {
      question: 'Q', choices: [{ label: 'A', consequence: 'B', effect: 'hidden' }],
    }],
    ['a decision control', {
      question: 'Q\nQ', choices: [{ label: 'A', consequence: 'B' }],
    }],
    ['a terminal control', {
      question: 'Q', choices: [{ label: 'A', consequence: 'B' }], terminalExcerpt: 'bad\rline',
    }],
    ['a bidirectional isolate', {
      question: 'Q', choices: [{ label: 'A\u2066', consequence: 'B' }],
    }],
  ])('rejects %s', (_label, value) => {
    expect(() => normalizeGateRequest(value)).toThrow(GateRequestError);
  });

  it('enforces field limits in UTF-8 bytes rather than code points', () => {
    expect(() => normalizeGateRequest({
      question: 'é'.repeat(513),
      choices: [{ label: 'A', consequence: 'B' }],
    })).toThrow(/question: exceeds 1024 UTF-8 bytes/);
    expect(() => normalizeGateRequest({
      question: 'Q',
      choices: [{ label: 'é'.repeat(129), consequence: 'B' }],
    })).toThrow(/label: exceeds 256 UTF-8 bytes/);
  });

  it.each([
    ['question', 1024, (length: number) => ({
      question: 'x'.repeat(length), choices: [{ label: 'A', consequence: 'B' }],
    })],
    ['label', 256, (length: number) => ({
      question: 'Q', choices: [{ label: 'x'.repeat(length), consequence: 'B' }],
    })],
    ['consequence', 2048, (length: number) => ({
      question: 'Q', choices: [{ label: 'A', consequence: 'x'.repeat(length) }],
    })],
    ['terminalExcerpt', 16 * 1024, (length: number) => ({
      question: 'Q',
      choices: [{ label: 'A', consequence: 'B' }],
      terminalExcerpt: 'x'.repeat(length),
    })],
  ] as const)('accepts %s at limit-1 and limit, then rejects limit+1', (_field, limit, fixture) => {
    expect(() => normalizeGateRequest(fixture(limit - 1))).not.toThrow();
    expect(() => normalizeGateRequest(fixture(limit))).not.toThrow();
    expect(() => normalizeGateRequest(fixture(limit + 1))).toThrow(/exceeds/);
  });

  it('accepts the complete request at 32 KiB - 1 and 32 KiB, then rejects + 1', () => {
    expect(() => normalizeGateRequest(requestAtSerializedBytes((32 * 1024) - 1))).not.toThrow();
    expect(() => normalizeGateRequest(requestAtSerializedBytes(32 * 1024))).not.toThrow();
    expect(() => normalizeGateRequest(requestAtSerializedBytes((32 * 1024) + 1))).toThrow(
      /request: exceeds 32768 UTF-8 bytes/,
    );
  });

  it('enforces excerpt and whole-request limits after normalization', () => {
    expect(() => normalizeGateRequest({
      question: 'Q',
      choices: [{ label: 'A', consequence: 'B' }],
      terminalExcerpt: 'x'.repeat((16 * 1024) + 1),
    })).toThrow(/terminalExcerpt: exceeds 16384 UTF-8 bytes/);

    expect(() => normalizeGateRequest({
      question: '\\'.repeat(1024),
      choices: Array.from({ length: 5 }, () => ({
        label: '\\'.repeat(256),
        consequence: '\\'.repeat(2048),
      })),
      terminalExcerpt: '\\'.repeat(16 * 1024),
    })).toThrow(/request: exceeds 32768 UTF-8 bytes/);
  });
});

describe('gate request file input', () => {
  it('reports unreadable, invalid UTF-8, and invalid JSON files without coercion', () => {
    expect(() => readGateRequestFile(testDir, 'missing.json')).toThrow(/cannot read missing.json/);

    fs.writeFileSync(path.join(testDir, 'bad-utf8.json'), Buffer.from([0xc3, 0x28]));
    expect(() => readGateRequestFile(testDir, 'bad-utf8.json')).toThrow(/not valid UTF-8/);

    fs.writeFileSync(path.join(testDir, 'bad.json'), '{ nope');
    expect(() => readGateRequestFile(testDir, 'bad.json')).toThrow(/invalid JSON in bad.json/);
  });

  it('rejects prohibited content even when it is hidden inside an ANSI sequence', () => {
    expect(() => normalizeGateRequest({
      question: 'Q',
      choices: [{ label: 'A', consequence: 'B' }],
      terminalExcerpt: '\u001b]title\u0000\u0007',
    })).toThrow(/terminalExcerpt: contains a prohibited control/);
    expect(() => normalizeGateRequest({
      question: 'Q',
      choices: [{ label: 'A', consequence: 'B' }],
      terminalExcerpt: '\u001b]title\u2066\u0007',
    })).toThrow(/terminalExcerpt: contains a prohibited bidirectional control/);
  });
});

describe('porch gate CLI arguments', () => {
  it('supports either project-id/request-file ordering and auto-detection', () => {
    expect(parseGateArgs(['128', '--request-file', 'gate.json'])).toEqual({
      projectIdArg: '128', requestFile: 'gate.json',
    });
    expect(parseGateArgs(['--request-file', 'gate.json'])).toEqual({
      projectIdArg: undefined, requestFile: 'gate.json',
    });
    expect(parseGateArgs(['--request-file', 'gate.json', '128'])).toEqual({
      projectIdArg: '128', requestFile: 'gate.json',
    });
  });

  it('rejects missing, duplicate, unknown, and extra arguments', () => {
    expect(() => parseGateArgs(['--request-file'])).toThrow(/requires a path/);
    expect(() => parseGateArgs([
      '--request-file', 'a.json', '--request-file', 'b.json',
    ])).toThrow(/only be provided once/);
    expect(() => parseGateArgs(['--wat'])).toThrow(/Unknown gate option/);
    expect(() => parseGateArgs(['128', 'extra'])).toThrow(/Unexpected gate argument/);
  });
});

describe('porch gate --request-file persistence', () => {
  it('atomically creates the pending gate with normalized request content', async () => {
    await gate(testDir, '128', undefined, { requestFile: writeRequest(validRequest) });

    const saved = readState(statusPath).gates['plan-approval'];
    expect(saved.status).toBe('pending');
    expect(saved.requested_at).toEqual(expect.any(String));
    expect(saved.request).toEqual({
      ...validRequest,
      terminalExcerpt: 'warning\n\tcheckout failed',
    });
  });

  it('replaces content without changing requested_at and treats identical content as a no-op', async () => {
    await gate(testDir, '128', undefined, { requestFile: writeRequest(validRequest) });
    const first = readState(statusPath);
    const requestedAt = first.gates['plan-approval'].requested_at;

    const replacement = {
      question: '  Keep the table? ',
      choices: [{ label: ' Keep ', consequence: ' Preserve audit history. ' }],
    };
    await gate(testDir, '128', undefined, { requestFile: writeRequest(replacement) });
    const replaced = readState(statusPath);
    expect(replaced.gates['plan-approval'].requested_at).toBe(requestedAt);
    expect(replaced.gates['plan-approval'].request?.question).toBe('Keep the table?');

    const beforeNoOp = fs.readFileSync(statusPath);
    await gate(testDir, '128', undefined, { requestFile: writeRequest(replacement) });
    expect(fs.readFileSync(statusPath)).toEqual(beforeNoOp);
  });

  it('preserves attached content on a flag-free gate request and approval', async () => {
    await gate(testDir, '128', undefined, { requestFile: writeRequest(validRequest) });
    const request = readState(statusPath).gates['plan-approval'].request;

    await gate(testDir, '128');
    expect(readState(statusPath).gates['plan-approval'].request).toEqual(request);

    await approve(testDir, '128', 'plan-approval', true);
    const approved = readState(statusPath).gates['plan-approval'];
    expect(approved.status).toBe('approved');
    expect(approved.request).toEqual(request);
  });

  it('rejects invalid input and approved or non-current targets without mutating state', async () => {
    const beforeInvalid = fs.readFileSync(statusPath);
    await expect(gate(testDir, '128', undefined, {
      requestFile: writeRequest({ question: '', choices: [] }),
    })).rejects.toThrow(/request\.choices/);
    expect(fs.readFileSync(statusPath)).toEqual(beforeInvalid);

    fs.writeFileSync(path.join(testDir, 'malformed.json'), '{ nope');
    await expect(gate(testDir, '128', undefined, {
      requestFile: 'malformed.json',
    })).rejects.toThrow(/invalid JSON/);
    expect(fs.readFileSync(statusPath)).toEqual(beforeInvalid);

    const approvedState = makeState({
      gates: { 'plan-approval': { status: 'approved', approved_at: '2026-08-25T01:00:00Z' } },
    });
    writeState(statusPath, approvedState);
    const beforeApproved = fs.readFileSync(statusPath);
    await expect(gate(testDir, '128', undefined, {
      requestFile: writeRequest(validRequest),
    })).rejects.toThrow(/already approved/);
    expect(fs.readFileSync(statusPath)).toEqual(beforeApproved);

    writeState(statusPath, makeState({ phase: 'implement' }));
    const beforeNoGate = fs.readFileSync(statusPath);
    await expect(gate(testDir, '128', undefined, {
      requestFile: writeRequest(validRequest),
    })).rejects.toThrow(/has no approval gate/);
    expect(fs.readFileSync(statusPath)).toEqual(beforeNoGate);
  });

  it('still requires the explicit human approval flag and preserves state without it', async () => {
    await gate(testDir, '128', undefined, { requestFile: writeRequest(validRequest) });
    const before = fs.readFileSync(statusPath);
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit:1');
    }) as typeof process.exit);

    await expect(approve(testDir, '128', 'plan-approval', false)).rejects.toThrow('process.exit:1');
    expect(exit).toHaveBeenCalledWith(1);
    expect(fs.readFileSync(statusPath)).toEqual(before);
  });

  it('clears request content when rollback creates a fresh gate cycle', async () => {
    writeState(statusPath, makeState({
      phase: 'implement',
      gates: {
        'spec-approval': { status: 'approved', approved_at: '2026-08-25T00:30:00Z' },
        'plan-approval': {
          status: 'approved',
          requested_at: '2026-08-25T00:40:00Z',
          approved_at: '2026-08-25T00:50:00Z',
          request: normalizeGateRequest(validRequest),
        },
      },
    }));

    await rollback(testDir, '128', 'plan');
    expect(readState(statusPath).gates['plan-approval']).toEqual({ status: 'pending' });
  });
});
