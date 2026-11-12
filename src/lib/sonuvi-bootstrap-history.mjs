/**
 * Fixed, client-owned history validator. Both the stdin capsule and the guard
 * embed these exact bytes; neither imports this file from a candidate kit.
 * Readers authenticate records and complete kit trees before calling it.
 * createdAt is the immutable generation boundary, updatedAt its terminal end.
 */
export function validateBootstrapHistory(records, active, pendingOperationId = null) {
  const reject = () => { throw new Error('replacement_recovery_required'); };
  const sameKit = (left, right) => left && right && left.marker === right.marker
    && left.manifest.releaseId === right.manifest.releaseId;
  const ordered = [...records].sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
  const ids = new Set();
  let previous = null;
  for (const record of ordered) {
    const start = Date.parse(record.createdAt);
    const end = Date.parse(record.updatedAt);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || !record.before || !record.after
      || ids.has(record.operationId)) reject();
    ids.add(record.operationId);
    if (previous && (start <= Date.parse(previous.updatedAt)
      || record.targetIdentity !== previous.targetIdentity || !sameKit(previous.after, record.before))) reject();
    if (record.pending && (record.operationId !== pendingOperationId || record !== ordered.at(-1))) reject();
    previous = record;
  }
  if (previous && !sameKit(previous.after, active)) reject();
  return {
    records: ordered,
    latest: previous,
    // Allocate the next generation under the common lock, including a clock
    // rollback or two operations within one clock tick. Never rewrite history.
    nextCreatedAt: new Date(Math.max(Date.now(), previous ? Date.parse(previous.updatedAt) + 1 : 0)).toISOString(),
  };
}
