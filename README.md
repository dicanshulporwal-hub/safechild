# SafeBrowse 🛡️

### Cross-Device Child Web Protection Platform

> **"One child. Multiple devices. One protection policy."**

SafeBrowse is a unified family internet safety platform that enforces parental web controls directly on child devices (Android & Windows), ensuring continuous protection across Home Wi-Fi, Mobile 4G/5G, School Wi-Fi, and public hotspots without relying solely on browser plugins or router DNS.

---

## 🌟 Key Features

1. **Child-Centric Policy Model:** Define website rules once for a child; SafeBrowse distributes and enforces them synchronously across all paired phones, laptops, and tablets.
2. **Device-Level Protection:** Network-level enforcement via Android `VpnService` and Windows local DNS interceptor prevents bypass through alternate browsers or apps.
3. **Offline Protection:** Child devices cache active policies locally (`policy.json`) and evaluate access decisions instantly without internet latency or backend dependencies.
4. **"Ask Parent" & Temporary Exceptions:** Children can request access directly from the block screen with a reason (e.g. *"Need a maths tutorial"*). Parents can approve for **15 minutes**, **1 hour**, **Today**, or **Always**. Rules automatically revert to `BLOCK` after expiration.
5. **Protection Health Monitoring:** Real-time device heartbeats track whether local enforcement is actively running (🟢 **Protected**, 🟡 **Syncing**, 🔴 **Protection Inactive**).
6. **Privacy-First Telemetry:** Only domain names and timestamps are recorded for safety events. Search keywords, private messages, and browsing histories are never collected.
7. **Interactive Live Device Simulator:** Built-in interactive simulator in the Parent Dashboard to test and demonstrate cross-device blocking, multi-device synchronization, and the "Ask Parent" approval workflow.

---

## 📁 Monorepo Structure

```
safechild/
├── packages/
│   ├── shared/            # Shared TypeScript types, Domain Normalizer, Matcher, & Policy Engine
│   ├── backend/           # SafeBrowse Cloud API (Express + WebSockets + Store)
│   ├── parent-web/        # Modern Parent Web App (React + Vite + Tailwind CSS + Lucide)
│   ├── agent-windows/     # Windows Local DNS Proxy + Local Block Page Server
│   └── agent-android/     # Android App (VpnService + Room Policy Cache + Ask Parent UI)
├── scripts/
│   └── test-e2e-scenario.ts # Automated End-to-End Section 22 Acceptance Test
└── package.json
```

---

## 🚀 Quick Start

### 1. Install Dependencies & Build Packages
```bash
npm install
npm run build
```

### 2. Run the SafeBrowse Platform
Start both the Backend Cloud API (Port 1002) and the Parent Web Dashboard (Port 1001):
```bash
npm run dev
```

* **Parent Web Dashboard:** [http://localhost:1001](http://localhost:1001)
* **Backend API & WebSockets:** [http://localhost:1002](http://localhost:1002) (WebSocket on `/ws`)

Demo Parent Credentials:
* **Email:** `parent@safebrowse.io`
* **Password:** `password123`

---

### 3. Run the Automated Section 22 End-to-End Test
Verifies the full multi-device pairing, remote policy synchronization, "Ask Parent" temporary approvals, and automatic TTL expiration:
```bash
npx ts-node scripts/test-e2e-scenario.ts
```

---

### 4. Run the Windows Local Enforcement Agent
```bash
npm run dev --workspace=packages/agent-windows
```
* **Local Block Landing Page:** [http://127.0.0.1:8880](http://127.0.0.1:8880)
* **Local DNS Interceptor:** Listening on `127.0.0.1:5353`

---

## 🔒 Security & Privacy Guarantees

* **Zero Surveillance Browsing:** Full URLs, page contents, search queries, and private chats are never inspected or logged.
* **Tamper-Resistant Health Checks:** If a child uninstalls the agent or disconnects VPN protection, the parent dashboard alerts the parent within 60–90 seconds with a 🔴 **Protection Inactive** status badge.
