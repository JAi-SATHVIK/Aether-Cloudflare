import { Env, ArbitrationAuditEvent } from "./types";
import { SemanticCircuitBreaker, CircuitState } from "./firewall_circuit_breaker";
import { VerificationGate } from "./verification_gate";
export interface CandidateVariant {
    candidateId: string;
    targetParentId: string;
    intentSpec: string;
    syntaxSExpr: string;
    rawSource: string;
    agentId: string;
}
export interface ArbitrationResult {
    winnerCandidateId: string | null;
    status: "ADMITTED" | "FLAGGED_HUMAN_REVIEW" | "REJECTED_STATIC_INVARIANTS";
    mode: "STATIC_FILTER" | "ADVISORY_LLM" | "BASELINE_PRESERVED_FLAGGED_REVIEW";
    rationale: string;
}
export class SemanticConflictArbiter {
    private sql: SqlStorage;
    private env: Env;
    private circuitBreaker: SemanticCircuitBreaker;
    private verificationGate: VerificationGate;
    constructor(sql: SqlStorage, env: Env) {
        this.sql = sql;
        this.env = env;
        this.circuitBreaker = new SemanticCircuitBreaker();
        this.verificationGate = new VerificationGate();
    }
    public async arbitrateSuperpositionPool(): Promise<ArbitrationResult | null> {
        const candidates = this.fetchPendingCandidates();
        if (candidates.length === 0)
            return null;
        const targetParentId = candidates[0].targetParentId;
        const intent = candidates[0].intentSpec;
        const viableVariants: CandidateVariant[] = [];
        for (const variant of candidates) {
            const vResult = this.verificationGate.verifyCandidate(variant.rawSource, "tsx");
            if (vResult.passed) {
                viableVariants.push(variant);
            }
        }
        if (viableVariants.length === 0) {
            this.recordArbitrationDecision({
                decisionId: crypto.randomUUID(),
                targetParentId,
                intent,
                winnerCandidateId: null,
                status: "REJECTED_STATIC_INVARIANTS",
                rationale: "All candidate variants violated static invariants or syntax checks.",
                staticAnalysisPass: false,
                typeCheckPass: false,
                advisoryLlmEvaluated: false,
                timestamp: Date.now()
            });
            this.purgeSuperpositionPool(targetParentId);
            return {
                winnerCandidateId: null,
                status: "REJECTED_STATIC_INVARIANTS",
                mode: "STATIC_FILTER",
                rationale: "All candidates rejected by static verification gate."
            };
        }
        if (viableVariants.length === 1) {
            const winner = viableVariants[0];
            this.commitWinningVariant(winner);
            this.recordArbitrationDecision({
                decisionId: crypto.randomUUID(),
                targetParentId,
                intent,
                winnerCandidateId: winner.candidateId,
                status: "ADMITTED",
                rationale: "Single variant passed all static verification checks.",
                staticAnalysisPass: true,
                typeCheckPass: true,
                advisoryLlmEvaluated: false,
                timestamp: Date.now()
            });
            return {
                winnerCandidateId: winner.candidateId,
                status: "ADMITTED",
                mode: "STATIC_FILTER",
                rationale: "Only one candidate survived static verification."
            };
        }
        const currentState = this.circuitBreaker.getState();
        if (currentState === CircuitState.OPEN) {
            return this.handleFallbackReview(viableVariants, targetParentId, intent, "Circuit breaker OPEN: AI unavailable");
        }
        const startTime = performance.now();
        try {
            const winner = await this.evaluateViaAdvisoryLLM(intent, viableVariants);
            const elapsed = performance.now() - startTime;
            this.circuitBreaker.recordSuccess(elapsed);
            this.commitWinningVariant(winner);
            this.recordArbitrationDecision({
                decisionId: crypto.randomUUID(),
                targetParentId,
                intent,
                winnerCandidateId: winner.candidateId,
                status: "ADMITTED",
                rationale: "Advisory LLM selected optimal variant satisfying intent.",
                staticAnalysisPass: true,
                typeCheckPass: true,
                advisoryLlmEvaluated: true,
                timestamp: Date.now()
            });
            return {
                winnerCandidateId: winner.candidateId,
                status: "ADMITTED",
                mode: "ADVISORY_LLM",
                rationale: "Advisory tie-breaker consensus achieved."
            };
        }
        catch {
            this.circuitBreaker.recordFailure();
            return this.handleFallbackReview(viableVariants, targetParentId, intent, "LLM evaluation error or timeout");
        }
    }
    private handleFallbackReview(viableVariants: CandidateVariant[], targetParentId: string, intent: string, reason: string): ArbitrationResult {
        this.recordArbitrationDecision({
            decisionId: crypto.randomUUID(),
            targetParentId,
            intent,
            winnerCandidateId: null,
            status: "FLAGGED_HUMAN_REVIEW",
            rationale: `Tie-break fallback: ${reason}. Baseline AST preserved; flagged for human review.`,
            staticAnalysisPass: true,
            typeCheckPass: true,
            advisoryLlmEvaluated: false,
            timestamp: Date.now()
        });
        this.sql.exec(`
      UPDATE ast_superposition_pool 
      SET fitness_score = -1.0 
      WHERE target_parent_id = ?1;
    `, targetParentId);
        return {
            winnerCandidateId: null,
            status: "FLAGGED_HUMAN_REVIEW",
            mode: "BASELINE_PRESERVED_FLAGGED_REVIEW",
            rationale: `Baseline preserved; ${viableVariants.length} competing variants flagged for human review.`
        };
    }
    private fetchPendingCandidates(): CandidateVariant[] {
        const cursor = this.sql.exec(`
      SELECT candidate_id, target_parent_id, intent_spec, syntax_sexpr, raw_source, agent_id
      FROM ast_superposition_pool
      WHERE fitness_score IS NULL OR fitness_score >= 0
      ORDER BY submitted_at ASC
      LIMIT 8;
    `);
        const result: CandidateVariant[] = [];
        for (const r of cursor) {
            result.push({
                candidateId: r.candidate_id as string,
                targetParentId: r.target_parent_id as string,
                intentSpec: r.intent_spec as string,
                syntaxSExpr: r.syntax_sexpr as string,
                rawSource: r.raw_source as string,
                agentId: r.agent_id as string
            });
        }
        return result;
    }
    private async evaluateViaAdvisoryLLM(intent: string, variants: CandidateVariant[]): Promise<CandidateVariant> {
        const sanitizedVariants = variants.map(v => ({
            ...v,
            cleanSource: VerificationGate.sanitizeAgentCode(v.rawSource)
        }));
        try {
            const response = await this.env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
                messages: [
                    {
                        role: "system",
                        content: "You are an advisory tie-breaker for competing AST code variants. Evaluate candidate implementations against the specification. Return STRICT JSON with format: {\"winner_id\": string, \"rationale\": string}."
                    },
                    {
                        role: "user",
                        content: `INTENT SPECIFICATION:\n${VerificationGate.sanitizeAgentCode(intent)}\n\nCOMPETING VARIANTS:\n${sanitizedVariants.map((v, i) => `[VARIANT ${i + 1}] ID: ${v.candidateId}\n${v.cleanSource}`).join("\n\n")}`
                    }
                ],
                max_tokens: 200,
                temperature: 0.1
            }) as {
                response?: string;
                choices?: Array<{
                    message?: {
                        content?: string;
                    };
                }>;
            };
            const rawContent = response.response || response.choices?.[0]?.message?.content || "";
            const jsonMatch = rawContent.match(/\{[\s\S]*\}/);
            if (!jsonMatch) {
                throw new Error("Advisory LLM did not return a valid JSON object");
            }
            const parsed = JSON.parse(jsonMatch[0]) as {
                winner_id: string;
                rationale?: string;
            };
            const winner = variants.find(v => v.candidateId === parsed.winner_id);
            if (!winner) {
                throw new Error(`Advisory LLM returned unknown candidate ID: ${parsed.winner_id}`);
            }
            return winner;
        }
        catch (err: any) {
            throw new Error(`LLM evaluation failed: ${err.message || String(err)}`);
        }
    }
    private commitWinningVariant(winner: CandidateVariant): void {
        const now = Date.now();
        this.sql.exec(`
      UPDATE ast_nodes 
      SET is_alive = 0, death_lamport = ?1
      WHERE parent_id = ?2 AND node_id != ?3 AND is_alive = 1;
    `, now, winner.targetParentId, winner.candidateId);
        this.sql.exec(`
      INSERT INTO ast_nodes (node_id, parent_id, grammar_type, pos_fractional, is_alive, birth_lamport, birth_agent)
      VALUES (?1, ?2, 'COLLAPSED_PRODUCTION', '32768', 1, ?3, ?4)
      ON CONFLICT(node_id) DO UPDATE SET is_alive = 1, death_lamport = NULL;
    `, winner.candidateId, winner.targetParentId, now, winner.agentId);
        this.sql.exec(`
      INSERT INTO ast_attributes (node_id, attr_key, attr_val, lamport_counter, agent_id)
      VALUES (?1, 'token', ?2, ?3, ?4)
      ON CONFLICT(node_id, attr_key) DO UPDATE SET attr_val = excluded.attr_val;
    `, winner.candidateId, winner.rawSource, now, winner.agentId);
        this.purgeSuperpositionPool(winner.targetParentId);
    }
    private recordArbitrationDecision(audit: ArbitrationAuditEvent): void {
        this.sql.exec(`
      CREATE TABLE IF NOT EXISTS ast_arbitration_log (
        decision_id TEXT PRIMARY KEY NOT NULL,
        target_parent_id TEXT NOT NULL,
        intent_spec TEXT NOT NULL,
        winner_candidate_id TEXT,
        status TEXT NOT NULL,
        rationale TEXT NOT NULL,
        static_pass INTEGER NOT NULL,
        type_pass INTEGER NOT NULL,
        ai_evaluated INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
        this.sql.exec(`
      INSERT INTO ast_arbitration_log (
        decision_id, target_parent_id, intent_spec, winner_candidate_id,
        status, rationale, static_pass, type_pass, ai_evaluated, created_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10);
    `, audit.decisionId, audit.targetParentId, audit.intent, audit.winnerCandidateId, audit.status, audit.rationale, audit.staticAnalysisPass ? 1 : 0, audit.typeCheckPass ? 1 : 0, audit.advisoryLlmEvaluated ? 1 : 0, audit.timestamp);
        this.sql.exec(`
      INSERT INTO crdt_merkle_ledger (mutation_hash, parent_root, new_root, lamport_counter, signer_public_key)
      VALUES (?1, ?2, ?3, ?4, ?5);
    `, audit.decisionId, audit.targetParentId, audit.winnerCandidateId || "BASELINE_PRESERVED", audit.timestamp, "kernel:arbitration");
    }
    private purgeSuperpositionPool(targetParentId: string): void {
        this.sql.exec(`
      DELETE FROM ast_superposition_pool WHERE target_parent_id = ?1;
    `, targetParentId);
    }
}
export const WaveFunctionCollapseAlarmController = SemanticConflictArbiter;
export type WFCSelectionResult = ArbitrationResult;
