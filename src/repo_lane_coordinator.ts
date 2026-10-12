import crypto from "crypto";
import { ASTSemanticAnalyzer, SemanticAnalysisReport } from "./ast_semantic_analyzer";
export interface ProposalSubmission {
    repoId: string;
    targetBranch: string;
    agentId: string;
    agentSignature?: string;
    baseCommitSha: string;
    filePath: string;
    patchContent: string;
    intentDescription: string;
    idempotencyKey: string;
}
export interface ProposalRecord {
    id: string;
    repoId: string;
    targetBranch: string;
    agentId: string;
    agentSignature?: string;
    baseCommitSha: string;
    candidateCommitSha?: string;
    filePath: string;
    patchContent: string;
    intentDescription: string;
    affectedSymbols: string[];
    idempotencyKey: string;
    status: "QUEUED" | "ANALYZING" | "SAFE_INTEGRATED" | "POTENTIAL_INTERACTION" | "UNRESOLVED_CONFLICT" | "COMMITTED" | "REJECTED";
    analysisOutcome?: SemanticAnalysisReport;
    testStatus?: {
        executed: boolean;
        passed: boolean;
        revisionSha: string;
        output?: string;
    };
    submittedAt: number;
    updatedAt: number;
}
export interface LaneSequenceEntry {
    sequenceId: number;
    proposalId: string;
    targetBranch: string;
    priorHeadSha: string;
    newHeadSha: string;
    transitionType: "ADMISSION" | "INTEGRATION" | "REJECTION";
    merkleHash: string;
    createdAt: number;
}
export interface AuditRecord {
    sequenceId: number;
    priorHash: string;
    payloadHash: string;
    recordHash: string;
    actor: string;
    action: string;
    timestamp: number;
    payload: any;
}
export class RepoLaneCoordinator {
    private proposals = new Map<string, ProposalRecord>();
    private idempotencyIndex = new Map<string, string>();
    private laneSequence: LaneSequenceEntry[] = [];
    private auditLedger: AuditRecord[] = [];
    private branchHeads = new Map<string, string>();
    private fileStore = new Map<string, string>();
    constructor(initialHeadSha = "0000000000000000000000000000000000000000") {
        this.branchHeads.set("main", initialHeadSha);
    }
    public setFileContent(filePath: string, content: string): void {
        this.fileStore.set(filePath, content);
    }
    public getFileContent(filePath: string): string {
        return this.fileStore.get(filePath) || "";
    }
    public getBranchHead(branch = "main"): string {
        return this.branchHeads.get(branch) || "0000000000000000000000000000000000000000";
    }
    public setBranchHead(branch: string, sha: string): void {
        this.branchHeads.set(branch, sha);
    }
    public async submitProposal(submission: ProposalSubmission): Promise<{
        proposal: ProposalRecord;
        isRetry: boolean;
    }> {
        if (this.idempotencyIndex.has(submission.idempotencyKey)) {
            const existingId = this.idempotencyIndex.get(submission.idempotencyKey)!;
            const existing = this.proposals.get(existingId)!;
            return { proposal: existing, isRetry: true };
        }
        const proposalId = `prop_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
        const baseCode = this.fileStore.get(submission.filePath) || "";
        const proposal: ProposalRecord = {
            id: proposalId,
            repoId: submission.repoId,
            targetBranch: submission.targetBranch,
            agentId: submission.agentId,
            agentSignature: submission.agentSignature,
            baseCommitSha: submission.baseCommitSha,
            filePath: submission.filePath,
            patchContent: submission.patchContent,
            intentDescription: submission.intentDescription,
            affectedSymbols: [],
            idempotencyKey: submission.idempotencyKey,
            status: "ANALYZING",
            submittedAt: Date.now(),
            updatedAt: Date.now()
        };
        const baseSummary = ASTSemanticAnalyzer.parseFile(baseCode, submission.filePath);
        const candidateSummary = ASTSemanticAnalyzer.parseFile(submission.patchContent, submission.filePath);
        if (candidateSummary.syntaxErrors.length > 0) {
            proposal.status = "UNRESOLVED_CONFLICT";
            proposal.analysisOutcome = {
                outcome: "UNRESOLVED_CONFLICT",
                summary: `TypeScript syntax error: ${candidateSummary.syntaxErrors.join("; ")}`,
                interactions: [{
                        type: "SYNTAX_ERROR",
                        affectedSymbol: "FILE_SYNTAX",
                        filePath: submission.filePath,
                        reason: candidateSummary.syntaxErrors.join("; ")
                    }],
                canAutoMerge: false,
                affectedSymbols: [],
                diagnostics: candidateSummary.syntaxErrors
            };
            this.recordProposal(proposal);
            return { proposal, isRetry: false };
        }
        let foundInteraction = false;
        const activeProposals = Array.from(this.proposals.values()).filter(p => p.targetBranch === submission.targetBranch &&
            ["QUEUED", "ANALYZING", "SAFE_INTEGRATED", "POTENTIAL_INTERACTION"].includes(p.status));
        for (const other of activeProposals) {
            let analysis: SemanticAnalysisReport;
            if (other.filePath === submission.filePath) {
                analysis = ASTSemanticAnalyzer.analyzeProposals({
                    baseCode,
                    filePath: submission.filePath,
                    proposalA: { agentId: other.agentId, intent: other.intentDescription, code: other.patchContent },
                    proposalB: { agentId: submission.agentId, intent: submission.intentDescription, code: submission.patchContent }
                });
            }
            else {
                analysis = ASTSemanticAnalyzer.analyzeCrossFileProposals({
                    proposalA: { agentId: other.agentId, intent: other.intentDescription, filePath: other.filePath, code: other.patchContent },
                    proposalB: { agentId: submission.agentId, intent: submission.intentDescription, filePath: submission.filePath, code: submission.patchContent }
                });
            }
            if (analysis.outcome !== "SAFE_INTEGRATION") {
                foundInteraction = true;
                proposal.status = analysis.outcome;
                proposal.analysisOutcome = analysis;
                proposal.affectedSymbols = analysis.affectedSymbols;
                break;
            }
        }
        if (!foundInteraction) {
            proposal.status = "SAFE_INTEGRATED";
            proposal.analysisOutcome = {
                outcome: "SAFE_INTEGRATION",
                summary: "Proposal is fully compatible and safe to integrate.",
                interactions: [],
                canAutoMerge: true,
                affectedSymbols: Array.from(candidateSummary.definitions.keys()),
                diagnostics: []
            };
            proposal.affectedSymbols = Array.from(candidateSummary.definitions.keys());
            const currentHead = this.getBranchHead(submission.targetBranch);
            if (submission.baseCommitSha === currentHead) {
                const newCommitSha = this.generateCommitSha(currentHead, submission.patchContent, proposal.id);
                proposal.candidateCommitSha = newCommitSha;
                proposal.status = "COMMITTED";
                this.fileStore.set(submission.filePath, submission.patchContent);
                this.branchHeads.set(submission.targetBranch, newCommitSha);
                this.appendLaneSequence(proposal.id, submission.targetBranch, currentHead, newCommitSha, "INTEGRATION");
            }
        }
        this.recordProposal(proposal);
        return { proposal, isRetry: false };
    }
    public async approveProposal(proposalId: string, approverId: string, resolvedCode?: string): Promise<ProposalRecord> {
        const proposal = this.proposals.get(proposalId);
        if (!proposal) {
            throw new Error(`Proposal '${proposalId}' not found.`);
        }
        const currentHead = this.getBranchHead(proposal.targetBranch);
        const finalContent = resolvedCode || proposal.patchContent;
        const newCommitSha = this.generateCommitSha(currentHead, finalContent, proposal.id);
        proposal.candidateCommitSha = newCommitSha;
        proposal.status = "COMMITTED";
        proposal.updatedAt = Date.now();
        this.fileStore.set(proposal.filePath, finalContent);
        this.branchHeads.set(proposal.targetBranch, newCommitSha);
        this.appendLaneSequence(proposal.id, proposal.targetBranch, currentHead, newCommitSha, "INTEGRATION");
        this.appendAuditRecord(approverId, "APPROVE_PROPOSAL", { proposalId, approverId, newCommitSha });
        return proposal;
    }
    public getProposal(proposalId: string): ProposalRecord | undefined {
        return this.proposals.get(proposalId);
    }
    public listProposals(repoId?: string, branch?: string): ProposalRecord[] {
        return Array.from(this.proposals.values()).filter(p => {
            if (repoId && p.repoId !== repoId)
                return false;
            if (branch && p.targetBranch !== branch)
                return false;
            return true;
        });
    }
    public getLaneSequence(branch = "main"): LaneSequenceEntry[] {
        return this.laneSequence.filter(s => s.targetBranch === branch);
    }
    public getAuditLedger(): AuditRecord[] {
        return [...this.auditLedger];
    }
    public verifyAuditChain(): {
        valid: boolean;
        recordsVerified: number;
        error?: string;
    } {
        let priorHash = "0000000000000000000000000000000000000000000000000000000000000000";
        for (let i = 0; i < this.auditLedger.length; i++) {
            const record = this.auditLedger[i];
            if (record.priorHash !== priorHash) {
                return {
                    valid: false,
                    recordsVerified: i,
                    error: `Broken hash chain at sequence ${record.sequenceId}: expected priorHash ${priorHash}, found ${record.priorHash}`
                };
            }
            const payloadString = JSON.stringify(record.payload);
            const computedPayloadHash = crypto.createHash("sha256").update(payloadString).digest("hex");
            if (computedPayloadHash !== record.payloadHash) {
                return {
                    valid: false,
                    recordsVerified: i,
                    error: `Payload hash mismatch at sequence ${record.sequenceId}: data has been tampered with.`
                };
            }
            const expectedRecordHash = crypto.createHash("sha256")
                .update(`${record.priorHash}:${record.payloadHash}:${record.actor}:${record.action}:${record.timestamp}`)
                .digest("hex");
            if (expectedRecordHash !== record.recordHash) {
                return {
                    valid: false,
                    recordsVerified: i,
                    error: `Record hash mismatch at sequence ${record.sequenceId}: expected ${expectedRecordHash}, found ${record.recordHash}`
                };
            }
            priorHash = record.recordHash;
        }
        return { valid: true, recordsVerified: this.auditLedger.length };
    }
    private recordProposal(proposal: ProposalRecord): void {
        this.proposals.set(proposal.id, proposal);
        this.idempotencyIndex.set(proposal.idempotencyKey, proposal.id);
        this.appendAuditRecord(proposal.agentId, "SUBMIT_PROPOSAL", {
            proposalId: proposal.id,
            baseCommitSha: proposal.baseCommitSha,
            status: proposal.status,
            intent: proposal.intentDescription
        });
    }
    private appendLaneSequence(proposalId: string, targetBranch: string, priorHeadSha: string, newHeadSha: string, transitionType: "ADMISSION" | "INTEGRATION" | "REJECTION"): void {
        const sequenceId = this.laneSequence.length + 1;
        const priorMerkle = this.laneSequence.length > 0
            ? this.laneSequence[this.laneSequence.length - 1].merkleHash
            : "0000000000000000000000000000000000000000000000000000000000000000";
        const merkleHash = crypto.createHash("sha256")
            .update(`${priorMerkle}:${proposalId}:${priorHeadSha}:${newHeadSha}:${transitionType}`)
            .digest("hex");
        this.laneSequence.push({
            sequenceId,
            proposalId,
            targetBranch,
            priorHeadSha,
            newHeadSha,
            transitionType,
            merkleHash,
            createdAt: Date.now()
        });
    }
    private appendAuditRecord(actor: string, action: string, payload: any): void {
        const sequenceId = this.auditLedger.length + 1;
        const priorHash = this.auditLedger.length > 0
            ? this.auditLedger[this.auditLedger.length - 1].recordHash
            : "0000000000000000000000000000000000000000000000000000000000000000";
        const payloadString = JSON.stringify(payload);
        const payloadHash = crypto.createHash("sha256").update(payloadString).digest("hex");
        const timestamp = Date.now();
        const recordHash = crypto.createHash("sha256")
            .update(`${priorHash}:${payloadHash}:${actor}:${action}:${timestamp}`)
            .digest("hex");
        this.auditLedger.push({
            sequenceId,
            priorHash,
            payloadHash,
            recordHash,
            actor,
            action,
            timestamp,
            payload
        });
    }
    private generateCommitSha(parentSha: string, content: string, proposalId: string): string {
        return crypto.createHash("sha1")
            .update(`commit:${parentSha}:${proposalId}:${crypto.createHash("sha256").update(content).digest("hex")}`)
            .digest("hex");
    }
}
