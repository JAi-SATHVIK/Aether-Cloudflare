import { Env } from "./types";
import { SymbolDependencyGraph } from "./symbol_graph";
import { VerificationGate } from "./verification_gate";
export interface SymbolDiffItem {
    symbolName: string;
    changeType: "ADDED" | "MODIFIED" | "REMOVED";
    filePath?: string;
    details: string;
}
export interface VirtualPullRequest {
    title: string;
    summary: string;
    impactAnalysis: string;
    mutationsAnalyzed: number;
    syntheticDiff: string;
    symbolDiffs: SymbolDiffItem[];
    provenance: {
        signers: string[];
        earliestTimestamp: number;
        latestTimestamp: number;
        merkleRootStart: string;
        merkleRootEnd: string;
    };
    riskFlags: string[];
    testStatus: {
        executed: boolean;
        passed: boolean;
        output?: string;
    };
}
export class VirtualPullRequestEngine {
    private sql: SqlStorage;
    private env: Env;
    constructor(sql: SqlStorage, env: Env) {
        this.sql = sql;
        this.env = env;
    }
    public async generateVirtualPR(fromSequenceId: number, toSequenceId: number, testOutput?: {
        executed: boolean;
        passed: boolean;
        output?: string;
    }): Promise<VirtualPullRequest> {
        const cursor = this.sql.exec(`
      SELECT sequence_id, mutation_hash, parent_root, new_root, lamport_counter, signer_public_key, committed_at
      FROM crdt_merkle_ledger
      WHERE sequence_id BETWEEN ?1 AND ?2
      ORDER BY sequence_id ASC;
    `, fromSequenceId, toSequenceId);
        const mutations = [...cursor];
        if (mutations.length === 0) {
            return {
                title: "Empty Changeset",
                summary: "No mutations found in the specified sequence interval.",
                impactAnalysis: "None",
                mutationsAnalyzed: 0,
                syntheticDiff: "",
                symbolDiffs: [],
                provenance: {
                    signers: [],
                    earliestTimestamp: Date.now(),
                    latestTimestamp: Date.now(),
                    merkleRootStart: "",
                    merkleRootEnd: ""
                },
                riskFlags: [],
                testStatus: testOutput || { executed: false, passed: false }
            };
        }
        const signersSet = new Set<string>();
        for (const m of mutations) {
            if (m.signer_public_key) {
                signersSet.add(String(m.signer_public_key));
            }
        }
        const provenance = {
            signers: Array.from(signersSet),
            earliestTimestamp: Number(mutations[0].committed_at || Date.now()),
            latestTimestamp: Number(mutations[mutations.length - 1].committed_at || Date.now()),
            merkleRootStart: String(mutations[0].parent_root || ""),
            merkleRootEnd: String(mutations[mutations.length - 1].new_root || "")
        };
        const minClock = Number(mutations[0].lamport_counter || 0);
        const nodeCursor = this.sql.exec(`
      SELECT n.node_id, n.grammar_type, n.is_alive, a.attr_val as source_chunk
      FROM ast_nodes n
      LEFT JOIN ast_attributes a ON n.node_id = a.node_id AND a.attr_key = 'token'
      WHERE n.birth_lamport >= ?1 OR n.death_lamport >= ?1;
    `, minClock);
        const modifiedNodes = [...nodeCursor];
        const addedChunks: string[] = [];
        const removedChunks: string[] = [];
        for (const n of modifiedNodes) {
            const code = String(n.source_chunk || "").trim();
            if (!code)
                continue;
            if (n.is_alive === 1) {
                addedChunks.push(code);
            }
            else {
                removedChunks.push(code);
            }
        }
        const unifiedDiffLines: string[] = [];
        for (const rem of removedChunks.slice(0, 30)) {
            unifiedDiffLines.push(`- ${rem}`);
        }
        for (const add of addedChunks.slice(0, 30)) {
            unifiedDiffLines.push(`+ ${add}`);
        }
        const syntheticDiff = unifiedDiffLines.join("\n") || "No text attribute modifications in changeset.";
        const addedText = addedChunks.join("\n");
        const removedText = removedChunks.join("\n");
        const addedSymbols = SymbolDependencyGraph.extractSymbols(addedText, "module.ts");
        const removedSymbols = SymbolDependencyGraph.extractSymbols(removedText, "module.ts");
        const symbolDiffs: SymbolDiffItem[] = [];
        const removedMap = new Map(removedSymbols.definitions.map(d => [d.symbolName, d]));
        for (const def of addedSymbols.definitions) {
            if (removedMap.has(def.symbolName)) {
                const oldDef = removedMap.get(def.symbolName)!;
                symbolDiffs.push({
                    symbolName: def.symbolName,
                    changeType: "MODIFIED",
                    details: `Signature changed: (${oldDef.parameters.join(", ")}) -> (${def.parameters.join(", ")}) [arity ${oldDef.arity} -> ${def.arity}]`
                });
                removedMap.delete(def.symbolName);
            }
            else {
                symbolDiffs.push({
                    symbolName: def.symbolName,
                    changeType: "ADDED",
                    details: `New definition with arity ${def.arity} (${def.parameters.join(", ")})`
                });
            }
        }
        for (const [symName, oldDef] of removedMap) {
            symbolDiffs.push({
                symbolName: symName,
                changeType: "REMOVED",
                details: `Removed definition (was arity ${oldDef.arity})`
            });
        }
        const riskFlags: string[] = [];
        const authRegex = /\b(isAdmin|isAuthorized|hasPermission|authenticate|verifyToken|checkAccess)\b/;
        if (authRegex.test(removedText) && !authRegex.test(addedText)) {
            riskFlags.push("SECURITY: Authorization/permission guard was removed in this changeset.");
        }
        const execRegex = /\b(eval|exec|Function|child_process|subprocess)\b/;
        if (execRegex.test(addedText)) {
            riskFlags.push("CRITICAL_RISK: Dynamic execution (eval/exec/subprocess) introduced.");
        }
        for (const sd of symbolDiffs) {
            if (sd.changeType === "MODIFIED") {
                riskFlags.push(`SIGNATURE_CHANGE: Symbol '${sd.symbolName}' modified; call sites must be verified.`);
            }
        }
        const boundedDiff = syntheticDiff.slice(0, 1500);
        const testStatus = testOutput || { executed: false, passed: false, output: "Sandbox tests not attached." };
        try {
            const response = await this.env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
                messages: [
                    {
                        role: "system",
                        content: "You are the Lead Code Reviewer and Architect. Analyze this real code diff and synthesize an executive-ready Virtual Pull Request (VPR). Return STRICT JSON format: {\"title\": string, \"summary\": string, \"impactAnalysis\": string}."
                    },
                    {
                        role: "user",
                        content: `DIFF:\n${boundedDiff}\n\nSYMBOL CHANGES:\n${symbolDiffs.map(s => `${s.changeType}: ${s.symbolName} - ${s.details}`).join("\n")}\n\nRISK FLAGS:\n${riskFlags.join("\n") || "None"}\n\nTEST STATUS: ${testStatus.passed ? "PASSED" : "FAILED / UNVERIFIED"}`
                    }
                ],
                max_tokens: 300,
                temperature: 0.1
            }) as {
                response?: string;
                choices?: Array<{
                    message?: {
                        content?: string;
                    };
                }>;
            };
            const raw = response.response || response.choices?.[0]?.message?.content || "";
            const jsonMatch = raw.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                const parsed = JSON.parse(jsonMatch[0]);
                return {
                    title: parsed.title || `Swarm Refactor: ${mutations.length} AST Mutations`,
                    summary: parsed.summary || `Coordinated changes across ${modifiedNodes.length} AST nodes.`,
                    impactAnalysis: parsed.impactAnalysis || (riskFlags.length > 0 ? riskFlags.join("; ") : "No high-risk security regressions detected."),
                    mutationsAnalyzed: mutations.length,
                    syntheticDiff,
                    symbolDiffs,
                    provenance,
                    riskFlags,
                    testStatus
                };
            }
        }
        catch {
        }
        return {
            title: `Swarm Revision: ${mutations.length} AST Operations`,
            summary: `Consolidated ${mutations.length} mutations from ${provenance.signers.length} agent signers across ${modifiedNodes.length} AST nodes.`,
            impactAnalysis: riskFlags.length > 0
                ? `Advisory flags detected: ${riskFlags.join("; ")}`
                : "Automated analysis completed. Static verification checks passed.",
            mutationsAnalyzed: mutations.length,
            syntheticDiff,
            symbolDiffs,
            provenance,
            riskFlags,
            testStatus
        };
    }
}
