import { Env, ASTMutationPayload } from "./types";
export interface ReconstitutedNode {
    nodeId: string;
    parentId: string | null;
    grammarType: string;
    posFractional: string;
    attributes: Record<string, string>;
}
interface LoggedMutation {
    sequence_id: number;
    lamport_counter: number;
    mutation_json: string;
}
interface MutableNode extends ReconstitutedNode {
    birthLamport: number;
    birthAgent: string;
    deathLamport: number | null;
    alive: boolean;
    registers: Map<string, {
        value: string;
        counter: number;
        agent: string;
    }>;
}
export class ASTSnapshotInspector {
    private sql: SqlStorage;
    private env: Env;
    private shardId: string;
    constructor(sql: SqlStorage, env: Env, shardId: string) {
        this.sql = sql;
        this.env = env;
        this.shardId = shardId;
    }
    public async getStateAtLamportClock(targetClock: number): Promise<Map<string, ReconstitutedNode>> {
        if (!Number.isSafeInteger(targetClock) || targetClock < 0)
            throw new Error("targetClock must be a non-negative safe integer.");
        const archived = await this.readArchivedMutations(targetClock);
        let active: LoggedMutation[] = [];
        try {
            active = [...this.sql.exec("SELECT sequence_id, lamport_counter, mutation_json FROM ast_mutation_log WHERE lamport_counter <= ?1 ORDER BY sequence_id ASC;", targetClock)] as unknown as LoggedMutation[];
        }
        catch {
            throw new Error("Mutation history table is unavailable; a historical state cannot be proven.");
        }
        return this.replay([...archived, ...active], targetClock);
    }
    private async readArchivedMutations(targetClock: number): Promise<LoggedMutation[]> {
        const bucket = this.env.ARCHIVE_BUCKET;
        if (!bucket)
            return [];
        const result: LoggedMutation[] = [];
        let archives: Array<Record<string, unknown>>;
        try {
            archives = [...this.sql.exec("SELECT r2_object_key, payload_sha256, min_lamport FROM ast_archive_index WHERE min_lamport <= ?1 ORDER BY first_mutation_sequence ASC;", targetClock)] as Array<Record<string, unknown>>;
        }
        catch {
            return result;
        }
        for (const archive of archives) {
            const key = String(archive.r2_object_key);
            const archived = await bucket.get(key);
            if (!archived)
                throw new Error(`Required history archive is missing: ${key}`);
            const bytes = new Uint8Array(await archived.arrayBuffer());
            const digest = await sha256Hex(bytes);
            if (digest !== String(archive.payload_sha256) || digest !== archived.customMetadata?.payloadSha256) {
                throw new Error(`History archive checksum mismatch: ${key}`);
            }
            const data = JSON.parse(new TextDecoder().decode(bytes)) as {
                schema?: string;
                mutations?: LoggedMutation[];
            };
            if (data.schema !== "AETHER-ARCHIVE-v2" || !Array.isArray(data.mutations)) {
                throw new Error(`Unsupported or malformed history archive: ${key}`);
            }
            result.push(...data.mutations.filter(item => Number(item.lamport_counter) <= targetClock));
        }
        return result;
    }
    private replay(log: LoggedMutation[], targetClock: number): Map<string, ReconstitutedNode> {
        const nodes = new Map<string, MutableNode>();
        nodes.set("root", {
            nodeId: "root",
            parentId: null,
            grammarType: "MODULE_ROOT",
            posFractional: "000000",
            attributes: {},
            birthLamport: 0,
            birthAgent: "system",
            deathLamport: null,
            alive: true,
            registers: new Map()
        });
        log.sort((a, b) => Number(a.sequence_id) - Number(b.sequence_id));
        const writeRegister = (node: MutableNode, key: string, value: string, counter: number, agent: string) => {
            const current = node.registers.get(key);
            if (!current || counter > current.counter || (counter === current.counter && agent > current.agent)) {
                node.registers.set(key, { value, counter, agent });
            }
        };
        for (const entry of log) {
            if (Number(entry.lamport_counter) > targetClock)
                continue;
            let mutation: ASTMutationPayload;
            try {
                mutation = JSON.parse(entry.mutation_json) as ASTMutationPayload;
            }
            catch {
                throw new Error(`Invalid mutation JSON at history sequence ${entry.sequence_id}.`);
            }
            if (!mutation?.nodeId || !mutation.lamport || !Number.isSafeInteger(mutation.lamport.counter)) {
                throw new Error(`Invalid mutation record at history sequence ${entry.sequence_id}.`);
            }
            const counter = Number(mutation.lamport.counter);
            const agent = String(mutation.lamport.agentId || "");
            let node = nodes.get(mutation.nodeId);
            if (mutation.kind === "INSERT") {
                if (mutation.parentId && !nodes.get(mutation.parentId)?.alive) {
                    throw new Error(`Missing live parent at history sequence ${entry.sequence_id}.`);
                }
                if (!node) {
                    node = {
                        nodeId: mutation.nodeId,
                        parentId: mutation.parentId,
                        grammarType: mutation.grammarType,
                        posFractional: mutation.posFractional,
                        attributes: {},
                        birthLamport: counter,
                        birthAgent: agent,
                        deathLamport: null,
                        alive: true,
                        registers: new Map()
                    };
                    nodes.set(mutation.nodeId, node);
                }
                else if (counter > node.birthLamport || (counter === node.birthLamport && agent >= node.birthAgent)) {
                    node.alive = true;
                    node.deathLamport = null;
                    node.birthLamport = counter;
                    node.birthAgent = agent;
                }
                if (mutation.attrVal !== undefined)
                    writeRegister(node, "token", mutation.attrVal, counter, agent);
                if (mutation.triviaLead)
                    writeRegister(node, "__trivia_lead", mutation.triviaLead, counter, agent);
                if (mutation.triviaTrail)
                    writeRegister(node, "__trivia_trail", mutation.triviaTrail, counter, agent);
                if (mutation.alphaHash)
                    writeRegister(node, "__alpha_hash", mutation.alphaHash, counter, agent);
            }
            else if (mutation.kind === "UPDATE") {
                if (!node?.alive || mutation.attrVal === undefined)
                    throw new Error(`Invalid update at history sequence ${entry.sequence_id}.`);
                writeRegister(node, mutation.attrKey || "token", mutation.attrVal, counter, agent);
            }
            else if (mutation.kind === "DELETE") {
                if (!node?.alive || mutation.nodeId === "root")
                    throw new Error(`Invalid delete at history sequence ${entry.sequence_id}.`);
                if ([...nodes.values()].some(child => child.alive && child.parentId === mutation.nodeId)) {
                    throw new Error(`Delete would orphan active children at history sequence ${entry.sequence_id}.`);
                }
                node.alive = false;
                node.deathLamport = node.deathLamport === null ? counter : Math.max(node.deathLamport, counter);
            }
            else if (mutation.kind === "MOVE") {
                if (!node?.alive || mutation.nodeId === "root" || (mutation.parentId && !nodes.get(mutation.parentId)?.alive)) {
                    throw new Error(`Invalid move at history sequence ${entry.sequence_id}.`);
                }
                let ancestor = mutation.parentId ? nodes.get(mutation.parentId) : undefined;
                while (ancestor) {
                    if (ancestor.nodeId === mutation.nodeId)
                        throw new Error(`Cycle in history at sequence ${entry.sequence_id}.`);
                    ancestor = ancestor.parentId ? nodes.get(ancestor.parentId) : undefined;
                }
                node.parentId = mutation.parentId;
                node.posFractional = mutation.posFractional;
            }
            else {
                throw new Error(`Unsupported mutation at history sequence ${entry.sequence_id}.`);
            }
        }
        const state = new Map<string, ReconstitutedNode>();
        for (const [id, node] of nodes) {
            if (!node.alive || node.birthLamport > targetClock || (node.deathLamport !== null && node.deathLamport <= targetClock))
                continue;
            const attributes: Record<string, string> = {};
            for (const [key, register] of node.registers)
                attributes[key] = register.value;
            state.set(id, {
                nodeId: id,
                parentId: node.parentId,
                grammarType: node.grammarType,
                posFractional: node.posFractional,
                attributes
            });
        }
        return state;
    }
}
export const PhylogeneticTimeTravelEngine = ASTSnapshotInspector;
async function sha256Hex(bytes: Uint8Array): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
