export interface AetherPolicyConfig {
    protectedPaths: string[];
    requireTypecheckPass: boolean;
    blockOnSecurityGuardRemoval: boolean;
    autoLandDisjointChanges: boolean;
    requireHumanForDeletions: boolean;
}
export const DEFAULT_AETHER_POLICY: AetherPolicyConfig = {
    protectedPaths: [
        ".github/",
        ".aether/",
        "wrangler.toml",
        "package.json",
        "package-lock.json",
        "src/security_gate.ts"
    ],
    requireTypecheckPass: true,
    blockOnSecurityGuardRemoval: true,
    autoLandDisjointChanges: true,
    requireHumanForDeletions: false
};
export interface PolicyEvaluationParams {
    filePath: string;
    affectedSymbols: string[];
    opsSummary: string[];
    newTypeErrorsCount: number;
    securityGuardRemoved: boolean;
    policyConfig?: Partial<AetherPolicyConfig>;
}
export interface PolicyDecision {
    canAutoLand: boolean;
    decision: "AUTO_LAND" | "NEEDS_HUMAN";
    reasons: string[];
    policySnapshot: AetherPolicyConfig;
}
export class PolicyEngine {
    public static evaluate(params: PolicyEvaluationParams): PolicyDecision {
        const config: AetherPolicyConfig = { ...DEFAULT_AETHER_POLICY, ...(params.policyConfig || {}) };
        const reasons: string[] = [];
        const isProtected = config.protectedPaths.some(p => params.filePath.startsWith(p) || params.filePath === p);
        if (isProtected) {
            reasons.push(`File '${params.filePath}' is protected by repository policy`);
        }
        if (config.requireTypecheckPass && params.newTypeErrorsCount > 0) {
            reasons.push(`Differential type check found ${params.newTypeErrorsCount} new errors`);
        }
        if (config.blockOnSecurityGuardRemoval && params.securityGuardRemoved) {
            reasons.push("Removal of authorization/security guards detected");
        }
        const canAutoLand = reasons.length === 0;
        return {
            canAutoLand,
            decision: canAutoLand ? "AUTO_LAND" : "NEEDS_HUMAN",
            reasons: canAutoLand ? ["All auto-land criteria satisfied (zero new type errors, unprotected path, intact guards)"] : reasons,
            policySnapshot: config
        };
    }
}
export interface GitTrailersParams {
    proposalId: string;
    agents: Array<{
        id: string;
        name?: string;
        email?: string;
    }>;
    intent: string;
    ops: string[];
    baseSha: string;
    newTypeErrors: number;
    decision: "auto" | string;
}
export class GitProvenance {
    public static formatCommitMessage(summary: string, params: GitTrailersParams): string {
        const lines: string[] = [];
        lines.push(summary);
        lines.push("");
        lines.push(`Aether-Proposal: ${params.proposalId}`);
        for (const a of params.agents) {
            lines.push(`Aether-Agent: ${a.id}`);
        }
        lines.push(`Aether-Intent: ${params.intent.replace(/\r?\n/g, " ").trim()}`);
        if (params.ops.length > 0) {
            lines.push(`Aether-Ops: ${params.ops.join(", ")}`);
        }
        lines.push(`Aether-Verified: typecheck-new=${params.newTypeErrors} base=${params.baseSha}`);
        lines.push(`Aether-Decision: ${params.decision}`);
        for (const a of params.agents) {
            const name = a.name || a.id;
            const email = a.email || `${a.id}@agents.aether.local`;
            lines.push(`Co-authored-by: ${name} <${email}>`);
        }
        return lines.join("\n") + "\n";
    }
    public static parseTrailers(message: string): Record<string, string | string[]> {
        const trailers: Record<string, string | string[]> = {};
        const lines = message.split("\n");
        for (const line of lines) {
            const match = line.match(/^(Aether-[A-Za-z]+|Co-authored-by):\s*(.*)$/);
            if (match) {
                const key = match[1];
                const val = match[2].trim();
                if (trailers[key]) {
                    if (Array.isArray(trailers[key])) {
                        (trailers[key] as string[]).push(val);
                    }
                    else {
                        trailers[key] = [trailers[key] as string, val];
                    }
                }
                else {
                    trailers[key] = val;
                }
            }
        }
        return trailers;
    }
}
