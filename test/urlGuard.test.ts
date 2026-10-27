import { test, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

const { isBlockedAddress, assertAllowedUrl } = await import('../src/providers/urlGuard.js');
const { AnthropicProvider } = await import('../src/providers/anthropic.js');

const original = { allow: process.env.ALLOW_PRIVATE_URLS, node: process.env.NODE_ENV };
afterEach(() => {
  if (original.allow === undefined) delete process.env.ALLOW_PRIVATE_URLS; else process.env.ALLOW_PRIVATE_URLS = original.allow;
  if (original.node === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = original.node;
});

test('classifies private, internal and public addresses', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1', '224.0.0.1', '::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '[::1]']) {
    assert.equal(isBlockedAddress(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '93.184.216.34', '172.15.0.1', '172.32.0.1', '1.1.1.1', '2606:4700:4700::1111']) {
    assert.equal(isBlockedAddress(ip), false, ip);
  }
});

test('production blocks private URLs, including cloud metadata and localhost', async () => {
  process.env.ALLOW_PRIVATE_URLS = 'false';
  for (const url of ['http://127.0.0.1:8080/v1', 'http://[::1]/v1', 'http://10.0.0.5/v1', 'http://169.254.169.254/latest/meta-data', 'http://localhost:11434/v1', 'http://2130706433/v1']) {
    await assert.rejects(assertAllowedUrl(url), /Blocked|resolve/, url);
  }
  await assert.rejects(assertAllowedUrl('ftp://example.com'), /http/);
  await assert.rejects(assertAllowedUrl('not a url'), /not valid/);
  await assertAllowedUrl('https://93.184.216.34/v1'); // a public address is fine
});

test('defaults: allowed in development, blocked when NODE_ENV=production', async () => {
  delete process.env.ALLOW_PRIVATE_URLS;
  process.env.NODE_ENV = 'development';
  await assertAllowedUrl('http://127.0.0.1:11434/v1');
  process.env.NODE_ENV = 'production';
  await assert.rejects(assertAllowedUrl('http://127.0.0.1:11434/v1'), /Blocked/);
  process.env.ALLOW_PRIVATE_URLS = 'true'; // self-hosters can opt in
  await assertAllowedUrl('http://127.0.0.1:11434/v1');
});

test('the guard protects real provider calls, and redirects are refused', async () => {
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/v1/messages')) { res.writeHead(302, { location: 'http://127.0.0.1:1/' }); return res.end(); }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const provider = new AnthropicProvider('k-12345678', base);

  process.env.ALLOW_PRIVATE_URLS = 'false';
  await assert.rejects(provider.generate({ model: 'm', prompt: 'hi' }), /Blocked/);

  process.env.ALLOW_PRIVATE_URLS = 'true';
  await assert.rejects(provider.generate({ model: 'm', prompt: 'hi' }), /Could not reach the provider/); // redirect refused
});
