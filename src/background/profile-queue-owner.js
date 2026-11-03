// Shared owner metadata; directory capabilities never cross this boundary.
export const QUEUE_OWNER = "reelnest:queue-owner:v1";
export const MUTATION_OWNER = "reelnest:mutation-owner:v1";
export const BULK_ACTIVE = "reel-saver:bulk-active";

export const queueProblem = (code, message, stage = "queue") => Object.assign(new Error(message), { code, stage });
export async function readQueueOwner() { return (await chrome.storage.session.get(QUEUE_OWNER))[QUEUE_OWNER]; }
export async function readMutationOwner() { return (await chrome.storage.session.get(MUTATION_OWNER))[MUTATION_OWNER]; }

export async function assertNoProfileQueue() {
  if ((await readQueueOwner())?.active) throw queueProblem("QUEUE_BUSY", "Stop the profile queue before starting another download or changing library history.");
}

export async function assertOrdinaryStart() {
  await assertNoProfileQueue();
  if (await readMutationOwner()) throw queueProblem("JOB_BUSY", "Finish the current library operation before starting another download.");
}

export async function queueBinding(job, ctx, { settling = false } = {}) {
  if (!job.queue) return null;
  const owner = await readQueueOwner();
  if (!owner || !settling && !owner.active || owner.runId !== job.queue.runId || owner.childJobId !== job.jobId ||
      owner.entryId !== job.queue.entryId || !settling && owner.generation !== job.queue.generation ||
      owner.tabId !== ctx.tabId || owner.documentId !== ctx.documentId ||
      !settling && (owner.sourceTabId !== job.queue.sourceTabId || owner.sourceDocumentId !== job.queue.sourceDocumentId)) {
    throw queueProblem("STALE_JOB", "This profile result belongs to an older queue document or profile.");
  }
  return owner;
}
