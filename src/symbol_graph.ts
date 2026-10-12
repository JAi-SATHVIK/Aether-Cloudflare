import { ASTSemanticAnalyzer } from "./ast_semantic_analyzer";
export interface SymbolDefinition {
    symbolName: string;
    nodeId: string;
    signatureHash: string;
    arity: number;
    maxArity: number | null;
    parameters: string[];
    filePath: string;
}
export interface SymbolReference {
    symbolName: string;
    callerNodeId: string;
    callSiteArgs: number | null;
    filePath: string;
}
export interface DependencyConflict {
    type: "SIGNATURE_ARITY_MISMATCH" | "CROSS_FUNCTION_SIGNATURE_COLLISION" | "UNDEFINED_SYMBOL_CALL" | "UNRESOLVED_SYMBOL_CALL";
    symbolName: string;
    defNodeId?: string;
    callerNodeId: string;
    expectedArity?: number;
    maxArity?: number | null;
    actualArgs?: number;
    reason: string;
}
export class SymbolDependencyGraph {
    public static extractSymbols(sourceCode: string, filePath: string): {
        definitions: SymbolDefinition[];
        references: SymbolReference[];
    } {
        const extension = filePath.toLowerCase().split(".").pop() || "";
        if (["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"].includes(extension)) {
            const summary = ASTSemanticAnalyzer.parseFile(sourceCode, filePath);
            if (summary.syntaxErrors.length > 0)
                return { definitions: [], references: [] };
            const definitions: SymbolDefinition[] = [];
            for (const definition of summary.definitions.values()) {
                if (definition.kind !== "function")
                    continue;
                const parameters = definition.parameters.map(parameter => parameter.name);
                const signature = definition.parameters.map(parameter => `${parameter.type || "?"}${parameter.optional ? "?" : ""}${parameter.rest ? "..." : ""}`).join(",") + `)->${definition.returnType || "?"}`;
                definitions.push({
                    symbolName: definition.name,
                    nodeId: `def:${filePath}:${definition.name}:${definition.span.line}:${definition.span.character}`,
                    signatureHash: SymbolDependencyGraph.hashString(signature),
                    arity: definition.arity,
                    maxArity: definition.parameters.some(parameter => parameter.rest) ? null : definition.parameters.length,
                    parameters,
                    filePath
                });
            }
            const references: SymbolReference[] = summary.callReferences.map(reference => ({
                symbolName: reference.calleeName,
                callerNodeId: `call:${filePath}:${reference.span.line}:${reference.span.character}:${reference.calleeName}`,
                callSiteArgs: reference.hasSpreadArguments ? null : reference.argCount,
                filePath
            }));
            return { definitions, references };
        }
        const definitions: SymbolDefinition[] = [];
        const references: SymbolReference[] = [];
        const defRegexes = [
            /\bdef\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(([^)]*)\)/g,
            /\bfunction\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(([^)]*)\)/g,
            /\b(?:const|let|var)\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>/g,
            /\bfn\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(([^)]*)\)/g
        ];
        for (const regex of defRegexes) {
            let match: RegExpExecArray | null;
            while ((match = regex.exec(sourceCode)) !== null) {
                const symbolName = match[1];
                const rawParams = match[2].trim();
                const parameters = rawParams.length > 0 ? splitTopLevelArguments(rawParams) : [];
                if (["if", "for", "while", "catch", "switch"].includes(symbolName))
                    continue;
                const requiredCount = parameters.filter(parameter => !parameter.includes("=") && !/^\*+/.test(parameter)).length;
                const hasRestParameter = parameters.some(parameter => /^\*+/.test(parameter));
                const signatureHash = SymbolDependencyGraph.hashString(parameters.join(","));
                definitions.push({
                    symbolName,
                    nodeId: `def:${filePath}:${symbolName}`,
                    signatureHash,
                    arity: requiredCount,
                    maxArity: hasRestParameter ? null : parameters.length,
                    parameters: parameters.map(parameter => parameter.split(/[:=]/)[0].trim()).filter(Boolean),
                    filePath
                });
            }
        }
        const callRegex = /\b([a-zA-Z_][a-zA-Z0-9_]*)\s*\(([^)]*)\)/g;
        let callMatch: RegExpExecArray | null;
        const definedNames = new Set(definitions.map(d => d.symbolName));
        while ((callMatch = callRegex.exec(sourceCode)) !== null) {
            const symbolName = callMatch[1];
            const matchIndex = callMatch.index;
            const prefix = sourceCode.slice(Math.max(0, matchIndex - 15), matchIndex);
            if (/(?:def|function|fn)\s+$/.test(prefix)) {
                continue;
            }
            if (["def", "function", "fn", "if", "for", "while", "catch", "switch", "return", "console", "Math"].includes(symbolName)) {
                continue;
            }
            const openParen = matchIndex + callMatch[0].lastIndexOf("(");
            const rawArgs = extractBalancedArguments(sourceCode, openParen);
            const argCount = rawArgs.trim().length > 0 ? splitTopLevelArguments(rawArgs).length : 0;
            references.push({
                symbolName,
                callerNodeId: `call:${filePath}:${symbolName}:${callMatch.index}`,
                callSiteArgs: argCount,
                filePath
            });
        }
        return { definitions, references };
    }
    public static checkDependencyConflicts(sql: SqlStorage, newDefs: SymbolDefinition[], newRefs: SymbolReference[], filePath: string): DependencyConflict[] {
        const conflicts: DependencyConflict[] = [];
        for (const def of newDefs) {
            const cursor = sql.exec(`
        SELECT caller_node_id, call_site_args, file_path
        FROM ast_symbol_references
        WHERE symbol_name = ?1;
      `, def.symbolName);
            for (const row of cursor) {
                const rawCallArgs = Number(row.call_site_args);
                const callerId = row.caller_node_id as string;
                const callerFile = row.file_path as string;
                if (callerFile === filePath)
                    continue;
                if (rawCallArgs < 0) {
                    conflicts.push({
                        type: "UNRESOLVED_SYMBOL_CALL",
                        symbolName: def.symbolName,
                        defNodeId: def.nodeId,
                        callerNodeId: callerId,
                        expectedArity: def.arity,
                        maxArity: def.maxArity,
                        reason: `Call site in ${callerFile} uses spread arguments, so its arity cannot be verified against '${def.symbolName}'.`
                    });
                    continue;
                }
                const callArgs = rawCallArgs;
                if (!acceptsArity(def.arity, def.maxArity, callArgs)) {
                    conflicts.push({
                        type: "SIGNATURE_ARITY_MISMATCH",
                        symbolName: def.symbolName,
                        defNodeId: def.nodeId,
                        callerNodeId: callerId,
                        expectedArity: def.arity,
                        maxArity: def.maxArity,
                        actualArgs: callArgs,
                        reason: `Cross-function signature conflict: '${def.symbolName}' in ${filePath} accepts ${describeArity(def.arity, def.maxArity)}, but caller in ${callerFile} passes ${callArgs} arguments.`
                    });
                }
            }
        }
        for (const ref of newRefs) {
            const cursor = sql.exec(`
        SELECT node_id, arity, max_arity, file_path
        FROM ast_symbol_definitions
        WHERE symbol_name = ?1;
      `, ref.symbolName);
            const rows = [...cursor];
            for (const defRow of rows) {
                const defFile = defRow.file_path as string;
                if (defFile === filePath)
                    continue;
                const defArity = defRow.arity as number;
                const maxArity = defRow.max_arity === null || defRow.max_arity === undefined ? null : Number(defRow.max_arity);
                if (ref.callSiteArgs === null) {
                    conflicts.push({
                        type: "UNRESOLVED_SYMBOL_CALL",
                        symbolName: ref.symbolName,
                        defNodeId: defRow.node_id as string,
                        callerNodeId: ref.callerNodeId,
                        expectedArity: defArity,
                        maxArity,
                        reason: `Call site in ${filePath} uses spread arguments, so its arity cannot be verified against '${ref.symbolName}'.`
                    });
                    continue;
                }
                if (!acceptsArity(defArity, maxArity, ref.callSiteArgs)) {
                    conflicts.push({
                        type: "SIGNATURE_ARITY_MISMATCH",
                        symbolName: ref.symbolName,
                        defNodeId: defRow.node_id as string,
                        callerNodeId: ref.callerNodeId,
                        expectedArity: defArity,
                        maxArity,
                        actualArgs: ref.callSiteArgs,
                        reason: `Call site in ${filePath} supplies ${ref.callSiteArgs} arguments to '${ref.symbolName}', but definition in ${defFile} accepts ${describeArity(defArity, maxArity)}.`
                    });
                }
            }
        }
        for (const ref of newRefs) {
            for (const def of newDefs) {
                if (def.symbolName !== ref.symbolName)
                    continue;
                if (ref.callSiteArgs === null) {
                    conflicts.push({
                        type: "UNRESOLVED_SYMBOL_CALL",
                        symbolName: ref.symbolName,
                        defNodeId: def.nodeId,
                        callerNodeId: ref.callerNodeId,
                        expectedArity: def.arity,
                        maxArity: def.maxArity,
                        reason: `Call site in ${filePath} uses spread arguments, so its arity cannot be verified against '${ref.symbolName}'.`
                    });
                    continue;
                }
                if (acceptsArity(def.arity, def.maxArity, ref.callSiteArgs))
                    continue;
                conflicts.push({
                    type: "SIGNATURE_ARITY_MISMATCH",
                    symbolName: ref.symbolName,
                    defNodeId: def.nodeId,
                    callerNodeId: ref.callerNodeId,
                    expectedArity: def.arity,
                    maxArity: def.maxArity,
                    actualArgs: ref.callSiteArgs,
                    reason: `Call site in ${filePath} supplies ${ref.callSiteArgs} arguments to '${ref.symbolName}', but its candidate definition accepts ${describeArity(def.arity, def.maxArity)}.`
                });
            }
        }
        return conflicts;
    }
    public static updateSymbolIndex(sql: SqlStorage, defs: SymbolDefinition[], refs: SymbolReference[], filePath: string): void {
        sql.exec(`DELETE FROM ast_symbol_definitions WHERE file_path = ?1;`, filePath);
        sql.exec(`DELETE FROM ast_symbol_references WHERE file_path = ?1;`, filePath);
        for (const d of defs) {
            sql.exec(`
        INSERT INTO ast_symbol_definitions (symbol_name, node_id, signature_hash, arity, max_arity, file_path)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6)
        ON CONFLICT(symbol_name, file_path) DO UPDATE SET
          signature_hash = excluded.signature_hash,
          arity = excluded.arity,
          max_arity = excluded.max_arity;
      `, d.symbolName, d.nodeId, d.signatureHash, d.arity, d.maxArity, filePath);
        }
        for (const r of refs) {
            sql.exec(`
        INSERT INTO ast_symbol_references (symbol_name, caller_node_id, call_site_args, file_path)
        VALUES (?1, ?2, ?3, ?4);
      `, r.symbolName, r.callerNodeId, r.callSiteArgs === null ? -1 : r.callSiteArgs, filePath);
        }
    }
    private static hashString(input: string): string {
        let hash = 0;
        for (let i = 0; i < input.length; i++) {
            hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0;
        }
        return Math.abs(hash).toString(16).padStart(16, "0");
    }
}
function acceptsArity(minimum: number, maximum: number | null, actual: number): boolean {
    return actual >= minimum && (maximum === null || actual <= maximum);
}
function describeArity(minimum: number, maximum: number | null): string {
    if (maximum === null)
        return `at least ${minimum} arguments`;
    return minimum === maximum ? `${minimum} arguments` : `between ${minimum} and ${maximum} arguments`;
}
function splitTopLevelArguments(source: string): string[] {
    const parts: string[] = [];
    let start = 0;
    let nesting = 0;
    let quote = "";
    let escaped = false;
    const closingFor: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
    const openings = new Set(Object.keys(closingFor));
    for (let index = 0; index < source.length; index++) {
        const character = source[index];
        if (quote) {
            if (escaped)
                escaped = false;
            else if (character === "\\")
                escaped = true;
            else if (character === quote)
                quote = "";
            continue;
        }
        if (character === "'" || character === '"' || character === "`") {
            quote = character;
            continue;
        }
        if (openings.has(character))
            nesting++;
        else if (character === ")" || character === "]" || character === "}")
            nesting = Math.max(0, nesting - 1);
        else if (character === "," && nesting === 0) {
            const part = source.slice(start, index).trim();
            if (part)
                parts.push(part);
            start = index + 1;
        }
    }
    const last = source.slice(start).trim();
    if (last)
        parts.push(last);
    return parts;
}
function extractBalancedArguments(source: string, openParenIndex: number): string {
    if (source[openParenIndex] !== "(")
        return "";
    let depth = 0;
    let quote = "";
    let escaped = false;
    for (let index = openParenIndex; index < source.length; index++) {
        const character = source[index];
        if (quote) {
            if (escaped)
                escaped = false;
            else if (character === "\\")
                escaped = true;
            else if (character === quote)
                quote = "";
            continue;
        }
        if (character === "'" || character === '"' || character === "`") {
            quote = character;
            continue;
        }
        if (character === "(")
            depth++;
        else if (character === ")" && --depth === 0)
            return source.slice(openParenIndex + 1, index);
    }
    return "";
}
