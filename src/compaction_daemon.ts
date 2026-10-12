import { Env } from "./types";
export interface CompactionReport {
    purgedNodes: number;
    archivedMutations: number;
    archivedLedgerEntries: number;
    reclaimedPages: number;
    r2ObjectKey: string | null;
    safeLamportHorizon: number;
}
interface ArchiveRow {
    sequence_id: number;
    lamport_counter: number;
    mutation_json?: string;
    mutation_hash?: string;
    parent_root?: string;
    new_root?: string;
    signer_public_key?: string;
}
export class StateCompactionAlarmDaemon {
    private readonly retentionWindowMs = 24 * 60 * 60 * 1000;
    private readonly batchLimit = 1000;
    private readonly maxArchiveSectionBytes = 2 * 1024 * 1024;
    private readonly vacuumPages = 500;
    constructor(private readonly sql: SqlStorage, private readonly env: Env, private readonly shardId: string, private readonly transaction: (operation: () => void) => void = operation => operation()) { }
    public async runCompactionCycle(): Promise<CompactionReport> {
        const now = Date.now();
        const defaultReport = (safeLamportHorizon: number): CompactionReport => ({
            purgedNodes: 0,
            archivedMutations: 0,
            archivedLedgerEntries: 0,
            reclaimedPages: 0,
            r2ObjectKey: null,
            safeLamportHorizon
        });
        if (!this.env.ARCHIVE_BUCKET)
            return defaultReport(0);
        const cutoff = new Date(now - this.retentionWindowMs).toISOString().slice(0, 19).replace("T", " ");
        const oldLedgerRows = [...this.sql.exec("SELECT MAX(lamport_counter) AS safe_lamport FROM crdt_merkle_ledger WHERE committed_at <= ?1;", cutoff)];
        const archivedHorizonRows = [...this.sql.exec("SELECT MAX(max_lamport) AS max_lamport FROM ast_archive_index;")];
        const safeLamport = Math.max(Number(oldLedgerRows[0]?.safe_lamport || 0), Number(archivedHorizonRows[0]?.max_lamport || 0));
        if (safeLamport <= 0)
            return defaultReport(safeLamport);
        const nodes = [...this.sql.exec("WITH candidates AS (" +
                "SELECT n.node_id, n.parent_id, n.grammar_type, n.pos_fractional, n.birth_lamport, n.death_lamport, " +
                "COALESCE(SUM(length(COALESCE(a.attr_val, '')) + length(COALESCE(a.attr_key, ''))), 0) + " +
                "length(n.node_id) + length(n.grammar_type) + length(n.pos_fractional) + 128 AS estimated_bytes " +
                "FROM ast_nodes n LEFT JOIN ast_attributes a ON a.node_id = n.node_id " +
                "WHERE n.is_alive = 0 AND n.death_lamport IS NOT NULL AND n.death_lamport <= ?1 " +
                "GROUP BY n.node_id" +
                "), eligible AS (SELECT * FROM candidates WHERE estimated_bytes <= ?2), " +
                "bounded AS (SELECT *, SUM(estimated_bytes) OVER (ORDER BY node_id ROWS UNBOUNDED PRECEDING) AS cumulative_bytes FROM eligible) " +
                "SELECT node_id, parent_id, grammar_type, pos_fractional, birth_lamport, death_lamport FROM bounded WHERE cumulative_bytes <= ?2 LIMIT ?3;", safeLamport, this.maxArchiveSectionBytes, this.batchLimit)];
        const mutations = [...this.sql.exec("WITH bounded AS (SELECT sequence_id, lamport_counter, mutation_json, " +
                "SUM(length(mutation_json) + 96) OVER (ORDER BY sequence_id ROWS UNBOUNDED PRECEDING) AS cumulative_bytes " +
                "FROM ast_mutation_log WHERE lamport_counter <= ?1) " +
                "SELECT sequence_id, lamport_counter, mutation_json FROM bounded WHERE cumulative_bytes <= ?2 ORDER BY sequence_id ASC LIMIT ?3;", safeLamport, this.maxArchiveSectionBytes, this.batchLimit)] as unknown as ArchiveRow[];
        const ledgerRows = [...this.sql.exec("SELECT sequence_id, lamport_counter, mutation_hash, parent_root, new_root, signer_public_key FROM crdt_merkle_ledger WHERE lamport_counter <= ?1 ORDER BY sequence_id ASC LIMIT ?2;", safeLamport, this.batchLimit)] as unknown as ArchiveRow[];
        if (nodes.length === 0 && mutations.length === 0 && ledgerRows.length === 0)
            return defaultReport(safeLamport);
        if (mutations.length > 0 && ledgerRows.length === 0) {
            throw new Error("Cannot archive mutation history without its matching Merkle ledger entries.");
        }
        const nodeIds = nodes.map(row => String(row.node_id));
        const attributes = nodeIds.length
            ? [...this.sql.exec("SELECT node_id, attr_key, attr_val, lamport_counter, agent_id FROM ast_attributes WHERE node_id IN (" +
                    nodeIds.map(() => "?").join(",") + ");", ...nodeIds)]
            : [];
        const zeroRoot = "0".repeat(64);
        const priorRootRows = [...this.sql.exec("SELECT root FROM (" +
                "SELECT sequence_id, new_root AS root FROM crdt_merkle_ledger " +
                "UNION ALL SELECT last_ledger_sequence AS sequence_id, last_root AS root FROM ast_archive_index WHERE last_ledger_sequence > 0" +
                ") ORDER BY sequence_id DESC LIMIT 1;")];
        const firstParentRoot = ledgerRows.length ? String(ledgerRows[0].parent_root) : String(priorRootRows[0]?.root || zeroRoot);
        const lastRoot = ledgerRows.length ? String(ledgerRows[ledgerRows.length - 1].new_root) : firstParentRoot;
        const clocks = [...mutations, ...ledgerRows].map(row => Number(row.lamport_counter));
        const minLamport = clocks.length ? Math.min(...clocks) : safeLamport;
        const maxLamport = clocks.length ? Math.max(...clocks) : safeLamport;
        const firstMutationSequence = mutations.length ? Number(mutations[0].sequence_id) : 0;
        const lastMutationSequence = mutations.length ? Number(mutations[mutations.length - 1].sequence_id) : 0;
        const firstLedgerSequence = ledgerRows.length ? Number(ledgerRows[0].sequence_id) : 0;
        const lastLedgerSequence = ledgerRows.length ? Number(ledgerRows[ledgerRows.length - 1].sequence_id) : 0;
        const payload = new TextEncoder().encode(JSON.stringify({
            schema: "AETHER-ARCHIVE-v2",
            shardId: this.shardId,
            timestamp: now,
            mutations,
            merkleRows: ledgerRows,
            nodes,
            attributes
        }));
        const payloadSha256 = await sha256Hex(payload);
        const r2ObjectKey = "historical-archives/" + this.shardId + "/" + now + "-" + crypto.randomUUID() + ".json";
        await this.env.ARCHIVE_BUCKET.put(r2ObjectKey, payload, {
            customMetadata: {
                schema: "AETHER-ARCHIVE-v2",
                shardId: this.shardId,
                payloadSha256,
                minLamport: String(minLamport),
                maxLamport: String(maxLamport),
                firstLedgerSequence: String(firstLedgerSequence),
                lastLedgerSequence: String(lastLedgerSequence),
                timestamp: String(now)
            }
        });
        this.transaction(() => {
            if (mutations.length || ledgerRows.length) {
                this.sql.exec("INSERT INTO ast_archive_index (r2_object_key, payload_sha256, first_mutation_sequence, last_mutation_sequence, first_ledger_sequence, last_ledger_sequence, min_lamport, max_lamport, first_parent_root, last_root, archived_at) " +
                    "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11);", r2ObjectKey, payloadSha256, firstMutationSequence, lastMutationSequence, firstLedgerSequence, lastLedgerSequence, minLamport, maxLamport, firstParentRoot, lastRoot, now);
            }
            for (const row of nodes)
                this.sql.exec("DELETE FROM ast_nodes WHERE node_id = ?1;", row.node_id);
            this.sql.exec("DELETE FROM ast_attributes WHERE node_id NOT IN (SELECT node_id FROM ast_nodes);");
            if (lastMutationSequence)
                this.sql.exec("DELETE FROM ast_mutation_log WHERE sequence_id <= ?1;", lastMutationSequence);
            if (lastLedgerSequence)
                this.sql.exec("DELETE FROM crdt_merkle_ledger WHERE sequence_id <= ?1;", lastLedgerSequence);
        });
        let reclaimedPages = 0;
        try {
            const beforeRows = [...this.sql.exec("PRAGMA freelist_count;")];
            this.sql.exec("PRAGMA incremental_vacuum(" + this.vacuumPages + ");");
            const afterRows = [...this.sql.exec("PRAGMA freelist_count;")];
            reclaimedPages = Math.max(0, Number(beforeRows[0]?.freelist_count || 0) - Number(afterRows[0]?.freelist_count || 0));
        }
        catch {
        }
        return {
            purgedNodes: nodes.length,
            archivedMutations: mutations.length,
            archivedLedgerEntries: ledgerRows.length,
            reclaimedPages,
            r2ObjectKey,
            safeLamportHorizon: safeLamport
        };
    }
}
async function sha256Hex(bytes: Uint8Array): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
