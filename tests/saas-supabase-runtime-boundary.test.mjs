import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configPath = path.join(root, 'js', 'config.js');
const main = fs.readFileSync(path.join(root, 'js', 'main.js'), 'utf8');
const service = fs.readFileSync(path.join(root, 'js', 'services', 'supabase.js'), 'utf8');
const config = await import(pathToFileURL(configPath));

test('only the designated SaaS staging endpoint and key are accepted', () => {
  assert.equal(config.isSaasStagingSupabaseUrl(config.COMPANY_SUPABASE_URL), true);
  assert.equal(config.isSaasStagingSupabaseUrl('https://example.supabase.co'), false);
  assert.equal(config.isSaasStagingSupabaseUrl('http://mqxqswwssmemkimnolfu.supabase.co'), false);
  assert.deepEqual(
    config.assertSaasStagingConnection(config.COMPANY_SUPABASE_URL, config.COMPANY_SUPABASE_KEY),
    { url: config.COMPANY_SUPABASE_URL, key: config.COMPANY_SUPABASE_KEY }
  );
  assert.throws(
    () => config.assertSaasStagingConnection('https://example.supabase.co', config.COMPANY_SUPABASE_KEY),
    /Supabase test/
  );
  assert.throws(
    () => config.assertSaasStagingConnection(config.COMPANY_SUPABASE_URL, 'wrong-key'),
    /Supabase test/
  );
});

test('runtime replaces legacy browser configuration and clears its auth session', () => {
  assert.match(main, /previousUrl !== COMPANY_SUPABASE_URL \|\| previousKey !== COMPANY_SUPABASE_KEY/);
  assert.match(main, /clearSupabaseAuthStorage\(\);/);
  assert.match(main, /const savedUrl = COMPANY_SUPABASE_URL;/);
  assert.match(main, /const savedKey = COMPANY_SUPABASE_KEY;/);
});

test('connection service enforces staging boundary before creating a client', () => {
  const guardIndex = service.indexOf('assertSaasStagingConnection(url, key)');
  const clientIndex = service.indexOf('supabase.createClient(url, key)');
  assert.ok(guardIndex >= 0);
  assert.ok(clientIndex > guardIndex);
});

test('cloud settings cannot override the locked SaaS connection', () => {
  assert.match(main, /dbUrlInput\.readOnly = true/);
  assert.match(main, /dbKeyInput\.readOnly = true/);
  assert.match(main, /connectSupabase\(COMPANY_SUPABASE_URL, COMPANY_SUPABASE_KEY, true\)/);
});
