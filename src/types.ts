export type MutationKind = "INSERT" | "UPDATE" | "DELETE" | "MOVE" | "SUPERPOSITION";
export interface LamportClock {
    counter: number;
    agentId: string;
}
export interface ASTMutationPayload {
    kind: MutationKind;
    nodeId: string;
    symbolId?: string;
    parentId: string | null;
    grammarType: string;
    posFractional: string;
    attrKey?: string;
    attrVal?: string;
    previousAttrVal?: string;
    triviaLead?: string;
    triviaTrail?: string;
    lamport: LamportClock;
    vectorClock?: Record<string, number>;
    previousParentId?: string | null;
    previousPos?: string;
    alphaHash?: string;
}
export interface SignedMutationEnvelope {
    payload: ASTMutationPayload;
    payloadBytes: Uint8Array;
    signature: Uint8Array;
    signerPublicKey: string;
    mutationHash: string;
}
export interface ArtifactsCreateRepoResult {
    id: string;
    name: string;
    description?: string | null;
    remote: string;
    defaultBranch: string;
    token: string;
}
export interface ArtifactsCreateTokenResult {
    id: string;
    plaintext: string;
    scope: "read" | "write";
    expiresAt: string;
}
export interface ArtifactsRepoInfo {
    id?: string;
    name: string;
    remote: string;
    defaultBranch: string;
    readOnly: boolean;
    description?: string;
}
export interface ArtifactsRepo {
    createToken(scope?: "read" | "write", ttlSeconds?: number): Promise<ArtifactsCreateTokenResult>;
    info(): Promise<ArtifactsRepoInfo>;
    log?(options?: {
        ref?: string;
        limit?: number;
        offset?: number;
    }): Promise<Array<{
        hash: string;
        message: string;
        parents: string[];
    }>>;
    readFile?(args: {
        ref: string;
        path: string;
    }): Promise<Blob | null>;
    fork(targetName: string, options?: {
        description?: string;
        readOnly?: boolean;
        defaultBranchOnly?: boolean;
    }): Promise<ArtifactsCreateRepoResult>;
    fs?: unknown;
    headSha?: string;
    [Symbol.dispose]?: () => void;
}
export interface ArtifactsBinding {
    create(name: string, opts?: {
        readOnly?: boolean;
        description?: string;
        setDefaultBranch?: string;
    }): Promise<ArtifactsCreateRepoResult>;
    get(name: string): Promise<ArtifactsRepo>;
    list?(opts?: {
        limit?: number;
        cursor?: string;
    }): Promise<{
        repos: ArtifactsRepoInfo[];
        cursor?: string;
    }>;
    delete?(name: string): Promise<{
        success: boolean;
    }>;
    createRepository?(name: string, options?: {
        private?: boolean;
    }): Promise<{
        id: string;
        name: string;
        cloneUrl: string;
    }>;
    createToken?(repo: string, options: {
        scope: "read" | "write";
        ttlSeconds?: number;
    }): Promise<ArtifactsCreateTokenResult>;
    getRepository?(name: string): Promise<{
        id: string;
        name: string;
        defaultBranch: string;
    } | null>;
}
export interface ArtifactsQueueEvent {
    type: "cf.artifacts.repo.pushed" | "cf.artifacts.repo.forked" | "cf.artifacts.repo.created" | string;
    source?: string | {
        type?: string;
        namespace?: string;
        repoName?: string;
    };
    payload?: {
        ref?: string;
        before?: string;
        after?: string;
        pusher?: string | {
            name?: string;
        };
        repo?: string;
        commit_sha?: string;
        before_sha?: string;
    };
    metadata?: Record<string, string>;
}
export type ArtifactsPushEvent = ArtifactsQueueEvent;
export interface ArbitrationAuditEvent {
    decisionId: string;
    targetParentId: string;
    intent: string;
    winnerCandidateId: string | null;
    status: "ADMITTED" | "FLAGGED_HUMAN_REVIEW" | "REJECTED_STATIC_INVARIANTS";
    rationale: string;
    staticAnalysisPass: boolean;
    typeCheckPass: boolean;
    advisoryLlmEvaluated: boolean;
    timestamp: number;
}
export interface Env {
    MODULE_SHARD_DO: DurableObjectNamespace;
    MESH_COORDINATOR_DO: DurableObjectNamespace;
    AI: Ai;
    SEMANTIC_INDEX: VectorizeIndex;
    ARCHIVE_BUCKET: R2Bucket;
    ARTIFACTS?: ArtifactsBinding;
    ARTIFACTS_QUEUE?: Queue<ArtifactsQueueEvent>;
    ASSETS?: Fetcher;
    GRAMMAR_ASSETS?: Fetcher;
    AETHER_AUTH_SECRET?: string;
    ENVIRONMENT?: string;
    AETHER_WEBHOOK_SECRET?: string;
}
export type DurableObjectLocationHint = "wnam" | "enam" | "sam" | "weur" | "eeur" | "apac" | "oc";
