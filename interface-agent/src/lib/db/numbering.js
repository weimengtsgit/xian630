/**
 * Pure version-numbering domain logic for the interface-agent versioning
 * feature (Task 2).
 *
 * This module is deliberately free of any database or async dependency: it
 * holds the label/sequence arithmetic, the structured sort comparator and the
 * cross-session domain error. The persistence layer (`repository.js`) calls
 * these helpers inside its transaction so the SQL stays thin and the rules are
 * unit-testable in isolation.
 *
 * Authoritative rules: spec §编号规则 and 领域规则 4/8.
 *
 * Numbering summary:
 *   - root              -> V1,            mainline_sequence=1, branch_sequence=0, label_path=[1]
 *   - base == head      -> V<seq+1>,      mainline_sequence advances, branch_sequence=0,
 *                                         label_path=[mainline_sequence] (a NEW top-level segment)
 *   - base != head      -> <parent>.<n>,  mainline_sequence inherited, branch_sequence = max+1,
 *                                         label_path = parent.label_path ++ [branch_sequence]
 *
 * label_path is a numeric array so the tree sorts numerically per segment
 * (V10 after V2, not before as string lex would give). Mainline versions are
 * kept single-segment on purpose: that guarantees their label_path can never
 * collide with a branch path (branches are always length >= 2), so the sort
 * order is a strict total order across the whole tree.
 */

/**
 * Thrown when a version referenced as a parent / base / confirm target does
 * not belong to the session performing the write. T4/T5/T7 write paths call
 * `assertVersionInSession` before mutating so cross-session references are
 * rejected uniformly rather than silently corrupting another session's tree.
 */
export class VersionNotInSessionError extends Error {
  constructor(versionId, sessionId) {
    super(`版本 ${versionId} 不属于会话 ${sessionId}（禁止跨会话引用）`);
    this.name = 'VersionNotInSessionError';
    this.versionId = versionId;
    this.sessionId = sessionId;
  }
}

/**
 * Parse a version's `label_path_json` column into a number[].
 * Missing / malformed values degrade to [] (legacy imports) instead of
 * throwing, so projection over mixed data never breaks.
 *
 * @param {string | null | undefined} labelPathJson
 * @returns {number[]}
 */
export function parseLabelPath(labelPathJson) {
  if (!labelPathJson) return [];
  try {
    const parsed = JSON.parse(labelPathJson);
    return Array.isArray(parsed) ? parsed.map((n) => Number(n)) : [];
  } catch {
    return [];
  }
}

/**
 * Structured, numeric per-segment comparison of two label paths.
 *
 * Shorter prefixes (ancestors) sort before their longer descendants; equal
 * prefixes break on the next numeric segment. This is NOT string lex order,
 * so [10] correctly follows [2]. Callers should tie-break on `created_at` for
 * full determinism (done in `getVersionTree`).
 *
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number}
 */
export function compareLabelPath(a, b) {
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

/**
 * Compute the numbering fields for a ROOT commit (parentVersionId == null).
 * @returns {{ versionLabel: string, mainlineSequence: number, branchSequence: number, labelPath: number[] }}
 */
export function rootNumbering() {
  return { versionLabel: 'V1', mainlineSequence: 1, branchSequence: 0, labelPath: [1] };
}

/**
 * Compute the numbering fields for a MAINLINE advance (parent is the session
 * head at commit time). The new version opens a fresh top-level slot, so its
 * label_path is the single segment [mainlineSequence].
 *
 * @param {{ mainline_sequence: number }} parent
 */
export function mainlineNumbering(parent) {
  const mainlineSequence = (parent.mainline_sequence ?? 0) + 1;
  return {
    versionLabel: `V${mainlineSequence}`,
    mainlineSequence,
    branchSequence: 0,
    labelPath: [mainlineSequence],
  };
}

/**
 * Compute the numbering fields for a BRANCH commit (parent is a historical or
 * already-branched version, not the current head). branch_sequence is one past
 * the parent's existing max so the UNIQUE(parent_version_id, branch_sequence)
 * index is never violated, even under serialized contention.
 *
 * @param {{ version_label: string, mainline_sequence: number, label_path_json: string }} parent
 * @param {number | null} maxBranchSequence - MAX(branch_sequence) under this parent
 */
export function branchNumbering(parent, maxBranchSequence) {
  const branchSequence = (maxBranchSequence ?? 0) + 1;
  return {
    versionLabel: `${parent.version_label}.${branchSequence}`,
    mainlineSequence: parent.mainline_sequence, // inherited, mainline not advanced
    branchSequence,
    labelPath: [...parseLabelPath(parent.label_path_json), branchSequence],
  };
}
