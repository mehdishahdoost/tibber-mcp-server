# Tibber MCP Server

Read-only access to Tibber account details, home addresses, electricity prices, and consumption or production history through MCP.

Runs on Node.js 18+ with the official JavaScript MCP SDK and Node's built-in `fetch`. No Java runtime, Maven build, or Java connector is required. Supports stdio and loopback Streamable HTTP; live WebSocket subscriptions and account changes are not implemented.

## Local setup

Run these commands from the repository root. Shell examples use Bash.

```sh
npm ci
```

Get a personal access token from the [Tibber developer portal](https://developer.tibber.com/), then create `tibber.properties` in the repository root:

```properties
accessToken=YOUR_TIBBER_ACCESS_TOKEN
transport=stdio
port=8080
```

Replace the token placeholder with your token. This file is ignored by Git; keep it private and avoid pasting its contents into chats or logs.

To launch manually:

```sh
npm start
```

Stdio mode waits for MCP messages on standard input and writes protocol responses to standard output. A quiet terminal is normal. An MCP client should launch the executable directly, as shown below.

## Connect an MCP client

### Codex CLI

After local setup, run this from the repository root:

```sh
codex mcp add tibber \
  --env "TIBBER_CONFIG=$(pwd)/tibber.properties" \
  --env TIBBER_TRANSPORT=stdio \
  -- node "$(pwd)/bin/tibber-mcp-server.js"

codex mcp list
```

`$(pwd)` resolves to the actual checkout path, so the configuration works even when Codex starts elsewhere. This example reads the token from the properties file. See the [official Codex MCP documentation](https://developers.openai.com/codex/mcp) for client configuration details.

Restart Codex after configuring the server or updating its source so it launches a fresh process. Then ask it to call `tibber_account` to find your homes, followed by `tibber_prices` with the selected home ID. No rebuild is required for JavaScript source changes.

### Clients using `mcpServers` JSON

Replace **both** `/FULL/PATH/TO/tibber-mcp-server` paths below with the actual checkout path. The placeholder is not a valid executable location. Other clients may use different configuration formats.

```json
{
  "mcpServers": {
    "tibber": {
      "command": "node",
      "args": ["/FULL/PATH/TO/tibber-mcp-server/bin/tibber-mcp-server.js"],
      "env": {
        "TIBBER_CONFIG": "/FULL/PATH/TO/tibber-mcp-server/tibber.properties",
        "TIBBER_TRANSPORT": "stdio"
      }
    }
  }
}
```

### Streamable HTTP

With credentials configured, start the server from the repository root:

```sh
TIBBER_TRANSPORT=http TIBBER_PORT=8080 npm start
```

Connect your MCP client using Streamable HTTP at `http://127.0.0.1:8080/mcp`. The server always binds to `127.0.0.1`; there is no configurable public bind address. HTTP mode is stateless and accepts MCP requests through POST. Opening `/mcp` in a browser sends GET and returns HTTP 405; that is expected. The root `/` returns HTTP 404.

### Run with npx

The npm package name is `tibber-mcp-server`. Node.js 18+ is required; no checkout or build is needed.

With `tibber.properties` in the current directory or `TIBBER_ACCESS_TOKEN` set:

```sh
npx -y tibber-mcp-server
```

For a stdio MCP client, use `command: "npx"` and `args: ["-y", "tibber-mcp-server"]`, with an absolute `TIBBER_CONFIG` path or a `TIBBER_ACCESS_TOKEN` environment value. HTTP mode uses the same environment settings as the local executable.

## Configuration

| Environment variable | Properties key | Default / accepted values |
| --- | --- | --- |
| `TIBBER_ACCESS_TOKEN` | `accessToken` | Required; missing credentials stop startup |
| `TIBBER_TRANSPORT` | `transport` | `stdio` (default) or `http` |
| `TIBBER_PORT` | `port` | `8080`; integer from 1 to 65535 |
| `TIBBER_CONFIG` | — | `tibber.properties` in the process's current working directory |

Nonempty environment values take precedence over file values. The optional properties file supports simple `key=value` or `key:value` lines, blank lines, and comments beginning with `#` or `!`. It does not implement the full Java properties escaping or continuation syntax. Use an absolute `TIBBER_CONFIG` path when an MCP client launches the server from another directory.

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
| Startup asks for `TIBBER_ACCESS_TOKEN` | Set the token in the environment or properties file; check the config file's absolute path |
| `AUTH_FAILED` | Tibber returned HTTP 401/403; check the token's validity and access |
| `INVALID_INPUT` / `INVALID_RANGE` | Check home ID, timestamps, ordering, and the 31-day maximum |
| `EMPTY_DATA` | Tibber returned no data or no history nodes within the requested interval |
| `API_ERROR` | Read the message: GraphQL errors include Tibber's first error and HTTP status; also check network access |
| `Cannot find module` / `ERR_MODULE_NOT_FOUND` | Check the real script path and run `npm ci` in the checkout |
| An old GraphQL error persists after a source update | Restart the MCP server/client so it reloads the changed JavaScript |

## Development checks

```sh
npm ci
npm test
```

The 8 regression checks in [test/tools.test.js](test/tools.test.js) call every tool through an in-memory MCP client. A mocked Tibber endpoint parses, validates, and executes the generated GraphQL against a fixture containing the schema fields we use. Coverage includes account/home addresses, prices for two homes, unpublished day-ahead prices, and hourly/daily consumption and production.

Tests use synthetic data and need no Tibber token or network access after dependencies are installed. They do not verify live account data, credentials, upstream schema changes, or stdio/HTTP transport behavior. These checks have been run on Node.js 22.22.0. The `graphql` package is a development dependency used by the checks; the runtime uses the JavaScript MCP SDK and Zod.
