import { ASTMutationPayload } from "./types";
import { createHash } from "node:crypto";
export interface BatchItem {
    payload: ASTMutationPayload;
    estimatedBytes: number;
    resolve: () => void;
    reject: (err: Error) => void;
}
export class TransactionBatcher {
    private queue: BatchItem[] = [];
    private queuedBytes = 0;
    private flushTimer: number | null = null;
    private readonly maxBatchSize = 256;
    private readonly maxBatchBytes = 4 * 1024 * 1024;
    private readonly maxLatencyMs = 10;
    private sql: SqlStorage;
    private transaction: (operation: () => void) => void;
    private validate?: (payload: ASTMutationPayload) => string | null;
    private rollingMerkleRoot: string = "0000000000000000000000000000000000000000000000000000000000000000";
    constructor(sql: SqlStorage, transaction?: (operation: () => void) => void, validate?: (payload: ASTMutationPayload) => string | null) {
        this.sql = sql;
        this.transaction = transaction || (operation => operation());
        this.validate = validate;
        this.initLedgerRoot();
    }
    private initLedgerRoot(): void {
        try {
            const cursor = this.sql.exec(`
        SELECT root AS new_root FROM (
          SELECT sequence_id, new_root AS root FROM crdt_merkle_ledger
          UNION ALL
          SELECT last_ledger_sequence AS sequence_id, last_root AS root FROM ast_archive_index
          WHERE last_ledger_sequence > 0
        ) ORDER BY sequence_id DESC LIMIT 1;
      `);
            const latest = [...cursor][0];
            if (latest && latest.new_root) {
                this.rollingMerkleRoot = latest.new_root as string;
            }
        }
        catch {
        }
    }
    public schedule(payload: ASTMutationPayload): Promise<void> {
        return new Promise((resolve, reject) => {
            const estimatedBytes = (JSON.stringify(payload)?.length || 0) * 3;
            if (estimatedBytes > this.maxBatchBytes) {
                reject(new Error("ERR_MUTATION_TOO_LARGE_FOR_BATCH"));
                return;
            }
            if (this.queue.length && this.queuedBytes + estimatedBytes > this.maxBatchBytes)
                this.flushImmediate();
            this.queue.push({ payload, estimatedBytes, resolve, reject });
            this.queuedBytes += estimatedBytes;
            if (this.queue.length >= this.maxBatchSize || this.queuedBytes >= this.maxBatchBytes) {
                this.flushImmediate();
            }
            else if (this.flushTimer === null) {
                this.flushTimer = setTimeout(() => this.flushImmediate(), this.maxLatencyMs) as unknown as number;
            }
        });
    }
    public flushImmediate(): void {
        if (this.flushTimer !== null) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        if (this.queue.length === 0)
            return;
        const currentBatch = this.queue;
        this.queue = [];
        this.queuedBytes = 0;
        const previousRoot = this.rollingMerkleRoot;
        const itemErrors = new Map<BatchItem, Error>();
        try {
            this.transaction(() => {
                for (const item of currentBatch) {
                    const validationError = this.validate?.(item.payload);
                    if (validationError) {
                        itemErrors.set(item, new Error(validationError));
                        continue;
                    }
                    this.applySingleMutation(item.payload);
                }
            });
            currentBatch.forEach(item => itemErrors.has(item) ? item.reject(itemErrors.get(item)!) : item.resolve());
        }
        catch (err) {
            this.rollingMerkleRoot = previousRoot;
            currentBatch.forEach(item => item.reject(err as Error));
        }
    }
    private applySingleMutation(m: ASTMutationPayload): void {
        switch (m.kind) {
            case "INSERT": {
                this.sql.exec(`
          INSERT INTO ast_nodes (node_id, parent_id, grammar_type, pos_fractional, is_alive, birth_lamport, birth_agent)
          VALUES (?1, ?2, ?3, ?4, 1, ?5, ?6)
          ON CONFLICT(node_id) DO UPDATE SET
            is_alive = 1,
            death_lamport = NULL,
            death_agent = NULL
          WHERE excluded.birth_lamport >= ast_nodes.birth_lamport;
        `, m.nodeId, m.parentId, m.grammarType, m.posFractional, m.lamport.counter, m.lamport.agentId);
                if (m.attrVal !== undefined) {
                    this.insertAttribute(m.nodeId, "token", m.attrVal, m.lamport.counter, m.lamport.agentId);
                }
                if (m.triviaLead) {
                    this.insertAttribute(m.nodeId, "__trivia_lead", m.triviaLead, m.lamport.counter, m.lamport.agentId);
                }
                if (m.triviaTrail) {
                    this.insertAttribute(m.nodeId, "__trivia_trail", m.triviaTrail, m.lamport.counter, m.lamport.agentId);
                }
                if (m.alphaHash) {
                    this.insertAttribute(m.nodeId, "__alpha_hash", m.alphaHash, m.lamport.counter, m.lamport.agentId);
                }
                break;
            }
            case "UPDATE": {
                const key = m.attrKey || "token";
                if (m.attrVal !== undefined) {
                    this.insertAttribute(m.nodeId, key, m.attrVal, m.lamport.counter, m.lamport.agentId);
                }
                break;
            }
            case "DELETE": {
                this.sql.exec(`
          UPDATE ast_nodes 
          SET is_alive = 0,
              death_lamport = CASE 
                WHEN death_lamport IS NULL THEN ?2 
                ELSE MAX(death_lamport, ?2) 
              END,
              death_agent = ?3
          WHERE node_id = ?1;
        `, m.nodeId, m.lamport.counter, m.lamport.agentId);
                break;
            }
            case "MOVE": {
                this.sql.exec(`
          UPDATE ast_nodes 
          SET parent_id = ?1, pos_fractional = ?2 
          WHERE node_id = ?3 AND is_alive = 1;
        `, m.parentId, m.posFractional, m.nodeId);
                this.sql.exec(`
          INSERT INTO ast_move_history (node_id, new_parent_id, pos_fractional, lamport_counter, agent_id)
          VALUES (?1, ?2, ?3, ?4, ?5);
        `, m.nodeId, m.parentId, m.posFractional, m.lamport.counter, m.lamport.agentId);
                break;
            }
        }
        const mutationHash = createHash("sha256").update(canonicalJson(m), "utf8").digest("hex");
        const nextRoot = this.computeNextMerkleRoot(this.rollingMerkleRoot, mutationHash, m.lamport.agentId, m.lamport.counter);
        this.sql.exec(`
      INSERT INTO crdt_merkle_ledger (mutation_hash, parent_root, new_root, lamport_counter, signer_public_key)
      VALUES (?1, ?2, ?3, ?4, ?5);
    `, mutationHash, this.rollingMerkleRoot, nextRoot, m.lamport.counter, m.lamport.agentId);
        this.sql.exec(`
      INSERT INTO ast_mutation_log (lamport_counter, agent_id, mutation_hash, mutation_json)
      VALUES (?1, ?2, ?3, ?4);
    `, m.lamport.counter, m.lamport.agentId, mutationHash, canonicalJson(m));
        this.rollingMerkleRoot = nextRoot;
    }
    private insertAttribute(nodeId: string, key: string, val: string, counter: number, agentId: string): void {
        this.sql.exec(`
      INSERT INTO ast_attributes (node_id, attr_key, attr_val, lamport_counter, agent_id)
      VALUES (?1, ?2, ?3, ?4, ?5)
      ON CONFLICT(node_id, attr_key) DO UPDATE SET
        attr_val = excluded.attr_val,
        lamport_counter = excluded.lamport_counter,
        agent_id = excluded.agent_id
      WHERE excluded.lamport_counter > ast_attributes.lamport_counter 
         OR (excluded.lamport_counter = ast_attributes.lamport_counter AND excluded.agent_id > ast_attributes.agent_id);
    `, nodeId, key, val, counter, agentId);
    }
    public computeNextMerkleRoot(parentRoot: string, mutationHash: string, agentId: string, counter: number): string {
        return createHash("sha256")
            .update(`${parentRoot}:${mutationHash}:${agentId}:${counter}`, "utf8")
            .digest("hex");
    }
}
function canonicalJson(value: unknown): string {
    if (Array.isArray(value))
        return `[${value.map(canonicalJson).join(",")}]`;
    if (value && typeof value === "object") {
        const record = value as Record<string, unknown>;
        return `{${Object.keys(record).sort().filter(key => record[key] !== undefined)
            .map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
    }
    return JSON.stringify(value) ?? "null";
}
