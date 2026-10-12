import { Env, ASTMutationPayload } from "./types";
import { TransactionBatcher } from "./batcher";
import { SemanticConflictArbiter } from "./collapse_alarm";
import { VirtualPullRequestEngine } from "./vpr_engine";
import { SymbolDependencyGraph } from "./symbol_graph";
import { StateCompactionAlarmDaemon } from "./compaction_daemon";
export class ASTMeshShard implements DurableObject {
    private ctx: DurableObjectState;
    private env: Env;
    private sql: SqlStorage;
    private batcher: TransactionBatcher;
    private serverClock: number = 0;
    constructor(ctx: DurableObjectState, env: Env) {
        this.ctx = ctx;
        this.env = env;
        this.sql = ctx.storage.sql;
        this.initializeDatabase();
        this.batcher = new TransactionBatcher(this.sql, operation => this.ctx.storage.transactionSync(operation), mutation => this.validateQueuedMutation(mutation));
        this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    }
    private initializeDatabase(): void {
        this.sql.exec(`
      CREATE TABLE IF NOT EXISTS ast_nodes (
        node_id TEXT PRIMARY KEY NOT NULL,
        parent_id TEXT,
        grammar_type TEXT NOT NULL,
        pos_fractional TEXT NOT NULL,
        is_alive INTEGER NOT NULL DEFAULT 1,
        birth_lamport INTEGER NOT NULL,
        birth_agent TEXT NOT NULL,
        death_lamport INTEGER,
        death_agent TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_ast_nodes_hierarchy 
      ON ast_nodes (parent_id, is_alive, pos_fractional ASC);

      CREATE TABLE IF NOT EXISTS ast_attributes (
        node_id TEXT NOT NULL,
        attr_key TEXT NOT NULL,
        attr_val TEXT,
        lamport_counter INTEGER NOT NULL,
        agent_id TEXT NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (node_id, attr_key)
      );

      CREATE TABLE IF NOT EXISTS ast_subtree_locks (
        lock_id TEXT PRIMARY KEY NOT NULL,
        subtree_root_id TEXT NOT NULL,
        owner_identity TEXT NOT NULL,
        owner_public_key TEXT NOT NULL,
        lease_expires_at INTEGER NOT NULL,
        lock_scope TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS crdt_merkle_ledger (
        sequence_id INTEGER PRIMARY KEY AUTOINCREMENT,
        mutation_hash TEXT NOT NULL,
        parent_root TEXT NOT NULL,
        new_root TEXT NOT NULL,
        lamport_counter INTEGER NOT NULL,
        signer_public_key TEXT NOT NULL,
        committed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS ast_mutation_log (
        sequence_id INTEGER PRIMARY KEY AUTOINCREMENT,
        lamport_counter INTEGER NOT NULL,
        agent_id TEXT NOT NULL,
        mutation_hash TEXT NOT NULL,
        mutation_json TEXT NOT NULL,
        committed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS ast_archive_index (
        r2_object_key TEXT PRIMARY KEY NOT NULL,
        payload_sha256 TEXT NOT NULL,
        first_mutation_sequence INTEGER NOT NULL,
        last_mutation_sequence INTEGER NOT NULL,
        first_ledger_sequence INTEGER NOT NULL,
        last_ledger_sequence INTEGER NOT NULL,
        min_lamport INTEGER NOT NULL,
        max_lamport INTEGER NOT NULL,
        first_parent_root TEXT NOT NULL,
        last_root TEXT NOT NULL,
        archived_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ast_move_history (
        sequence_id INTEGER PRIMARY KEY AUTOINCREMENT,
        node_id TEXT NOT NULL,
        new_parent_id TEXT,
        pos_fractional TEXT NOT NULL,
        lamport_counter INTEGER NOT NULL,
        agent_id TEXT NOT NULL,
        applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS ast_superposition_pool (
        candidate_id TEXT PRIMARY KEY NOT NULL,
        target_parent_id TEXT NOT NULL,
        intent_spec TEXT NOT NULL,
        syntax_sexpr TEXT NOT NULL,
        raw_source TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        submitted_at INTEGER NOT NULL,
        fitness_score REAL DEFAULT NULL
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

      -- Seed Virtual Root Node
      INSERT OR IGNORE INTO ast_nodes (node_id, parent_id, grammar_type, pos_fractional, is_alive, birth_lamport, birth_agent)
      VALUES ('root', NULL, 'MODULE_ROOT', '000000', 1, 0, 'system');
    `);
        try {
            this.sql.exec("ALTER TABLE ast_symbol_definitions ADD COLUMN max_arity INTEGER;");
        }
        catch { }
        const cursor = this.sql.exec(`
      SELECT MAX(max_c) AS max_c FROM (
        SELECT MAX(lamport_counter) AS max_c FROM crdt_merkle_ledger
        UNION ALL
        SELECT MAX(max_lamport) AS max_c FROM ast_archive_index
      );
    `);
        const row = [...cursor][0];
        if (row && row.max_c) {
            this.serverClock = row.max_c as number;
        }
    }
    async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);
        if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
            const webSocketPair = new WebSocketPair();
            const [client, server] = Object.values(webSocketPair);
            const agentKey = request.headers.get("X-Aether-Verified-Sub");
            if (!agentKey)
                return new Response("Verified WebSocket identity required", { status: 401 });
            const subTreeRoot = url.searchParams.get("subTreeRoot") || "root";
            this.ctx.acceptWebSocket(server, [
                `agent:${agentKey}`,
                `sub:${subTreeRoot}`,
                "role:collaborator"
            ]);
            return new Response(null, { status: 101, webSocket: client });
        }
        if (request.method === "GET" && url.pathname.endsWith("/stream")) {
            const rootId = url.searchParams.get("rootId") || "root";
            return new Response(this.synthesizeCSTStream(rootId), {
                headers: { "Content-Type": "text/plain; charset=utf-8" }
            });
        }
        if (request.method === "POST" && url.pathname.endsWith("/lock")) {
            const body = await request.json() as {
                subtreeRootId: string;
                ownerIdentity: string;
                ownerPublicKey: string;
                durationMs?: number;
            };
            if (!body.subtreeRootId || !body.ownerIdentity || !body.ownerPublicKey) {
                return Response.json({ success: false, error: "subtreeRootId and verified owner identity are required." }, { status: 400 });
            }
            const targetExists = [...this.sql.exec("SELECT 1 AS found FROM ast_nodes WHERE node_id = ?1 AND is_alive = 1 LIMIT 1;", body.subtreeRootId)].length > 0;
            if (!targetExists)
                return Response.json({ success: false, error: "Lock target node does not exist." }, { status: 404 });
            const now = Date.now();
            const requestedDuration = Number.isFinite(body.durationMs) ? Number(body.durationMs) : 600000;
            const expiresAt = now + Math.max(1000, Math.min(requestedDuration, 600000));
            this.sql.exec("DELETE FROM ast_subtree_locks WHERE lease_expires_at <= ?1;", now);
            const existingCursor = this.sql.exec(`
        WITH RECURSIVE ancestors(node_id, parent_id) AS (
          SELECT node_id, parent_id FROM ast_nodes WHERE node_id = ?1
          UNION
          SELECT n.node_id, n.parent_id FROM ast_nodes n JOIN ancestors a ON n.node_id = a.parent_id
        ), descendants(node_id, parent_id) AS (
          SELECT node_id, parent_id FROM ast_nodes WHERE node_id = ?1
          UNION
          SELECT n.node_id, n.parent_id FROM ast_nodes n JOIN descendants d ON n.parent_id = d.node_id
        )
        SELECT l.lock_id, l.owner_identity, l.subtree_root_id FROM ast_subtree_locks l
        WHERE l.lease_expires_at > ?2 AND (
          l.subtree_root_id IN (SELECT node_id FROM ancestors) OR
          l.subtree_root_id IN (SELECT node_id FROM descendants)
        );
      `, body.subtreeRootId, now);
            const existingLocks = [...existingCursor];
            if (existingLocks.length > 0) {
                const exactLock = existingLocks.find(lock => lock.subtree_root_id === body.subtreeRootId && lock.owner_identity === body.ownerIdentity);
                const overlappingLock = existingLocks.find(lock => lock.subtree_root_id !== body.subtreeRootId || lock.owner_identity !== body.ownerIdentity);
                if (overlappingLock) {
                    return Response.json({
                        success: false,
                        error: "Requested subtree overlaps an active lease."
                    }, { status: 409 });
                }
                if (exactLock) {
                    this.sql.exec("UPDATE ast_subtree_locks SET lease_expires_at = ?1 WHERE lock_id = ?2;", expiresAt, exactLock.lock_id);
                    return Response.json({ success: true, lockId: exactLock.lock_id, expiresAt, renewed: true });
                }
            }
            const lockId = crypto.randomUUID();
            this.sql.exec(`
        INSERT INTO ast_subtree_locks (lock_id, subtree_root_id, owner_identity, owner_public_key, lease_expires_at, lock_scope)
        VALUES (?1, ?2, ?3, ?4, ?5, 'EXCLUSIVE_WRITE');
      `, lockId, body.subtreeRootId, body.ownerIdentity, body.ownerPublicKey, expiresAt);
            return Response.json({ success: true, lockId, expiresAt, renewed: false });
        }
        if (request.method === "POST" && url.pathname.endsWith("/lock/release")) {
            const { lockId, ownerIdentity } = await request.json() as {
                lockId: string;
                ownerIdentity: string;
            };
            if (!lockId || !ownerIdentity)
                return Response.json({ success: false, error: "lockId and verified owner identity are required." }, { status: 400 });
            const existing = [...this.sql.exec(`SELECT lock_id FROM ast_subtree_locks WHERE lock_id = ?1 AND owner_identity = ?2;`, lockId, ownerIdentity)];
            if (!existing.length)
                return Response.json({ success: false, error: "Lock not found for this identity." }, { status: 404 });
            this.sql.exec(`DELETE FROM ast_subtree_locks WHERE lock_id = ?1 AND owner_identity = ?2;`, lockId, ownerIdentity);
            return Response.json({ success: true });
        }
        if (request.method === "GET" && url.pathname.endsWith("/chain/verify")) {
            const isValid = await this.verifyLedgerChainIntegrity();
            return Response.json({ valid: isValid });
        }
        if (request.method === "POST" && url.pathname.endsWith("/commit")) {
            const rawText = await request.text();
            const mutation = JSON.parse(rawText) as ASTMutationPayload;
            const callerKey = request.headers.get("X-Agent-Key") || mutation.lamport.agentId;
            const validationError = this.validateAndNormalizeMutation(mutation, callerKey);
            if (validationError) {
                return Response.json({ success: false, error: validationError }, { status: 400 });
            }
            try {
                await this.batcher.schedule(mutation);
            }
            catch (err: any) {
                return Response.json({ success: false, error: err?.message || String(err) }, { status: 409 });
            }
            this.broadcastMutation(mutation);
            return Response.json({ success: true, serverClock: mutation.lamport.counter });
        }
        if (request.method === "POST" && url.pathname.endsWith("/superposition/submit")) {
            const body = await request.json() as {
                candidateId?: string;
                targetParentId: string;
                intentSpec: string;
                syntaxSExpr?: string;
                rawSource: string;
                agentId: string;
            };
            const candidateId = body.candidateId || `cand-${crypto.randomUUID().slice(0, 8)}`;
            this.sql.exec(`
        INSERT INTO ast_superposition_pool (candidate_id, target_parent_id, intent_spec, syntax_sexpr, raw_source, agent_id, submitted_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
        ON CONFLICT(candidate_id) DO UPDATE SET raw_source = excluded.raw_source;
      `, candidateId, body.targetParentId, body.intentSpec, body.syntaxSExpr || "()", body.rawSource, body.agentId, Date.now());
            await this.ctx.storage.setAlarm(Date.now() + 50);
            return Response.json({ success: true, candidateId, alarmScheduled: true });
        }
        if (request.method === "GET" && url.pathname.endsWith("/superposition/pending")) {
            const cursor = this.sql.exec(`
        SELECT candidate_id, target_parent_id, intent_spec, raw_source, agent_id, submitted_at, fitness_score
        FROM ast_superposition_pool
        ORDER BY submitted_at ASC;
      `);
            return Response.json([...cursor]);
        }
        if (request.method === "GET" && url.pathname.endsWith("/arbitration/audit")) {
            try {
                const cursor = this.sql.exec(`
          SELECT * FROM ast_arbitration_log
          ORDER BY created_at DESC
          LIMIT 50;
        `);
                return Response.json([...cursor]);
            }
            catch {
                return Response.json([]);
            }
        }
        if (request.method === "POST" && url.pathname.endsWith("/vpr/generate")) {
            const body = await request.json() as {
                fromSequenceId?: number;
                toSequenceId?: number;
            };
            const fromSeq = body.fromSequenceId || 1;
            const toSeq = body.toSequenceId || 999999;
            const engine = new VirtualPullRequestEngine(this.sql, this.env);
            const vpr = await engine.generateVirtualPR(fromSeq, toSeq);
            return Response.json(vpr);
        }
        return new Response("Not Found", { status: 404 });
    }
    async alarm(): Promise<void> {
        const arbiter = new SemanticConflictArbiter(this.sql, this.env);
        await arbiter.arbitrateSuperpositionPool();
        const lastCompaction = await this.ctx.storage.get<number>("aether:last-compaction-at") || 0;
        if (Date.now() - lastCompaction >= 6 * 60 * 60 * 1000) {
            try {
                const compactor = new StateCompactionAlarmDaemon(this.sql, this.env, this.ctx.id.toString(), operation => this.ctx.storage.transactionSync(operation));
                await compactor.runCompactionCycle();
                await this.ctx.storage.put("aether:last-compaction-at", Date.now());
            }
            catch (err) {
                console.error("[Compaction] Cycle failed; data was retained:", err);
            }
        }
    }
    async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
        const rawLength = typeof message === "string" ? new TextEncoder().encode(message).byteLength : message.byteLength;
        const error = rawLength > 1048576 ? "ERR_PAYLOAD_TOO_LARGE" : "ERR_SIGNED_REST_REQUIRED";
        try {
            ws.send(JSON.stringify({ type: "ERROR_REJECTED", code: error }));
        }
        catch { }
        ws.close(1008, "Mutations require the signed REST envelope endpoint");
    }
    async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
        ws.close(code, "Aether Shard Session Closed");
    }
    private validateAndNormalizeMutation(mutation: ASTMutationPayload, callerPublicKey: string): string | null {
        if (!mutation || typeof mutation !== "object" || Array.isArray(mutation) || !mutation.lamport ||
            !Number.isSafeInteger(mutation.lamport.counter) || mutation.lamport.counter < 0) {
            return "ERR_INVALID_LAMPORT_CLOCK";
        }
        if (!/^[0-9a-fA-F]{64}$/.test(callerPublicKey))
            return "ERR_INVALID_SIGNER_IDENTITY";
        if (!new Set(["INSERT", "UPDATE", "DELETE", "MOVE"]).has(mutation.kind)) {
            return "ERR_UNSUPPORTED_MUTATION_KIND";
        }
        if (typeof mutation.nodeId !== "string" || !mutation.nodeId || mutation.nodeId.length > 512 ||
            typeof mutation.grammarType !== "string" || !mutation.grammarType || mutation.grammarType.length > 256 ||
            typeof mutation.posFractional !== "string" || !mutation.posFractional || mutation.posFractional.length > 256) {
            return "ERR_INVALID_MUTATION_SHAPE";
        }
        if (mutation.parentId !== undefined && mutation.parentId !== null &&
            (typeof mutation.parentId !== "string" || mutation.parentId.length > 512))
            return "ERR_INVALID_PARENT_ID";
        if (["INSERT", "MOVE"].includes(mutation.kind) &&
            (typeof mutation.parentId !== "string" || !mutation.parentId || mutation.parentId.length > 512))
            return "ERR_PARENT_REQUIRED";
        if (mutation.attrKey !== undefined &&
            (typeof mutation.attrKey !== "string" || mutation.attrKey.length > 128 || mutation.attrKey === "__alpha_hash")) {
            return "ERR_INVALID_ATTRIBUTE_KEY";
        }
        if (mutation.attrVal !== undefined && (typeof mutation.attrVal !== "string" || mutation.attrVal.length > 1000000)) {
            return "ERR_ATTRIBUTE_VALUE_TOO_LARGE";
        }
        if ((mutation.triviaLead !== undefined && (typeof mutation.triviaLead !== "string" || mutation.triviaLead.length > 1000000)) ||
            (mutation.triviaTrail !== undefined && (typeof mutation.triviaTrail !== "string" || mutation.triviaTrail.length > 1000000))) {
            return "ERR_TRIVIA_TOO_LARGE";
        }
        const targetToCheck = (mutation.kind === "INSERT" && mutation.parentId)
            ? mutation.parentId
            : mutation.nodeId;
        if (this.isSubtreeLocked(targetToCheck, callerPublicKey)) {
            return "ERR_SUBTREE_LOCKED_BY_HUMAN";
        }
        if (mutation.kind === "MOVE" && mutation.parentId && this.isSubtreeLocked(mutation.parentId, callerPublicKey)) {
            return "ERR_DESTINATION_SUBTREE_LOCKED";
        }
        if (mutation.kind === "MOVE" && mutation.parentId) {
            if (this.isDescendant(mutation.parentId, mutation.nodeId)) {
                return "ERR_CYCLE_DETECTED";
            }
        }
        if (["UPDATE", "DELETE", "MOVE"].includes(mutation.kind)) {
            const exists = [...this.sql.exec("SELECT 1 AS found FROM ast_nodes WHERE node_id = ?1 AND is_alive = 1 LIMIT 1;", mutation.nodeId)].length > 0;
            if (!exists)
                return "ERR_NODE_NOT_FOUND";
        }
        if (mutation.kind === "INSERT") {
            const nodeIdWasUsed = [...this.sql.exec("SELECT 1 AS found FROM ast_nodes WHERE node_id = ?1 LIMIT 1;", mutation.nodeId)].length > 0;
            if (nodeIdWasUsed)
                return "ERR_NODE_ID_ALREADY_USED";
        }
        if (["INSERT", "MOVE"].includes(mutation.kind) && mutation.parentId) {
            const parentExists = [...this.sql.exec("SELECT 1 AS found FROM ast_nodes WHERE node_id = ?1 AND is_alive = 1 LIMIT 1;", mutation.parentId)].length > 0;
            if (!parentExists)
                return "ERR_PARENT_NOT_FOUND";
        }
        if (["UPDATE", "DELETE", "MOVE"].includes(mutation.kind) && mutation.nodeId === "root")
            return "ERR_ROOT_NODE_IMMUTABLE";
        if (this.serverClock > Number.MAX_SAFE_INTEGER - 1002)
            return "ERR_SERVER_CLOCK_EXHAUSTED";
        const clampedCounter = Math.min(mutation.lamport.counter, this.serverClock + 1000);
        const nextServerClock = Math.max(this.serverClock, clampedCounter) + 1;
        mutation.lamport = { counter: nextServerClock, agentId: callerPublicKey };
        this.serverClock = nextServerClock;
        delete mutation.alphaHash;
        return null;
    }
    private validateQueuedMutation(mutation: ASTMutationPayload): string | null {
        const caller = mutation.lamport.agentId;
        const targetToCheck = mutation.kind === "INSERT" && mutation.parentId ? mutation.parentId : mutation.nodeId;
        if (this.isSubtreeLocked(targetToCheck, caller))
            return "ERR_SUBTREE_LOCKED_BY_HUMAN";
        if (mutation.kind === "MOVE" && mutation.parentId && this.isSubtreeLocked(mutation.parentId, caller))
            return "ERR_DESTINATION_SUBTREE_LOCKED";
        if (["UPDATE", "DELETE", "MOVE"].includes(mutation.kind)) {
            const exists = [...this.sql.exec("SELECT 1 AS found FROM ast_nodes WHERE node_id = ?1 AND is_alive = 1 LIMIT 1;", mutation.nodeId)].length > 0;
            if (!exists)
                return "ERR_NODE_NOT_FOUND";
        }
        if (mutation.kind === "INSERT") {
            const nodeIdWasUsed = [...this.sql.exec("SELECT 1 AS found FROM ast_nodes WHERE node_id = ?1 LIMIT 1;", mutation.nodeId)].length > 0;
            if (nodeIdWasUsed)
                return "ERR_NODE_ID_ALREADY_USED";
        }
        if (["INSERT", "MOVE"].includes(mutation.kind) && mutation.parentId) {
            const parentExists = [...this.sql.exec("SELECT 1 AS found FROM ast_nodes WHERE node_id = ?1 AND is_alive = 1 LIMIT 1;", mutation.parentId)].length > 0;
            if (!parentExists)
                return "ERR_PARENT_NOT_FOUND";
        }
        if (["UPDATE", "DELETE", "MOVE"].includes(mutation.kind) && mutation.nodeId === "root")
            return "ERR_ROOT_NODE_IMMUTABLE";
        if (mutation.kind === "DELETE") {
            const children = [...this.sql.exec("SELECT 1 AS found FROM ast_nodes WHERE parent_id = ?1 AND is_alive = 1 LIMIT 1;", mutation.nodeId)];
            if (children.length)
                return "ERR_NODE_HAS_ACTIVE_CHILDREN";
        }
        if (mutation.kind === "MOVE" && mutation.parentId && this.isDescendant(mutation.parentId, mutation.nodeId)) {
            return "ERR_CYCLE_DETECTED";
        }
        return null;
    }
    private isSubtreeLocked(nodeId: string, callerPublicKey: string): boolean {
        const now = Date.now();
        const cursor = this.sql.exec(`
      WITH RECURSIVE ancestor_chain AS (
        SELECT node_id, parent_id FROM ast_nodes WHERE node_id = ?1
        UNION
        SELECT n.node_id, n.parent_id 
        FROM ast_nodes n
        JOIN ancestor_chain ac ON n.node_id = ac.parent_id
      )
      SELECT l.lock_id, l.owner_identity
      FROM ast_subtree_locks l
      JOIN ancestor_chain a ON l.subtree_root_id = a.node_id
      WHERE l.lease_expires_at > ?2;
    `, nodeId, now);
        const activeLocks = [...cursor];
        if (activeLocks.length === 0)
            return false;
        return activeLocks.some(l => l.owner_identity !== callerPublicKey);
    }
    private broadcastMutation(mutation: ASTMutationPayload): void {
        const message = JSON.stringify(mutation);
        const subscribers = this.ctx.getWebSockets(`sub:${mutation.parentId || "root"}`);
        for (const target of subscribers) {
            try {
                target.send(message);
            }
            catch { }
        }
    }
    private isDescendant(potentialDescendant: string, rootId: string): boolean {
        if (potentialDescendant === rootId)
            return true;
        const cursor = this.sql.exec(`
      WITH RECURSIVE ancestor_chain AS (
        SELECT node_id, parent_id FROM ast_nodes WHERE node_id = ?1
        UNION
        SELECT n.node_id, n.parent_id 
        FROM ast_nodes n
        JOIN ancestor_chain ac ON n.node_id = ac.parent_id
      )
      SELECT 1 FROM ancestor_chain WHERE node_id = ?2;
    `, potentialDescendant, rootId);
        const result = [...cursor][0];
        return result !== null && result !== undefined;
    }
    private async verifyLedgerChainIntegrity(): Promise<boolean> {
        let currentRoot = "0000000000000000000000000000000000000000000000000000000000000000";
        let lastSequence = 0;
        const archives = [...this.sql.exec(`
      SELECT r2_object_key, payload_sha256, first_ledger_sequence, last_ledger_sequence,
             first_parent_root, last_root
      FROM ast_archive_index
      ORDER BY first_ledger_sequence ASC;
    `)];
        for (const archive of archives) {
            const firstSequence = Number(archive.first_ledger_sequence);
            const finalSequence = Number(archive.last_ledger_sequence);
            const object = await this.env.ARCHIVE_BUCKET?.get(String(archive.r2_object_key));
            if (!object)
                return false;
            const bytes = new Uint8Array(await object.arrayBuffer());
            const digest = await sha256Hex(bytes);
            if (digest !== archive.payload_sha256 || digest !== object.customMetadata?.payloadSha256)
                return false;
            let payload: {
                merkleRows?: Array<Record<string, unknown>>;
            };
            try {
                payload = JSON.parse(new TextDecoder().decode(bytes));
            }
            catch {
                return false;
            }
            const entries = (payload.merkleRows || []).sort((a, b) => Number(a.sequence_id) - Number(b.sequence_id));
            if (entries.length === 0) {
                if (firstSequence !== 0 || finalSequence !== 0 || archive.first_parent_root !== currentRoot || archive.last_root !== currentRoot)
                    return false;
                continue;
            }
            if (firstSequence !== lastSequence + 1 || archive.first_parent_root !== currentRoot)
                return false;
            if (entries.length !== finalSequence - firstSequence + 1)
                return false;
            for (const row of entries) {
                if (Number(row.sequence_id) !== lastSequence + 1 || row.parent_root !== currentRoot)
                    return false;
                const expected = this.batcher.computeNextMerkleRoot(currentRoot, String(row.mutation_hash), String(row.signer_public_key), Number(row.lamport_counter));
                if (row.new_root !== expected)
                    return false;
                currentRoot = expected;
                lastSequence = Number(row.sequence_id);
            }
            if (currentRoot !== archive.last_root)
                return false;
        }
        const cursor = this.sql.exec(`
      SELECT sequence_id, mutation_hash, parent_root, new_root, lamport_counter, signer_public_key
      FROM crdt_merkle_ledger
      ORDER BY sequence_id ASC;
    `);
        for (const row of cursor) {
            if (Number(row.sequence_id) !== lastSequence + 1 || (row.parent_root as string) !== currentRoot) {
                return false;
            }
            const expectedNewRoot = this.batcher.computeNextMerkleRoot(currentRoot, row.mutation_hash as string, row.signer_public_key as string, row.lamport_counter as number);
            if ((row.new_root as string) !== expectedNewRoot) {
                return false;
            }
            currentRoot = expectedNewRoot;
            lastSequence = Number(row.sequence_id);
        }
        return true;
    }
    private synthesizeCSTStream(rootNodeId: string): ReadableStream<Uint8Array> {
        const sql = this.sql;
        const encoder = new TextEncoder();
        return new ReadableStream<Uint8Array>({
            start(controller) {
                const rows = sql.exec(`
          WITH RECURSIVE tree_traversal AS (
            SELECT node_id, parent_id, pos_fractional, grammar_type, 0 as depth, pos_fractional as sort_path, '|' || node_id || '|' as id_path
            FROM ast_nodes
            WHERE node_id = ?1 AND is_alive = 1
            UNION ALL
            SELECT child.node_id, child.parent_id, child.pos_fractional, child.grammar_type, tt.depth + 1, tt.sort_path || '/' || child.pos_fractional, tt.id_path || child.node_id || '|'
            FROM ast_nodes child
            JOIN tree_traversal tt ON child.parent_id = tt.node_id
            WHERE child.is_alive = 1 AND tt.depth < 512 AND instr(tt.id_path, '|' || child.node_id || '|') = 0
          )
          SELECT 
            t.node_id,
            a_lead.attr_val as lead_trivia,
            a_tok.attr_val as token_val,
            a_trail.attr_val as trail_trivia
          FROM tree_traversal t
          LEFT JOIN ast_attributes a_lead ON t.node_id = a_lead.node_id AND a_lead.attr_key = '__trivia_lead'
          LEFT JOIN ast_attributes a_tok ON t.node_id = a_tok.node_id AND a_tok.attr_key = 'token'
          LEFT JOIN ast_attributes a_trail ON t.node_id = a_trail.node_id AND a_trail.attr_key = '__trivia_trail'
          ORDER BY t.sort_path ASC;
        `, rootNodeId);
                for (const row of rows) {
                    if (row.lead_trivia)
                        controller.enqueue(encoder.encode(row.lead_trivia as string));
                    if (row.token_val)
                        controller.enqueue(encoder.encode(row.token_val as string));
                    if (row.trail_trivia)
                        controller.enqueue(encoder.encode(row.trail_trivia as string));
                }
                controller.close();
            }
        });
    }
}
async function sha256Hex(bytes: Uint8Array): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
