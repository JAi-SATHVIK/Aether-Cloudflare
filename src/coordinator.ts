import crypto from "crypto";
import { Env } from "./types";
import { SymbolDependencyGraph, SymbolDefinition, SymbolReference, DependencyConflict } from "./symbol_graph";
import { ASTSemanticAnalyzer, SemanticAnalysisReport } from "./ast_semantic_analyzer";
import { VerificationGate } from "./verification_gate";
import { ArtifactsBridge, isGitSha, isSafeBranchName, normalizeRepoPath } from "./artifacts_bridge";
import { SemanticImmuneSystem } from "./immune_system";
import { SemanticRebaseEngine } from "./semantic_rebase";
const artifactsBridge = new ArtifactsBridge();
export interface ProposalRecord {
    id: string;
    repoId: string;
    targetBranch: string;
    agentId: string;
    agentSignature?: string;
    baseCommitSha: string;
    candidateCommitSha?: string | null;
    candidateContentSha?: string | null;
    filePath: string;
    patchContent: string;
    intentDescription: string;
    affectedSymbols?: string[];
    idempotencyKey: string;
    status: string;
    analysisOutcome?: any;
    testStatus?: any;
    fileManifest?: Array<{
        filePath: string;
        patchContent: string;
    }>;
    submittedAt?: number;
    updatedAt?: number;
    createdAt?: number;
}
export class MeshCoordinator implements DurableObject {
    private ctx: DurableObjectState;
    private env: Env;
    private sql: SqlStorage;
    constructor(ctx: DurableObjectState, env: Env) {
        this.ctx = ctx;
        this.env = env;
        this.sql = ctx.storage.sql;
        this.sql.exec(`
      CREATE TABLE IF NOT EXISTS mesh_modules (
        module_path TEXT PRIMARY KEY NOT NULL,
        shard_id TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS agent_registry (
        agent_public_key TEXT PRIMARY KEY NOT NULL,
        registered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        is_quarantined INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS repo_symbols (
        symbol_name TEXT NOT NULL,
        file_path TEXT NOT NULL,
        signature_hash TEXT NOT NULL,
        arity INTEGER NOT NULL DEFAULT 0,
        parameters TEXT NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (symbol_name, file_path)
      );

      CREATE TABLE IF NOT EXISTS ast_symbol_definitions (
        symbol_name TEXT NOT NULL,
        node_id TEXT NOT NULL,
        signature_hash TEXT NOT NULL,
        arity INTEGER NOT NULL DEFAULT 0,
        max_arity INTEGER,
        file_path TEXT NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (symbol_name, file_path)
      );

      CREATE TABLE IF NOT EXISTS ast_symbol_references (
        reference_id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol_name TEXT NOT NULL,
        caller_node_id TEXT NOT NULL,
        call_site_args INTEGER NOT NULL DEFAULT 0,
        file_path TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_coordinator_symbol_refs ON ast_symbol_references (symbol_name);

      CREATE TABLE IF NOT EXISTS repo_symbol_references (
        ref_id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol_name TEXT NOT NULL,
        caller_id TEXT NOT NULL,
        call_site_args INTEGER NOT NULL DEFAULT 0,
        file_path TEXT NOT NULL
      );

      -- Authoritative Proposal State in Durable Object SQLite
      CREATE TABLE IF NOT EXISTS proposals (
        id TEXT PRIMARY KEY NOT NULL,
        repo_id TEXT NOT NULL,
        target_branch TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        agent_signature TEXT,
        base_commit_sha TEXT NOT NULL,
        candidate_commit_sha TEXT,
        candidate_content_sha TEXT,
        file_path TEXT NOT NULL,
        patch_content TEXT NOT NULL,
        intent_description TEXT NOT NULL,
        affected_symbols TEXT NOT NULL,
        idempotency_key TEXT UNIQUE NOT NULL,
        status TEXT NOT NULL,
        analysis_outcome TEXT,
        test_status TEXT,
        submitted_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS lane_sequence (
        sequence_id INTEGER PRIMARY KEY AUTOINCREMENT,
        proposal_id TEXT NOT NULL,
        target_branch TEXT NOT NULL,
        prior_head_sha TEXT NOT NULL,
        new_head_sha TEXT NOT NULL,
        transition_type TEXT NOT NULL,
        merkle_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_records (
        sequence_id INTEGER PRIMARY KEY AUTOINCREMENT,
        prior_hash TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        record_hash TEXT NOT NULL,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        payload TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS branch_heads (
        branch TEXT PRIMARY KEY NOT NULL,
        head_sha TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS artifacts_event_receipts (
        repo_id TEXT NOT NULL,
        branch TEXT NOT NULL,
        commit_sha TEXT NOT NULL,
        before_sha TEXT NOT NULL,
        observed_head_sha TEXT NOT NULL,
        pusher TEXT NOT NULL,
        received_at INTEGER NOT NULL,
        PRIMARY KEY (repo_id, branch, commit_sha)
      );

      CREATE TABLE IF NOT EXISTS repo_files (
        branch TEXT NOT NULL,
        file_path TEXT NOT NULL,
        content TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (branch, file_path)
      );

      CREATE TABLE IF NOT EXISTS git_push_outbox (
        outbox_id TEXT PRIMARY KEY NOT NULL,
        proposal_id TEXT NOT NULL,
        repo_id TEXT NOT NULL,
        branch TEXT NOT NULL,
        base_sha TEXT NOT NULL,
        commit_sha TEXT,
        status TEXT NOT NULL,
        error TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        commit_message TEXT NOT NULL DEFAULT '',
        actor TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS rate_limits (
        agent_id TEXT PRIMARY KEY NOT NULL,
        request_count INTEGER NOT NULL,
        window_start INTEGER NOT NULL
      );
    `);
        try {
            this.sql.exec("ALTER TABLE proposals ADD COLUMN candidate_content_sha TEXT;");
        }
        catch { }
        try {
            this.sql.exec("ALTER TABLE proposals ADD COLUMN file_manifest TEXT;");
        }
        catch { }
        try {
            this.sql.exec("ALTER TABLE git_push_outbox ADD COLUMN files_json TEXT;");
        }
        catch { }
        try {
            this.sql.exec("ALTER TABLE git_push_outbox ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;");
        }
        catch { }
        try {
            this.sql.exec("ALTER TABLE git_push_outbox ADD COLUMN commit_message TEXT NOT NULL DEFAULT ''; ");
        }
        catch { }
        try {
            this.sql.exec("ALTER TABLE git_push_outbox ADD COLUMN actor TEXT NOT NULL DEFAULT ''; ");
        }
        catch { }
        try {
            this.sql.exec("ALTER TABLE ast_symbol_definitions ADD COLUMN max_arity INTEGER;");
        }
        catch { }
    }
    public checkRateLimit(agentId: string, maxRequests = 120, windowMs = 60000): {
        allowed: boolean;
        remaining: number;
    } {
        const now = Date.now();
        const cursor = this.sql.exec("SELECT request_count, window_start FROM rate_limits WHERE agent_id = ?1 LIMIT 1;", agentId);
        const rows = [...cursor];
        if (rows.length === 0 || (now - Number(rows[0].window_start)) > windowMs) {
            this.sql.exec(`INSERT INTO rate_limits (agent_id, request_count, window_start) VALUES (?1, 1, ?2)
         ON CONFLICT(agent_id) DO UPDATE SET request_count = 1, window_start = excluded.window_start;`, agentId, now);
            return { allowed: true, remaining: maxRequests - 1 };
        }
        const currentCount = Number(rows[0].request_count);
        if (currentCount >= maxRequests) {
            return { allowed: false, remaining: 0 };
        }
        this.sql.exec("UPDATE rate_limits SET request_count = request_count + 1 WHERE agent_id = ?1;", agentId);
        return { allowed: true, remaining: maxRequests - (currentCount + 1) };
    }
    public getBranchFile(branch: string, filePath: string): string | null {
        const cursor = this.sql.exec("SELECT content FROM repo_files WHERE branch = ?1 AND file_path = ?2 LIMIT 1;", branch, filePath);
        const rows = [...cursor];
        return rows.length > 0 ? String(rows[0].content) : null;
    }
    public setBranchFile(branch: string, filePath: string, content: string): void {
        this.sql.exec(`INSERT INTO repo_files (branch, file_path, content, updated_at)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(branch, file_path) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at;`, branch, filePath, content, Date.now());
        try {
            const { definitions, references } = SymbolDependencyGraph.extractSymbols(content, filePath);
            SymbolDependencyGraph.updateSymbolIndex(this.sql, definitions, references, filePath);
        }
        catch { }
    }
    public getBranchTree(branch: string): Map<string, string> {
        const tree = new Map<string, string>();
        const cursor = this.sql.exec("SELECT file_path, content FROM repo_files WHERE branch = ?1;", branch);
        for (const row of cursor) {
            tree.set(String(row.file_path), String(row.content));
        }
        return tree;
    }
    public getBranchHeadSha(branch: string, defaultSha = "0000000000000000000000000000000000000000"): string {
        const cursor = this.sql.exec("SELECT head_sha FROM branch_heads WHERE branch = ?1 LIMIT 1;", branch);
        const rows = [...cursor];
        return rows.length > 0 ? String(rows[0].head_sha) : defaultSha;
    }
    public setBranchHeadSha(branch: string, headSha: string): void {
        this.sql.exec(`INSERT INTO branch_heads (branch, head_sha, updated_at)
       VALUES (?1, ?2, ?3)
       ON CONFLICT(branch) DO UPDATE SET head_sha = excluded.head_sha, updated_at = excluded.updated_at;`, branch, headSha, Date.now());
    }
    async alarm(): Promise<void> {
        const now = Date.now();
        const pending = [...this.sql.exec(`SELECT outbox_id FROM git_push_outbox
       WHERE status IN ('PENDING', 'RETRY') OR (status = 'PUSHING' AND updated_at < ?1)
       ORDER BY created_at ASC LIMIT 1;`, now - 30000)][0];
        if (pending)
            await this.processOutbox(String(pending.outbox_id));
        const remaining = [...this.sql.exec("SELECT COUNT(*) AS count FROM git_push_outbox WHERE status IN ('PENDING', 'RETRY', 'PUSHING');")][0];
        if (Number(remaining?.count || 0) > 0)
            await this.ctx.storage.setAlarm(Date.now() + 2000);
    }
    private async processOutbox(outboxId: string): Promise<{
        success: boolean;
        commitSha?: string;
        error?: string;
        terminal?: boolean;
        baseShaMismatch?: boolean;
    }> {
        const row = [...this.sql.exec(`SELECT o.outbox_id, o.repo_id, o.branch, o.base_sha, o.status AS outbox_status,
              o.commit_sha, o.error, o.attempts, o.commit_message, o.actor, o.files_json, o.updated_at,
              p.id AS proposal_id, p.file_path, p.patch_content, p.candidate_content_sha, p.file_manifest
       FROM git_push_outbox o JOIN proposals p ON p.id = o.proposal_id
       WHERE o.outbox_id = ?1 LIMIT 1;`, outboxId)][0] as any;
        if (!row)
            return { success: false, error: "Outbox record not found.", terminal: true };
        if (row.outbox_status === "PUSHED")
            return { success: true, commitSha: String(row.commit_sha) };
        if (row.outbox_status === "FAILED")
            return { success: false, error: String(row.error || "Git push exhausted retries."), terminal: true };
        if (row.outbox_status === "PUSHING" && Date.now() - Number(row.updated_at) < 30000) {
            await this.ctx.storage.setAlarm(Date.now() + 30000);
            return { success: false, error: "A Git push attempt is already in progress." };
        }
        const actualContentSha = crypto.createHash("sha256").update(String(row.patch_content), "utf8").digest("hex");
        if (!row.candidate_content_sha || actualContentSha !== String(row.candidate_content_sha)) {
            const error = "Candidate content hash no longer matches the reviewed revision.";
            this.ctx.storage.transactionSync(() => {
                this.sql.exec("UPDATE git_push_outbox SET status = 'FAILED', error = ?1, updated_at = ?2 WHERE outbox_id = ?3;", error, Date.now(), outboxId);
                this.sql.exec("UPDATE proposals SET status = 'FAILED', updated_at = ?1 WHERE id = ?2;", Date.now(), row.proposal_id);
            });
            return { success: false, error, terminal: true };
        }
        const attempt = Number(row.attempts || 0) + 1;
        this.sql.exec("UPDATE git_push_outbox SET status = 'PUSHING', attempts = ?1, updated_at = ?2 WHERE outbox_id = ?3;", attempt, Date.now(), outboxId);
        let result;
        const rawManifest = row.files_json || row.file_manifest;
        let extraFiles: Array<{
            path: string;
            content: string;
        }> | undefined;
        if (rawManifest) {
            try {
                const parsed = JSON.parse(rawManifest) as Array<{
                    filePath: string;
                    patchContent: string;
                }>;
                if (parsed.length > 1) {
                    extraFiles = parsed.slice(1).map(f => ({ path: f.filePath, content: f.patchContent }));
                }
            }
            catch { }
        }
        try {
            result = await artifactsBridge.landVPRToArtifacts(String(row.repo_id), String(row.file_path), String(row.branch), String(row.base_sha), String(row.commit_message || `feat(resolve): approve proposal ${row.proposal_id}`), String(row.patch_content), this.env, extraFiles);
        }
        catch (err: any) {
            result = { success: false, error: err?.message || String(err) };
        }
        if (result.success && result.commitSha) {
            const commitSha = result.commitSha;
            const now = Date.now();
            this.ctx.storage.transactionSync(() => {
                this.sql.exec("UPDATE proposals SET status = 'COMMITTED', candidate_commit_sha = ?1, updated_at = ?2 WHERE id = ?3 AND status = 'LANDING';", commitSha, now, row.proposal_id);
                this.sql.exec("UPDATE git_push_outbox SET status = 'PUSHED', commit_sha = ?1, error = NULL, updated_at = ?2 WHERE outbox_id = ?3;", commitSha, now, outboxId);
                if (rawManifest) {
                    try {
                        const parsed = JSON.parse(rawManifest) as Array<{
                            filePath: string;
                            patchContent: string;
                        }>;
                        for (const f of parsed) {
                            this.setBranchFile(String(row.branch), f.filePath, f.patchContent);
                        }
                    }
                    catch {
                        this.setBranchFile(String(row.branch), String(row.file_path), String(row.patch_content));
                    }
                }
                else {
                    this.setBranchFile(String(row.branch), String(row.file_path), String(row.patch_content));
                }
                this.setBranchHeadSha(String(row.branch), commitSha);
                this.appendLaneSequence(String(row.proposal_id), String(row.branch), String(row.base_sha), commitSha, "INTEGRATION");
                this.appendAuditRecord(String(row.actor || "system"), "APPROVE_PROPOSAL", {
                    proposalId: row.proposal_id,
                    commitSha,
                    actor: row.actor,
                    baseSha: row.base_sha,
                    candidateContentSha: row.candidate_content_sha
                });
            });
            return { success: true, commitSha };
        }
        const error = result.error || "Git push failed without a diagnostic.";
        if (result.baseShaMismatch) {
            const now = Date.now();
            this.ctx.storage.transactionSync(() => {
                this.sql.exec("UPDATE git_push_outbox SET status = 'FAILED', error = ?1, updated_at = ?2 WHERE outbox_id = ?3;", error, now, outboxId);
                this.sql.exec("UPDATE proposals SET status = 'NEEDS_REVIEW', updated_at = ?1 WHERE id = ?2 AND status = 'LANDING';", now, row.proposal_id);
                this.appendAuditRecord(String(row.actor || "system"), "LANDING_STALE_BASE", {
                    proposalId: row.proposal_id,
                    expectedBaseSha: row.base_sha,
                    error
                });
            });
            return { success: false, error, terminal: true, baseShaMismatch: true };
        }
        const terminal = attempt >= 5;
        const now = Date.now();
        this.ctx.storage.transactionSync(() => {
            this.sql.exec("UPDATE git_push_outbox SET status = ?1, error = ?2, updated_at = ?3 WHERE outbox_id = ?4;", terminal ? "FAILED" : "RETRY", error, now, outboxId);
            if (terminal) {
                this.sql.exec("UPDATE proposals SET status = 'FAILED', updated_at = ?1 WHERE id = ?2 AND status = 'LANDING';", now, row.proposal_id);
            }
        });
        if (!terminal) {
            await this.ctx.storage.setAlarm(now + Math.min(attempt * 5000, 60000));
        }
        return { success: false, error, terminal };
    }
    async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);
        if (request.method === "POST" && url.pathname.endsWith("/_internal/rate-limit")) {
            let body: {
                agentId?: string;
            };
            try {
                body = await request.json() as {
                    agentId?: string;
                };
            }
            catch {
                return Response.json({ error: "Invalid rate-limit request." }, { status: 400 });
            }
            if (!body.agentId || body.agentId.length > 256)
                return Response.json({ error: "Invalid agent id." }, { status: 400 });
            return Response.json(this.checkRateLimit(`burst:${body.agentId}`, 500, 1000));
        }
        if (request.method === "POST" && url.pathname.endsWith("/proposals/submit")) {
            const body = await request.json() as {
                repoId: string;
                targetBranch?: string;
                agentId: string;
                agentSignature?: string;
                baseCommitSha: string;
                filePath?: string;
                patchContent?: string;
                files?: Array<{
                    filePath: string;
                    patchContent: string;
                }>;
                intentDescription: string;
                idempotencyKey: string;
            };
            const verifiedAgentId = request.headers.get("X-Aether-Verified-Sub") ||
                (typeof body?.agentId === "string" ? body.agentId : "");
            const hasMultiFiles = Array.isArray(body?.files) && body.files.length > 0;
            const normalizedFiles: Array<{
                filePath: string;
                patchContent: string;
            }> = hasMultiFiles
                ? body.files!.map(f => ({ filePath: normalizeRepoPath(f.filePath) || f.filePath, patchContent: f.patchContent }))
                : [{ filePath: normalizeRepoPath(body?.filePath || "") || body?.filePath || "", patchContent: body?.patchContent || "" }];
            const primaryFilePath = normalizedFiles[0]?.filePath || "";
            let primaryPatchContent = normalizedFiles[0]?.patchContent || "";
            if (!body || typeof body.repoId !== "string" || !body.repoId.trim() || body.repoId.length > 256 ||
                !verifiedAgentId || verifiedAgentId.length > 256 ||
                typeof body.baseCommitSha !== "string" || !isGitSha(body.baseCommitSha) ||
                normalizedFiles.some(f => !f.filePath || !normalizeRepoPath(f.filePath) || typeof f.patchContent !== "string") ||
                typeof body.intentDescription !== "string" ||
                typeof body.idempotencyKey !== "string" || body.idempotencyKey.length < 8 || body.idempotencyKey.length > 256) {
                return Response.json({ error: "Required proposal fields are missing or invalid." }, { status: 400 });
            }
            if (body.targetBranch !== undefined && (typeof body.targetBranch !== "string" || !isSafeBranchName(body.targetBranch))) {
                return Response.json({ error: "Invalid Git branch name." }, { status: 400 });
            }
            const targetBranch = body.targetBranch || "main";
            const totalBytes = normalizedFiles.reduce((sum, f) => sum + (f.patchContent?.length || 0), 0);
            if (totalBytes > 2 * 1024 * 1024 || normalizedFiles.some(f => f.patchContent.length > 1024 * 1024)) {
                return Response.json({
                    error: "Payload size exceeds limit for AST semantic analysis."
                }, { status: 413 });
            }
            const scopedIdempKey = JSON.stringify([body.repoId, targetBranch, verifiedAgentId, body.idempotencyKey]);
            const resolveIdempotencyRetry = (): Response | null => {
                const rows = [...this.sql.exec("SELECT * FROM proposals WHERE idempotency_key = ?1 LIMIT 1;", scopedIdempKey)];
                if (rows.length === 0)
                    return null;
                const existing = this.deserializeProposal(rows[0]);
                const sameRequest = existing.filePath === primaryFilePath &&
                    existing.patchContent === primaryPatchContent &&
                    existing.baseCommitSha === body.baseCommitSha &&
                    existing.intentDescription === body.intentDescription;
                if (!sameRequest) {
                    return Response.json({
                        error: "Idempotency key collision with conflicting proposal content, base revision, or intent."
                    }, { status: 409 });
                }
                return Response.json({ proposal: existing, isRetry: true });
            };
            const initialRetry = resolveIdempotencyRetry();
            if (initialRetry)
                return initialRetry;
            const rateCheck = this.checkRateLimit(verifiedAgentId, 120, 60000);
            if (!rateCheck.allowed) {
                return Response.json({
                    error: `Rate limit exceeded for agent '${verifiedAgentId}'. Maximum 120 submissions per minute.`
                }, { status: 429, headers: { "Retry-After": "60" } });
            }
            const pendingCursor = this.sql.exec("SELECT COUNT(*) as count FROM proposals WHERE target_branch = ?1 AND status IN ('ANALYZING', 'READY_TO_LAND', 'NEEDS_REVIEW', 'LANDING');", targetBranch);
            const pendingRows = [...pendingCursor];
            const pendingCount = pendingRows.length > 0 ? Number(pendingRows[0].count) : 0;
            if (pendingCount >= 200) {
                return Response.json({
                    error: `Branch '${targetBranch}' proposal queue full (capacity: 200). Awaiting review or landing of active proposals.`
                }, { status: 429 });
            }
            let branchSnapshot: Awaited<ReturnType<typeof artifactsBridge.getBranchSnapshot>>;
            try {
                branchSnapshot = await artifactsBridge.getBranchSnapshot(body.repoId, targetBranch, primaryFilePath, this.env);
            }
            catch (err: any) {
                return Response.json({ error: `Could not read Artifacts branch snapshot: ${err.message || String(err)}` }, { status: 502 });
            }
            const proposalId = `prop_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
            if (body.baseCommitSha !== branchSnapshot.headSha) {
                const rebaseBatch = SemanticRebaseEngine.rebaseAndComposeBatch({
                    repoId: body.repoId,
                    targetBranch,
                    newHeadSha: branchSnapshot.headSha,
                    baseFiles: { [primaryFilePath]: branchSnapshot.content ?? "" },
                    proposals: [{
                            id: proposalId,
                            agentId: verifiedAgentId,
                            intent: body.intentDescription,
                            filePath: primaryFilePath,
                            patchContent: primaryPatchContent,
                            baseCommitSha: body.baseCommitSha,
                            status: "READY_TO_LAND"
                        }]
                });
                if (rebaseBatch.landedCount > 0 && rebaseBatch.composedFiles[primaryFilePath]) {
                    primaryPatchContent = rebaseBatch.composedFiles[primaryFilePath];
                    if (normalizedFiles[0])
                        normalizedFiles[0].patchContent = primaryPatchContent;
                    body.baseCommitSha = branchSnapshot.headSha;
                }
                else {
                    const reason = rebaseBatch.needsHumanProposals[0]?.reason || "Unresolvable semantic conflict against updated branch head";
                    return Response.json({
                        error: `Proposal base is stale and cannot be auto-rebased: ${reason}. Resubmit against latest head.`,
                        currentHeadSha: branchSnapshot.headSha,
                        semanticConflict: true
                    }, { status: 409 });
                }
            }
            const racedRetry = resolveIdempotencyRetry();
            if (racedRetry)
                return racedRetry;
            const pendingAfterRead = Number([...this.sql.exec("SELECT COUNT(*) AS count FROM proposals WHERE target_branch = ?1 AND status IN ('ANALYZING', 'READY_TO_LAND', 'NEEDS_REVIEW', 'LANDING');", targetBranch)][0]?.count || 0);
            if (pendingAfterRead >= 200) {
                return Response.json({
                    error: `Branch '${targetBranch}' proposal queue full (capacity: 200). Awaiting review or landing of active proposals.`
                }, { status: 429 });
            }
            this.setBranchHeadSha(targetBranch, branchSnapshot.headSha);
            if (branchSnapshot.content !== null)
                this.setBranchFile(targetBranch, primaryFilePath, branchSnapshot.content);
            const submittedTime = Date.now();
            const fileManifest = hasMultiFiles ? JSON.stringify(normalizedFiles) : null;
            this.sql.exec(`INSERT INTO proposals (
          id, repo_id, target_branch, agent_id, agent_signature, base_commit_sha,
          candidate_commit_sha, file_path, patch_content, intent_description,
          affected_symbols, idempotency_key, status, analysis_outcome, test_status,
          file_manifest, submitted_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7, ?8, ?9, '[]', ?10, 'ANALYZING', NULL, ?11, ?12, ?13, ?14);`, proposalId, body.repoId, targetBranch, verifiedAgentId, body.agentSignature || null, body.baseCommitSha, primaryFilePath, primaryPatchContent, body.intentDescription, scopedIdempKey, JSON.stringify({ executed: false, passed: false, output: "No runtime test runner is configured; static analysis only." }), fileManifest, submittedTime, submittedTime);
            const currentHead = branchSnapshot.headSha;
            const baseCode = this.getBranchFile(targetBranch, primaryFilePath) || "";
            let candidatePatchContent = primaryPatchContent;
            const primaryExt = primaryFilePath.toLowerCase().split(".").pop() || "";
            const isPythonOrRust = ["py", "rs"].includes(primaryExt);
            let status = "ANALYZING";
            let analysisOutcome: SemanticAnalysisReport | null = null;
            if (isPythonOrRust) {
                const polyglot = SymbolDependencyGraph.extractSymbols(primaryPatchContent, primaryFilePath);
                const securityPatterns = ["isAdmin", "verifyToken", "authKey", "checkPermission", "hasAccess"];
                const removedGuards = securityPatterns.filter(p => baseCode.includes(p) && !primaryPatchContent.includes(p));
                if (removedGuards.length > 0) {
                    status = "NEEDS_REVIEW";
                    analysisOutcome = {
                        outcome: "UNRESOLVED_CONFLICT",
                        summary: `Security guards removed in ${primaryFilePath}: ${removedGuards.join(", ")}`,
                        interactions: removedGuards.map(g => ({
                            type: "SECURITY_GUARD_REMOVED",
                            affectedSymbol: g,
                            filePath: primaryFilePath,
                            reason: `Proposal removed authorization guard '${g}' present in base commit.`
                        })),
                        canAutoMerge: false,
                        affectedSymbols: removedGuards,
                        diagnostics: removedGuards.map(g => `Removed guard ${g}`)
                    };
                }
                else {
                    const repoConflicts = SymbolDependencyGraph.checkDependencyConflicts(this.sql, polyglot.definitions, polyglot.references, primaryFilePath);
                    if (repoConflicts.length > 0) {
                        status = "NEEDS_REVIEW";
                        analysisOutcome = {
                            outcome: "POTENTIAL_INTERACTION",
                            summary: repoConflicts.map(c => c.reason).join("; "),
                            interactions: repoConflicts.map(c => ({
                                type: "SIGNATURE_CALL_MISMATCH" as const,
                                affectedSymbol: c.symbolName,
                                filePath: primaryFilePath,
                                reason: c.reason
                            })),
                            canAutoMerge: false,
                            affectedSymbols: repoConflicts.map(c => c.symbolName),
                            diagnostics: repoConflicts.map(c => c.reason)
                        };
                    }
                    else {
                        status = "READY_TO_LAND";
                        analysisOutcome = {
                            outcome: "SAFE_INTEGRATION",
                            summary: `Polyglot (${primaryExt}) symbol checks passed. Clean definitions: ${polyglot.definitions.map(d => d.symbolName).join(", ") || "none"}.`,
                            interactions: [],
                            canAutoMerge: false,
                            affectedSymbols: polyglot.definitions.map(d => d.symbolName),
                            diagnostics: []
                        };
                    }
                }
            }
            else {
                const candidateSummary = ASTSemanticAnalyzer.parseFile(primaryPatchContent, primaryFilePath);
                if (candidateSummary.syntaxErrors.length > 0) {
                    status = "REJECTED";
                    analysisOutcome = {
                        outcome: "UNRESOLVED_CONFLICT",
                        summary: `TypeScript syntax errors: ${candidateSummary.syntaxErrors.join("; ")}`,
                        interactions: [{
                                type: "SYNTAX_ERROR",
                                affectedSymbol: "FILE_SYNTAX",
                                filePath: primaryFilePath,
                                reason: candidateSummary.syntaxErrors.join("; ")
                            }],
                        canAutoMerge: false,
                        affectedSymbols: [],
                        diagnostics: candidateSummary.syntaxErrors
                    };
                }
                else {
                    const activeCursor = this.sql.exec("SELECT * FROM proposals WHERE target_branch = ?1 AND id != ?2 AND status IN ('ANALYZING', 'READY_TO_LAND', 'NEEDS_REVIEW', 'LANDING');", targetBranch, proposalId);
                    const activeRows = [...activeCursor];
                    const activeProposals = activeRows.map(r => this.deserializeProposal(r));
                    let foundInteraction = false;
                    const dedupeCheck = await SemanticImmuneSystem.evaluateProposalDeduplication(candidatePatchContent, proposalId, activeProposals, this.env);
                    if (dedupeCheck.isDuplicate) {
                        foundInteraction = true;
                        status = "NEEDS_REVIEW";
                        analysisOutcome = {
                            outcome: "POTENTIAL_INTERACTION",
                            summary: `Semantic duplicate detected: proposal produces equivalent AST/semantics to active proposal ${dedupeCheck.duplicateOf} (similarity: ${dedupeCheck.cosineScore.toFixed(3)}).`,
                            interactions: [{
                                    type: "SIGNATURE_CALL_MISMATCH",
                                    affectedSymbol: "DUPLICATE_PROPOSAL",
                                    filePath: primaryFilePath,
                                    reason: `Duplicate of active proposal ${dedupeCheck.duplicateOf}`
                                }],
                            canAutoMerge: false,
                            affectedSymbols: ["DUPLICATE_PROPOSAL"],
                            diagnostics: [`Equivalent alpha-hash: ${dedupeCheck.alphaHash}`]
                        };
                    }
                    else {
                        for (const other of activeProposals) {
                            let report: SemanticAnalysisReport;
                            if (other.filePath === primaryFilePath) {
                                report = ASTSemanticAnalyzer.analyzeProposals({
                                    baseCode,
                                    filePath: primaryFilePath,
                                    proposalA: { agentId: other.agentId, intent: other.intentDescription, code: other.patchContent },
                                    proposalB: { agentId: verifiedAgentId, intent: body.intentDescription, code: primaryPatchContent }
                                });
                                if (report.outcome === "SAFE_INTEGRATION" && report.synthesizedCode) {
                                    candidatePatchContent = report.synthesizedCode;
                                }
                            }
                            else {
                                report = ASTSemanticAnalyzer.analyzeCrossFileProposals({
                                    proposalA: { agentId: other.agentId, intent: other.intentDescription, filePath: other.filePath, code: other.patchContent },
                                    proposalB: { agentId: verifiedAgentId, intent: body.intentDescription, filePath: primaryFilePath, code: primaryPatchContent }
                                });
                            }
                            if (report.outcome !== "SAFE_INTEGRATION") {
                                foundInteraction = true;
                                status = "NEEDS_REVIEW";
                                analysisOutcome = report;
                                if (other.status === "READY_TO_LAND" || other.status === "ANALYZING") {
                                    this.sql.exec("UPDATE proposals SET status = 'NEEDS_REVIEW', analysis_outcome = ?1, updated_at = ?2 WHERE id = ?3 AND status IN ('READY_TO_LAND', 'ANALYZING');", JSON.stringify(report), Date.now(), other.id);
                                    this.appendAuditRecord(verifiedAgentId, "RECLASSIFY_PROPOSAL_FOR_INTERACTION", {
                                        proposalId: other.id,
                                        interactingProposalId: proposalId,
                                        outcome: report.outcome,
                                        affectedSymbols: report.affectedSymbols
                                    });
                                }
                                break;
                            }
                        }
                    }
                    if (!foundInteraction) {
                        const { definitions: candidateDefs, references: candidateRefs } = SymbolDependencyGraph.extractSymbols(primaryPatchContent, primaryFilePath);
                        const repoConflicts = SymbolDependencyGraph.checkDependencyConflicts(this.sql, candidateDefs, candidateRefs, primaryFilePath);
                        if (repoConflicts.length > 0) {
                            foundInteraction = true;
                            status = "NEEDS_REVIEW";
                            analysisOutcome = {
                                outcome: "POTENTIAL_INTERACTION",
                                summary: repoConflicts.map(c => c.reason).join("; "),
                                interactions: repoConflicts.map(c => ({
                                    type: "SIGNATURE_CALL_MISMATCH" as const,
                                    affectedSymbol: c.symbolName,
                                    filePath: primaryFilePath,
                                    reason: c.reason
                                })),
                                canAutoMerge: false,
                                affectedSymbols: repoConflicts.map(c => c.symbolName),
                                diagnostics: repoConflicts.map(c => c.reason)
                            };
                        }
                        else {
                            status = "READY_TO_LAND";
                            analysisOutcome = {
                                outcome: "SAFE_INTEGRATION",
                                summary: "No conflict was detected by the current TypeScript AST checks. Reviewer approval and Git landing are still required.",
                                interactions: [],
                                canAutoMerge: false,
                                affectedSymbols: Array.from(candidateSummary.definitions.keys()),
                                diagnostics: []
                            };
                        }
                    }
                }
            }
            let candidateCommitSha: string | null = null;
            let finalStatus = status;
            if (status === "READY_TO_LAND") {
                const verification = new VerificationGate().verifyCandidate(candidatePatchContent, languageForPath(primaryFilePath), baseCode);
                if (!verification.passed || verification.securityRiskDetected) {
                    finalStatus = "NEEDS_REVIEW";
                    analysisOutcome = {
                        outcome: "POTENTIAL_INTERACTION",
                        summary: "Static source checks found an issue that requires reviewer attention.",
                        interactions: [],
                        canAutoMerge: false,
                        affectedSymbols: analysisOutcome?.affectedSymbols || [],
                        diagnostics: verification.diagnostics.concat(verification.riskFlags)
                    };
                }
            }
            const affectedSymbols = analysisOutcome ? JSON.stringify(analysisOutcome.affectedSymbols) : "[]";
            const now = Date.now();
            const finalPatch = candidatePatchContent;
            const candidateContentSha = crypto.createHash("sha256").update(finalPatch, "utf8").digest("hex");
            this.sql.exec(`UPDATE proposals SET
          candidate_commit_sha = ?1,
          candidate_content_sha = ?2,
          patch_content = ?3,
          status = ?4,
          analysis_outcome = ?5,
          test_status = ?6,
          affected_symbols = ?7,
          updated_at = ?8
        WHERE id = ?9;`, candidateCommitSha, candidateContentSha, finalPatch, finalStatus, analysisOutcome ? JSON.stringify(analysisOutcome) : null, JSON.stringify({ executed: false, passed: false, output: "No runtime test runner is configured; only static AST and security checks were performed." }), affectedSymbols, now, proposalId);
            this.appendAuditRecord(verifiedAgentId, "SUBMIT_PROPOSAL", {
                proposalId,
                baseCommitSha: body.baseCommitSha,
                status: finalStatus,
                intent: body.intentDescription
            });
            const savedCursor = this.sql.exec("SELECT * FROM proposals WHERE id = ?1 LIMIT 1;", proposalId);
            const saved = this.deserializeProposal([...savedCursor][0]);
            return Response.json({ proposal: saved, isRetry: false });
        }
        if (request.method === "GET" && url.pathname.endsWith("/proposals/get")) {
            const id = url.searchParams.get("id");
            if (!id)
                return Response.json({ error: "Missing id parameter" }, { status: 400 });
            const cursor = this.sql.exec("SELECT * FROM proposals WHERE id = ?1 LIMIT 1;", id);
            const rows = [...cursor];
            if (rows.length === 0)
                return Response.json({ error: "Proposal not found" }, { status: 404 });
            return Response.json({ proposal: this.deserializeProposal(rows[0]) });
        }
        if (request.method === "GET" && url.pathname.endsWith("/proposals/list")) {
            const branch = url.searchParams.get("branch") || "main";
            const cursor = this.sql.exec("SELECT * FROM proposals WHERE target_branch = ?1 ORDER BY submitted_at DESC;", branch);
            const proposals = [...cursor].map(r => this.deserializeProposal(r));
            return Response.json({ proposals });
        }
        if (request.method === "POST" && (url.pathname.endsWith("/proposals/approve") || url.pathname.endsWith("/vpr/accept"))) {
            const body = await request.json() as {
                proposalId?: string;
                approverId?: string;
                resolvedCode?: string;
                repoId?: string;
                repo?: string;
                module?: string;
                message?: string;
            };
            const approverId = request.headers.get("X-Aether-Verified-Sub") || body.approverId;
            if (!approverId) {
                return Response.json({ error: "Unauthorized: approver identity required." }, { status: 401 });
            }
            if (!body.proposalId) {
                return Response.json({ error: "Missing required field: proposalId" }, { status: 400 });
            }
            const cursor = this.sql.exec("SELECT * FROM proposals WHERE id = ?1 LIMIT 1;", body.proposalId);
            const rows = [...cursor];
            if (rows.length === 0) {
                return Response.json({ error: `Proposal '${body.proposalId}' not found.` }, { status: 404 });
            }
            const proposal = this.deserializeProposal(rows[0]);
            if (proposal.status === "COMMITTED") {
                return Response.json({ error: `Proposal '${proposal.id}' is already committed.` }, { status: 409 });
            }
            if (proposal.status === "REJECTED") {
                return Response.json({ error: `Proposal '${proposal.id}' has been rejected.` }, { status: 409 });
            }
            const approvableStatuses = ["SAFE_INTEGRATED", "POTENTIAL_INTERACTION", "UNRESOLVED_CONFLICT", "NEEDS_REVIEW", "READY_TO_LAND", "QUEUED"];
            if (!approvableStatuses.includes(proposal.status)) {
                return Response.json({
                    error: `Proposal '${proposal.id}' cannot be approved in state '${proposal.status}'. Must be awaiting review.`
                }, { status: 409 });
            }
            const targetRepo = body.repoId || body.repo;
            if (targetRepo && proposal.repoId !== targetRepo) {
                return Response.json({ error: `Proposal '${proposal.id}' belongs to '${proposal.repoId}', not '${targetRepo}'.` }, { status: 403 });
            }
            let currentSnapshot: Awaited<ReturnType<typeof artifactsBridge.getBranchSnapshot>>;
            try {
                currentSnapshot = await artifactsBridge.getBranchSnapshot(proposal.repoId, proposal.targetBranch, proposal.filePath, this.env);
            }
            catch (err: any) {
                return Response.json({ error: `Could not refresh Artifacts branch before approval: ${err.message || String(err)}` }, { status: 502 });
            }
            const latestProposalRow = [...this.sql.exec("SELECT status FROM proposals WHERE id = ?1 LIMIT 1;", proposal.id)][0];
            if (!latestProposalRow)
                return Response.json({ error: "Proposal no longer exists." }, { status: 404 });
            const latestStatus = String(latestProposalRow.status);
            if (!approvableStatuses.includes(latestStatus)) {
                return Response.json({
                    error: `Proposal '${proposal.id}' cannot be approved in state '${latestStatus}'. Another request may already be landing it.`
                }, { status: 409 });
            }
            if (currentSnapshot.headSha !== proposal.baseCommitSha) {
                const staleReport = {
                    outcome: "POTENTIAL_INTERACTION",
                    summary: "The target branch moved after this proposal was submitted; fetch the new head and resubmit.",
                    interactions: [{ type: "STALE_BASE", affectedSymbol: "BRANCH_HEAD", filePath: proposal.filePath, reason: "Proposal base does not match current Artifacts head." }],
                    canAutoMerge: false,
                    affectedSymbols: [],
                    diagnostics: ["Current branch head: " + currentSnapshot.headSha]
                };
                this.sql.exec("UPDATE proposals SET status = 'NEEDS_REVIEW', analysis_outcome = ?1, updated_at = ?2 WHERE id = ?3;", JSON.stringify(staleReport), Date.now(), proposal.id);
                this.appendAuditRecord(approverId, "APPROVAL_REJECTED_STALE_BASE", {
                    proposalId: proposal.id,
                    submittedBaseSha: proposal.baseCommitSha,
                    currentHeadSha: currentSnapshot.headSha
                });
                return Response.json({
                    error: "Proposal base is stale. Refresh repository state and submit a candidate against the current head before approval.",
                    staleBase: true,
                    currentHeadSha: currentSnapshot.headSha,
                    currentContent: currentSnapshot.content
                }, { status: 409 });
            }
            const currentHead = currentSnapshot.headSha;
            const finalCode = body.resolvedCode || proposal.patchContent;
            const baseCode = currentSnapshot.content || "";
            const effectiveBaseSha = currentHead;
            this.setBranchHeadSha(proposal.targetBranch, currentHead);
            if (currentSnapshot.content !== null)
                this.setBranchFile(proposal.targetBranch, proposal.filePath, currentSnapshot.content);
            const candidateContentSha = crypto.createHash("sha256").update(finalCode, "utf8").digest("hex");
            const verification = new VerificationGate().verifyCandidate(finalCode, languageForPath(proposal.filePath), baseCode);
            if (!verification.passed || verification.securityRiskDetected) {
                return Response.json({
                    error: "Verification gate rejected candidate code",
                    diagnostics: verification.diagnostics,
                    riskFlags: verification.riskFlags,
                    notRun: verification.notRun
                }, { status: 422 });
            }
            const outboxId = `outbox_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
            const commitMessage = body.message || `feat(resolve): approve proposal ${proposal.id} by ${approverId}`;
            const landingAt = Date.now();
            this.ctx.storage.transactionSync(() => {
                this.sql.exec("UPDATE proposals SET status = 'LANDING', patch_content = ?1, candidate_content_sha = ?2, updated_at = ?3 WHERE id = ?4 AND status IN ('SAFE_INTEGRATED', 'POTENTIAL_INTERACTION', 'UNRESOLVED_CONFLICT', 'NEEDS_REVIEW', 'READY_TO_LAND', 'QUEUED');", finalCode, candidateContentSha, landingAt, proposal.id);
                const filesJson = proposal.fileManifest ? JSON.stringify(proposal.fileManifest) : null;
                this.sql.exec(`INSERT INTO git_push_outbox (outbox_id, proposal_id, repo_id, branch, base_sha, status, commit_message, actor, files_json, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, 'PENDING', ?6, ?7, ?8, ?9, ?10);`, outboxId, proposal.id, proposal.repoId, proposal.targetBranch, effectiveBaseSha, commitMessage, approverId, filesJson, landingAt, landingAt);
            });
            await this.ctx.storage.setAlarm(Date.now() + 1000);
            const outcome = await this.processOutbox(outboxId);
            if (outcome.success) {
                const updated = this.deserializeProposal([...this.sql.exec("SELECT * FROM proposals WHERE id = ?1 LIMIT 1;", proposal.id)][0]);
                return Response.json({
                    success: true,
                    commitSha: outcome.commitSha,
                    approverId,
                    proposal: updated,
                    verificationMode: "static-only",
                    notRun: verification.notRun
                });
            }
            if (outcome.terminal)
                return Response.json({
                    success: false,
                    error: outcome.error,
                    staleBase: outcome.baseShaMismatch === true,
                    requiresResubmission: outcome.baseShaMismatch === true
                }, { status: outcome.baseShaMismatch ? 409 : 502 });
            return Response.json({
                success: true,
                queued: true,
                status: "LANDING",
                proposalId: proposal.id,
                error: outcome.error,
                verificationMode: "static-only",
                notRun: verification.notRun
            }, { status: 202 });
        }
        if (request.method === "GET" && url.pathname.endsWith("/audit/verify")) {
            const recordsCursor = this.sql.exec("SELECT * FROM audit_records ORDER BY sequence_id ASC;");
            const records = [...recordsCursor];
            let priorHash = "0000000000000000000000000000000000000000000000000000000000000000";
            for (const r of records) {
                if (r.prior_hash !== priorHash) {
                    return Response.json({
                        valid: false,
                        recordsVerified: Number(r.sequence_id) - 1,
                        error: `Broken hash chain at sequence ${r.sequence_id}`
                    });
                }
                const recomputedPayloadHash = crypto.createHash("sha256").update(String(r.payload)).digest("hex");
                if (recomputedPayloadHash !== r.payload_hash) {
                    return Response.json({
                        valid: false,
                        recordsVerified: Number(r.sequence_id) - 1,
                        error: `Payload hash mismatch at sequence ${r.sequence_id}: data has been tampered with.`
                    });
                }
                const expectedRecordHash = crypto.createHash("sha256")
                    .update(`${r.prior_hash}:${r.payload_hash}:${r.actor}:${r.action}:${r.timestamp}`)
                    .digest("hex");
                if (expectedRecordHash !== r.record_hash) {
                    return Response.json({
                        valid: false,
                        recordsVerified: Number(r.sequence_id) - 1,
                        error: `Tampered record at sequence ${r.sequence_id}`
                    });
                }
                priorHash = String(r.record_hash);
            }
            return Response.json({
                valid: true,
                recordsVerified: records.length,
                headRecordHash: priorHash,
                records: records.map(r => ({
                    sequenceId: Number(r.sequence_id),
                    action: String(r.action),
                    actor: String(r.actor),
                    timestamp: Number(r.timestamp),
                    priorHash: String(r.prior_hash),
                    payloadHash: String(r.payload_hash),
                    recordHash: String(r.record_hash)
                }))
            });
        }
        if (request.method === "POST" && url.pathname.endsWith("/repo/reset")) {
            try {
                this.sql.exec("DELETE FROM proposals;");
                this.sql.exec("DELETE FROM lane_sequence;");
                this.sql.exec("DELETE FROM audit_records;");
                this.sql.exec("DELETE FROM repo_symbols;");
                this.sql.exec("DELETE FROM ast_symbol_definitions;");
                this.sql.exec("DELETE FROM ast_symbol_references;");
                this.sql.exec("DELETE FROM repo_symbol_references;");
                this.sql.exec("DELETE FROM git_push_outbox;");
                this.sql.exec("DELETE FROM rate_limits;");
                return Response.json({ success: true, message: "Repository lane data, proposals, and commit ledger cleared." });
            } catch (err: any) {
                return Response.json({ error: err.message || String(err) }, { status: 500 });
            }
        }
        if (request.method === "GET" && url.pathname.endsWith("/lane/history")) {
            const branch = url.searchParams.get("branch") || "main";
            const cursor = this.sql.exec("SELECT * FROM lane_sequence WHERE target_branch = ?1 ORDER BY sequence_id ASC;", branch);
            return Response.json({ history: [...cursor] });
        }
        if (request.method === "GET" && url.pathname.endsWith("/why")) {
            const filePath = url.searchParams.get("path") || url.searchParams.get("filePath") || "";
            const symbolName = url.searchParams.get("symbol") || url.searchParams.get("symbolName") || "";
            const rows = [...this.sql.exec(`SELECT id, agent_id, intent_description, candidate_commit_sha, status, updated_at, affected_symbols
         FROM proposals
         WHERE file_path = ?1 AND status = 'COMMITTED'
         ORDER BY updated_at DESC;`, filePath)];
            const lineage = rows
                .map(r => ({
                proposalId: String(r.id),
                agentId: String(r.agent_id),
                intent: String(r.intent_description),
                commitSha: r.candidate_commit_sha ? String(r.candidate_commit_sha) : null,
                status: String(r.status),
                timestamp: Number(r.updated_at),
                affectedSymbols: r.affected_symbols ? JSON.parse(String(r.affected_symbols)) : []
            }))
                .filter(entry => entry.affectedSymbols.includes(symbolName) || entry.affectedSymbols.length === 0);
            return Response.json({
                filePath,
                symbolName,
                lineageCount: lineage.length,
                lineage
            });
        }
        if (request.method === "GET" && url.pathname.endsWith("/proposals/dag")) {
            const branch = url.searchParams.get("branch") || "main";
            const rows = [...this.sql.exec("SELECT * FROM proposals WHERE target_branch = ?1 AND status IN ('READY_TO_LAND', 'ANALYZING', 'NEEDS_REVIEW') ORDER BY submitted_at ASC;", branch)];
            const pendingProposals = rows.map(r => this.deserializeProposal(r));
            const dag = this.evaluateConcurrencyDAG(pendingProposals);
            const propMap = new Map(pendingProposals.map(p => [p.id, p]));
            const batches = dag.independentBatches.map((ids, idx) => ({
                batchIndex: idx,
                proposals: ids.map(id => propMap.get(id)).filter(Boolean)
            }));
            return Response.json({
                branch,
                totalPending: pendingProposals.length,
                totalProposals: pendingProposals.length,
                dag,
                batches
            });
        }
        if (request.method === "GET" && url.pathname.endsWith("/repo/state")) {
            const branch = url.searchParams.get("branch") || "main";
            const filePath = url.searchParams.get("filePath") || "";
            const repoId = url.searchParams.get("repoId") || "";
            try {
                const snapshot = await artifactsBridge.getBranchSnapshot(repoId, branch, filePath, this.env);
                return Response.json(snapshot);
            }
            catch (err: any) {
                return Response.json({ error: err.message || String(err) }, { status: 500 });
            }
        }
        if (request.method === "POST" && url.pathname.endsWith("/events/push")) {
            let body: {
                repo?: unknown;
                branch?: unknown;
                commitSha?: unknown;
                beforeSha?: unknown;
                observedHeadSha?: unknown;
                pusher?: unknown;
                timestamp?: unknown;
                files?: unknown;
            };
            try {
                body = await request.json() as typeof body;
            }
            catch {
                return Response.json({ error: "Malformed push event JSON." }, { status: 400 });
            }
            if (typeof body.repo !== "string" || !body.repo || body.repo.length > 256 ||
                typeof body.branch !== "string" || !isSafeBranchName(body.branch) ||
                typeof body.commitSha !== "string" || !isGitSha(body.commitSha) ||
                typeof body.beforeSha !== "string" || (body.beforeSha !== "" && !isGitSha(body.beforeSha)) ||
                typeof body.observedHeadSha !== "string" || !isGitSha(body.observedHeadSha) ||
                typeof body.pusher !== "string" || body.pusher.length > 256) {
                return Response.json({ error: "Push event is missing a valid repository, branch, commit, or observed head." }, { status: 400 });
            }
            if (body.files !== undefined) {
                if (!Array.isArray(body.files) || body.files.length > 100) {
                    return Response.json({ error: "Push event file snapshot exceeds supported limits or has an invalid shape." }, { status: 413 });
                }
                const encoder = new TextEncoder();
                let totalFileBytes = 0;
                for (const entry of body.files as Array<{
                    path?: unknown;
                    content?: unknown;
                }>) {
                    if (!entry || typeof entry.path !== "string" || !normalizeRepoPath(entry.path) ||
                        typeof entry.content !== "string") {
                        return Response.json({ error: "Push event file snapshot exceeds supported limits or has an invalid shape." }, { status: 413 });
                    }
                    totalFileBytes += encoder.encode(entry.path).byteLength + encoder.encode(entry.content).byteLength;
                    if (totalFileBytes > 1000000) {
                        return Response.json({ error: "Push event file snapshot exceeds the 1 MB total content limit." }, { status: 413 });
                    }
                }
            }
            const repo = body.repo;
            const branch = body.branch;
            const commitSha = body.commitSha;
            const beforeSha = body.beforeSha;
            const observedHeadSha = body.observedHeadSha;
            const pusher = body.pusher || "unknown";
            const eventResult = this.ctx.storage.transactionSync(() => {
                const receipt = [...this.sql.exec("SELECT commit_sha FROM artifacts_event_receipts WHERE repo_id = ?1 AND branch = ?2 AND commit_sha = ?3 LIMIT 1;", repo, branch, commitSha)][0];
                const duplicate = Boolean(receipt);
                const conflicts: DependencyConflict[] = [];
                const cachedHead = this.getBranchHeadSha(branch);
                const headChanged = cachedHead !== observedHeadSha;
                if (headChanged) {
                    this.setBranchHeadSha(branch, observedHeadSha);
                }
                const now = Date.now();
                const rows = [...this.sql.exec(`SELECT id, base_commit_sha, file_path FROM proposals
         WHERE target_branch = ?1 AND status IN ('ANALYZING', 'SAFE_INTEGRATED', 'POTENTIAL_INTERACTION', 'UNRESOLVED_CONFLICT', 'READY_TO_LAND', 'QUEUED');`, branch)];
                let invalidatedProposalCount = 0;
                for (const row of rows) {
                    if (String(row.base_commit_sha) === observedHeadSha)
                        continue;
                    const staleReport = {
                        outcome: "POTENTIAL_INTERACTION",
                        summary: "The Artifacts branch advanced after this proposal was created; fetch the new head and resubmit.",
                        interactions: [{ type: "STALE_BASE", affectedSymbol: "BRANCH_HEAD", filePath: String(row.file_path), reason: "Artifacts push notification refreshed the observed branch head." }],
                        canAutoMerge: false,
                        affectedSymbols: [],
                        diagnostics: [`Observed Artifacts head: ${observedHeadSha}`]
                    };
                    this.sql.exec("UPDATE proposals SET status = 'NEEDS_REVIEW', analysis_outcome = ?1, updated_at = ?2 WHERE id = ?3 AND status IN ('ANALYZING', 'SAFE_INTEGRATED', 'POTENTIAL_INTERACTION', 'UNRESOLVED_CONFLICT', 'READY_TO_LAND', 'QUEUED');", JSON.stringify(staleReport), now, String(row.id));
                    invalidatedProposalCount++;
                }
                if (!duplicate) {
                    this.sql.exec(`INSERT INTO artifacts_event_receipts
           (repo_id, branch, commit_sha, before_sha, observed_head_sha, pusher, received_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7);`, repo, branch, commitSha, beforeSha, observedHeadSha, pusher, now);
                    this.appendAuditRecord(pusher, "ARTIFACTS_PUSH_OBSERVED", {
                        repo,
                        branch,
                        commitSha,
                        beforeSha,
                        observedHeadSha,
                        invalidatedProposalCount
                    });
                }
                else if (headChanged) {
                    this.appendAuditRecord(pusher, "ARTIFACTS_HEAD_RECONCILED", {
                        repo,
                        branch,
                        notificationCommitSha: commitSha,
                        priorObservedHeadSha: cachedHead,
                        observedHeadSha,
                        invalidatedProposalCount
                    });
                }
                if (Array.isArray(body.files)) {
                    for (const file of body.files as Array<{
                        path: string;
                        content: string;
                    }>) {
                        const { definitions, references } = SymbolDependencyGraph.extractSymbols(file.content, file.path);
                        const detected = SymbolDependencyGraph.checkDependencyConflicts(this.sql, definitions, references, file.path);
                        conflicts.push(...detected);
                        SymbolDependencyGraph.updateSymbolIndex(this.sql, definitions, references, file.path);
                    }
                }
                return {
                    processed: true,
                    duplicate,
                    repo,
                    branch,
                    commitSha,
                    observedHeadSha,
                    invalidatedProposalCount,
                    conflictsCount: conflicts.length,
                    conflicts
                };
            });
            return Response.json(eventResult);
        }
        return new Response("Mesh Coordinator Ready", { status: 200 });
    }
    private deserializeProposal(row: any): any {
        return {
            id: row.id,
            repoId: row.repo_id,
            targetBranch: row.target_branch,
            agentId: row.agent_id,
            agentSignature: row.agent_signature,
            baseCommitSha: row.base_commit_sha,
            candidateCommitSha: row.candidate_commit_sha,
            candidateContentSha: row.candidate_content_sha || null,
            filePath: row.file_path,
            patchContent: row.patch_content,
            intentDescription: row.intent_description,
            affectedSymbols: row.affected_symbols ? JSON.parse(row.affected_symbols) : [],
            idempotencyKey: row.idempotency_key,
            status: row.status,
            analysisOutcome: row.analysis_outcome ? JSON.parse(row.analysis_outcome) : null,
            testStatus: row.test_status ? JSON.parse(row.test_status) : null,
            fileManifest: row.file_manifest ? JSON.parse(row.file_manifest) : undefined,
            submittedAt: Number(row.submitted_at),
            updatedAt: Number(row.updated_at)
        };
    }
    private appendLaneSequence(proposalId: string, targetBranch: string, priorHeadSha: string, newHeadSha: string, transitionType: string): void {
        const priorCursor = this.sql.exec("SELECT merkle_hash FROM lane_sequence ORDER BY sequence_id DESC LIMIT 1;");
        const priorRows = [...priorCursor];
        const priorMerkle = priorRows.length > 0 ? String(priorRows[0].merkle_hash) : "0000000000000000000000000000000000000000000000000000000000000000";
        const merkleHash = crypto.createHash("sha256")
            .update(`${priorMerkle}:${proposalId}:${priorHeadSha}:${newHeadSha}:${transitionType}`)
            .digest("hex");
        this.sql.exec("INSERT INTO lane_sequence (proposal_id, target_branch, prior_head_sha, new_head_sha, transition_type, merkle_hash, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7);", proposalId, targetBranch, priorHeadSha, newHeadSha, transitionType, merkleHash, Date.now());
    }
    private appendAuditRecord(actor: string, action: string, payload: any): void {
        const priorCursor = this.sql.exec("SELECT record_hash FROM audit_records ORDER BY sequence_id DESC LIMIT 1;");
        const priorRows = [...priorCursor];
        const priorHash = priorRows.length > 0 ? String(priorRows[0].record_hash) : "0000000000000000000000000000000000000000000000000000000000000000";
        const payloadString = JSON.stringify(payload);
        const payloadHash = crypto.createHash("sha256").update(payloadString).digest("hex");
        const timestamp = Date.now();
        const recordHash = crypto.createHash("sha256")
            .update(`${priorHash}:${payloadHash}:${actor}:${action}:${timestamp}`)
            .digest("hex");
        this.sql.exec("INSERT INTO audit_records (prior_hash, payload_hash, record_hash, actor, action, timestamp, payload) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7);", priorHash, payloadHash, recordHash, actor, action, timestamp, payloadString);
    }
    public evaluateConcurrencyDAG(pendingProposals: any[]): {
        independentBatches: string[][];
        parallelismFactor: number;
        conflictEdges: Array<{
            from: string;
            to: string;
            reason: string;
        }>;
    } {
        if (pendingProposals.length === 0) {
            return { independentBatches: [], parallelismFactor: 1, conflictEdges: [] };
        }
        const symbolTouchMap = new Map<string, Set<string>>();
        const fileTouchMap = new Map<string, Set<string>>();
        for (const p of pendingProposals) {
            const symSet = new Set<string>();
            const fileSet = new Set<string>();
            if (Array.isArray(p.fileManifest) && p.fileManifest.length > 0) {
                p.fileManifest.forEach((f: any) => fileSet.add(f.filePath));
            }
            else if (p.filePath) {
                fileSet.add(p.filePath);
            }
            if (Array.isArray(p.affectedSymbols)) {
                p.affectedSymbols.forEach((s: any) => symSet.add(typeof s === "string" ? s : s.name));
            }
            symbolTouchMap.set(p.id, symSet);
            fileTouchMap.set(p.id, fileSet);
        }
        const conflictEdges: Array<{
            from: string;
            to: string;
            reason: string;
        }> = [];
        const adj = new Map<string, Set<string>>();
        for (const p of pendingProposals)
            adj.set(p.id, new Set());
        for (let i = 0; i < pendingProposals.length; i++) {
            for (let j = i + 1; j < pendingProposals.length; j++) {
                const pA = pendingProposals[i];
                const pB = pendingProposals[j];
                const idA = pA.id;
                const idB = pB.id;
                const filesA = fileTouchMap.get(idA)!;
                const filesB = fileTouchMap.get(idB)!;
                const overlappingFiles = [...filesA].filter(f => filesB.has(f));
                if (overlappingFiles.length > 0) {
                    const symsA = symbolTouchMap.get(idA)!;
                    const symsB = symbolTouchMap.get(idB)!;
                    const overlappingSymbols = [...symsA].filter(s => symsB.has(s));
                    if (overlappingSymbols.length > 0 || symsA.size === 0 || symsB.size === 0) {
                        const reason = overlappingSymbols.length > 0
                            ? `Symbol collision on [${overlappingSymbols.join(", ")}] in ${overlappingFiles.join(", ")}`
                            : `Coarse file overlap in ${overlappingFiles.join(", ")}`;
                        adj.get(idA)!.add(idB);
                        adj.get(idB)!.add(idA);
                        conflictEdges.push({ from: idA, to: idB, reason });
                    }
                }
            }
        }
        const batches: string[][] = [];
        const assigned = new Set<string>();
        while (assigned.size < pendingProposals.length) {
            const currentBatch: string[] = [];
            for (const p of pendingProposals) {
                if (assigned.has(p.id))
                    continue;
                const hasConflictWithBatch = currentBatch.some(id => adj.get(id)!.has(p.id));
                if (!hasConflictWithBatch) {
                    currentBatch.push(p.id);
                    assigned.add(p.id);
                }
            }
            batches.push(currentBatch);
        }
        const parallelismFactor = Number((pendingProposals.length / Math.max(1, batches.length)).toFixed(2));
        return {
            independentBatches: batches,
            parallelismFactor,
            conflictEdges
        };
    }
}
function languageForPath(filePath: string): string {
    const extension = filePath.toLowerCase().split(".").pop() || "";
    if (["ts", "tsx", "mts", "cts"].includes(extension))
        return extension === "tsx" ? "tsx" : "typescript";
    if (["js", "jsx", "mjs", "cjs"].includes(extension))
        return extension === "jsx" ? "jsx" : "javascript";
    if (extension === "py")
        return "python";
    if (extension === "rs")
        return "rust";
    return "unsupported";
}
