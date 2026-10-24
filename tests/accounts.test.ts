import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('capacity is enforced for create, edit and assign; a released slot can be reused', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'x-bot-api-'));
  fs.copyFileSync(path.join(root, 'server.ts'), path.join(dir, 'server.ts'));
  fs.cpSync(path.join(root, 'server'), path.join(dir, 'server'), { recursive: true });
  // Capture the caller boundary without contacting X or reading any real cookies.
  fs.writeFileSync(path.join(dir, 'server/services/automation.ts'), `import fs from 'node:fs';
export async function postTweetWithStealthBrowser(options) {
  fs.writeFileSync('captured.json', JSON.stringify(options));
  return { success: false, method: 'browser_human_typing', error: 'Synthetic provider failure' };
}`);
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  fs.mkdirSync(path.join(dir, 'data'));
  for (const name of ['accounts', 'proxies', 'queue']) fs.writeFileSync(path.join(dir, 'data', `${name}.json`), '[]');
  const port = await new Promise<number>(resolve => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => { const port = (server.address() as net.AddressInfo).port; server.close(() => resolve(port)); });
  });
  const child = spawn(process.execPath, [path.join(root, 'node_modules/tsx/dist/cli.mjs'), 'server.ts'], { cwd: dir, env: { ...process.env, PORT: String(port) }, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  const call = async (route: string, method = 'GET', body?: any) => {
    const res = await fetch(base + route, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() as any };
  };
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { if ((await call('/api/accounts')).status === 200) { ready = true; break; } } catch {}
      await new Promise(r => setTimeout(r, 50));
    }
    assert.equal(ready, true, 'isolated server did not start');
    const raw = 'vless://00000000-0000-4000-8000-000000000001@example.com:443?type=ws&path=%2Fsocket';
    const proxy = await call('/api/proxies', 'POST', { url: raw });
    assert.equal(proxy.status, 201);
    assert.equal(proxy.body.proxy.url, raw);
    const proxyId = proxy.body.proxy.id;
    const ids = [];
    for (let i = 0; i < 3; i++) {
      const account = await call('/api/accounts', 'POST', { name: `Synthetic ${i}`, username: `fixture${i}`, proxy_id: proxyId });
      assert.equal(account.status, 201);
      ids.push(account.body.account.id);
    }
    assert.equal((await call('/api/accounts', 'POST', { name: 'Fourth', username: 'fourth', proxy_id: proxyId })).status, 400);
    const fourth = (await call('/api/accounts', 'POST', { name: 'Fourth', username: 'fourth' })).body.account.id;
    assert.equal((await call(`/api/accounts/${fourth}`, 'PATCH', { proxy_id: proxyId })).status, 400);
    assert.equal((await call(`/api/proxies/${proxyId}/assign`, 'POST', { account_id: fourth })).status, 400);
    assert.equal((await call(`/api/proxies/${proxyId}/assign`, 'POST', { account_id: ids[0] })).status, 200);
    const listed = (await call('/api/proxies')).body[0];
    assert.equal(listed.capacity_used, 3);
    assert.equal(listed.is_full, true);
    await call(`/api/proxies/${proxyId}/unassign`, 'POST', { account_id: ids[0] });
    assert.equal((await call(`/api/proxies/${proxyId}/assign`, 'POST', { account_id: fourth })).status, 200);
    assert.equal((await call('/api/proxies')).body[0].capacity_used, 3);
    const failedPost = await call('/api/tweet/now', 'POST', { account_id: fourth, text: 'Synthetic text' });
    assert.equal(failedPost.status, 500);
    assert.equal(failedPost.body.success, false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'captured.json'), 'utf8')).proxyUrl, raw);
    const accountAfterFailure = (await call('/api/accounts')).body.find((a: any) => a.id === fourth);
    assert.equal(accountAfterFailure.total_tweets, 0);
    assert.equal(accountAfterFailure.last_tweet_at, null);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'data/queue.json'), 'utf8'))[0].status, 'failed');
    const invalid = await call('/api/proxies', 'POST', { urls: `${raw}\ninvalid` });
    assert.equal(invalid.status, 400);
    assert.equal((await call('/api/proxies')).body.length, 1, 'invalid batch must not partially import');
  } finally {
    const exited = new Promise(r => child.once('exit', r));
    child.kill(); await exited;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
