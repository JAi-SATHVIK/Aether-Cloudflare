export interface AgentActivity {
    agentId: string;
    branch: string;
    filePath: string;
    modifiedSymbols: string[];
    referencedSymbols: string[];
    updatedAt: number;
}
export interface CollisionWarning {
    severity: "DIRECT_CONFLICT" | "CALLER_DEPENDENCY";
    symbolName: string;
    filePath: string;
    agentsInvolved: string[];
    details: string;
}
export class CollisionRadar {
    private static activities = new Map<string, Map<string, AgentActivity>>();
    public static recordActivity(repoId: string, activity: AgentActivity): void {
        const key = `${repoId}:${activity.filePath}`;
        if (!this.activities.has(key)) {
            this.activities.set(key, new Map());
        }
        this.activities.get(key)!.set(activity.agentId, activity);
    }
    public static clearActivity(repoId: string, filePath: string, agentId: string): void {
        const key = `${repoId}:${filePath}`;
        if (this.activities.has(key)) {
            this.activities.get(key)!.delete(agentId);
        }
    }
    public static checkCollisions(repoId: string, agentId: string, filePath: string, targetSymbols: string[]): CollisionWarning[] {
        const warnings: CollisionWarning[] = [];
        const targetSet = new Set(targetSymbols);
        for (const [key, map] of this.activities.entries()) {
            const [rId, actFile] = key.split(":");
            if (rId !== repoId)
                continue;
            for (const [otherAgentId, act] of map.entries()) {
                if (otherAgentId === agentId)
                    continue;
                for (const sym of act.modifiedSymbols) {
                    if (targetSet.has(sym)) {
                        warnings.push({
                            severity: "DIRECT_CONFLICT",
                            symbolName: sym,
                            filePath: act.filePath,
                            agentsInvolved: [agentId, otherAgentId],
                            details: `Agent ${otherAgentId} is actively modifying symbol '${sym}' on branch '${act.branch}' in '${act.filePath}'`
                        });
                    }
                }
                for (const ref of act.referencedSymbols) {
                    if (targetSet.has(ref)) {
                        warnings.push({
                            severity: "CALLER_DEPENDENCY",
                            symbolName: ref,
                            filePath: act.filePath,
                            agentsInvolved: [agentId, otherAgentId],
                            details: `Agent ${otherAgentId} in '${act.filePath}' calls '${ref}' which you are modifying in '${filePath}'`
                        });
                    }
                }
            }
        }
        return warnings;
    }
    public static whatsHappening(repoId: string): Array<{
        agentId: string;
        filePath: string;
        branch: string;
        modifiedSymbols: string[];
        updatedAt: number;
    }> {
        const results: Array<{
            agentId: string;
            filePath: string;
            branch: string;
            modifiedSymbols: string[];
            updatedAt: number;
        }> = [];
        for (const [key, map] of this.activities.entries()) {
            const [rId, filePath] = key.split(":");
            if (rId !== repoId)
                continue;
            for (const act of map.values()) {
                results.push({
                    agentId: act.agentId,
                    filePath: act.filePath,
                    branch: act.branch,
                    modifiedSymbols: act.modifiedSymbols,
                    updatedAt: act.updatedAt
                });
            }
        }
        return results;
    }
}
