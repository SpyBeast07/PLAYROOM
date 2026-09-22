# PLAYROOM Backend Deployment Guide

Production deployment guide for the Bun + Hono + WebSocket backend on a VPS behind Cloudflare Tunnel.

---

## 1. Environment Variables

The backend accepts the following environment variables:

| Variable | Default | Purpose | Secret? |
| :--- | :--- | :--- | :--- |
| `PORT` | `3000` (local) / `8787` (Docker) | Port the internal Bun process listens on | No |
| `HOST` | `0.0.0.0` | Host interface to bind to (`0.0.0.0` allows container/network traffic) | No |
| `HOST_PORT` | `18787` | Port on the VPS host mapped to container port `8787` via Docker Compose | No |
| `CORS_ORIGINS` | `http://localhost:5173` | Comma-separated list of allowed frontend origins (e.g. `http://localhost:5173,https://playroom-chi.vercel.app`) | No |
| `NODE_ENV` | `production` | Environment mode (`production` or `development`) | No |

> **Security Note:** While current configuration variables are non-sensitive, never commit any `.env` file containing tokens, private keys, Cloudflare Tunnel credentials, or database passwords. `.gitignore` is configured to ignore all `.env` and `.env.*` files except `.env.example`.

---

## 2. Architecture & Traffic Flow

```text
Vercel Frontend (https://playroom-chi.vercel.app)
       │
       ▼ (HTTPS / WSS API & WebSockets)
Custom Domain (https://playroom.kushagraguptaco.in)
       │
       ▼
Cloudflare Tunnel (cloudflared daemon on VPS)
       │
       ▼ (HTTP / WS on loopback/host port)
VPS Host Port (:18787)
       │
       ▼ (Docker port forward)
Docker Container (:8787)
       │
       ▼
Bun + Hono Backend (listening on 0.0.0.0:8787)
```

- **HTTPS / WSS**: Cloudflare terminates TLS at edge and forwards WebSocket handshakes (`Upgrade: websocket`) and API requests to `http://localhost:18787`.
- **CORS**: Hono evaluates incoming `Origin` headers against `CORS_ORIGINS`. Handshakes and preflight `OPTIONS` requests from allowed origins are granted access.

---

## 3. Local Development (Without Docker)

When developing locally without Docker, no extra setup is required. The backend defaults to `http://0.0.0.0:3000` with default CORS allowed for `http://localhost:5173`:

```bash
cd backend
bun install
bun run dev
```

Override port or CORS locally as needed:
```bash
PORT=4000 CORS_ORIGINS="http://localhost:5173" bun run dev
```

---

## 4. Docker Build & Run (Standalone)

To build and run the Docker container directly without Docker Compose:

### Build Image
```bash
cd backend
docker build -t playroom-backend .
```

### Run Container
```bash
docker run -d \
  --name playroom-backend \
  --restart unless-stopped \
  -p 18787:8787 \
  -e PORT=8787 \
  -e HOST=0.0.0.0 \
  -e CORS_ORIGINS="http://localhost:5173,https://playroom-chi.vercel.app" \
  playroom-backend
```

---

## 5. VPS Deployment (Recommended: Docker Compose)

### Step 1: Copy or Pull Code to VPS
```bash
cd /path/to/PLAYROOM/backend
```

### Step 2: Create Production `.env`
Copy the template and configure your production origins and host port:
```bash
cp .env.example .env
```

Example `.env` on VPS:
```env
PORT=8787
HOST=0.0.0.0
HOST_PORT=18787
NODE_ENV=production
CORS_ORIGINS=http://localhost:5173,https://playroom-chi.vercel.app
```

### Step 3: Start the Backend Service
```bash
docker compose up -d --build
```

### Step 4: Stop or Restart Service
```bash
# View running status
docker compose ps

# Restart service
docker compose restart

# Stop service
docker compose down

# Rebuild after pulling latest git commits
docker compose up -d --build
```

---

## 6. Cloudflare Tunnel Configuration

Point your Cloudflare Tunnel to the VPS host port:

1. In the **Cloudflare Zero Trust Dashboard** (or via `config.yml` if using CLI tunnel):
   - Navigate to **Networks** → **Tunnels** → select your tunnel.
   - Add a Public Hostname:
     - **Subdomain**: `playroom`
     - **Domain**: `kushagraguptaco.in`
     - **Path**: *(leave empty)*
     - **Type**: `HTTP`
     - **URL**: `localhost:18787` (or `127.0.0.1:18787`)
2. Under **Additional application settings**:
   - **HTTP2**: Enabled (optional)
   - **No TLS Verify**: N/A (connection to host port is plain HTTP)
   - WebSockets are supported automatically over Cloudflare HTTP ingress rules.

---

## 7. Monitoring, Health Check, and Logs

### Health Check Endpoint
The backend exposes `GET /health`:
```bash
# From VPS host
curl http://localhost:18787/health
# Response: {"status":"ok","service":"playroom-backend"}
```

The Dockerfile and `docker-compose.yml` include an automatic health check:
```bash
docker inspect --format='{{json .State.Health.Status}}' playroom-backend
# Output: "healthy"
```

### Viewing Logs
```bash
# Follow real-time logs via docker compose
docker compose logs -f

# Or using docker directly
docker logs -f playroom-backend
```

---

## 8. Frontend Configuration Note

In the SvelteKit frontend (`playroom`), set the environment variable pointing to the production tunnel:

```env
VITE_MAFIA_BACKEND_URL=https://playroom.kushagraguptaco.in
```

The frontend client will automatically use `https://playroom.kushagraguptaco.in` for REST requests and `wss://playroom.kushagraguptaco.in/ws/rooms/...` for WebSockets.
