import { Env } from "./types";
import ts from "typescript";
export interface SemanticAdmissionResult {
    action: "DEDUPLICATED" | "SUPERPOSITION" | "ADMIT_COMMITTED";
    targetNodeId: string;
    alphaHash: string;
    duplicateOf?: string;
    cosineScore: number;
}
export class SemanticImmuneSystem {
    public static async computeAlphaNormalizedAST(source: string): Promise<{
        normalized: string;
        alphaHash: string;
    }> {
        const fileName = "aether-candidate.tsx";
        const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
        const renameAt = new Map<number, string>();
        const parseDiagnostics = (sourceFile as ts.SourceFile & {
            parseDiagnostics: readonly ts.Diagnostic[];
        }).parseDiagnostics;
        if (parseDiagnostics.length === 0) {
            const options: ts.CompilerOptions = {
                allowJs: true,
                checkJs: false,
                noResolve: true,
                noLib: true,
                target: ts.ScriptTarget.Latest
            };
            const host = ts.createCompilerHost(options);
            const isCandidateFile = (requestedFile: string): boolean => requestedFile.replace(/\\/g, "/").endsWith("/aether-candidate.tsx") || requestedFile === fileName;
            host.getSourceFile = (requestedFile, _languageVersion) => isCandidateFile(requestedFile) ? sourceFile : undefined;
            host.fileExists = requestedFile => isCandidateFile(requestedFile);
            host.readFile = requestedFile => isCandidateFile(requestedFile) ? source : undefined;
            const program = ts.createProgram([fileName], options, host);
            const checker = program.getTypeChecker();
            const localNames = new Map<ts.Symbol, string>();
            let nextLocal = 0;
            const isInsideFunction = (declaration: ts.Declaration): boolean => {
                let parent: ts.Node | undefined = declaration.parent;
                while (parent && !ts.isSourceFile(parent)) {
                    if (ts.isFunctionLike(parent))
                        return true;
                    parent = parent.parent;
                }
                return false;
            };
            const isLocalBinding = (symbol: ts.Symbol): boolean => (symbol.declarations || []).some(declaration => isInsideFunction(declaration) && (ts.isParameter(declaration) ||
                ts.isVariableDeclaration(declaration) ||
                ts.isBindingElement(declaration) ||
                ts.isFunctionDeclaration(declaration)));
            const visit = (node: ts.Node): void => {
                if (ts.isIdentifier(node)) {
                    const symbol = checker.getSymbolAtLocation(node);
                    if (symbol && isLocalBinding(symbol)) {
                        let replacement = localNames.get(symbol);
                        if (!replacement) {
                            replacement = `_local${nextLocal++}`;
                            localNames.set(symbol, replacement);
                        }
                        renameAt.set(node.getStart(sourceFile), replacement);
                    }
                }
                ts.forEachChild(node, visit);
            };
            visit(sourceFile);
        }
        const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.JSX, source);
        const tokens: string[] = [];
        while (scanner.scan() !== ts.SyntaxKind.EndOfFileToken) {
            const kind = scanner.getToken();
            const start = scanner.getTokenPos();
            const text = renameAt.get(start) || scanner.getTokenText();
            tokens.push(`${kind}:${JSON.stringify(text)}`);
        }
        const normalized = tokens.join("|");
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized));
        const alphaHash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
        return { normalized, alphaHash };
    }
    public async evaluateMutationWithStorage(sourceText: string, candidateNodeId: string, sql: SqlStorage, env: Env): Promise<SemanticAdmissionResult> {
        const { normalized, alphaHash } = await SemanticImmuneSystem.computeAlphaNormalizedAST(sourceText);
        const cursor = sql.exec(`
      SELECT node_id FROM ast_nodes
      WHERE node_id IN (
        SELECT node_id FROM ast_attributes
        WHERE attr_key = '__alpha_hash' AND attr_val = ?1
      ) AND is_alive = 1;
    `, alphaHash);
        const existingRows = [...cursor];
        if (existingRows.length > 0) {
            const existingNodeId = existingRows[0].node_id as string;
            return {
                action: "DEDUPLICATED",
                targetNodeId: existingNodeId,
                alphaHash,
                duplicateOf: existingNodeId,
                cosineScore: 1.0
            };
        }
        if (env.AI && env.SEMANTIC_INDEX) {
            try {
                const embeddingRes = await env.AI.run("@cf/baai/bge-base-en-v1.5", {
                    text: [normalized]
                }) as {
                    data: number[][];
                };
                const vector = embeddingRes.data[0];
                const searchRes = await env.SEMANTIC_INDEX.query(vector, { topK: 1 });
                if (searchRes.matches && searchRes.matches.length > 0) {
                    const top = searchRes.matches[0];
                    if (top.score >= 0.98) {
                        return {
                            action: "DEDUPLICATED",
                            targetNodeId: top.id,
                            alphaHash,
                            duplicateOf: top.id,
                            cosineScore: top.score
                        };
                    }
                    if (top.score >= 0.90 && top.score < 0.98) {
                        return {
                            action: "SUPERPOSITION",
                            targetNodeId: candidateNodeId,
                            alphaHash,
                            cosineScore: top.score
                        };
                    }
                }
                if (typeof (env.SEMANTIC_INDEX as any).upsert === "function") {
                    await (env.SEMANTIC_INDEX as any).upsert([
                        {
                            id: candidateNodeId,
                            values: vector,
                            metadata: { alphaHash, timestamp: Date.now() }
                        }
                    ]);
                }
            }
            catch {
            }
        }
        return {
            action: "ADMIT_COMMITTED",
            targetNodeId: candidateNodeId,
            alphaHash,
            cosineScore: 0.0
        };
    }
    public static async evaluateProposalDeduplication(candidateCode: string, candidateProposalId: string, activeProposals: Array<{
        id: string;
        patchContent: string;
        intentDescription?: string;
    }>, env?: Env): Promise<{
        isDuplicate: boolean;
        duplicateOf?: string;
        alphaHash: string;
        cosineScore: number;
    }> {
        const { normalized, alphaHash } = await SemanticImmuneSystem.computeAlphaNormalizedAST(candidateCode);
        for (const other of activeProposals) {
            if (other.id === candidateProposalId)
                continue;
            const otherNorm = await SemanticImmuneSystem.computeAlphaNormalizedAST(other.patchContent);
            if (otherNorm.alphaHash === alphaHash) {
                return {
                    isDuplicate: true,
                    duplicateOf: other.id,
                    alphaHash,
                    cosineScore: 1.0
                };
            }
        }
        if (env?.AI && env?.SEMANTIC_INDEX) {
            try {
                const embeddingRes = await env.AI.run("@cf/baai/bge-base-en-v1.5", {
                    text: [normalized.slice(0, 1000)]
                }) as {
                    data: number[][];
                };
                const vector = embeddingRes.data[0];
                const searchRes = await env.SEMANTIC_INDEX.query(vector, { topK: 1 });
                if (searchRes.matches && searchRes.matches.length > 0) {
                    const top = searchRes.matches[0];
                    if (top.score >= 0.98) {
                        return {
                            isDuplicate: true,
                            duplicateOf: top.id,
                            alphaHash,
                            cosineScore: top.score
                        };
                    }
                }
                if (typeof (env.SEMANTIC_INDEX as any).upsert === "function") {
                    await (env.SEMANTIC_INDEX as any).upsert([
                        {
                            id: candidateProposalId,
                            values: vector,
                            metadata: { alphaHash, timestamp: Date.now() }
                        }
                    ]);
                }
            }
            catch {
            }
        }
        return {
            isDuplicate: false,
            alphaHash,
            cosineScore: 0.0
        };
    }
}
