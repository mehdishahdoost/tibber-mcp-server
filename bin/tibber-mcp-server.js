#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const ENDPOINT = 'https://api.tibber.com/v1-beta/gql';

class TibberError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

async function loadConfig() {
  const configPath = process.env.TIBBER_CONFIG || 'tibber.properties';
  let props = {};
  try {
    const contents = await readFile(configPath, 'utf8');
    for (const line of contents.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) continue;
      const match = trimmed.match(/^([^=:\s]+)\s*[=:]\s*(.*)$/);
      if (match) props[match[1]] = match[2].trim();
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const token = process.env.TIBBER_ACCESS_TOKEN?.trim() || props.accessToken || '';
  const transport = (process.env.TIBBER_TRANSPORT || props.transport || 'stdio').toLowerCase();
  const port = Number(process.env.TIBBER_PORT || props.port || '8080');
  if (!['stdio', 'http'].includes(transport)) throw new Error('TIBBER_TRANSPORT must be stdio or http.');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('TIBBER_PORT must be an integer between 1 and 65535.');
  if (!token) throw new TibberError('AUTH_REQUIRED', 'Set TIBBER_ACCESS_TOKEN or accessToken in tibber.properties.');
  return { token, transport, port };
}

async function gql(token, query, variables = {}) {
  let response;
  try {
    response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'user-agent': `tibber-mcp-server/0.2.1 Node/${process.versions.node}`
      },
      body: JSON.stringify({ query, variables })
    });
  } catch {
    throw new TibberError('API_ERROR', 'Could not connect to the Tibber API. Check network access and try again.');
  }
  if (response.status === 401 || response.status === 403) {
    throw new TibberError('AUTH_FAILED', 'Tibber rejected the access token. Check its validity and permissions.');
  }
  let body;
  try { body = await response.json(); } catch { throw new TibberError('API_ERROR', 'Tibber returned an unreadable response.'); }
  if (body.errors?.length) throw new TibberError('API_ERROR', `Tibber GraphQL request failed (HTTP ${response.status}): ${body.errors[0].message || 'unknown error'}`);
  if (!response.ok) throw new TibberError('API_ERROR', `Tibber API returned HTTP ${response.status}.`);
  if (!body.data) throw new TibberError('EMPTY_DATA', 'Tibber returned no data for this request.');
  return body.data;
}

function cursor(date) { return Buffer.from(date).toString('base64'); }
function validDate(value, key) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value)) || !/(Z|[+-]\d\d:\d\d)$/.test(value)) {
    throw new TibberError('INVALID_INPUT', `${key} must be an ISO-8601 timestamp with a UTC offset.`);
  }
  return new Date(value);
}
function requireHomeId(value) {
  if (typeof value !== 'string' || !value.trim()) throw new TibberError('INVALID_INPUT', 'homeId is required.');
  return value;
}

function addTools(server, token) {
  server.registerTool('tibber_account', {
    description: 'Get the authenticated Tibber user and homes.',
    inputSchema: {}
  }, async () => toolResult(async () => gql(token,
    '{ viewer { userId login name accountType homes { id appNickname type size address { address1 postalCode city country } } } }')));

  server.registerTool('tibber_home', {
    description: 'Get details for one Tibber home.',
    inputSchema: { homeId: z.string().min(1).describe('Tibber home ID') }
  }, async ({ homeId }) => toolResult(async () => gql(token,
    'query($id: ID!) { viewer { home(id: $id) { id appNickname type size address { address1 postalCode city country } features { realTimeConsumptionEnabled } } } }',
    { id: requireHomeId(homeId) })));

  server.registerTool('tibber_prices', {
    description: 'Get current, today, and available day-ahead consumption prices for a home.',
    inputSchema: { homeId: z.string().min(1).describe('Tibber home ID') }
  }, async ({ homeId }) => toolResult(async () => {
    const data = await gql(token,
      `query Prices($id: ID!) {
        viewer {
          home(id: $id) {
            id
            currentSubscription {
              priceInfo {
                current { total energy tax startsAt currency }
                today { total energy tax startsAt currency }
                tomorrow { total energy tax startsAt currency }
              }
            }
          }
        }
      }`,
      { id: requireHomeId(homeId) });
    const info = data.viewer?.home?.currentSubscription?.priceInfo;
    if (info && Array.isArray(info.tomorrow) && info.tomorrow.length === 0) {
      info.futurePrices = { available: false, reason: 'Tibber has not published day-ahead prices yet.' };
    }
    return data;
  }));

  server.registerTool('tibber_history', {
    description: 'Get consumption or production history for a home (up to 31 days per request).',
    inputSchema: {
      homeId: z.string().min(1),
      from: z.string().describe('Start ISO-8601 timestamp with UTC offset'),
      to: z.string().describe('End ISO-8601 timestamp with UTC offset'),
      type: z.enum(['consumption', 'production']).default('consumption'),
      resolution: z.enum(['HOURLY', 'DAILY']).default('HOURLY')
    }
  }, async ({ homeId, from: fromValue, to: toValue, type = 'consumption', resolution = 'HOURLY' }) => toolResult(async () => {
    const id = requireHomeId(homeId);
    const from = validDate(fromValue, 'from');
    const to = validDate(toValue, 'to');
    if (to <= from) throw new TibberError('INVALID_RANGE', 'Provide a to timestamp later than from.');
    if (to - from > 31 * 24 * 60 * 60 * 1000) throw new TibberError('INVALID_RANGE', 'Tibber history supports at most 31 days per request.');
    const measure = type === 'production' ? 'production' : 'consumption';
    const amount = type === 'production' ? 'profit' : 'cost';
    const field = type;
    const data = await gql(token,
      `query($id: ID!, $to: String!, $limit: Int!) { viewer { home(id: $id) { id ${field}(resolution: ${resolution}, last: $limit, before: $to) { nodes { from to ${amount} unitPrice ${measure} } pageInfo { count currency } } } } }`,
      { id, to: cursor(toValue), limit: resolution === 'HOURLY' ? 744 : 31 });
    const connection = data.viewer?.home?.[field];
    if (Array.isArray(connection?.nodes)) {
      connection.nodes = connection.nodes.filter(node => {
        const timestamp = Date.parse(node.from);
        return Number.isFinite(timestamp) && timestamp >= from.getTime() && timestamp < to.getTime();
      });
      if (!connection.nodes.length) throw new TibberError('EMPTY_DATA', 'Tibber returned no history for the requested date range.');
    }
    return data;
  }));
}

async function toolResult(operation) {
  try {
    const data = await operation();
    return { structuredContent: data, content: [{ type: 'text', text: JSON.stringify(data) }] };
  } catch (error) {
    const detail = error instanceof TibberError ? error : new TibberError('API_ERROR', 'Tibber request failed.');
    const structuredContent = { error: { code: detail.code, message: detail.message } };
    return { isError: true, structuredContent, content: [{ type: 'text', text: JSON.stringify(structuredContent) }] };
  }
}

export function makeServer(token) {
  const server = new McpServer({ name: 'tibber-mcp-server', version: '0.2.1' });
  addTools(server, token);
  return server;
}

async function startStdio(token) {
  const server = makeServer(token);
  const transport = new StdioServerTransport();
  // Explicitly keep the input stream active when launched with a pipe by an MCP host.
  process.stdin.resume();
  await server.connect(transport);
  const keepAlive = setInterval(() => {}, 60_000);
  const shutdown = () => { clearInterval(keepAlive); void server.close(); };
  process.stdin.once('end', shutdown);
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

async function startHttp(token, port) {
  const httpServer = createServer(async (req, res) => {
    if (req.url !== '/mcp') { res.writeHead(404).end('Not found'); return; }
    if (req.method === 'GET' || req.method === 'DELETE') { res.writeHead(405).end('Method not allowed'); return; }
    let body;
    if (req.method === 'POST') {
      try {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
      } catch { res.writeHead(400).end('Invalid JSON'); return; }
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const mcp = makeServer(token);
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch {
      if (!res.headersSent) res.writeHead(500).end('MCP request failed');
    } finally {
      await transport.close().catch(() => {});
      await mcp.close().catch(() => {});
    }
  });
  httpServer.listen(port, '127.0.0.1', () => process.stderr.write(`Tibber MCP server listening on http://127.0.0.1:${port}/mcp\n`));
  const shutdown = () => httpServer.close();
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

// Resolve npm's executable symlink so importing the factory does not start a CLI.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    const config = await loadConfig();
    if (config.transport === 'http') await startHttp(config.token, config.port);
    else await startStdio(config.token);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
