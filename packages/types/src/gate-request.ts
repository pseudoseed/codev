/**
 * One outcome offered by a human approval gate.
 *
 * This portable shape is camelCase in JSON, persisted YAML, and the v2 wire.
 * The surrounding legacy gate status deliberately keeps its snake_case dates.
 */
export interface GateRequestChoice {
  label: string;
  consequence: string;
  recommended?: boolean;
}

/** Structured decision content attached to one porch gate cycle. */
export interface GateRequest {
  question: string;
  choices: GateRequestChoice[];
  terminalExcerpt?: string;
}

/** Runtime limits shared by porch ingress and wire validators. All byte caps are UTF-8. */
export const GATE_REQUEST_LIMITS = Object.freeze({
  minChoices: 1,
  maxChoices: 5,
  questionBytes: 1024,
  labelBytes: 256,
  consequenceBytes: 2048,
  terminalExcerptBytes: 16 * 1024,
  requestBytes: 32 * 1024,
});
