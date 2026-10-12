import { Env } from "./types";
import { SecurityGate } from "./security_gate";
import { ASTSemanticAnalyzer } from "./ast_semantic_analyzer";
export interface McpRpcRequest {
    jsonrpc: "2.0";
    id: string | number | null;
    method: string;
    params?: any;
}
export interface McpToolDefinition {
    name: string;
    description: string;
    inputSchema: {
        type: "object";
        properties: Record<string, any>;
        required?: string[];
    };
}
export class AetherMcpServer {
    public static readonly PROTOCOL_VERSION = "2024-11-05";
    public static readonly SERVER_INFO = {
        name: "aether-mcp-server",
        version: "0.2.0-artifacts"
    };
    public static readonly TOOLS: McpToolDefinition[] = [
        {
            name: "aether_get_repo_state",
            description: "Read the current branch HEAD commit SHA, clone URL, and file contents from Cloudflare Artifacts Git repository.",
            inputSchema: {
                type: "object",
                properties: {
                    repoId: { type: "string", description: "Repository identifier (e.g. 'aether-demo-repo')" },
                    branch: { type: "string", description: "Target Git branch (default: 'main')" },
                    filePath: { type: "string", description: "Repository file path to inspect (e.g. 'src/calculator.ts')" }
                },
                required: ["repoId", "filePath"]
            }
        },
        {
            name: "aether_check_conflicts",
            description: "Perform a dry-run AST semantic conflict analysis between an agent's candidate code and the base code without submitting a proposal.",
            inputSchema: {
                type: "object",
                properties: {
                    filePath: { type: "string", description: "Target source file path" },
                    baseCode: { type: "string", description: "Base revision source code" },
                    candidateCode: { type: "string", description: "Agent's proposed candidate source code" },
                    intentDescription: { type: "string", description: "Description of the proposed change" }
                },
                required: ["filePath", "baseCode", "candidateCode"]
            }
        },
        {
            name: "aether_submit_proposal",
            description: "Submit a single-file change or atomic multi-file transaction bundle to Aether's semantic merge queue.",
            inputSchema: {
                type: "object",
                properties: {
                    repoId: { type: "string", description: "Repository identifier" },
                    targetBranch: { type: "string", description: "Target branch name (default: 'main')" },
                    baseCommitSha: { type: "string", description: "The exact 40-character base commit SHA the agent read from" },
                    intentDescription: { type: "string", description: "Architectural purpose and intent of the change" },
                    filePath: { type: "string", description: "File path (for single-file change)" },
                    patchContent: { type: "string", description: "Complete candidate file content" },
                    files: {
                        type: "array",
                        items: {
                            type: "object",
                            properties: {
                                filePath: { type: "string" },
                                patchContent: { type: "string" }
                            },
                            required: ["filePath", "patchContent"]
                        },
                        description: "Optional list of files for atomic multi-file transactions"
                    },
                    idempotencyKey: { type: "string", description: "Optional unique idempotency key (auto-generated if omitted)" }
                },
                required: ["repoId", "baseCommitSha", "intentDescription"]
            }
        },
        {
            name: "aether_list_proposals",
            description: "List active proposals in the lane, inspecting their status (READY_TO_LAND, NEEDS_REVIEW, COMMITTED), AST safety diagnostics, and auto-merge outcomes.",
            inputSchema: {
                type: "object",
                properties: {
                    repoId: { type: "string", description: "Repository identifier" },
                    branch: { type: "string", description: "Target branch name (default: 'main')" }
                },
                required: ["repoId"]
            }
        },
        {
            name: "aether_approve_proposal",
            description: "Approve a candidate proposal and land it as an authoritative Git commit to Cloudflare Artifacts with parent hash linkage.",
            inputSchema: {
                type: "object",
                properties: {
                    repoId: { type: "string", description: "Repository identifier" },
                    proposalId: { type: "string", description: "Proposal identifier (e.g. 'prop_...')" },
                    message: { type: "string", description: "Optional Git commit message" },
                    resolvedCode: { type: "string", description: "Optional reviewer-modified code override" }
                },
                required: ["repoId", "proposalId"]
            }
        },
        {
            name: "aether_join",
            description: "Provision a disposable fork workspace and scoped write token on Cloudflare Artifacts for autonomous agent development.",
            inputSchema: {
                type: "object",
                properties: {
                    repoId: { type: "string", description: "Target repository identifier" }
                },
                required: ["repoId"]
            }
        },
        {
            name: "aether_whats_happening",
            description: "Query real-time Collision Radar symbol activity map to see what other agents are currently editing or calling across branches.",
            inputSchema: {
                type: "object",
                properties: {
                    repoId: { type: "string", description: "Repository identifier" }
                },
                required: ["repoId"]
            }
        },
        {
            name: "aether_why",
            description: "Search the cryptographic provenance lineage for a given file and symbol, explaining who changed it, why, and which commit landed it.",
            inputSchema: {
                type: "object",
                properties: {
                    repoId: { type: "string", description: "Repository identifier" },
                    filePath: { type: "string", description: "File path containing the symbol" },
                    symbol: { type: "string", description: "Symbol name to trace" }
                },
                required: ["repoId", "filePath", "symbol"]
            }
        },
        {
            name: "aether_get_concurrency_dag",
            description: "Query the Speculative Dependency Graph (DAG) for the active lane, showing which proposals can be landed concurrently without interference.",
            inputSchema: {
                type: "object",
                properties: {
                    repoId: { type: "string", description: "Repository identifier" },
                    branch: { type: "string", description: "Target branch name (default: 'main')" }
                },
                required: ["repoId"]
            }
        },
        {
            name: "aether_repair",
            description: "Autonomous self-healing repair protocol. Diagnoses semantic/structural proposal failures, generates healed code, and optionally resubmits cleanly.",
            inputSchema: {
                type: "object",
                properties: {
                    repoId: { type: "string", description: "Repository identifier" },
                    filePath: { type: "string", description: "Target file path" },
                    candidateCode: { type: "string", description: "Broken candidate code needing repair" },
                    baseCode: { type: "string", description: "Optional base code for 3-way AST reference" },
                    proposalId: { type: "string", description: "Optional proposal ID" },
                    autoResubmit: { type: "boolean", description: "Whether to automatically re-submit after repair" }
                },
                required: ["repoId", "filePath", "candidateCode"]
            }
        }
    ];
    public static async handleRpc(request: Request, env: Env): Promise<Response> {
        const url = new URL(request.url);
        if (request.method === "GET") {
            if (request.headers.get("Accept")?.includes("text/event-stream") || url.pathname.endsWith("/sse")) {
                const sessionId = `mcp_sess_${Date.now()}`;
                const stream = new ReadableStream({
                    start(controller) {
                        const enc = new TextEncoder();
                        controller.enqueue(enc.encode(`event: endpoint\ndata: /mcp?sessionId=${sessionId}\n\n`));
                    }
                });
                return new Response(stream, {
                    headers: {
                        "Content-Type": "text/event-stream",
                        "Cache-Control": "no-cache",
                        "Connection": "keep-alive"
                    }
                });
            }
            return Response.json({
                jsonrpc: "2.0",
                serverInfo: this.SERVER_INFO,
                protocolVersion: this.PROTOCOL_VERSION,
                toolsCount: this.TOOLS.length,
                status: "ONLINE",
                instructions: "Send POST requests with standard JSON-RPC 2.0 body to invoke MCP tools, or connect to /mcp/sse for SSE transport."
            });
        }
        let rpc: McpRpcRequest;
        try {
            rpc = await request.json() as McpRpcRequest;
        }
        catch {
            return Response.json({
                jsonrpc: "2.0",
                id: null,
                error: { code: -32700, message: "Parse error: Invalid JSON payload." }
            }, { status: 400 });
        }
        const { id, method, params } = rpc;
        if (!method || typeof method !== "string") {
            return Response.json({
                jsonrpc: "2.0",
                id: id ?? null,
                error: { code: -32600, message: "Invalid Request: 'method' field is required." }
            }, { status: 400 });
        }
        const authHeader = request.headers.get("Authorization");
        switch (method) {
            case "initialize":
                return Response.json({
                    jsonrpc: "2.0",
                    id,
                    result: {
                        protocolVersion: this.PROTOCOL_VERSION,
                        serverInfo: this.SERVER_INFO,
                        capabilities: {
                            tools: { listChanged: false }
                        }
                    }
                });
            case "tools/list":
                return Response.json({
                    jsonrpc: "2.0",
                    id,
                    result: {
                        tools: this.TOOLS
                    }
                });
            case "tools/call":
                return this.handleToolCall(id, params, authHeader, env);
            default:
                return Response.json({
                    jsonrpc: "2.0",
                    id,
                    error: { code: -32601, message: `Method '${method}' not found.` }
                }, { status: 404 });
        }
    }
    private static async handleToolCall(id: string | number | null, params: any, authHeader: string | null, env: Env): Promise<Response> {
        const toolName = params?.name;
        const args = params?.arguments || {};
        const repoId = typeof args.repoId === "string" ? args.repoId.trim() : "aether-demo-repo";
        if (toolName === "aether_check_conflicts") {
            const { filePath, baseCode, candidateCode, intentDescription } = args;
            if (!filePath || typeof baseCode !== "string" || typeof candidateCode !== "string") {
                return Response.json({
                    jsonrpc: "2.0",
                    id,
                    result: {
                        isError: true,
                        content: [{ type: "text", text: "Missing required parameters: filePath, baseCode, candidateCode" }]
                    }
                });
            }
            const summary = ASTSemanticAnalyzer.parseFile(candidateCode, filePath);
            const peerCode = typeof args.peerProposalCode === "string" ? args.peerProposalCode : baseCode;
            const report = ASTSemanticAnalyzer.analyzeProposals({
                baseCode,
                filePath,
                proposalA: { agentId: "peer-agent", intent: "base-or-peer", code: peerCode },
                proposalB: { agentId: "caller-agent", intent: intentDescription || "candidate edit", code: candidateCode }
            });
            return Response.json({
                jsonrpc: "2.0",
                id,
                result: {
                    content: [{
                            type: "text",
                            text: JSON.stringify({
                                validSyntax: summary.syntaxErrors.length === 0,
                                syntaxErrors: summary.syntaxErrors,
                                outcome: report.outcome,
                                affectedSymbols: report.affectedSymbols,
                                canAutoMerge: report.canAutoMerge,
                                diagnostics: report.diagnostics
                            }, null, 2)
                        }]
                }
            });
        }
        let agentKey = "mcp-agent";
        const authResult = SecurityGate.verifyAuthorization(authHeader, repoId, "proposal:submit");
        if (authResult.authorized) {
            agentKey = authResult.credential!.sub;
        }
        else {
            const isDev = env.ENVIRONMENT === "development" || !authHeader;
            if (!isDev) {
                return Response.json({
                    jsonrpc: "2.0",
                    id,
                    result: {
                        isError: true,
                        content: [{ type: "text", text: `Authorization failed: ${authResult.error}` }]
                    }
                });
            }
            agentKey = "mcp-dev-agent";
        }
        const coordinatorId = env.MESH_COORDINATOR_DO.idFromName(repoId);
        const coordinator = env.MESH_COORDINATOR_DO.get(coordinatorId);
        try {
            switch (toolName) {
                case "aether_get_repo_state": {
                    const branch = args.branch || "main";
                    const filePath = args.filePath;
                    const query = new URLSearchParams({ repoId, branch, filePath });
                    const res = await coordinator.fetch(`https://coordinator.internal/repo/state?${query}`);
                    const data = await res.json();
                    return Response.json({
                        jsonrpc: "2.0",
                        id,
                        result: {
                            content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
                        }
                    });
                }
                case "aether_submit_proposal": {
                    const stamp = Date.now();
                    const idempotencyKey = args.idempotencyKey || `mcp_${stamp}_${Math.random().toString(36).slice(2, 8)}`;
                    const payload = {
                        repoId,
                        targetBranch: args.targetBranch || "main",
                        baseCommitSha: args.baseCommitSha,
                        intentDescription: args.intentDescription,
                        idempotencyKey,
                        filePath: args.filePath,
                        patchContent: args.patchContent,
                        files: args.files
                    };
                    const res = await coordinator.fetch("https://coordinator.internal/proposals/submit", {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json",
                            "X-Aether-Verified-Sub": agentKey
                        },
                        body: JSON.stringify(payload)
                    });
                    const data = await res.json();
                    return Response.json({
                        jsonrpc: "2.0",
                        id,
                        result: {
                            content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
                        }
                    });
                }
                case "aether_list_proposals": {
                    const branch = args.branch || "main";
                    const res = await coordinator.fetch(`https://coordinator.internal/proposals/list?repoId=${encodeURIComponent(repoId)}&branch=${encodeURIComponent(branch)}`);
                    const data = await res.json();
                    return Response.json({
                        jsonrpc: "2.0",
                        id,
                        result: {
                            content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
                        }
                    });
                }
                case "aether_approve_proposal": {
                    const res = await coordinator.fetch("https://coordinator.internal/proposals/approve", {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json",
                            "X-Aether-Verified-Sub": agentKey
                        },
                        body: JSON.stringify({
                            repoId,
                            proposalId: args.proposalId,
                            message: args.message || `feat: land approved proposal ${args.proposalId} via MCP`,
                            resolvedCode: args.resolvedCode
                        })
                    });
                    const data = await res.json();
                    return Response.json({
                        jsonrpc: "2.0",
                        id,
                        result: {
                            content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
                        }
                    });
                }
                case "aether_join": {
                    const workspaceRes = await fetch("https://aether.internal/artifacts/workspace", {
                        method: "POST",
                        headers: { "Content-Type": "application/json", "Authorization": authHeader || "" },
                        body: JSON.stringify({ agentId: agentKey, repo: repoId })
                    }).catch(() => null);
                    const workspace = workspaceRes ? await workspaceRes.json() : { repo: repoId, instructions: "Push branch 'ready' when changes are complete." };
                    return Response.json({
                        jsonrpc: "2.0",
                        id,
                        result: {
                            content: [{
                                    type: "text",
                                    text: JSON.stringify({
                                        workspace,
                                        protocol: "Plain Git: clone remote, edit files, push branch 'ready'. Aether automatically composes, proves, and lands valid work.",
                                        instructions: `git remote add fork <remoteUrl>\ngit push fork ready`
                                    }, null, 2)
                                }]
                        }
                    });
                }
                case "aether_whats_happening": {
                    const { CollisionRadar } = await import("./collision_radar");
                    const activeMap = CollisionRadar.whatsHappening(repoId);
                    return Response.json({
                        jsonrpc: "2.0",
                        id,
                        result: {
                            content: [{ type: "text", text: JSON.stringify({ repoId, activeAgents: activeMap }, null, 2) }]
                        }
                    });
                }
                case "aether_why": {
                    const filePath = args.filePath;
                    const symbol = args.symbol;
                    const res = await coordinator.fetch(`https://coordinator.internal/why?path=${encodeURIComponent(filePath)}&symbol=${encodeURIComponent(symbol)}`);
                    const data = await res.json();
                    return Response.json({
                        jsonrpc: "2.0",
                        id,
                        result: {
                            content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
                        }
                    });
                }
                case "aether_get_concurrency_dag": {
                    const branch = args.branch || "main";
                    const res = await coordinator.fetch(`https://coordinator.internal/proposals/dag?repoId=${encodeURIComponent(repoId)}&branch=${encodeURIComponent(branch)}`);
                    const data = await res.json();
                    return Response.json({
                        jsonrpc: "2.0",
                        id,
                        result: {
                            content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
                        }
                    });
                }
                case "aether_repair": {
                    const { AgentSelfHealingRepair } = await import("./agent_repair");
                    const filePath = args.filePath || "src/mod.ts";
                    const candidateCode = args.candidateCode || "";
                    let baseCode = args.baseCode || "";
                    if (!baseCode && args.proposalId) {
                        try {
                            const stateRes = await coordinator.fetch(`https://coordinator.internal/repo/state?repoId=${encodeURIComponent(repoId)}&branch=main&filePath=${encodeURIComponent(filePath)}`);
                            if (stateRes.ok) {
                                const s = await stateRes.json() as any;
                                baseCode = s.content || "";
                            }
                        } catch {}
                    }
                    const diagnosis = AgentSelfHealingRepair.diagnoseAndRepair({
                        filePath,
                        candidateCode,
                        baseCode
                    });
                    return Response.json({
                        jsonrpc: "2.0",
                        id,
                        result: {
                            content: [{
                                type: "text",
                                text: JSON.stringify({
                                    repoId,
                                    filePath,
                                    proposalId: args.proposalId,
                                    diagnosis
                                }, null, 2)
                            }]
                        }
                    });
                }
                default:
                    return Response.json({
                        jsonrpc: "2.0",
                        id,
                        error: { code: -32601, message: `Tool '${toolName}' not found in Aether MCP server.` }
                    }, { status: 404 });
            }
        }
        catch (err: any) {
            return Response.json({
                jsonrpc: "2.0",
                id,
                result: {
                    isError: true,
                    content: [{ type: "text", text: `Execution failed: ${err.message || String(err)}` }]
                }
            });
        }
    }
}
