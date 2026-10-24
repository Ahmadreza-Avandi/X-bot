import test from 'node:test';
import assert from 'node:assert/strict';
import { readTweetConfirmation, submitComposer } from '../server/services/automation.js';

test('only successful CreateTweet acknowledgement with a valid ID confirms publication', () => {
  const body = { data: { create_tweet: { tweet_results: { result: { rest_id: '12345' } } } } };
  assert.equal(readTweetConfirmation(200, body), '12345');
  assert.throws(() => readTweetConfirmation(404, body), /404/);
  assert.throws(() => readTweetConfirmation(200, { ...body, errors: [{ message: 'Rate limited' }] }), /Rate limited/);
  for (const payload of [null, {}, { data: {} }, { data: { create_tweet: { tweet_results: { result: { rest_id: 'invalid' } } } } }]) {
    assert.throws(() => readTweetConfirmation(200, payload));
  }
});

function fakePage(response: any, opts: { timeout?: boolean; ready?: boolean } = {}) {
  const events: string[] = [];
  let resolveResponse: (r: any) => void;
  const pending = new Promise(resolve => { resolveResponse = resolve; });
  const button = { asElement: () => ({ click: async () => { events.push('click'); resolveResponse(response); } }), dispose: async () => {} };
  return { events, page: {
    waitForFunction: async () => { events.push('ready'); if (opts.ready === false) throw new Error('Composer not ready'); },
    evaluateHandle: async () => button,
    waitForResponse: (predicate: any) => {
      events.push('subscribe');
      assert.equal(predicate({ url: () => 'https://x.com/i/api/graphql/query/CreateTweet', request: () => ({ method: () => 'POST' }) }), true);
      assert.equal(predicate({ url: () => 'https://x.com/i/api/graphql/query/HomeTimeline', request: () => ({ method: () => 'POST' }) }), false);
      assert.equal(predicate({ url: () => 'https://other.example/CreateTweet', request: () => ({ method: () => 'POST' }) }), false);
      return opts.timeout ? Promise.reject(new Error('Timeout')) : pending;
    },
  } as any };
}
const response = (status: number, body: any) => ({ status: () => status, json: async () => body });

test('waits for readiness and subscribes before click, including a fast response', async () => {
  const { page, events } = fakePage(response(200, { data: { create_tweet: { tweet_results: { result: { rest_id: '456' } } } } }));
  assert.equal(await submitComposer(page, 'hello'), '456');
  assert.deepEqual(events, ['ready', 'subscribe', 'click']);
});

test('timeout, HTTP failure and GraphQL error fail without retry or false success', async () => {
  for (const [res, opts] of [[response(404, {}), {}], [response(200, { errors: [{ message: 'Duplicate' }] }), {}], [response(200, {}), {}], [null, { timeout: true }]] as const) {
    const { page, events } = fakePage(res, opts);
    await assert.rejects(submitComposer(page, 'hello'), /تأیید انتشار/);
    assert.equal(events.filter(e => e === 'click').length, 1);
  }
});

test('does not click before the composer is ready', async () => {
  const { page, events } = fakePage(null, { ready: false });
  await assert.rejects(submitComposer(page, 'hello'), /not ready/);
  assert.deepEqual(events, ['ready']);
});

test('readiness evaluates the requested multiline text and ignores disabled or unrelated buttons', async () => {
  const doc = (globalThis as any).document;
  const expected = 'سلام\nجهان';
  let enabled = false;
  const makeButton = (visible: boolean, disabled: boolean) => ({ getClientRects: () => visible ? [1] : [], hasAttribute: () => disabled, getAttribute: () => disabled ? 'true' : 'false' });
  const scope = { querySelectorAll: () => [makeButton(false, false), makeButton(true, !enabled)] };
  const box = { innerText: expected, textContent: 'سلامجهان', closest: () => scope };
  (globalThis as any).document = { querySelector: () => box };
  const { page } = fakePage(response(200, { data: { create_tweet: { tweet_results: { result: { rest_id: '999' } } } } }));
  page.waitForFunction = async (fn: any, _opts: any, selector: string, text: string) => {
    assert.equal(fn(selector, text), false, 'must wait while disabled');
    enabled = true;
    assert.equal(fn(selector, text), true, 'multiline innerText matches');
    box.innerText = 'wrong draft';
    assert.equal(fn(selector, text), false, 'must reject different text');
    box.innerText = expected;
  };
  try { assert.equal(await submitComposer(page, expected), '999'); }
  finally { if (doc === undefined) delete (globalThis as any).document; else (globalThis as any).document = doc; }
});

test('browser navigation failure does not call direct API or claim success', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { default: puppeteer } = await import('puppeteer-core');
  const { postTweetWithStealthBrowser } = await import('../server/services/automation.js');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const accountId = `acc_regression_${process.pid}`;
  const cookieFile = path.join(root, 'data/cookies', `cookies_${accountId}.json`);
  const profile = path.join(root, 'data/profiles', accountId);
  fs.mkdirSync(path.dirname(cookieFile), { recursive: true });
  fs.writeFileSync(cookieFile, JSON.stringify([{ name: 'auth_token', value: 'synthetic', domain: '.twitter.com' }]));
  const chrome = process.env.CHROME_BIN;
  const launch = puppeteer.launch;
  const fetch = globalThis.fetch;
  const document = (globalThis as any).document;
  let phase = 'navigation';
  let composeClosed = false;
  let consentDismissed = false;
  let closed = false;
  let directRequests = 0;
  let setCookies: any[] = [];
  process.env.CHROME_BIN = process.execPath;
  globalThis.fetch = (async () => { directRequests++; throw new Error('Direct request is forbidden'); }) as any;
  puppeteer.launch = (async (opts: any) => {
    assert.equal(opts.args.includes('--proxy-server=http://127.0.0.1:1'), true);
    return {
      pages: async () => [{ evaluateOnNewDocument: async () => {}, goto: async () => { if (phase === 'navigation') throw new Error('Proxy connection failed'); },
        url: () => 'https://x.com/compose/post', evaluate: async (fn: any) => fn(),
        waitForSelector: async () => { throw new Error('Stop after popup dismissal'); }, isClosed: () => true }],
      defaultBrowserContext: () => ({ setCookie: async (...cookies: any[]) => { setCookies = cookies; } }),
      close: async () => { closed = true; },
    };
  }) as any;
  try {
    const result = await postTweetWithStealthBrowser({ accountId, accountName: 'Synthetic', username: 'fixture', text: 'test', proxyUrl: 'http://127.0.0.1:1', logFn: () => {} });
    assert.equal(result.success, false);
    assert.match(result.error!, /Proxy connection failed/);
    assert.equal(directRequests, 0);
    assert.equal(closed, true);
    assert.equal(setCookies[0].domain, '.x.com');
    phase = 'popup';
    (globalThis as any).document = { querySelectorAll: () => [
      { textContent: 'Close', getClientRects: () => [1], click: () => { composeClosed = true; } },
      { textContent: 'Refuse non-essential cookies', getClientRects: () => [1], click: () => { consentDismissed = true; } },
      { textContent: 'Dismiss', getClientRects: () => [], click: () => { throw new Error('hidden action clicked'); } },
    ] };
    const popupResult = await postTweetWithStealthBrowser({ accountId, accountName: 'Synthetic', username: 'fixture', text: 'test', proxyUrl: 'http://127.0.0.1:1', logFn: () => {} });
    assert.match(popupResult.error!, /Stop after popup dismissal/);
    assert.equal(composeClosed, false, 'compose close action must not be clicked');
    assert.equal(consentDismissed, true);
  } finally {
    puppeteer.launch = launch;
    globalThis.fetch = fetch;
    if (document === undefined) delete (globalThis as any).document; else (globalThis as any).document = document;
    if (chrome === undefined) delete process.env.CHROME_BIN; else process.env.CHROME_BIN = chrome;
    fs.rmSync(cookieFile, { force: true });
    fs.rmSync(profile, { recursive: true, force: true });
  }
});
