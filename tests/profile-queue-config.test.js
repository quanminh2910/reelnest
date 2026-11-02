import assert from 'node:assert/strict';
import { test } from 'node:test';
import '../src/shared/download-limits.js';
import '../src/shared/profile-queue-config.js';

const config = globalThis.ReelNestProfileQueueConfig;

test('queue profiles normalize usernames and exact HTTPS profile/Reels URLs', () => {
  for (const value of ['Creator.Name', '@Creator.Name', 'https://www.instagram.com/Creator.Name/',
    'https://instagram.com/Creator.Name/reels/?tracking=ignored#section']) {
    assert.equal(config.normalizeProfileInput(value), 'creator.name');
  }
  for (const value of ['', '@', 'name/name', 'instagram.com/name', 'http://instagram.com/name/',
    'https://instagram.com.attacker.example/name/', 'https://user:pass@instagram.com/name/',
    'https://instagram.com:444/name/', 'https://instagram.com/name/tagged/',
    'https://instagram.com/reel/ABC/', 'https://instagram.com/p/ABC/', 'https://instagram.com/name%2Fother/',
    'ads', '@explore', 'https://instagram.com/accounts/', 'a'.repeat(31)]) {
    assert.throws(() => config.normalizeProfileInput(value), { code: 'INVALID_QUEUE' }, value);
  }
});

test('multiline queue input keeps valid rows and reports exact invalid or duplicate lines', () => {
  const result = config.parseLines(' creator_a\n\n@CREATOR_A\nhttps://instagram.com/creator_b/reels/\nhttps://elsewhere.example/name');
  assert.deepEqual(result.entries.map(value => value.username), ['creator_a', 'creator_b']);
  assert.equal(new Set(result.entries.map(value => value.id)).size, 2);
  assert.ok(result.entries.every(value => value.limitMode === 'inherit' && value.maxNewVideos === null));
  assert.deepEqual(result.errors.map(value => value.line), [3, 5]);
  assert.equal(result.errors[0].code, 'DUPLICATE_PROFILE');
  const bounded = config.parseLines(Array.from({ length: 101 }, (_, index) => `creator_${index}`).join('\n'));
  assert.equal(bounded.entries.length, 100);
  assert.equal(bounded.errors.length, 1);
  assert.equal(bounded.errors[0].line, 101);
});

test('queue drafts retain stable row IDs and explicit inherit/custom/unlimited choices', () => {
  assert.deepEqual(config.normalizeDraft(), { schemaVersion: 1, batchSize: 35, defaultLimit: null, totalLimit: null, entries: [] });
  const draft = config.normalizeDraft({ defaultLimit: 25, totalLimit: 60, entries: [
    { id: 'a', username: '@Creator_A' },
    { id: 'b', username: 'creator_b', limitMode: 'custom', maxNewVideos: 10 },
    { id: 'c', username: 'creator_c', limitMode: 'unlimited', maxNewVideos: 50 },
  ] });
  assert.deepEqual(draft.entries.map(value => value.id), ['a', 'b', 'c']);
  assert.deepEqual(draft.entries.map(value => config.effectiveLimit(draft, value)), [25, 10, null]);
  assert.equal(draft.entries[2].maxNewVideos, null);
  assert.deepEqual(config.normalizeDraft(draft), draft);
});

test('queue validation rejects cap coercion, unsupported formats, duplicate rows and oversized drafts', () => {
  for (const value of [0, -1, 1.5, '25', 50_001, Infinity, NaN]) {
    assert.throws(() => config.normalizeDraft({ defaultLimit: value }), { code: 'INVALID_LIMIT' });
    assert.throws(() => config.normalizeDraft({ totalLimit: value }), { code: 'INVALID_LIMIT' });
  }
  for (const value of [0, 501, '35', 1.5]) assert.throws(() => config.normalizeDraft({ batchSize: value }), { code: 'INVALID_QUEUE' });
  assert.throws(() => config.normalizeDraft({ schemaVersion: 2 }), { code: 'QUEUE_DRAFT_UNSUPPORTED' });
  for (const entries of [[{ username: 'creator', limitMode: 'custom', maxNewVideos: null }],
    [{ username: 'creator', limitMode: 'random' }], [{ username: 'creator' }, { username: 'CREATOR' }],
    [{ id: 'same', username: 'first' }, { id: 'same', username: 'second' }],
    Array.from({ length: 101 }, (_, index) => ({ username: `creator_${index}` }))]) {
    assert.throws(() => config.normalizeDraft({ entries }), { code: 'INVALID_QUEUE' });
  }
  assert.throws(() => config.parseLines('x'.repeat(200_001)), { code: 'INVALID_QUEUE' });
  assert.throws(() => config.parseLines('\n'.repeat(1001)), { code: 'INVALID_QUEUE' });
});
