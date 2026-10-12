import { ASTSemanticAnalyzer } from "./ast_semantic_analyzer";
export interface StaticCheckResult {
    success: boolean;
    checksPassed: number;
    checksFailed: number;
    durationMs: number;
    output: string;
}
export interface VerificationResult {
    passed: boolean;
    typeCheckPass: boolean | null;
    lintPass: boolean | null;
    securityRiskDetected: boolean;
    riskFlags: string[];
    diagnostics: string[];
    staticChecks: StaticCheckResult;
    notRun: string[];
}
export class VerificationGate {
    public static sanitizeAgentCode(rawSource: string): string {
        return rawSource
            .replace(/\[INST\]/gi, "[REDACTED_INST]")
            .replace(/\[\/INST\]/gi, "[/REDACTED_INST]")
            .replace(/<<SYS>>/gi, "<REDACTED_SYS>")
            .replace(/<\/SYS>>/gi, "</REDACTED_SYS>")
            .replace(/system:/gi, "code_system:")
            .replace(/ignore previous instructions/gi, "[FILTERED_INSTRUCTION]")
            .replace(/system prompt/gi, "[FILTERED_PROMPT]");
    }
    public static validateAdvisoryResponse(responseJsonText: string, validCandidateIds: Set<string>): {
        valid: boolean;
        selectedCandidateId: string | null;
    } {
        try {
            const parsed = JSON.parse(responseJsonText) as {
                winner_id?: string;
            };
            if (parsed.winner_id && validCandidateIds.has(parsed.winner_id)) {
                return { valid: true, selectedCandidateId: parsed.winner_id };
            }
        }
        catch {
        }
        return { valid: false, selectedCandidateId: null };
    }
    public static runStaticChecks(candidateCode: string, filePath = "candidate.ts", baseCode?: string): StaticCheckResult {
        const startTime = performance.now();
        const summary = ASTSemanticAnalyzer.parseFile(candidateCode, filePath);
        let passedCount = 0;
        let failedCount = 0;
        const failures: string[] = [];
        if (summary.syntaxErrors.length === 0) {
            passedCount++;
        }
        else {
            failedCount++;
            failures.push(`SyntaxError: ${summary.syntaxErrors.join("; ")}`);
        }
        const unavailable = summary.unsupportedConstructs.filter(item => item.startsWith("Analysis unavailable:"));
        const unsafeConstructs = summary.unsupportedConstructs.filter(item => !item.startsWith("Analysis unavailable:"));
        if (unsafeConstructs.length === 0 && unavailable.length === 0) {
            passedCount++;
        }
        else {
            failedCount++;
            failures.push(...unavailable, ...unsafeConstructs.map(item => `SecurityRisk: ${item}`));
        }
        if (baseCode) {
            const securityGuards = ["isAdmin", "verifyToken", "authKey", "checkPermission", "hasAccess"];
            for (const guard of securityGuards) {
                if (baseCode.includes(guard) && !candidateCode.includes(guard)) {
                    failedCount++;
                    failures.push(`SecurityViolation: Removed required authorization guard '${guard}'`);
                }
            }
            if (failedCount === 0)
                passedCount++;
        }
        const durationMs = Math.round(performance.now() - startTime);
        const success = failedCount === 0;
        return {
            success,
            checksPassed: passedCount,
            checksFailed: failedCount,
            durationMs,
            output: success
                ? `Static source checks passed (${passedCount} checks, 0 failures); candidate code was not executed.`
                : `Verification failed:\n  ${failures.join("\n  ")}`
        };
    }
    public verifyCandidate(sourceCode: string, grammarType = "typescript", baseCode?: string): VerificationResult {
        const diagnostics: string[] = [];
        const riskFlags: string[] = [];
        let syntaxValid = true;
        let securityRiskDetected = false;
        if (!sourceCode || sourceCode.trim().length === 0) {
            diagnostics.push("Empty source candidate rejected");
            syntaxValid = false;
        }
        if (sourceCode.includes("SYNTAX_ERROR") || sourceCode.includes("PARSE_FAILED")) {
            diagnostics.push("Parse error nodes detected in candidate AST");
            syntaxValid = false;
        }
        const securityPatterns = [
            { pattern: /\bdelete\s+auth/i, desc: "Touches authentication deletion" },
            { pattern: /\beval\s*\(/i, desc: "Uses dynamic eval execution" },
            { pattern: /\bexec\s*\(/i, desc: "Uses dynamic shell execution" },
            { pattern: /\bchild_process\b/i, desc: "Imports child_process" },
            { pattern: /isAdmin\s*=\s*true/i, desc: "Direct assignment to isAdmin flag" }
        ];
        for (const { pattern, desc } of securityPatterns) {
            if (pattern.test(sourceCode)) {
                riskFlags.push(desc);
                securityRiskDetected = true;
                diagnostics.push(`Security risk flag: ${desc}`);
            }
        }
        const astSummary = ASTSemanticAnalyzer.parseFile(sourceCode, `module.${extensionFor(grammarType)}`);
        if (astSummary.syntaxErrors.length > 0) {
            syntaxValid = false;
            diagnostics.push(...astSummary.syntaxErrors);
        }
        const unavailable = astSummary.unsupportedConstructs.filter(item => item.startsWith("Analysis unavailable:"));
        const unsafeConstructs = astSummary.unsupportedConstructs.filter(item => !item.startsWith("Analysis unavailable:"));
        if (unavailable.length > 0) {
            diagnostics.push(...unavailable);
        }
        if (unsafeConstructs.length > 0) {
            securityRiskDetected = true;
            riskFlags.push(...unsafeConstructs);
            diagnostics.push(...unsafeConstructs);
        }
        const staticChecks = VerificationGate.runStaticChecks(sourceCode, `candidate.${extensionFor(grammarType)}`, baseCode);
        const passed = syntaxValid && !securityRiskDetected && staticChecks.success;
        return {
            passed,
            typeCheckPass: null,
            lintPass: null,
            securityRiskDetected,
            riskFlags,
            diagnostics,
            staticChecks,
            notRun: ["full type checking", "lint", "runtime tests"]
        };
    }
}
function extensionFor(grammarType: string): string {
    if (grammarType === "tsx")
        return "tsx";
    if (grammarType === "javascript" || grammarType === "js")
        return "js";
    if (grammarType === "jsx")
        return "jsx";
    if (grammarType === "python")
        return "py";
    if (grammarType === "rust")
        return "rs";
    if (grammarType === "typescript")
        return "ts";
    return "unsupported";
}
