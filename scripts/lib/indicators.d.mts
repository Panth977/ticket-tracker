/** Types for indicators.mjs (loose on purpose: it takes @tm/shared and the Admin SDK as arguments). */
/* eslint-disable @typescript-eslint/no-explicit-any */
type Shared = any;
type Doc = Record<string, any>;

export interface KindCount {
  seen: number;
  toChange: number;
}
export interface Summary {
  boards: KindCount;
  artifacts: KindCount;
  memories: KindCount;
  workspaces: KindCount;
  /** Board descriptions flattened from rich text. */
  descriptions: number;
  /** Stages given an indicator. */
  stages: number;
  applied: {
    boards: number;
    artifacts: number;
    memories: number;
    workspaces: number;
    failed: { at: string; error: string }[];
  };
}

export function planStages(S: Shared, stages: Doc[] | undefined | null): Doc[] | null;
export function planBoard(S: Shared, board: Doc): Doc | null;
export function planArtifact(S: Shared, artifact: Doc): Doc | null;
export function planMemory(S: Shared, memory: Doc): Doc | null;
export function planWorkspace(S: Shared, workspace: Doc): Doc | null;
export function migrateIndicators(
  deps: { S: Shared; db: any },
  opts: { apply: boolean; log?: (m: string) => void },
): Promise<Summary>;
