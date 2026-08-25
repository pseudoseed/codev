import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  GATE_REQUEST_LIMITS,
  type GateRequest,
  type GateRequestChoice,
} from '@cluesmith/codev-types';

const ROOT_FIELDS = new Set(['question', 'choices', 'terminalExcerpt']);
const CHOICE_FIELDS = new Set(['label', 'consequence', 'recommended']);

// ECMA-48 CSI, OSC (BEL or ST terminated), then simple two-byte escapes.
// Anything unrecognised keeps its ESC/C1 byte and is rejected as a control.
const ANSI_OSC = /\u001b\](?:[^\u0007\u001b]|\u001b(?!\\))*(?:\u0007|\u001b\\)/gu;
const ANSI_CSI = /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/gu;
const ANSI_TWO_BYTE = /\u001b[@-_]/gu;
const BIDI_OVERRIDE_OR_ISOLATE = /[\u202a-\u202e\u2066-\u2069]/u;
const DECISION_CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
const TERMINAL_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u;

export class GateRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GateRequestError';
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function rejectUnknownFields(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  field: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new GateRequestError(`${field}.${key}: unknown field`);
    }
  }
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function requireWithin(value: string, maximum: number, field: string): void {
  const actual = utf8Bytes(value);
  if (actual > maximum) {
    throw new GateRequestError(`${field}: exceeds ${maximum} UTF-8 bytes (received ${actual})`);
  }
}

function normalizeDecisionText(
  value: unknown,
  field: string,
  maximum: number,
): string {
  if (typeof value !== 'string') {
    throw new GateRequestError(`${field}: must be a string`);
  }
  if (BIDI_OVERRIDE_OR_ISOLATE.test(value)) {
    throw new GateRequestError(`${field}: contains a prohibited bidirectional control`);
  }
  if (DECISION_CONTROL.test(value)) {
    throw new GateRequestError(`${field}: contains a prohibited control character`);
  }
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new GateRequestError(`${field}: must not be empty`);
  }
  requireWithin(normalized, maximum, field);
  return normalized;
}

export function stripTerminalAnsi(value: string): string {
  return value
    .replace(ANSI_OSC, '')
    .replace(ANSI_CSI, '')
    .replace(ANSI_TWO_BYTE, '');
}

function normalizeTerminalExcerpt(value: unknown): string {
  const field = 'request.terminalExcerpt';
  if (typeof value !== 'string') {
    throw new GateRequestError(`${field}: must be a string`);
  }
  // Check spoofing/NUL before ANSI removal so prohibited content cannot be
  // hidden inside an otherwise removable escape sequence.
  if (value.includes('\u0000')) {
    throw new GateRequestError(`${field}: contains a prohibited control character`);
  }
  if (BIDI_OVERRIDE_OR_ISOLATE.test(value)) {
    throw new GateRequestError(`${field}: contains a prohibited bidirectional control`);
  }
  const normalized = stripTerminalAnsi(value.replace(/\r\n/g, '\n'));
  if (TERMINAL_CONTROL.test(normalized)) {
    throw new GateRequestError(`${field}: contains a prohibited control character`);
  }
  requireWithin(normalized, GATE_REQUEST_LIMITS.terminalExcerptBytes, field);
  return normalized;
}

function normalizeChoice(value: unknown, index: number): GateRequestChoice {
  const field = `request.choices[${index}]`;
  if (!isPlainObject(value)) {
    throw new GateRequestError(`${field}: must be an object`);
  }
  rejectUnknownFields(value, CHOICE_FIELDS, field);

  const choice: GateRequestChoice = {
    label: normalizeDecisionText(
      value.label,
      `${field}.label`,
      GATE_REQUEST_LIMITS.labelBytes,
    ),
    consequence: normalizeDecisionText(
      value.consequence,
      `${field}.consequence`,
      GATE_REQUEST_LIMITS.consequenceBytes,
    ),
  };
  if (Object.hasOwn(value, 'recommended')) {
    if (typeof value.recommended !== 'boolean') {
      throw new GateRequestError(`${field}.recommended: must be a boolean`);
    }
    choice.recommended = value.recommended;
  }
  return choice;
}

/** Validate and return the exact normalized object porch persists. */
export function normalizeGateRequest(value: unknown): GateRequest {
  if (!isPlainObject(value)) {
    throw new GateRequestError('request: must be a JSON object');
  }
  rejectUnknownFields(value, ROOT_FIELDS, 'request');

  if (!Array.isArray(value.choices)) {
    throw new GateRequestError('request.choices: must be an array');
  }
  if (
    value.choices.length < GATE_REQUEST_LIMITS.minChoices
    || value.choices.length > GATE_REQUEST_LIMITS.maxChoices
  ) {
    throw new GateRequestError(
      `request.choices: must contain ${GATE_REQUEST_LIMITS.minChoices} to `
      + `${GATE_REQUEST_LIMITS.maxChoices} choices (received ${value.choices.length})`,
    );
  }

  const request: GateRequest = {
    question: normalizeDecisionText(
      value.question,
      'request.question',
      GATE_REQUEST_LIMITS.questionBytes,
    ),
    choices: value.choices.map(normalizeChoice),
  };
  if (Object.hasOwn(value, 'terminalExcerpt')) {
    request.terminalExcerpt = normalizeTerminalExcerpt(value.terminalExcerpt);
  }

  const recommended = request.choices.filter((choice) => choice.recommended === true).length;
  if (recommended > 1) {
    throw new GateRequestError('request.choices: at most one choice may be recommended');
  }

  const completeBytes = utf8Bytes(JSON.stringify(request));
  if (completeBytes > GATE_REQUEST_LIMITS.requestBytes) {
    throw new GateRequestError(
      `request: exceeds ${GATE_REQUEST_LIMITS.requestBytes} UTF-8 bytes after normalization `
      + `(received ${completeBytes})`,
    );
  }
  return request;
}

/** Read strict UTF-8 JSON relative to the invoking workspace and normalize it. */
export function readGateRequestFile(workspaceRoot: string, requestFile: string): GateRequest {
  const resolved = path.resolve(workspaceRoot, requestFile);
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(resolved);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new GateRequestError(`request file: cannot read ${requestFile}: ${detail}`);
  }

  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new GateRequestError(`request file: ${requestFile} is not valid UTF-8`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new GateRequestError(`request file: invalid JSON in ${requestFile}: ${detail}`);
  }
  return normalizeGateRequest(parsed);
}
