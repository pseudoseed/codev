export type V2Status = 'gate-waiting' | 'stalled' | 'running' | 'offline';

export type V2NodeKind = 'workspace' | 'architect' | 'builder';

export interface V2Node {
  id: string;
  kind: V2NodeKind;
  parentId: string | null;
  name: string;
  status: V2Status;
  flags: { heldMail: boolean };
  lastDataAt: string | null;
  buckets?: number[];
}

export interface V2Counts {
  workspaces: number;
  builders: { total: number; byStatus: { [K in V2Status]?: number } };
  gateWaiting: number;
}

export interface V2SnapshotFrame {
  seq: number;
  type: 'snapshot';
  streamId: string;
  resumed: boolean;
  scope: string[];
  nodes: V2Node[];
  counts: V2Counts;
}

export interface V2NodeFrame {
  seq: number;
  type: 'node';
  node: V2Node;
}

export interface V2GoneFrame {
  seq: number;
  type: 'gone';
  id: string;
}

export interface V2CountsFrame {
  seq: number;
  type: 'counts';
  counts: V2Counts;
}

export interface V2TickFrame {
  seq: number;
  type: 'tick';
  at: string;
  buckets: { [builderId: string]: number };
}

export interface V2DarkFrame {
  seq: number;
  type: 'dark';
  id: string;
  reason: string;
}

export interface V2ResumedFrame {
  seq: number;
  type: 'resumed';
  from: number;
}

export type V2Frame =
  | V2SnapshotFrame
  | V2NodeFrame
  | V2GoneFrame
  | V2CountsFrame
  | V2TickFrame
  | V2DarkFrame
  | V2ResumedFrame;
