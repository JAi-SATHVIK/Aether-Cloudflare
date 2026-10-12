# Project Aether

An edge-native, semantic merge queue designed for autonomous AI coding agents. Aether replaces line-based Git text conflicts with Abstract Syntax Tree (AST) commutativity, speculative topological DAG waves, differential in-worker type checks, and autonomous self-healing invariant repair on Cloudflare Workers and Durable Objects.

For the complete technical specification and compiler design, see **[ARCHITECTURE.md](ARCHITECTURE.md)**.

---

## Table of Contents

- [Prerequisites](#prerequisites)
- [Quickstart: Clone and Run Locally](#quickstart-clone-and-run-locally)
- [Connecting AI Agents via MCP](#connecting-ai-agents-via-mcp)
- [Using the Mission Control Dashboard](#using-the-mission-control-dashboard)
- [Command Line & API Usage](#command-line--api-usage)
- [Running Tests & Validation](#running-tests--validation)
- [Running the 50-Agent Concurrency Benchmark](#running-the-50-agent-concurrency-benchmark)
- [Deploying to Cloudflare Workers](#deploying-to-cloudflare-workers)
- [Architecture Deep Dive](#architecture-deep-dive)
- [License](#license)

---

## Prerequisites

Ensure you have the following installed on your machine:
- **Node.js**: `v22.13.0` or higher (Node 22 LTS recommended)
- **npm**: `v10.0.0` or higher
- **Git**: Any modern Git version

---

## Quickstart: Clone and Run Locally

### 1. Clone the Repository
```bash
git clone https://github.com/JAi-SATHVIK/Aether.git
cd Aether
```

### 2. Install Dependencies
```bash
npm ci
```

### 3. Start the Local Edge Mesh Server
```bash
npm run dev
```

This starts the Cloudflare Worker runtime via Wrangler on `http://127.0.0.1:8787` with:
- The **Mission Control Dashboard** served at `http://127.0.0.1:8787/`
- The **Native Model Context Protocol (MCP)** endpoint at `http://127.0.0.1:8787/mcp`
- The **REST API** at `http://127.0.0.1:8787/proposals/*` and `http://127.0.0.1:8787/whats_happening`

---

## Connecting AI Agents via MCP

Project Aether natively implements the **Model Context Protocol (JSON-RPC 2.0)** standard over HTTP and Server-Sent Events (SSE). This allows LLM coding agents to inspect the repository, check conflicts, repair invariants, and land commits directly from their editor.

### Cursor Configuration
Add Aether to `.cursor/mcp.json` in your workspace:
```json
{
  "mcpServers": {
    "aether": {
      "url": "http://127.0.0.1:8787/mcp",
      "transport": "http"
    }
  }
}
```

### Claude Desktop Configuration
Add Aether to your `claude_desktop_config.json`:
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "aether": {
      "url": "http://127.0.0.1:8787/mcp",
      "transport": "http"
    }
  }
}
```

### Supported MCP Tools
Once connected, agents have access to 10 native tools:
1. `aether_submit_proposal`: Submit a single file or atomic multi-file patch bundle.
2. `aether_check_conflicts`: Dry-run AST diagnostic analysis without altering repository state.
3. `aether_repair`: Self-heal dropped security guards, broken signatures, and syntax errors.
4. `aether_approve_proposal`: Land a proposal atomically to the Git commit ledger.
5. `aether_list_proposals`: Query all pending and landed proposals.
6. `aether_get_concurrency_dag`: View topological execution waves.
7. `aether_get_repo_state`: Read branch HEAD SHA and file contents.
8. `aether_whats_happening`: Query live collision radar for active agents.
9. `aether_why`: Explain why a symbol has conflicts or caller dependencies.
10. `aether_join`: Register agent session in the polar collision radar.

---

## Using the Mission Control Dashboard

Open `http://127.0.0.1:8787` in your browser. The dashboard provides:

1. **Top Telemetry Ribbon:** Live SQLite memory status, current branch HEAD SHA, landed commit counters, and edge ping latency.
2. **Speculative DAG Waves:** Real-time visual depiction of concurrent proposal batches grouped into parallel execution waves.
3. **Polar Collision Radar:** Live activity map displaying which agents are editing which files, with cross-file caller alerts.
4. **3-Way AST Conflict Lab:** Side-by-side inspection of:
   - Authority Base Code
   - Candidate Patch
   - Synthesized Result Editor with 1-click presets:
     - `Accept Candidate`: Loads candidate patch into editor.
     - `Keep Base`: Reverts to authoritative base code.
     - `Disjoint`: Automatically composes disjoint functions.
     - `Diff Markers`: Injects standard 3-way conflict markers.
     - `Format Synthesized AST`: Cleans indentation and formatting.
   - **1-Click Auto-Repair AST:** Click this button to run `AgentRepairEngine`, automatically restoring missing security guards and fixing breaking arities.
   - **Land Commit to Git:** Atomically commits the synthesized code into the Merkle Git ledger.
5. **MCP Tool Testing Console:** Interactive in-browser RPC runner to execute and debug all 10 MCP tools.

---

## Command Line & API Usage

### 1. Read Current Repository State
```bash
curl -s http://127.0.0.1:8787/repo/state \
  -H "Authorization: Bearer aether-development-cluster-secret-32-chars-long" \
  -G -d "repoId=aether-demo-repo" -d "branch=main" -d "filePath=src/calc.ts"
```

### 2. Submit a Code Proposal
```bash
curl -s -X POST http://127.0.0.1:8787/proposals/submit \
  -H "Authorization: Bearer aether-development-cluster-secret-32-chars-long" \
  -H "Content-Type: application/json" \
  -d '{
    "repoId": "aether-demo-repo",
    "targetBranch": "main",
    "baseCommitSha": "0000000000000000000000000000000000000000",
    "filePath": "src/calc.ts",
    "patchContent": "export function add(a: number, b: number): number { return a + b; }\n",
    "intentDescription": "Add add function",
    "idempotencyKey": "prop_add_1"
  }'
```

### 3. Check Live Collision Radar
```bash
curl -s http://127.0.0.1:8787/whats_happening \
  -H "Authorization: Bearer aether-development-cluster-secret-32-chars-long"
```

### 4. Execute Autonomous AST Auto-Repair
```bash
curl -s -X POST http://127.0.0.1:8787/proposals/repair \
  -H "Authorization: Bearer aether-development-cluster-secret-32-chars-long" \
  -H "Content-Type: application/json" \
  -d '{
    "repoId": "aether-demo-repo",
    "proposalId": "prop_add_1",
    "filePath": "src/admin.ts",
    "baseCode": "export function deleteUser(id: string, u: { isAdmin: boolean }) { if (!u.isAdmin) throw new Error(); db.delete(id); }",
    "candidateCode": "export function deleteUser(id: string, u: { isAdmin: boolean }) { db.delete(id); }",
    "autoResubmit": false
  }'
```

### 5. Approve and Land Proposal to Git
```bash
curl -s -X POST http://127.0.0.1:8787/proposals/approve \
  -H "Authorization: Bearer aether-development-cluster-secret-32-chars-long" \
  -H "Content-Type: application/json" \
  -d '{
    "repoId": "aether-demo-repo",
    "proposalId": "prop_add_1",
    "resolvedCode": "export function add(a: number, b: number): number { return a + b; }\n",
    "message": "feat: add calculate helper"
  }'
```

---

## Running Tests & Validation

Aether includes 17 automated test suites verifying AST analysis, concurrency, security gates, and Git mechanics:

```bash
# 1. Typecheck the entire project with TypeScript
npm run typecheck

# 2. Run all 17 automated verification suites
npm test
```

### What the test suite covers:
- AST semantic analysis and diagnostic checking
- Speculative DAG pipelining across 100 proposals (10x concurrency factor)
- Differential in-worker typecheck gate across 9 test cases
- AST composer rules (disjoint symbols, identical dedupe, class methods)
- Security gate authorization and cryptographic token isolation
- 1,000 randomized property tests for mathematical AST delta inversion
- 1,000 randomized concurrent tree move and cycle prevention trials
- 10/10 adversarial alpha-normalized deduplication attacks
- Native Model Context Protocol (MCP) JSON-RPC 2.0 handshake
- Autonomous agent self-healing remediation suite

---

## Running the 50-Agent Concurrency Benchmark

To benchmark Project Aether under load with 50 concurrent simulated agents:

```bash
npm run bench:swarm
```

### Typical Results:
- **Throughput:** ~980 proposals / second
- **P50 Latency:** ~6.78 ms
- **P99 Latency:** ~39.0 ms
- **Merkle Chain Integrity:** 100% verified

---

## Deploying to Cloudflare Workers

### 1. Authenticate with Cloudflare
```bash
npx wrangler login
```

### 2. Configure Cluster Secrets
Set your cluster signing secret in Cloudflare:
```bash
npx wrangler secret put AETHER_AUTH_SECRET
```
*(Enter a secure random string of 32+ characters when prompted).*

### 3. Deploy to the Edge
```bash
npm run deploy
```

Wrangler will package the TypeScript Worker, compile the Durable Object embedded SQLite schema migrations, bundle the static assets in `./public`, and deploy to your Cloudflare account.

---

## Architecture Deep Dive

For the complete technical architecture, dataflow diagrams, compiler internals, and security threat model, read the full specification:

**[ARCHITECTURE.md](ARCHITECTURE.md)**

---

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
