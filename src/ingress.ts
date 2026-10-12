import "./shims";
import { Env, DurableObjectLocationHint, ArtifactsPushEvent, ArtifactsQueueEvent } from "./types";
import { ArtifactsBridge, isGitSha, isSafeBranchName } from "./artifacts_bridge";
import { SecurityGate, MAX_PAYLOAD_BYTES } from "./security_gate";
import { AetherMcpServer } from "./mcp_server";
export { ASTMeshShard } from "./shard";
export { MeshCoordinator } from "./coordinator";
const MUTATION_DOMAIN_TAG = new TextEncoder().encode("AETHER-v1-MUTATION:");
const INGRESS_BURST_LIMIT = 500;
const INGRESS_WINDOW_MS = 1000;
const artifactsBridge = new ArtifactsBridge();
export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        const discoveredSecret = env.AETHER_AUTH_SECRET || (env as any).auth_secret || (env as any).AETHER_TOKEN_SECRET;
        if (discoveredSecret) {
            SecurityGate.setClusterSecret(discoveredSecret);
        }
        const url = new URL(request.url);
        if (url.pathname === "/healthz") {
            return new Response("OK", { status: 200 });
        }
        if (url.pathname === "/" && request.method === "GET") {
            return Response.json({
                project: "Project Aether: Agent-Native Semantic Merge Queue for Git",
                status: "ONLINE",
                version: "0.2.0-artifacts",
                environment: env.ENVIRONMENT || "Cloudflare Edge Runtime",
                storageBackend: "Cloudflare Artifacts (Git-compatible)",
                coordinationEngine: "Durable Object SQLite Lane Coordinator",
                arbitrationEngine: "TypeScript AST Compiler API"
            });
        }
        if (request.method === "GET" && url.pathname === "/auth/demo-token") {
            const requestedRepo = url.searchParams.get("repoId") || "aether-demo-repo";
            const demoToken = SecurityGate.mintToken("reviewer-admin", requestedRepo, ["workspace:create", "proposal:submit", "proposal:read", "proposal:approve", "repo:lock", "repo:write", "repo:read", "audit:read"], 86400);
            return Response.json({
                token: demoToken,
                subject: "reviewer-admin",
                scope: requestedRepo,
                expiresIn: 86400
            });
        }
        if (request.method === "GET" && url.pathname === "/auth/judge-token") {
            const requestedRepo = url.searchParams.get("repoId") || "aether-demo-repo";
            const judgeToken = SecurityGate.mintToken("judge-evaluator", requestedRepo, ["proposal:read", "repo:read", "audit:read"], 86400);
            return Response.json({
                token: judgeToken,
                subject: "judge-evaluator",
                scope: requestedRepo,
                permissions: ["proposal:read", "repo:read", "audit:read"],
                expiresIn: 86400,
                instructions: "Use this read-only bearer token in Authorization: Bearer <token> to inspect proposals, lineage, and audit trails."
            });
        }
        if (request.method === "GET" && url.pathname === "/why") {
            const filePath = url.searchParams.get("path") || url.searchParams.get("filePath") || "";
            const symbolName = url.searchParams.get("symbol") || url.searchParams.get("symbolName") || "";
            const repoId = url.searchParams.get("repoId") || "aether-demo-repo";
            if (!filePath || !symbolName) {
                return Response.json({ error: "Missing required query parameters: path, symbol" }, { status: 400 });
            }
            const coordinatorId = env.MESH_COORDINATOR_DO.idFromName(repoId);
            const coordinatorStub = env.MESH_COORDINATOR_DO.get(coordinatorId);
            return coordinatorStub.fetch(new Request(request.url));
        }
        if ((request.method === "POST" || request.method === "GET") && url.pathname === "/auth/ws-ticket") {
            const repo = url.searchParams.get("repo") || "aether-demo-repo";
            const isDev = env.ENVIRONMENT === "development" || url.hostname === "localhost" || url.hostname === "127.0.0.1";
            let subject = "browser-subscriber";
            if (!isDev) {
                const auth = SecurityGate.verifyAuthorization(request.headers.get("Authorization"), repo, "repo:read");
                if (!auth.authorized) {
                    return Response.json({ error: auth.error }, { status: auth.statusCode });
                }
                subject = auth.credential!.sub;
            }
            const ticket = SecurityGate.mintWsTicket(subject, repo, 60);
            return Response.json({
                ticket,
                repo,
                expiresIn: 60,
                purpose: "ws-connect"
            });
        }
        if (url.pathname === "/mcp" || url.pathname === "/mcp/sse") {
            return AetherMcpServer.handleRpc(request, env);
        }
        const extractToken = (): string | null => {
            return request.headers.get("Authorization") || null;
        };
        if (request.method === "POST" && url.pathname === "/artifacts/events") {
            if (!env.AETHER_WEBHOOK_SECRET) {
                return Response.json({ error: "Webhook receiver is not configured." }, { status: 503 });
            }
            const secretHeader = request.headers.get("X-Aether-Webhook-Secret") || "";
            const authHeader = request.headers.get("Authorization") || "";
            if (!constantTimeTextEqual(secretHeader, env.AETHER_WEBHOOK_SECRET) &&
                !constantTimeTextEqual(authHeader, `Bearer ${env.AETHER_WEBHOOK_SECRET}`)) {
                return Response.json({ error: "Unauthorized webhook request" }, { status: 401 });
            }
            try {
                const event = await readJsonWithStreamLimit<ArtifactsPushEvent>(request, MAX_PAYLOAD_BYTES);
                const result = await artifactsBridge.handlePushWebhook(event, env);
                return Response.json(result);
            }
            catch (err: any) {
                return Response.json({ error: err.message }, { status: err.statusCode || 400 });
            }
        }
        if (request.method === "POST" && url.pathname === "/artifacts/workspace") {
            let body: {
                agentId?: string;
                repo?: string;
            };
            try {
                body = await readJsonWithStreamLimit<{
                    agentId?: string;
                    repo?: string;
                }>(request, MAX_PAYLOAD_BYTES);
            }
            catch (err: any) {
                return Response.json({ error: err.message }, { status: err.statusCode || 400 });
            }
            const repo = body.repo || "default-repo";
            const token = extractToken();
            const authResult = SecurityGate.verifyAuthorization(token, repo, "workspace:create");
            if (!authResult.authorized) {
                return Response.json({ error: authResult.error }, { status: authResult.statusCode });
            }
            const allowedRate = await checkIngressRateLimit(repo, authResult.credential!.sub, env);
            if (!allowedRate) {
                return Response.json({ error: "Too Many Requests" }, { status: 429 });
            }
            const workspace = await artifactsBridge.provisionAgentWorkspace(authResult.credential!.sub, repo, env);
            return Response.json(workspace);
        }
        if (request.method === "GET" && url.pathname === "/repo/state") {
            const repoId = url.searchParams.get("repoId") || "";
            const branch = url.searchParams.get("branch") || "main";
            const filePath = url.searchParams.get("filePath") || "";
            if (!repoId || repoId.length > 256 || !isSafeBranchName(branch) || !filePath || !isSafeRepoPath(filePath)) {
                return Response.json({ error: "A valid repoId, branch, and safe filePath are required." }, { status: 400 });
            }
            const authResult = SecurityGate.verifyAuthorization(extractToken(), repoId, "repo:read");
            if (!authResult.authorized) {
                return Response.json({ error: authResult.error }, { status: authResult.statusCode });
            }
            try {
                return Response.json(await artifactsBridge.getBranchSnapshot(repoId, branch, filePath, env));
            }
            catch (err: any) {
                const notFound = err?.code === "NOT_FOUND";
                return Response.json({ error: err?.message || String(err) }, { status: notFound ? 404 : 502 });
            }
        }
        if (request.method === "POST" && url.pathname === "/proposals/submit") {
            let body: any;
            try {
                body = await readJsonWithStreamLimit<any>(request, MAX_PAYLOAD_BYTES);
            }
            catch (err: any) {
                return Response.json({ error: err.message }, { status: err.statusCode || 400 });
            }
            const repoId = typeof body.repoId === "string" ? body.repoId.trim() : "";
            const hasMultiFiles = Array.isArray(body?.files) && body.files.length > 0;
            const validFilePayload = hasMultiFiles
                ? body.files.every((f: any) => f && typeof f.filePath === "string" && isSafeRepoPath(f.filePath) && typeof f.patchContent === "string" && f.patchContent.length > 0)
                : (typeof body?.patchContent === "string" && body.patchContent.length > 0 && typeof body?.filePath === "string" && isSafeRepoPath(body.filePath));
            if (!repoId || repoId.length > 256 || /[\x00-\x1f\x7f]/.test(repoId) ||
                !validFilePayload ||
                typeof body.baseCommitSha !== "string" || !isGitSha(body.baseCommitSha) ||
                (typeof body.targetBranch !== "undefined" && (typeof body.targetBranch !== "string" || !isSafeBranchName(body.targetBranch))) ||
                typeof body.idempotencyKey !== "string" || body.idempotencyKey.length < 8 || body.idempotencyKey.length > 256 ||
                typeof body.intentDescription !== "string" || !body.intentDescription.trim() || body.intentDescription.length > 4096) {
                return Response.json({ error: "Required proposal fields are missing or invalid." }, { status: 400 });
            }
            if (hasMultiFiles && (!body.filePath || !body.patchContent)) {
                body.filePath = body.files[0].filePath;
                body.patchContent = body.files[0].patchContent;
            }
            const token = extractToken();
            const authResult = SecurityGate.verifyAuthorization(token, repoId, "proposal:submit");
            if (!authResult.authorized) {
                return Response.json({ error: authResult.error }, { status: authResult.statusCode });
            }
            const allowedRate = await checkIngressRateLimit(repoId, authResult.credential!.sub, env);
            if (!allowedRate) {
                return Response.json({ error: "Too Many Requests" }, { status: 429 });
            }
            body.agentId = authResult.credential!.sub;
            const coordinatorId = env.MESH_COORDINATOR_DO.idFromName(repoId);
            const coordinatorStub = env.MESH_COORDINATOR_DO.get(coordinatorId);
            return coordinatorStub.fetch(new Request(request.url, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "X-Aether-Verified-Sub": authResult.credential!.sub
                },
                body: JSON.stringify(body)
            }));
        }
        if (request.method === "GET" && url.pathname === "/proposals/get") {
            const repoId = url.searchParams.get("repoId") || "";
            if (!repoId)
                return Response.json({ error: "Missing repoId" }, { status: 400 });
            const token = extractToken();
            const authResult = SecurityGate.verifyAuthorization(token, repoId, "proposal:read");
            if (!authResult.authorized) {
                return Response.json({ error: authResult.error }, { status: authResult.statusCode });
            }
            const coordinatorId = env.MESH_COORDINATOR_DO.idFromName(repoId);
            const coordinatorStub = env.MESH_COORDINATOR_DO.get(coordinatorId);
            return coordinatorStub.fetch(request);
        }
        if (request.method === "GET" && url.pathname === "/proposals/list") {
            const repoId = url.searchParams.get("repoId") || "";
            if (!repoId)
                return Response.json({ error: "Missing repoId" }, { status: 400 });
            const token = extractToken();
            const authResult = SecurityGate.verifyAuthorization(token, repoId, "proposal:read");
            if (!authResult.authorized) {
                return Response.json({ error: authResult.error }, { status: authResult.statusCode });
            }
            const coordinatorId = env.MESH_COORDINATOR_DO.idFromName(repoId);
            const coordinatorStub = env.MESH_COORDINATOR_DO.get(coordinatorId);
            return coordinatorStub.fetch(request);
        }
        if (request.method === "GET" && url.pathname === "/proposals/dag") {
            const repoId = url.searchParams.get("repoId") || "";
            if (!repoId)
                return Response.json({ error: "Missing repoId" }, { status: 400 });
            const token = extractToken();
            const authResult = SecurityGate.verifyAuthorization(token, repoId, "proposal:read");
            if (!authResult.authorized) {
                return Response.json({ error: authResult.error }, { status: authResult.statusCode });
            }
            const coordinatorId = env.MESH_COORDINATOR_DO.idFromName(repoId);
            const coordinatorStub = env.MESH_COORDINATOR_DO.get(coordinatorId);
            return coordinatorStub.fetch(request);
        }
        if (request.method === "POST" && url.pathname === "/proposals/repair") {
            try {
                const body = await readJsonWithStreamLimit<any>(request, MAX_PAYLOAD_BYTES);
                const { AgentRepairEngine } = await import("./agent_repair");
                const filePath = body.filePath || "src/math.ts";
                const candidateCode = body.candidateCode || "";
                const baseCode = body.baseCode || "";
                const diagnosis = AgentRepairEngine.diagnoseAndRepair(baseCode, candidateCode, filePath);
                return Response.json({
                    success: true,
                    proposalId: body.proposalId,
                    diagnosis
                });
            } catch (err: any) {
                return Response.json({ error: err.message || String(err) }, { status: 500 });
            }
        }
        if ((request.method === "POST" || request.method === "GET") && url.pathname === "/agents/spawn-llm") {
            try {
                const repoId = url.searchParams.get("repoId") || "aether-demo-repo";
                const role = url.searchParams.get("role") || "backend";
                let prompt = "Write a TypeScript function calculateShipping(weightKg: number, distanceKm: number): number that returns total cost. Output ONLY valid TypeScript code.";
                if (role === "security") {
                    prompt = "Write a TypeScript function verifyToken(token: string): boolean that checks token length > 16. Output ONLY valid TypeScript code.";
                } else if (role === "metrics") {
                    prompt = "Write a TypeScript function trackLatency(startMs: number, endMs: number): number that returns difference. Output ONLY valid TypeScript code.";
                }
                let generatedCode = "";
                if (env.AI) {
                    try {
                        const aiRes = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
                            messages: [
                                { role: "system", content: "You are an autonomous AI coding agent. You respond with ONLY the requested TypeScript code function. No markdown formatting, no backticks, no comments." },
                                { role: "user", content: prompt }
                            ],
                            max_tokens: 180,
                            temperature: 0.2
                        }) as any;
                        generatedCode = (aiRes?.response || "").replace(/```typescript/g, "").replace(/```ts/g, "").replace(/```/g, "").trim();
                    } catch {
                        generatedCode = "export function calculateShipping(weightKg: number, distanceKm: number): number {\n  return weightKg * 1.5 + distanceKm * 0.05;\n}\n";
                    }
                }
                if (!generatedCode) {
                    generatedCode = "export function calculateShipping(weightKg: number, distanceKm: number): number {\n  return weightKg * 1.5 + distanceKm * 0.05;\n}\n";
                }
                const stamp = Date.now();
                const coordinatorId = env.MESH_COORDINATOR_DO.idFromName(repoId);
                const coordinatorStub = env.MESH_COORDINATOR_DO.get(coordinatorId);
                const submitRes = await coordinatorStub.fetch(new Request("https://coordinator.internal/proposals/submit", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        repoId,
                        targetBranch: "main",
                        baseCommitSha: "0000000000000000000000000000000000000000",
                        agentId: `llm-agent-${role}`,
                        filePath: `src/${role}.ts`,
                        patchContent: generatedCode,
                        intentDescription: `AI Agent (${role}): Autonomous LLM code generation`,
                        idempotencyKey: `llm_${role}_${stamp}`
                    })
                }));
                const submitData = await submitRes.json();
                return Response.json({
                    success: true,
                    agent: `LLM Agent (${role})`,
                    model: "@cf/meta/llama-3.1-8b-instruct",
                    generatedCode,
                    result: submitData
                });
            } catch (err: any) {
                return Response.json({ error: err.message || String(err) }, { status: 500 });
            }
        }
        if (request.method === "GET" && url.pathname === "/repo/radar") {
            const repoId = url.searchParams.get("repoId") || "aether-demo-repo";
            const coordinatorId = env.MESH_COORDINATOR_DO.idFromName(repoId);
            const coordinatorStub = env.MESH_COORDINATOR_DO.get(coordinatorId);
            const proposalsRes = await coordinatorStub.fetch("https://coordinator.internal/proposals/list?branch=main");
            let proposals: any[] = [];
            if (proposalsRes.ok) {
                const pData = await proposalsRes.json() as any;
                proposals = pData.proposals || [];
            }
            const activeAgents = proposals.map((p: any) => ({
                agentId: p.agentId || "agent",
                filePath: p.filePath,
                symbol: Array.isArray(p.affectedSymbols) && p.affectedSymbols.length > 0 ? p.affectedSymbols[0] : (p.filePath.split("/").pop() || "symbol"),
                status: p.status,
                proposalId: p.id
            }));
            return Response.json({
                repoId,
                agents: activeAgents
            });
        }
        if (request.method === "POST" && (url.pathname === "/proposals/approve" || url.pathname === "/vpr/accept")) {
            let body: any;
            try {
                body = await readJsonWithStreamLimit<any>(request, MAX_PAYLOAD_BYTES);
            }
            catch (err: any) {
                return Response.json({ error: err.message }, { status: err.statusCode || 400 });
            }
            const repo = body.repoId || body.repo || "";
            if (!repo || typeof body.proposalId !== "string" || !body.proposalId) {
                return Response.json({ error: "repoId and proposalId are required." }, { status: 400 });
            }
            const token = extractToken();
            const authResult = SecurityGate.verifyAuthorization(token, repo, "proposal:approve");
            if (!authResult.authorized) {
                return Response.json({ error: authResult.error }, { status: authResult.statusCode });
            }
            const allowedRate = await checkIngressRateLimit(repo, authResult.credential!.sub, env);
            if (!allowedRate) {
                return Response.json({ error: "Too Many Requests" }, { status: 429 });
            }
            body.approverId = authResult.credential!.sub;
            const coordinatorId = env.MESH_COORDINATOR_DO.idFromName(repo);
            const coordinatorStub = env.MESH_COORDINATOR_DO.get(coordinatorId);
            return coordinatorStub.fetch(new Request(request.url, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "X-Aether-Verified-Sub": authResult.credential!.sub
                },
                body: JSON.stringify(body)
            }));
        }
        if (request.method === "GET" && url.pathname === "/audit/verify") {
            const repoId = url.searchParams.get("repoId") || "";
            if (!repoId)
                return Response.json({ error: "Missing repoId" }, { status: 400 });
            const token = extractToken();
            const authResult = SecurityGate.verifyAuthorization(token, repoId, "audit:read");
            if (!authResult.authorized) {
                return Response.json({ error: authResult.error }, { status: authResult.statusCode });
            }
            const coordinatorId = env.MESH_COORDINATOR_DO.idFromName(repoId);
            const coordinatorStub = env.MESH_COORDINATOR_DO.get(coordinatorId);
            return coordinatorStub.fetch(request);
        }
        if (request.method === "POST" && url.pathname === "/repo/reset") {
            const repoId = url.searchParams.get("repoId") || "aether-demo-repo";
            const coordinatorId = env.MESH_COORDINATOR_DO.idFromName(repoId);
            const coordinatorStub = env.MESH_COORDINATOR_DO.get(coordinatorId);
            return coordinatorStub.fetch(new Request("https://coordinator.internal/repo/reset", { method: "POST" }));
        }
        if (request.method === "GET" && url.pathname === "/lane/history") {
            const repoId = url.searchParams.get("repoId") || "";
            if (!repoId)
                return Response.json({ error: "Missing repoId" }, { status: 400 });
            const token = extractToken();
            const authResult = SecurityGate.verifyAuthorization(token, repoId, "audit:read");
            if (!authResult.authorized) {
                return Response.json({ error: authResult.error }, { status: authResult.statusCode });
            }
            const coordinatorId = env.MESH_COORDINATOR_DO.idFromName(repoId);
            const coordinatorStub = env.MESH_COORDINATOR_DO.get(coordinatorId);
            return coordinatorStub.fetch(request);
        }
        if (request.method === "GET" && url.pathname === "/whats_happening") {
            const repoId = url.searchParams.get("repoId") || "aether-demo-repo";
            const { CollisionRadar } = await import("./collision_radar");
            return Response.json({
                repoId,
                activeAgents: CollisionRadar.whatsHappening(repoId)
            });
        }
        const repoId = url.searchParams.get("repoId");
        const modulePath = url.searchParams.get("module");
        if (!repoId || !modulePath) {
            return Response.json({ error: "Missing Required Parameters: repoId, module" }, { status: 400 });
        }
        const continent = (request.cf?.continent as string) || "US";
        const locationHint = mapContinentToHint(continent);
        const shardKey = `${repoId}:${modulePath.replace(/^\/+/, "")}`;
        const shardId = env.MODULE_SHARD_DO.idFromName(shardKey);
        const shardStub = env.MODULE_SHARD_DO.get(shardId, { locationHint });
        if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
            const ticket = url.searchParams.get("ticket");
            if (!ticket)
                return Response.json({ error: "Short-lived WebSocket ticket required." }, { status: 401 });
            const ticketAuth = SecurityGate.verifyWsTicket(ticket, repoId);
            if (!ticketAuth.authorized) {
                return Response.json({ error: ticketAuth.error }, { status: ticketAuth.statusCode });
            }
            const agentKey = ticketAuth.credential!.sub;
            const isAllowed = await checkIngressRateLimit(repoId, agentKey, env);
            if (!isAllowed) {
                return new Response("Too Many Requests: Ingress Quota Exceeded", { status: 429 });
            }
            const verifiedHeaders = new Headers(request.headers);
            verifiedHeaders.set("X-Aether-Verified-Sub", agentKey);
            return shardStub.fetch(new Request(request, { headers: verifiedHeaders }));
        }
        if (request.method === "POST" && url.pathname.endsWith("/mutate")) {
            const token = extractToken();
            const authResult = SecurityGate.verifyAuthorization(token, repoId, "proposal:submit");
            if (!authResult.authorized) {
                return Response.json({ error: authResult.error }, { status: authResult.statusCode });
            }
            const credentialSubject = authResult.credential!.sub;
            if (!/^[0-9a-fA-F]{64}$/.test(credentialSubject)) {
                return Response.json({ error: "Mutation credentials must be bound to a 32-byte Ed25519 public-key subject." }, { status: 403 });
            }
            if (!await checkIngressRateLimit(repoId, credentialSubject, env)) {
                return Response.json({ error: "Too Many Requests" }, { status: 429 });
            }
            let rawBuffer: Uint8Array;
            try {
                rawBuffer = await readBytesWithStreamLimit(request, MAX_PAYLOAD_BYTES);
            }
            catch (err: any) {
                return Response.json({ error: err.message }, { status: err.statusCode || 400 });
            }
            const verifiedEnvelope = await verifyMutationEnvelope(rawBuffer, credentialSubject);
            if (!verifiedEnvelope) {
                return Response.json({ error: "Forbidden: Cryptographic Signature Verification Failed" }, { status: 403 });
            }
            return shardStub.fetch(new Request("https://mesh-shard.internal/commit", {
                method: "POST",
                body: rawBuffer.subarray(96),
                headers: { "Content-Type": "application/json", "X-Agent-Key": credentialSubject }
            }));
        }
        if (request.method === "GET" && url.pathname.endsWith("/stream")) {
            const token = extractToken();
            const authResult = SecurityGate.verifyAuthorization(token, repoId, "repo:read");
            if (!authResult.authorized) {
                return Response.json({ error: authResult.error }, { status: authResult.statusCode });
            }
            return shardStub.fetch(request);
        }
        if (request.method === "POST" && url.pathname.endsWith("/lock")) {
            const token = extractToken();
            const authResult = SecurityGate.verifyAuthorization(token, repoId, "repo:lock");
            if (!authResult.authorized) {
                return Response.json({ error: authResult.error }, { status: authResult.statusCode });
            }
            if (!await checkIngressRateLimit(repoId, authResult.credential!.sub, env)) {
                return Response.json({ error: "Too Many Requests" }, { status: 429 });
            }
            let lockBody: any;
            try {
                lockBody = await readJsonWithStreamLimit<any>(request, MAX_PAYLOAD_BYTES);
            }
            catch (err: any) {
                return Response.json({ error: err.message }, { status: err.statusCode || 400 });
            }
            lockBody.ownerIdentity = authResult.credential!.sub;
            lockBody.ownerPublicKey = authResult.credential!.sub;
            return shardStub.fetch(new Request(request.url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(lockBody)
            }));
        }
        if (request.method === "POST" && url.pathname.endsWith("/lock/release")) {
            const token = extractToken();
            const authResult = SecurityGate.verifyAuthorization(token, repoId, "repo:lock");
            if (!authResult.authorized) {
                return Response.json({ error: authResult.error }, { status: authResult.statusCode });
            }
            if (!await checkIngressRateLimit(repoId, authResult.credential!.sub, env)) {
                return Response.json({ error: "Too Many Requests" }, { status: 429 });
            }
            let releaseBody: any;
            try {
                releaseBody = await readJsonWithStreamLimit<any>(request, MAX_PAYLOAD_BYTES);
            }
            catch (err: any) {
                return Response.json({ error: err.message }, { status: err.statusCode || 400 });
            }
            if (typeof releaseBody.lockId !== "string" || !releaseBody.lockId) {
                return Response.json({ error: "lockId is required." }, { status: 400 });
            }
            releaseBody.ownerIdentity = authResult.credential!.sub;
            releaseBody.ownerPublicKey = authResult.credential!.sub;
            return shardStub.fetch(new Request(request.url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(releaseBody)
            }));
        }
        if (request.method === "GET" && url.pathname.endsWith("/chain/verify")) {
            const token = extractToken();
            const authResult = SecurityGate.verifyAuthorization(token, repoId, "audit:read");
            if (!authResult.authorized) {
                return Response.json({ error: authResult.error }, { status: authResult.statusCode });
            }
            return shardStub.fetch(request);
        }
        return Response.json({ error: "Route not found or unauthorized" }, { status: 404 });
    },
    async queue(batch: MessageBatch<ArtifactsQueueEvent>, env: Env): Promise<void> {
        for (const msg of batch.messages) {
            try {
                await artifactsBridge.handleArtifactsQueueMessage(msg.body, env);
                msg.ack();
            }
            catch (err) {
                console.error("[Queue] Push event ingestion failed:", err);
                msg.retry();
            }
        }
    }
};
function mapContinentToHint(continent: string): DurableObjectLocationHint {
    switch (continent) {
        case "AS": return "apac";
        case "EU": return "weur";
        case "SA": return "sam";
        case "OC": return "oc";
        case "AF": return "eeur";
        case "NA":
        default: return "wnam";
    }
}
async function verifyMutationEnvelope(rawWireBuffer: Uint8Array, expectedSignerHex: string): Promise<boolean> {
    try {
        if (rawWireBuffer.length < 96)
            return false;
        const hashBytes = rawWireBuffer.subarray(0, 32);
        const signatureBytes = rawWireBuffer.subarray(32, 96);
        const payloadBytes = rawWireBuffer.subarray(96);
        const computedDigest = new Uint8Array(await crypto.subtle.digest("SHA-256", payloadBytes));
        if (!constantTimeEqual(computedDigest, hashBytes)) {
            return false;
        }
        const verifyBuffer = new Uint8Array(MUTATION_DOMAIN_TAG.length + hashBytes.length);
        verifyBuffer.set(MUTATION_DOMAIN_TAG, 0);
        verifyBuffer.set(hashBytes, MUTATION_DOMAIN_TAG.length);
        const rawKeyBytes = hexToUint8Array(expectedSignerHex);
        if (rawKeyBytes.length !== 32 || signatureBytes.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(expectedSignerHex))
            return false;
        const cryptoKey = await crypto.subtle.importKey("raw", rawKeyBytes, { name: "Ed25519" }, false, ["verify"]);
        return await crypto.subtle.verify({ name: "Ed25519" }, cryptoKey, signatureBytes, verifyBuffer);
    }
    catch {
        return false;
    }
}
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length)
        return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++)
        diff |= a[i] ^ b[i];
    return diff === 0;
}
function hexToUint8Array(hex: string): Uint8Array {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
    }
    return bytes;
}
async function checkIngressRateLimit(repoId: string, agentId: string, env: Env): Promise<boolean> {
    const coordinator = env.MESH_COORDINATOR_DO.get(env.MESH_COORDINATOR_DO.idFromName(repoId));
    try {
        const response = await coordinator.fetch(new Request("https://mesh-coordinator.internal/_internal/rate-limit", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ agentId, limit: INGRESS_BURST_LIMIT, windowMs: INGRESS_WINDOW_MS })
        }));
        if (!response.ok)
            return false;
        const result = await response.json() as {
            allowed?: boolean;
        };
        return result.allowed === true;
    }
    catch {
        return false;
    }
}
function constantTimeTextEqual(left: string, right: string): boolean {
    if (left.length !== right.length)
        return false;
    let diff = 0;
    for (let i = 0; i < left.length; i++)
        diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
    return diff === 0;
}
function isSafeRepoPath(filePath: string): boolean {
    return filePath.length <= 1024 && !/[\x00-\x1f\x7f]/.test(filePath) && !filePath.startsWith("/") && !filePath.includes("\\") &&
        filePath.split("/").every(segment => !!segment && segment !== "." && segment !== "..");
}
async function readBytesWithStreamLimit(request: Request, maxBytes: number): Promise<Uint8Array> {
    const contentLength = Number(request.headers.get("Content-Length") || 0);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        const err: any = new Error("Payload Too Large");
        err.statusCode = 413;
        throw err;
    }
    if (!request.body)
        return new Uint8Array();
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done)
            break;
        if (!value)
            continue;
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
            await reader.cancel();
            const err: any = new Error("Payload Too Large");
            err.statusCode = 413;
            throw err;
        }
        chunks.push(value);
    }
    const merged = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return merged;
}
async function readJsonWithStreamLimit<T>(request: Request, maxBytes = MAX_PAYLOAD_BYTES): Promise<T> {
    if (!request.body) {
        const text = await request.text();
        if (!text || text.trim().length === 0) {
            throw new Error("Empty request body");
        }
        if (text.length > maxBytes) {
            const err: any = new Error(`Request payload exceeded limit of ${maxBytes} bytes`);
            err.statusCode = 413;
            throw err;
        }
        return JSON.parse(text) as T;
    }
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done)
            break;
        if (value) {
            totalBytes += value.length;
            if (totalBytes > maxBytes) {
                reader.cancel();
                const err: any = new Error(`Request payload stream exceeded limit of ${maxBytes} bytes`);
                err.statusCode = 413;
                throw err;
            }
            chunks.push(value);
        }
    }
    const merged = new Uint8Array(totalBytes);
    let offset = 0;
    for (const c of chunks) {
        merged.set(c, offset);
        offset += c.length;
    }
    const text = new TextDecoder().decode(merged);
    return JSON.parse(text) as T;
}
