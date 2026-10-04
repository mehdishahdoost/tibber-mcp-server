# Tibber MCP Server

Available on npm: [tibber-mcp-server v0.2.2](https://www.npmjs.com/package/tibber-mcp-server/v/0.2.2).

Read-only access to Tibber account details, home addresses, electricity prices, and consumption or production history through MCP.

Runs on Node.js 18+ with the official JavaScript MCP SDK and Node's built-in `fetch`. No Java runtime, Maven build, or Java connector is required. Supports stdio and loopback Streamable HTTP; live WebSocket subscriptions and account changes are not implemented.

## Connect using npx

Install Node.js 18+ and get a personal access token from the [Tibber developer portal](https://developer.tibber.com/). No checkout or build is needed. Replace `YOUR_TIBBER_ACCESS_TOKEN` in the examples with your token.

### Clients using `mcpServers` JSON

```json
{
  "mcpServers": {
    "tibber": {
      "command": "npx",
      "args": ["-y", "tibber-mcp-server@latest"],
      "env": {
        "TIBBER_ACCESS_TOKEN": "YOUR_TIBBER_ACCESS_TOKEN",
        "TIBBER_TRANSPORT": "stdio"
      }
    }
  }
}
```

### Codex CLI

```sh
codex mcp add tibber \
  --env TIBBER_ACCESS_TOKEN=YOUR_TIBBER_ACCESS_TOKEN \
  --env TIBBER_TRANSPORT=stdio \
  -- npx -y tibber-mcp-server@latest

codex mcp list
```

See the [official Codex MCP documentation](https://developers.openai.com/codex/mcp) for client configuration details. Restart your MCP client after changing its configuration or installing a new release. Ask it to call `tibber_account` to find your homes, then `tibber_prices` with the selected home ID.

`@latest` selects the latest npm release when launched. To pin a version, replace it with `@0.2.2`. Stdio mode waits for MCP messages; a quiet terminal is normal.

### Streamable HTTP

Set your token and launch with npx (Bash):

```sh
export TIBBER_ACCESS_TOKEN=YOUR_TIBBER_ACCESS_TOKEN
TIBBER_TRANSPORT=http TIBBER_PORT=8080 npx -y tibber-mcp-server@latest
```

Connect your MCP client using Streamable HTTP at `http://127.0.0.1:8080/mcp`. The server binds to loopback only. HTTP mode is stateless and accepts MCP requests through POST. Opening `/mcp` in a browser sends GET and returns HTTP 405; the root `/` returns HTTP 404.

### Environment variables

| Variable | Default / accepted values |
| --- | --- |
| `TIBBER_ACCESS_TOKEN` | Required access token |
| `TIBBER_TRANSPORT` | `stdio` (default) or `http` |
| `TIBBER_PORT` | `8080`; integer from 1 to 65535 |

Keep your token private. Client configuration files containing it should not be committed to Git.

## Available tools

| Tool | Required arguments | Optional arguments | Result |
| --- | --- | --- | --- |
| `tibber_account` | None (`{}`) | None | `viewer.userId`, account details, and `viewer.homes` with IDs and addresses |
| `tibber_home` | `homeId` | None | `viewer.home` with address and home details |
| `tibber_prices` | `homeId` | None | Current, today, and tomorrow consumption prices under `viewer.home.currentSubscription.priceInfo` |
| `tibber_history` | `homeId`, `from`, `to` | `type`: `consumption` (default) or `production`; `resolution`: `HOURLY` (default) or `DAILY` | History nodes under `viewer.home.consumption` or `viewer.home.production` |

Home IDs come from `tibber_account` → `viewer.homes[].id`. Price entries include `total`, `energy`, `tax`, `currency`, and `startsAt`. If tomorrow's prices are not published, `tomorrow` remains an empty array and `priceInfo.futurePrices` explains their unavailability; current and today prices remain available. Subscription or price fields may be null if Tibber has no corresponding data for that home.

History timestamps must include `Z` or a UTC offset, with `to` later than `from`. Each request is limited to 31 × 24 hours; split longer intervals into separate requests. Returned nodes are filtered by their start timestamp: `from` is inclusive and `to` is exclusive. Values are not prorated for partially overlapping intervals. `pageInfo` describes the original Tibber page before this filtering.

Example arguments for `tibber_history` (replace `HOME_ID` and choose dates with available data):

```json
{
  "homeId": "HOME_ID",
  "from": "2026-10-01T00:00:00+02:00",
  "to": "2026-10-02T00:00:00+02:00",
  "type": "consumption",
  "resolution": "HOURLY"
}
```

Successful results include `structuredContent` and the same data serialized into a text content block. Tibber uses its [GraphQL API](https://developer.tibber.com/api/reference.md); requests include authentication and a User-Agent identifying this server and Node.js.

## Errors and troubleshooting

API and range errors return MCP `isError: true` with `structuredContent.error.code` and `message`. Invalid arguments rejected by the MCP SDK can instead produce its own validation error.

| Error or symptom | What to check |
| --- | --- |
| Startup asks for `TIBBER_ACCESS_TOKEN` | Set `TIBBER_ACCESS_TOKEN` in the MCP client environment |
| `AUTH_FAILED` | Tibber returned HTTP 401/403; check the token's validity and access |
| `INVALID_INPUT` / `INVALID_RANGE` | Check home ID, timestamps, ordering, and the 31-day maximum |
| `EMPTY_DATA` | Tibber returned no data or no history nodes within the requested interval |
| `API_ERROR` | Read the message: GraphQL errors include Tibber's first error and HTTP status; also check network access |
| `npx` not found | Install Node.js and ensure the MCP client can find `npx` on its PATH |
| An old error persists after an update | Use `tibber-mcp-server@latest` and restart the MCP client |

## Development checks

```sh
npm ci
npm test
```

The 8 regression checks in [test/tools.test.js](test/tools.test.js) call every tool through an in-memory MCP client. A mocked Tibber endpoint parses, validates, and executes the generated GraphQL against a fixture containing the schema fields we use. Coverage includes account/home addresses, prices for two homes, unpublished day-ahead prices, and hourly/daily consumption and production.

Tests use synthetic data and need no Tibber token or network access after dependencies are installed. They do not verify live account data, credentials, upstream schema changes, or stdio/HTTP transport behavior. These checks have been run on Node.js 22.22.0. The `graphql` package is a development dependency used by the checks; the runtime uses the JavaScript MCP SDK and Zod.

## Publishing releases

[`.github/workflows/publish.yml`](https://github.com/mehdishahdoost/tibber-mcp-server/blob/main/.github/workflows/publish.yml) publishes to npm when a GitHub release is published. It checks that the release tag matches `package.json`, installs locked dependencies, and publishes with npm provenance.

One-time setup: in the npm package settings, configure a [trusted publisher](https://docs.npmjs.com/trusted-publishers/) for GitHub Actions:

- Owner: `mehdishahdoost`
- Repository: `tibber-mcp-server`
- Workflow filename: `publish.yml`
- Environment: leave empty

No npm token secret is needed with trusted publishing. For a new release, update the version in `package.json`, `package-lock.json`, and the server metadata in `bin/tibber-mcp-server.js`; commit and push, then publish a GitHub release with the matching `vX.Y.Z` tag. npm versions are immutable; always increment the version.
