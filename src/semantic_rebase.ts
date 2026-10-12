import { ASTComposer, SymbolChangesetAnalyzer, SymbolOp } from "./ast_composer";
import { DifferentialTypecheckGate } from "./differential_typecheck";
import { PolicyEngine, GitProvenance, PolicyDecision } from "./policy_and_provenance";
export interface ProposalToRebase {
    id: string;
    agentId: string;
    intent: string;
    filePath: string;
    patchContent: string;
    baseCommitSha: string;
    status: string;
}
export interface SemanticRebaseBatchResult {
    landedCount: number;
    supersededCount: number;
    needsHumanCount: number;
    composedFiles: Record<string, string>;
    commitMessage?: string;
    autoLandedProposals: string[];
    supersededProposals: string[];
    needsHumanProposals: Array<{
        id: string;
        reason: string;
    }>;
}
export class SemanticRebaseEngine {
    public static rebaseAndComposeBatch(params: {
        repoId: string;
        targetBranch: string;
        newHeadSha: string;
        baseFiles: Record<string, string>;
        proposals: ProposalToRebase[];
    }): SemanticRebaseBatchResult {
        const { newHeadSha, baseFiles, proposals } = params;
        const workingFiles = { ...baseFiles };
        const autoLanded: string[] = [];
        const superseded: string[] = [];
        const needsHuman: Array<{
            id: string;
            reason: string;
        }> = [];
        const creditedAgents: Array<{
            id: string;
            name?: string;
        }> = [];
        const recordedOps: string[] = [];
        const byFile = new Map<string, ProposalToRebase[]>();
        for (const p of proposals) {
            if (!byFile.has(p.filePath))
                byFile.set(p.filePath, []);
            byFile.get(p.filePath)!.push(p);
        }
        for (const [filePath, fileProps] of byFile.entries()) {
            let currentFileContent = workingFiles[filePath] || "";
            const baseSnapshot = currentFileContent;
            for (const prop of fileProps) {
                const candDiffFromHead = SymbolChangesetAnalyzer.diffFile(currentFileContent, prop.patchContent, filePath);
                if (candDiffFromHead.ops.length === 0) {
                    superseded.push(prop.id);
                    continue;
                }
                const propDiff = SymbolChangesetAnalyzer.diffFile(baseSnapshot, prop.patchContent, filePath);
                const headDiffFromBase = SymbolChangesetAnalyzer.diffFile(baseSnapshot, currentFileContent, filePath);
                const headModifiedSyms = new Set(headDiffFromBase.ops.map(o => o.symbolName));
                let hasConflict = false;
                let conflictReason = "";
                for (const op of propDiff.ops) {
                    if (headModifiedSyms.has(op.symbolName)) {
                        const headOp = headDiffFromBase.ops.find(o => o.symbolName === op.symbolName)!;
                        if (headOp.newNormalizedText !== op.newNormalizedText) {
                            hasConflict = true;
                            conflictReason = `Symbol '${op.symbolName}' was modified concurrently with conflicting logic`;
                            break;
                        }
                    }
                }
                if (hasConflict) {
                    needsHuman.push({ id: prop.id, reason: conflictReason });
                    continue;
                }
                const currentSymbols = SymbolChangesetAnalyzer.extractSymbols(currentFileContent, filePath);
                let updatedContent = currentFileContent;
                for (const op of propDiff.ops) {
                    const currentSym = currentSymbols.symbols.get(op.symbolName);
                    if (op.kind === "MODIFY" && currentSym && op.newRawText) {
                        updatedContent = updatedContent.replace(currentSym.rawText, op.newRawText);
                    }
                    else if (op.kind === "DELETE" && currentSym) {
                        updatedContent = updatedContent.replace(currentSym.rawText, "");
                    }
                    else if (op.kind === "ADD" && op.newRawText) {
                        updatedContent = updatedContent.trimEnd() + "\n\n" + op.newRawText + "\n";
                    }
                }
                for (const imp of propDiff.imports) {
                    const hasImp = currentSymbols.imports.some(i => i.specifier === imp.specifier);
                    if (!hasImp) {
                        updatedContent = `import { ${imp.symbols.join(", ")} } from "${imp.specifier}";\n` + updatedContent;
                    }
                }
                currentFileContent = updatedContent;
                workingFiles[filePath] = currentFileContent;
                autoLanded.push(prop.id);
                creditedAgents.push({ id: prop.agentId });
                for (const op of propDiff.ops) {
                    recordedOps.push(`${filePath}#${op.symbolName}:${op.kind.toLowerCase()}`);
                }
            }
        }
        const typecheckOutcome = DifferentialTypecheckGate.checkDifferential({
            baseSha: newHeadSha,
            baseFiles,
            composedFiles: workingFiles
        });
        if (!typecheckOutcome.passed) {
            const failedProps = autoLanded.map(id => ({
                id,
                reason: `Differential type check failed with ${typecheckOutcome.newDiagnostics.length} new error(s): ${typecheckOutcome.newDiagnostics[0]?.message}`
            }));
            return {
                landedCount: 0,
                supersededCount: superseded.length,
                needsHumanCount: needsHuman.length + failedProps.length,
                composedFiles: baseFiles,
                autoLandedProposals: [],
                supersededProposals: superseded,
                needsHumanProposals: [...needsHuman, ...failedProps]
            };
        }
        let commitMessage: string | undefined;
        if (autoLanded.length > 0) {
            const summaryIntent = proposals
                .filter(p => autoLanded.includes(p.id))
                .map(p => p.intent)
                .join("; ");
            commitMessage = GitProvenance.formatCommitMessage(`chore(aether): compose and land ${autoLanded.length} semantic proposal(s)`, {
                proposalId: autoLanded.join(","),
                agents: creditedAgents,
                intent: summaryIntent || "Automated AST composition",
                ops: recordedOps,
                baseSha: newHeadSha,
                newTypeErrors: 0,
                decision: "auto"
            });
        }
        return {
            landedCount: autoLanded.length,
            supersededCount: superseded.length,
            needsHumanCount: needsHuman.length,
            composedFiles: workingFiles,
            commitMessage,
            autoLandedProposals: autoLanded,
            supersededProposals: superseded,
            needsHumanProposals: needsHuman
        };
    }
}
