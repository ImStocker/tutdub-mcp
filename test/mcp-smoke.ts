/**
 * Smoke test: spawns the MCP server on stdio and performs the
 * initialize -> tools/list handshake.
 *
 * The server runs with an isolated TUTDUB_CONFIG_HOME so the test always
 * behaves like a fresh install, regardless of any real `tutdub-mcp login`
 * performed on this machine.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const configHome = mkdtempSync(join(tmpdir(), 'tutdub-mcp-smoke-'));

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['src/cli.ts', 'serve'],
  cwd: import.meta.dir + '/..',
  stderr: 'pipe',
  env: { TUTDUB_CONFIG_HOME: configHome },
});

try {
  const client = new Client({ name: 'smoke', version: '0.0.0' });
  await client.connect(transport);

  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  console.log('tools:', names.join(', '));

  const expected = [
    'cancel_media',
    'delete_media',
    'download_result',
    'get_download_urls',
    'get_status',
    'list_media',
    'start_dub',
    'transcribe_media',
    'upload_media',
    'whoami',
  ];
  const missing = expected.filter((n) => !names.includes(n));
  if (missing.length) throw new Error(`missing tools: ${missing.join(', ')}`);

  // Every tool must have a description and an input schema.
  for (const t of tools) {
    if (!t.description) throw new Error(`tool ${t.name} has no description`);
    if (!t.inputSchema) throw new Error(`tool ${t.name} has no input schema`);
  }

  // Fresh config -> whoami works without a token (returns loggedIn: false).
  const result = await client.callTool({ name: 'whoami', arguments: {} });
  const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? '';
  console.log('whoami:', text.replace(/\s+/g, ' ').slice(0, 120));
  if (!text.includes('loggedIn')) {
    throw new Error('unexpected whoami payload');
  }

  await client.close();
  console.log('MCP smoke test OK');
} finally {
  rmSync(configHome, { recursive: true, force: true });
}
