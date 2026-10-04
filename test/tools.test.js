import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSchema, graphql } from 'graphql';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { makeServer } from '../bin/tibber-mcp-server.js';

// The subset used by our tools, from https://developer.tibber.com/api/reference.md.
// Parse, validate, and execute outgoing queries instead of accepting arbitrary strings.
const schema = buildSchema(`
  type Query { viewer: Viewer! }
  type Viewer {
    userId: String
    login: String
    name: String
    accountType: [String!]!
    homes: [Home]!
    home(id: ID!): Home!
  }
  type Home {
    id: ID!
    appNickname: String
    type: HomeType!
    size: Int
    address: Address
    features: HomeFeatures
    currentSubscription: Subscription
    consumption(resolution: EnergyResolution!, last: Int, before: String): ConsumptionConnection
    production(resolution: EnergyResolution!, last: Int, before: String): ProductionConnection
  }
  enum HomeType { APARTMENT ROWHOUSE HOUSE COTTAGE }
  type Address { address1: String postalCode: String city: String country: String }
  type HomeFeatures { realTimeConsumptionEnabled: Boolean }
  type Subscription { priceInfo: PriceInfo }
  type PriceInfo { current: Price today: [Price]! tomorrow: [Price]! }
  type Price { total: Float energy: Float tax: Float startsAt: String currency: String! }
  enum EnergyResolution { HOURLY DAILY WEEKLY MONTHLY ANNUAL }
  type ConsumptionConnection { nodes: [Consumption] pageInfo: ConsumptionPageInfo! }
  type ProductionConnection { nodes: [Production] pageInfo: ProductionPageInfo! }
  type ConsumptionPageInfo { count: Int currency: String }
  type ProductionPageInfo { count: Int currency: String }
  type Consumption { from: String! to: String! cost: Float unitPrice: Float consumption: Float }
  type Production { from: String! to: String! profit: Float unitPrice: Float production: Float }
`);

const makePrice = total => ({
  total, energy: total - 0.05, tax: 0.05,
  startsAt: '2026-01-01T12:00:00Z', currency: 'EUR'
});

function history(type, { resolution, before, last }) {
  assert.equal(Buffer.from(before, 'base64').toString('utf8'), '2026-01-02T00:00:00Z');
  assert.equal(last, resolution === 'HOURLY' ? 744 : 31);
  return {
    nodes: [{
      from: resolution === 'HOURLY' ? '2026-01-01T12:00:00Z' : '2026-01-01T00:00:00Z',
      to: resolution === 'HOURLY' ? '2026-01-01T13:00:00Z' : '2026-01-02T00:00:00Z',
      [type]: 2, [type === 'production' ? 'profit' : 'cost']: 0.6, unitPrice: 0.3
    }],
    pageInfo: { count: 1, currency: 'EUR' }
  };
}

const homes = [0.30, 0.45].map((total, index) => ({
  id: `fixture-home-${index + 1}`, appNickname: `Home ${index + 1}`, type: 'HOUSE', size: 100,
  address: { address1: '1 Fixture Street', postalCode: '1234 AB', city: 'Fixture City', country: 'NL' },
  features: { realTimeConsumptionEnabled: false },
  currentSubscription: { priceInfo: {
    current: makePrice(total), today: [makePrice(total)],
    tomorrow: index === 0 ? [makePrice(total + 0.01)] : []
  } },
  consumption: args => history('consumption', args),
  production: args => history('production', args)
}));

async function connect(t) {
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://api.tibber.com/v1-beta/gql');
    assert.equal(options.method, 'POST');
    const headers = new Headers(options.headers);
    assert.equal(headers.get('authorization'), 'Bearer fixture-token');
    assert.match(headers.get('user-agent'), /tibber-mcp-server\/.*Node\//);
    const { query, variables } = JSON.parse(options.body);
    const result = await graphql({
      schema, source: query, variableValues: variables,
      rootValue: { viewer: {
        userId: 'fixture-user', login: 'fixture', name: 'Fixture', accountType: ['CUSTOMER'], homes,
        home: ({ id }) => homes.find(home => home.id === id)
      } }
    });
    return Response.json(result, { status: result.errors ? 400 : 200 });
  });
  const server = makeServer('fixture-token');
  const client = new Client({ name: 'query-regression', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError ?? false, false, result.content[0]?.text);
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  return result.structuredContent.viewer;
}

test('account query validates and returns both home addresses', async t => {
  const viewer = await call(await connect(t), 'tibber_account');
  assert.equal(viewer.userId, 'fixture-user');
  assert.equal(viewer.homes.length, 2);
  assert.deepEqual(viewer.homes[0].address, homes[0].address);
});

test('home query validates and selects the requested home', async t => {
  const viewer = await call(await connect(t), 'tibber_home', { homeId: homes[1].id });
  assert.equal(viewer.home.id, homes[1].id);
  assert.deepEqual(viewer.home.address, homes[1].address);
});

for (const [index, home] of homes.entries()) {
  test(`price query validates and returns current prices for home ${index + 1}`, async t => {
    const viewer = await call(await connect(t), 'tibber_prices', { homeId: home.id });
    assert.equal(viewer.home.id, home.id);
    const info = viewer.home.currentSubscription.priceInfo;
    assert.deepEqual(info.current, home.currentSubscription.priceInfo.current);
    assert.deepEqual(info.today, home.currentSubscription.priceInfo.today);
    assert.deepEqual(info.tomorrow, home.currentSubscription.priceInfo.tomorrow);
    if (index === 1) assert.equal(info.futurePrices.available, false);
    else assert.equal(info.futurePrices, undefined);
  });
}

for (const type of ['consumption', 'production']) {
  for (const resolution of ['HOURLY', 'DAILY']) {
    test(`${type} query validates at ${resolution} resolution`, async t => {
      const viewer = await call(await connect(t), 'tibber_history', {
        homeId: homes[0].id, type, resolution,
        from: '2026-01-01T00:00:00Z', to: '2026-01-02T00:00:00Z'
      });
      assert.equal(viewer.home[type].nodes[0][type], 2);
      assert.equal(viewer.home[type].pageInfo.currency, 'EUR');
    });
  }
}
