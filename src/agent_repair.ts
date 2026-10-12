import * as ts from "typescript";
import { ASTSemanticAnalyzer, SemanticAnalysisReport } from "./ast_semantic_analyzer";
export interface RepairDiagnosis {
    canSelfHeal: boolean;
    rootCause: "SYNTAX_ERROR" | "SECURITY_GUARD_REMOVED" | "SIGNATURE_ARITY_MISMATCH" | "STALE_BASE" | "UNKNOWN";
    affectedSymbol?: string;
    errorLine?: number;
    errorColumn?: number;
    explanation: string;
    remediationPrompt: string;
    suggestedPatch?: string;
    repairedCode?: string;
    confidence: number;
}
export class AgentRepairEngine {
    public static diagnoseAndRepair(baseCode: string | { baseCode?: string; candidateCode?: string; filePath?: string; analysisReport?: SemanticAnalysisReport | null }, candidateCode?: string, filePath?: string, analysisReport?: SemanticAnalysisReport | null): RepairDiagnosis {
        if (typeof baseCode === "object" && baseCode !== null) {
            const opts = baseCode;
            return AgentRepairEngine.diagnoseAndRepair(opts.baseCode || "", opts.candidateCode || "", opts.filePath || "src/mod.ts", opts.analysisReport || null);
        }
        let actualBase: string = typeof baseCode === "string" ? baseCode : "";
        if (actualBase.startsWith("Loading base") || actualBase.startsWith("Base file does not exist") || actualBase.startsWith("Base file unavailable")) {
            actualBase = "";
        }
        const actualCandidate: string = typeof candidateCode === "string" ? candidateCode : "";
        const actualPath: string = typeof filePath === "string" ? filePath : "src/mod.ts";
        const sourceFile = ts.createSourceFile(actualPath, actualCandidate, ts.ScriptTarget.Latest, true, actualPath.endsWith(".tsx") || actualPath.endsWith(".jsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
        const parseDiagnostics = (sourceFile as any).parseDiagnostics || [];
        if (parseDiagnostics.length > 0) {
            const firstDiag = parseDiagnostics[0];
            const { line, character } = sourceFile.getLineAndCharacterOfPosition(firstDiag.start || 0);
            const message = typeof firstDiag.messageText === "string"
                ? firstDiag.messageText
                : firstDiag.messageText?.messageText || "Syntax parsing error";
            let repaired = actualCandidate;
            if (message.includes("expected") && actualCandidate.endsWith("}")) {
                repaired = actualCandidate + "\n";
            }
            return {
                canSelfHeal: true,
                rootCause: "SYNTAX_ERROR",
                errorLine: line + 1,
                errorColumn: character + 1,
                explanation: `Syntax error at line ${line + 1}, col ${character + 1}: ${message}`,
                remediationPrompt: `Your candidate patch for '${actualPath}' has a syntax error at line ${line + 1}: "${message}". Fix the syntax error while preserving your logic.`,
                suggestedPatch: repaired !== actualCandidate ? repaired : undefined,
                repairedCode: repaired !== actualCandidate ? repaired : undefined,
                confidence: 0.85
            };
        }
        const baseGuards = this.extractSecurityGuards(actualBase, actualPath);
        const candidateGuards = this.extractSecurityGuards(actualCandidate, actualPath);
        for (const [funcName, guards] of baseGuards.entries()) {
            const candGuards = candidateGuards.get(funcName) || [];
            const missingGuards = guards.filter(g => !candGuards.includes(g));
            if (missingGuards.length > 0) {
                const restoredCode = this.restoreSecurityGuards(actualBase, actualCandidate, actualPath, funcName, missingGuards);
                return {
                    canSelfHeal: true,
                    rootCause: "SECURITY_GUARD_REMOVED",
                    affectedSymbol: funcName,
                    explanation: `Security invariant violation: candidate removed essential guard(s) [${missingGuards.join(", ")}] from function '${funcName}'.`,
                    remediationPrompt: `Security Invariant Gate: You removed required authorization/validation guard(s) "${missingGuards.join(", ")}" inside function '${funcName}'. Re-insert the guard at the top of the function body.`,
                    suggestedPatch: restoredCode,
                    repairedCode: restoredCode,
                    confidence: 0.95
                };
            }
        }
        const comparison: SemanticAnalysisReport = analysisReport || ASTSemanticAnalyzer.analyzeProposals({
            baseCode: actualBase,
            filePath: actualPath,
            proposalA: { agentId: "candidate-agent", intent: "proposed change", code: actualCandidate },
            proposalB: { agentId: "base-reference", intent: "base snapshot", code: actualBase }
        });
        const validInteractions = comparison.interactions.filter(i => !(i.type === "SYNTAX_ERROR" && i.agentsInvolved?.includes("base-reference")));
        const sigMismatch = validInteractions.find((i: any) => i.type === "SIGNATURE_CALL_MISMATCH" ||
            (i.reason && (i.reason.includes("arity") || i.reason.includes("parameters"))));
        if (sigMismatch) {
            const sym = sigMismatch.affectedSymbol || "unknown";
            const repaired = this.makeParametersOptional(actualCandidate, actualPath, sym);
            return {
                canSelfHeal: true,
                rootCause: "SIGNATURE_ARITY_MISMATCH",
                affectedSymbol: sym,
                explanation: `Call-site break: function '${sym}' changed signature in a way that breaks existing callers: ${sigMismatch.reason}`,
                remediationPrompt: `Signature Contract Break: Modifying '${sym}' breaks callers expecting the prior parameter arity. Make newly introduced parameters optional (e.g. 'param?: Type' or 'param = defaultValue') so existing callers do not fail.`,
                suggestedPatch: repaired !== actualCandidate ? repaired : undefined,
                repairedCode: repaired !== actualCandidate ? repaired : undefined,
                confidence: 0.90
            };
        }
        if (validInteractions.length > 0) {
            const firstInter = validInteractions[0];
            return {
                canSelfHeal: true,
                rootCause: "UNKNOWN",
                affectedSymbol: firstInter?.affectedSymbol,
                explanation: firstInter?.reason || "Conflict detected against baseline AST.",
                remediationPrompt: `Aether detected a conflict: ${firstInter?.reason || "Multiple active proposals mutate overlapping symbols."} Refactor to modify only disjoint functions.`,
                confidence: 0.70
            };
        }
        return {
            canSelfHeal: false,
            rootCause: "UNKNOWN",
            explanation: "No AST or invariant violations detected in candidate code.",
            remediationPrompt: "Candidate code already passes Aether semantic validation.",
            confidence: 1.0
        };
    }
    private static extractSecurityGuards(code: string, filePath: string): Map<string, string[]> {
        const map = new Map<string, string[]>();
        try {
            const sf = ts.createSourceFile(filePath, code, ts.ScriptTarget.Latest, true);
            const visit = (node: ts.Node, currentFunc?: string) => {
                let fnName = currentFunc;
                if (ts.isFunctionDeclaration(node) && node.name) {
                    fnName = node.name.text;
                }
                else if (ts.isMethodDeclaration(node) && node.name && ts.isIdentifier(node.name)) {
                    fnName = node.name.text;
                }
                if (fnName && ts.isIfStatement(node)) {
                    const conditionText = sf.text.substring(node.expression.getStart(sf), node.expression.getEnd()).replace(/\s+/g, " ").trim();
                    if (conditionText.includes("auth") ||
                        conditionText.includes("admin") ||
                        conditionText.includes("token") ||
                        conditionText.includes("=== 0") ||
                        conditionText.includes("== null") ||
                        conditionText.includes("!valid") ||
                        conditionText.includes("permission") ||
                        conditionText.includes("!")) {
                        const list = map.get(fnName) || [];
                        list.push(conditionText);
                        map.set(fnName, list);
                    }
                }
                ts.forEachChild(node, child => visit(child, fnName));
            };
            visit(sf);
        }
        catch { }
        return map;
    }
    private static restoreSecurityGuards(baseCode: string, candidateCode: string, filePath: string, funcName: string, missingGuards: string[]): string {
        try {
            const baseSf = ts.createSourceFile("base.ts", baseCode, ts.ScriptTarget.Latest, true);
            let guardStatementText = "";
            const findGuard = (node: ts.Node) => {
                if ((ts.isFunctionDeclaration(node) && node.name?.text === funcName) ||
                    (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === funcName)) {
                    if (node.body && ts.isBlock(node.body)) {
                        for (const stmt of node.body.statements) {
                            if (ts.isIfStatement(stmt)) {
                                const cond = baseSf.text.substring(stmt.expression.getStart(baseSf), stmt.expression.getEnd()).replace(/\s+/g, " ").trim();
                                if (missingGuards.includes(cond)) {
                                    guardStatementText = baseSf.text.substring(stmt.getStart(baseSf), stmt.getEnd()).trim();
                                    break;
                                }
                            }
                        }
                    }
                }
                ts.forEachChild(node, findGuard);
            };
            findGuard(baseSf);
            if (!guardStatementText)
                return candidateCode;
            const candSf = ts.createSourceFile("cand.ts", candidateCode, ts.ScriptTarget.Latest, true);
            let insertPos: number | null = null;
            const findCand = (node: ts.Node) => {
                if ((ts.isFunctionDeclaration(node) && node.name?.text === funcName) ||
                    (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === funcName)) {
                    if (node.body && ts.isBlock(node.body)) {
                        insertPos = node.body.getStart(candSf) + 1;
                    }
                }
                ts.forEachChild(node, findCand);
            };
            findCand(candSf);
            if (insertPos !== null) {
                return (candidateCode.slice(0, insertPos) +
                    "\n  " + guardStatementText + "\n" +
                    candidateCode.slice(insertPos));
            }
        }
        catch { }
        return candidateCode;
    }
    private static makeParametersOptional(code: string, filePath: string, funcName: string): string {
        try {
            const sf = ts.createSourceFile(filePath, code, ts.ScriptTarget.Latest, true);
            let newCode = code;
            const visit = (node: ts.Node) => {
                if ((ts.isFunctionDeclaration(node) && node.name?.text === funcName) ||
                    (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === funcName)) {
                    if (node.parameters.length > 0) {
                        const lastParam = node.parameters[node.parameters.length - 1];
                        if (!lastParam.questionToken && !lastParam.initializer) {
                            const paramText = lastParam.getText(sf);
                            const paramName = lastParam.name.getText(sf);
                            const paramType = lastParam.type ? lastParam.type.getText(sf) : "any";
                            const fixedParam = `${paramName}?: ${paramType}`;
                            newCode = code.slice(0, lastParam.getStart(sf)) + fixedParam + code.slice(lastParam.getEnd());
                        }
                    }
                }
                ts.forEachChild(node, visit);
            };
            visit(sf);
            return newCode;
        }
        catch {
            return code;
        }
    }
}

export const AgentSelfHealingRepair = AgentRepairEngine;
