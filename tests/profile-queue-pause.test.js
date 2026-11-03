import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

const limits = await readFile(new URL('../src/shared/download-limits.js', import.meta.url), 'utf8');
const source = await readFile(new URL('../src/content/bulk-queue.js', import.meta.url), 'utf8');

for (const code of ['QUEUE_LIMIT_REACHED', 'QUEUE_PAUSED', 'STALE_QUEUE']) {
  test(`${code} pauses the child before another save and preserves its item for Resume`, async () => {
    const context = vm.createContext({ AbortController, setTimeout, clearTimeout });
    vm.runInContext(limits, context); vm.runInContext(source, context);
    let refusal = true, calls = 0;
    const queue = context.ReelSaverBulkQueue.create({ retryDelays: [],
      discoverPage: async () => ({ items: [{ mediaId: '1', shortcode: 'B' }, { mediaId: '2', shortcode: 'C' }], nextCursor: null, hasMore: false }),
      saveItem: async ({ item }) => {
        calls++;
        if (refusal) throw Object.assign(new Error('Parent queue requires attention'), { code });
        return { filename: `creator_${item.shortcode}.mp4`, bytesWritten: 2048 };
      },
    });
    queue.start({ profile: { id: '12345', username: 'creator' }, mode: 'batches', batchSize: 35 });
    const paused = await queue.waitForIdle();
    assert.equal(paused.state, 'paused');
    assert.equal(paused.counts.saved, 0);
    assert.equal(paused.counts.failed, 0);
    assert.equal(calls, 1);
    refusal = false;
    queue.resume();
    const finished = await queue.waitForIdle();
    assert.equal(finished.state, 'completed');
    assert.equal(finished.counts.saved, 2);
    assert.equal(calls, 3);
  });
}
