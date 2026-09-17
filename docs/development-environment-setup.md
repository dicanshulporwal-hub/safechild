# SafeBrowse Development Environment Runbook

This document describes the validated SafeBrowse development environment for both **VM1 Ubuntu** and future **Local Windows** development.

---

## Validated VM1 Baseline

| Component | Specification / Address | Notes |
| :--- | :--- | :--- |
| **Node.js** | `20.x` (NVM managed) | Compatible with LTS Node 20 runtimes |
| **PostgreSQL** | `16` | Dedicated local container isolated from production |
| **PostgreSQL Port** | `127.0.0.1:55432` | Bound strictly to loopback interface |
| **Development Database** | `safebrowse_dev` | Primary development schema and data |
| **Test Database** | `safebrowse_test` | Dedicated database for automated test suites |
| **Backend API** | `127.0.0.1:11002` | Express + Prisma backend server |
| **Frontend Web** | `127.0.0.1:11001` | React + Vite parent dashboard |

---

## 1. Repository Architecture

SafeBrowse is structured as a monorepo using **npm workspaces** (`"workspaces": ["packages/*"]`).

```
safebrowse/
├── packages/
│   ├── shared/          # @safebrowse/shared
│   ├── protocol/        # @safebrowse/protocol
│   ├── backend/         # @safebrowse/backend
│   ├── parent-web/      # @safebrowse/parent-web
│   └── agent-windows/   # @safebrowse/agent-windows
├── scripts/             # Root utility & verification scripts
└── docs/                # Architecture & runbook documentation
```

### Workspace Packages

1. **`packages/shared` (`@safebrowse/shared`)**
   - Contains shared domain types, validation schemas, common utility functions, and business models used across all packages.
2. **`packages/protocol` (`@safebrowse/protocol`)**
   - Defines wire protocol formats, Data Transfer Objects (DTOs), serialization helpers, and message contracts between the backend server, enforcement agents, and client applications.
3. **`packages/backend` (`@safebrowse/backend`)**
   - Node.js / Express REST and WebSocket application server. Integrates Prisma ORM for PostgreSQL persistence, JWT authentication, policy distribution, and device telemetry.
4. **`packages/parent-web` (`@safebrowse/parent-web`)**
   - Single-page application for the parent management dashboard built with React, Vite, and Tailwind CSS. Configured with a local development reverse proxy for `/api` and `/ws`.
5. **`packages/agent-windows` (`@safebrowse/agent-windows`)**
   - Windows desktop enforcement agent service and sync client. Contains synchronization client artifacts and build pipelines for policy enforcement and heartbeat reporting.

### Workspace Build Order

Because packages have inter-dependencies (e.g., backend tests depend on Windows agent sync client artifacts), the monorepo build executes in topological order:
```bash
npm run build
# Executes: build:shared -> build:protocol -> build:windows -> build:backend -> build:web
```

---

## 2. Environment Variables

Environment variables are configured via `.env` in the repository root.

> **CRITICAL SECURITY REQUIREMENT**:
> - Never commit passwords, PATs, JWT secrets, private SSH keys, database credentials, or `.env` files to version control.
> - Ensure `.env` files are secured with mode `600` (`chmod 600 .env`).

### Variable Reference

| Variable Name | Purpose | Scope / Expected Value |
| :--- | :--- | :--- |
| `DATABASE_URL` | PostgreSQL connection string for active development | Format: `postgresql://<user>:<password>@127.0.0.1:55432/safebrowse_dev?schema=public` |
| `TEST_DATABASE_URL` | PostgreSQL connection string for automated tests | Format: `postgresql://<user>:<password>@127.0.0.1:55432/safebrowse_test?schema=public` |
| `JWT_SECRET` | Cryptographic secret for signing and verifying JSON Web Tokens | Strong random key for parent/device authentication |
| `NODE_ENV` | Application environment lifecycle mode | `development` or `test` |
| `HOST` | Backend server network interface binding | `127.0.0.1` (defaults to loopback for security) |
| `PORT` | Backend server TCP port | `11002` |
| `AUTO_SEED_DEMO` | Demo data seeding on backend startup | **`false`** (disables automatic creation/seeding of SafeBrowse demo accounts/data on normal VM1 startup) |
| `VITE_DEV_HOST` | Host interface for Vite dev server binding | `127.0.0.1` |
| `VITE_DEV_PORT` | TCP port for Vite dev server | `11001` |
| `VITE_API_TARGET` | Target URL for Vite `/api` reverse proxy | `http://127.0.0.1:11002` |
| `VITE_WS_TARGET` | Target URL for Vite `/ws` reverse proxy | `ws://127.0.0.1:11002` |

---

## 3. Database Setup

SafeBrowse relies on PostgreSQL 16 with separate development and test databases.

### Key Principles

- **Engine**: PostgreSQL 16 running on isolated port `55432` bound to `127.0.0.1`.
- **Database Separation**:
  - `safebrowse_dev`: Main development database used by the running backend service.
  - `safebrowse_test`: Isolated database used solely for test execution.
- **Prisma Client Generation**:
  - Generates types and database access client:
    ```bash
    npm run db:generate
    ```
- **Prisma Migrations**:
  - Deploys pending migrations safely without interactive resets:
    ```bash
    npm run db:migrate:deploy
    ```
- **Fail-Secure Test Database Guard**:
  - Destructive tests and integration suites must ONLY use `TEST_DATABASE_URL`.
  - The automated test runner (`packages/backend/scripts/run-tests.js`) enforces fail-secure checks before running:
    1. `TEST_DATABASE_URL` must be explicitly defined and non-empty.
    2. Protocol must be PostgreSQL.
    3. Host must match permitted test database hosts: `localhost`, `127.0.0.1`, `postgres-test`, `::1` / `[::1]`.
    4. Database name **must end with `_test`**.
  - Any connection attempt pointing to a non-test database (e.g., `safebrowse_dev` or production) aborts immediately.

---

## 4. Standard Commands

### Daily Workflow Commands

```bash
# Clean dependency installation
npm ci

# Generate Prisma client artifacts
npm run db:generate

# Apply pending schema migrations to development database
npm run db:migrate:deploy

# Build all packages in correct topological order
npm run build

# Static PostgreSQL cutover gate verifying zero legacy JSON DataStore imports/usages in backend source and compiled output
npm run verify:postgres-cutover

# Run all workspace unit and integration tests
npm test

# Run PostgreSQL end-to-end test suite against TEST_DATABASE_URL
npm run test:postgres:e2e
```

### Current Validated Test Baseline

```
Workspace test suite:   166/166 passed
PostgreSQL E2E subset:   30/30 passed when executed separately
Failed:                  0
```

The 30 PostgreSQL E2E tests are included within the backend/workspace suite and therefore must not be added again to produce 196.

---

## 5. Git Workflow

SafeBrowse uses GitHub as the single source of truth.

> **Multi-Machine Development Rule**:
> VM1 Ubuntu and Local Windows are two working copies of the **same** GitHub repository.
> Do not create separate branches merely because development takes place on different machines.

### Before Starting Work (Synchronize Remote)
```bash
git status
git fetch origin
git pull --rebase
```

### Before Switching Machines (Save Recoverable Checkpoint)
```bash
git status
git add -A
git commit -m "wip: development checkpoint"
git push
```

By pushing checkpoints to GitHub before leaving a workstation, work can be resumed immediately on the alternate machine via `git pull --rebase`.

---

## 6. GitHub Authentication

All Git operations between development environments and GitHub should use **SSH authentication**.

### SSH Setup Guidelines
- Generate an SSH keypair on the host using `ssh-keygen`:
  ```bash
  ssh-keygen -t ed25519 -C "developer@safebrowse"
  ```
- Add the public key (`~/.ssh/id_ed25519.pub`) to your GitHub account under **Settings > SSH and GPG keys**.
- Verify connection:
  ```bash
  ssh -T git@github.com
  ```
- Ensure remote URL uses the SSH format:
  ```bash
  git remote set-url origin git@github.com:dicanshulporwal-hub/safechild.git
  ```

> **CRITICAL**:
> - Never copy or expose private SSH keys (`id_ed25519`, `id_rsa`).
> - Private keys must remain strictly on the machine where they were generated.

---

## 7. VM1 Persistent Services

On VM1, development backend and frontend services run as **systemd user services** under the `agdev` user. They are NOT root or system-wide services.

### Service Units
- `safebrowse-backend-dev.service` (`~/.config/systemd/user/safebrowse-backend-dev.service`)
- `safebrowse-frontend-dev.service` (`~/.config/systemd/user/safebrowse-frontend-dev.service`)

### Service Management Commands
```bash
# Check service status
systemctl --user status safebrowse-backend-dev.service
systemctl --user status safebrowse-frontend-dev.service

# Restart services after building or pulling changes
systemctl --user restart safebrowse-backend-dev.service
systemctl --user restart safebrowse-frontend-dev.service

# Inspect service logs
journalctl --user -u safebrowse-backend-dev.service -n 100 --no-pager
journalctl --user -u safebrowse-frontend-dev.service -n 100 --no-pager
```

### User Lingering (`Linger=yes`)
User lingering is enabled on VM1:
```bash
loginctl show-user agdev -p Linger
# Returns: Linger=yes
```
This ensures the `systemd --user` instance starts on VM boot and keeps development services running after interactive SSH sessions disconnect.

### Environment for SSH and Non-Login Shells
When managing systemd user services via non-interactive SSH sessions or scripts, export the user session D-Bus variables:
```bash
export XDG_RUNTIME_DIR=/run/user/$(id -u)
export DBUS_SESSION_BUS_ADDRESS=unix:path=$XDG_RUNTIME_DIR/bus
```

---

## 8. Browser Access

The development frontend binds strictly to `127.0.0.1` on VM1. To access the dashboard from a local Windows workstation, establish an SSH tunnel.

### Establishing the SSH Tunnel (Windows Terminal)
```bash
ssh -N -L 11001:127.0.0.1:11001 -p 2222 ubuntu@103.232.25.35
```

### Accessing the Dashboard
Open your web browser on Windows:
```
http://127.0.0.1:11001
```

### Why Backend Port 11002 Does Not Require a Tunnel
The Parent Web Vite development server contains an integrated reverse proxy configuration:
- All `/api/*` HTTP requests are proxied internally on VM1 to `http://127.0.0.1:11002`.
- All `/ws` WebSocket requests are proxied internally on VM1 to `ws://127.0.0.1:11002`.

Therefore, forwarding frontend port `11001` provides complete access to both the frontend interface and all backend APIs.

---

## 9. Production Isolation

VM1 also hosts the live **SPMCS production workload**. Strict isolation boundaries are enforced to guarantee production stability.

### Development Isolation Guardrails
SafeBrowse development is performed strictly under the non-root Linux user `agdev`.

SafeBrowse development must **NEVER**:
- Modify SPMCS production services, containers, or configs.
- Modify the SPMCS Docker network or shared Docker resources.
- Modify system nginx configuration unless explicitly authorized.
- Expose development ports (`11001`, `11002`, `55432`) publicly or on `0.0.0.0`.
- Add the `agdev` user to the `docker` group.
- Run development processes as `root` or use `sudo`.
- Restart, stop, or reload the Docker daemon.

---

## 10. Future Local Windows Setup

For development directly on a Windows workstation, configure an equivalent isolated environment matching the VM1 architecture:

### Intended Windows Baseline
- **Node.js**: `20.x` LTS (via nvm-windows or Node installer)
- **Container Engine**: Docker Desktop for Windows
- **PostgreSQL**: PostgreSQL 16 container exposed locally on port `55432` (`127.0.0.1:55432`)
- **Databases**:
  - `safebrowse_dev` (development)
  - `safebrowse_test` (automated tests)
- **Backend Port**: `11002` (bound to `127.0.0.1`)
- **Frontend Port**: `11001` (bound to `127.0.0.1`)

### Local Credentials & Environment Isolation
- Create an independent, machine-specific `.env` on Windows.
- **Do not reuse VM1 passwords, JWT secrets, or connection strings.**
- **Do not copy `.env` from VM1.**
- Generate unique, secure credentials for the local Windows development instance.

---

## 11. VM1 Health Checks

To verify that the VM1 SafeBrowse development environment is healthy and operational, run the following commands:

```bash
# 1. Verify Backend API health
curl http://127.0.0.1:11002/health
# Expected: {"status":"healthy","timestamp":"..."}

# 2. Verify Parent Web frontend
curl -I http://127.0.0.1:11001/
# Expected: HTTP/1.1 200 OK

# 3. Verify loopback socket bindings
ss -ltn | grep -E '11001|11002|55432'
# Expected: All ports listen strictly on 127.0.0.1 (not 0.0.0.0 or *)
```

Both web ports (`11001`, `11002`) and the database port (`55432`) must remain strictly bound to `127.0.0.1`.
