# Route Table

Source: `server.js`

This project registers routes directly on the Express `app`; it does not use `express.Router`.

## Global Middleware

| Type | Path | Description |
|---|---|---|
| `USE` | JSON body | `express.json({ limit })` |
| `USE` | Static files | Serves `public/` |
| `USE` | `/api/admin` | Routes registered after this point require `authenticateAdmin` |

## Pages

| Method | Path | Description |
|---|---|---|
| `GET` | `/admin` | Admin page |
| `GET` | `/admin-login`, `/admin-login/`, `/admin-login.html` | Admin login page |

## Admin API

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/admin/login` | No | Admin login |
| `GET` | `/api/admin/runtime-logs` | Yes | Read runtime logs |
| `POST` | `/api/admin/runtime-logs/clear` | Yes | Clear runtime logs |
| `POST` | `/api/admin/products/generate-stop` | Yes | Stop background product generation |
| `POST` | `/api/admin/proxy/test` | Yes | Test proxy URLs |
| `GET` | `/api/admin/pool-emails` | Yes | List pool emails |
| `POST` | `/api/admin/pool-emails/import` | Yes | Import pool emails |
| `DELETE` | `/api/admin/pool-emails/:id` | Yes | Delete a pool email |
| `GET` | `/api/admin/pool-emails/:id/messages` | Yes | Read recent messages for a pool email |
| `GET` | `/api/admin/session` | Yes | Get or refresh admin session |
| `GET` | `/api/admin/data` | Yes | Get admin dashboard data |
| `DELETE` | `/api/admin/task-logs/:jobKey` | Yes | Delete a task log |
| `POST` | `/api/admin/config` | Yes | Save app config |
| `POST` | `/api/admin/change-password` | Yes | Change admin password |
| `GET` | `/api/admin/cdks` | Yes | List CDKs |
| `POST` | `/api/admin/cdks/generate` | Yes | Generate CDKs |
| `POST` | `/api/admin/cdks/import` | Yes | Import CDKs |
| `POST` | `/api/admin/cdks/:cdk/ship` | Yes | Mark a CDK as shipped |
| `DELETE` | `/api/admin/cdks/:cdk` | Yes | Delete a CDK |
| `GET` | `/api/admin/products` | Yes | List products |
| `DELETE` | `/api/admin/products/:id` | Yes | Delete a product |
| `PUT` | `/api/admin/products/:id/status` | Yes | Update product status |
| `POST` | `/api/admin/products/export` | Yes | Export selected products |
| `GET` | `/api/admin/products/:id/export` | Yes | Export one product |
| `POST` | `/api/admin/products/generate` | Yes | Start product generation |
| `POST` | `/api/admin/products/resume` | Yes | Resume interrupted product generation |

## Public API

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/public/runtime` | Get runtime concurrency status |
| `POST` | `/api/redeem-product` | Redeem a product CDK and start product creation |
| `POST` | `/api/run-process` | Start self-service activation flow |
| `POST` | `/api/verify-cdk` | Verify a CDK |
| `GET` | `/api/cdk/query` | Query CDK status |
| `GET` | `/api/cdk/download` | Download product file by CDK |
| `GET` | `/api/download-sub2api/:filename` | Download a sub2api JSON file |
| `GET` | `/api/download-cpa/:filename` | Download a CPA JSON file |

## WebSocket

The WebSocket server is attached to the same HTTP server. There is no dedicated path restriction in `server.js`.

Clients subscribe to task progress by sending a JSON message:

```json
{
  "type": "subscribe",
  "jobKey": "<task job key>"
}
```

Heartbeat messages use:

```json
{
  "type": "ping",
  "ts": 0
}
```
