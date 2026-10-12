import ts from "typescript";
export type AnalysisOutcome = "SAFE_INTEGRATION" | "POTENTIAL_INTERACTION" | "UNRESOLVED_CONFLICT";
export interface SourceSpan {
    line: number;
    character: number;
    length: number;
}
export interface SymbolDef {
    name: string;
    kind: "function" | "method" | "interface" | "class" | "type";
    filePath: string;
    parameters: Array<{
        name: string;
        type?: string;
        optional: boolean;
        rest?: boolean;
    }>;
    maxArity?: number | null;
    arity: number;
    returnType?: string;
    isExported: boolean;
    span: SourceSpan;
    bodySpan?: SourceSpan;
    rawText: string;
}
export interface CallReference {
    calleeName: string;
    filePath: string;
    argCount: number;
    hasSpreadArguments: boolean;
    span: SourceSpan;
    enclosingSymbol?: string;
}
export interface FileASTSummary {
    filePath: string;
    syntaxErrors: string[];
    unsupportedConstructs: string[];
    definitions: Map<string, SymbolDef>;
    callReferences: CallReference[];
    imports: Array<{
        specifier: string;
        symbols: string[];
    }>;
    exports: string[];
}
export interface SemanticInteraction {
    type: "SIGNATURE_CALL_MISMATCH" | "INTERFACE_COLLISION" | "LEXICAL_OVERLAP" | "SECURITY_GUARD_REMOVED" | "SYNTAX_ERROR" | "UNSUPPORTED_SYNTAX";
    affectedSymbol: string;
    filePath: string;
    sourceSpan?: SourceSpan;
    reason: string;
    agentsInvolved?: string[];
    intents?: string[];
}
export interface SemanticAnalysisReport {
    outcome: AnalysisOutcome;
    summary: string;
    interactions: SemanticInteraction[];
    canAutoMerge: boolean;
    affectedSymbols: string[];
    diagnostics: string[];
    synthesizedCode?: string;
}
export class ASTSemanticAnalyzer {
    public static parseFile(sourceCode: string, filePath: string): FileASTSummary {
        const extension = filePath.toLowerCase().split(".").pop() || "";
        const scriptKind = extension === "tsx" ? ts.ScriptKind.TSX
            : extension === "jsx" ? ts.ScriptKind.JSX
                : ["js", "mjs", "cjs"].includes(extension) ? ts.ScriptKind.JS
                    : ["ts", "mts", "cts"].includes(extension) ? ts.ScriptKind.TS
                        : null;
        if (scriptKind === null) {
            return {
                filePath,
                syntaxErrors: [],
                unsupportedConstructs: [`Analysis unavailable: no language parser is configured for .${extension || "(no extension)"} files.`],
                definitions: new Map(),
                callReferences: [],
                imports: [],
                exports: []
            };
        }
        const sourceFile = ts.createSourceFile(filePath, sourceCode, ts.ScriptTarget.Latest, true, scriptKind);
        const syntaxErrors: string[] = [];
        const parseDiags = (sourceFile as any).parseDiagnostics;
        if (parseDiags && Array.isArray(parseDiags) && parseDiags.length > 0) {
            for (const diag of parseDiags) {
                syntaxErrors.push(ts.flattenDiagnosticMessageText(diag.messageText, "\n"));
            }
        }
        const definitions = new Map<string, SymbolDef>();
        const callReferences: CallReference[] = [];
        const imports: Array<{
            specifier: string;
            symbols: string[];
        }> = [];
        const exports: string[] = [];
        const unsupportedConstructs: string[] = [];
        let currentEnclosingSymbol: string | undefined;
        const visit = (node: ts.Node) => {
            if (ts.isIdentifier(node) && node.text === "eval") {
                unsupportedConstructs.push(`Dynamic 'eval' at line ${sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
            }
            if (ts.isImportDeclaration(node)) {
                const specifier = node.moduleSpecifier.getText(sourceFile).replace(/['"]/g, "");
                const symbols: string[] = [];
                if (node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
                    for (const elt of node.importClause.namedBindings.elements) {
                        symbols.push(elt.name.getText(sourceFile));
                    }
                }
                imports.push({ specifier, symbols });
            }
            if (ts.isFunctionDeclaration(node) && node.name) {
                const name = node.name.getText(sourceFile);
                const prevEnclosing = currentEnclosingSymbol;
                currentEnclosingSymbol = name;
                const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
                const parameters = node.parameters.map(p => ({
                    name: p.name.getText(sourceFile),
                    type: p.type ? p.type.getText(sourceFile) : undefined,
                    optional: !!p.questionToken || !!p.initializer || !!p.dotDotDotToken,
                    rest: !!p.dotDotDotToken
                }));
                const isExported = !!(ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Export);
                if (isExported)
                    exports.push(name);
                const bodySpan = node.body ? {
                    line: sourceFile.getLineAndCharacterOfPosition(node.body.getStart(sourceFile)).line + 1,
                    character: sourceFile.getLineAndCharacterOfPosition(node.body.getStart(sourceFile)).character,
                    length: node.body.getWidth(sourceFile)
                } : undefined;
                definitions.set(name, {
                    name,
                    kind: "function",
                    filePath,
                    parameters,
                    maxArity: parameters.some(parameter => parameter.rest) ? null : parameters.length,
                    arity: parameters.filter(p => !p.optional).length,
                    returnType: node.type ? node.type.getText(sourceFile) : undefined,
                    isExported,
                    span: {
                        line: pos.line + 1,
                        character: pos.character,
                        length: node.getWidth(sourceFile)
                    },
                    bodySpan,
                    rawText: node.getText(sourceFile)
                });
                ts.forEachChild(node, visit);
                currentEnclosingSymbol = prevEnclosing;
                return;
            }
            if (ts.isVariableStatement(node)) {
                const isExported = !!(node.modifiers && node.modifiers.some(m => m.kind === ts.SyntaxKind.ExportKeyword));
                for (const decl of node.declarationList.declarations) {
                    if (decl.initializer && (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer)) && ts.isIdentifier(decl.name)) {
                        const name = decl.name.getText(sourceFile);
                        const fn = decl.initializer;
                        const pos = sourceFile.getLineAndCharacterOfPosition(decl.getStart(sourceFile));
                        const parameters = fn.parameters.map(p => ({
                            name: p.name.getText(sourceFile),
                            type: p.type ? p.type.getText(sourceFile) : undefined,
                            optional: !!p.questionToken || !!p.initializer || !!p.dotDotDotToken,
                            rest: !!p.dotDotDotToken
                        }));
                        if (isExported)
                            exports.push(name);
                        definitions.set(name, {
                            name,
                            kind: "function",
                            filePath,
                            parameters,
                            maxArity: parameters.some(parameter => parameter.rest) ? null : parameters.length,
                            arity: parameters.filter(p => !p.optional).length,
                            returnType: fn.type ? fn.type.getText(sourceFile) : undefined,
                            isExported,
                            span: {
                                line: pos.line + 1,
                                character: pos.character,
                                length: decl.getWidth(sourceFile)
                            },
                            rawText: decl.getText(sourceFile)
                        });
                    }
                }
            }
            if (ts.isInterfaceDeclaration(node)) {
                const name = node.name.getText(sourceFile);
                const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
                const isExported = !!(ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Export);
                if (isExported)
                    exports.push(name);
                definitions.set(name, {
                    name,
                    kind: "interface",
                    filePath,
                    parameters: [],
                    arity: 0,
                    isExported,
                    span: {
                        line: pos.line + 1,
                        character: pos.character,
                        length: node.getWidth(sourceFile)
                    },
                    rawText: node.getText(sourceFile)
                });
            }
            if (ts.isCallExpression(node)) {
                let calleeName = "";
                if (ts.isIdentifier(node.expression)) {
                    calleeName = node.expression.getText(sourceFile);
                }
                else if (ts.isPropertyAccessExpression(node.expression)) {
                    calleeName = node.expression.name.getText(sourceFile);
                }
                if (calleeName && !["log", "warn", "error", "push", "map", "filter", "reduce", "slice"].includes(calleeName)) {
                    const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
                    callReferences.push({
                        calleeName,
                        filePath,
                        argCount: node.arguments.length,
                        hasSpreadArguments: node.arguments.some(argument => ts.isSpreadElement(argument)),
                        span: {
                            line: pos.line + 1,
                            character: pos.character,
                            length: node.getWidth(sourceFile)
                        },
                        enclosingSymbol: currentEnclosingSymbol
                    });
                }
            }
            ts.forEachChild(node, visit);
        };
        visit(sourceFile);
        return {
            filePath,
            syntaxErrors,
            unsupportedConstructs,
            definitions,
            callReferences,
            imports,
            exports
        };
    }
    public static analyzeProposals(params: {
        baseCode: string;
        filePath: string;
        proposalA: {
            agentId: string;
            intent: string;
            code: string;
        };
        proposalB: {
            agentId: string;
            intent: string;
            code: string;
        };
    }): SemanticAnalysisReport {
        const { baseCode, filePath, proposalA, proposalB } = params;
        const baseSummary = this.parseFile(baseCode, filePath);
        const summaryA = this.parseFile(proposalA.code, filePath);
        const summaryB = this.parseFile(proposalB.code, filePath);
        const interactions: SemanticInteraction[] = [];
        const diagnostics: string[] = [];
        const affectedSymbols = new Set<string>();
        if (summaryA.syntaxErrors.length > 0) {
            interactions.push({
                type: "SYNTAX_ERROR",
                affectedSymbol: "FILE_SYNTAX",
                filePath,
                reason: `Proposal from ${proposalA.agentId} contains TypeScript parse errors: ${summaryA.syntaxErrors.join("; ")}`,
                agentsInvolved: [proposalA.agentId],
                intents: [proposalA.intent]
            });
        }
        if (summaryB.syntaxErrors.length > 0) {
            interactions.push({
                type: "SYNTAX_ERROR",
                affectedSymbol: "FILE_SYNTAX",
                filePath,
                reason: `Proposal from ${proposalB.agentId} contains TypeScript parse errors: ${summaryB.syntaxErrors.join("; ")}`,
                agentsInvolved: [proposalB.agentId],
                intents: [proposalB.intent]
            });
        }
        if (summaryA.unsupportedConstructs.length > 0 || summaryB.unsupportedConstructs.length > 0) {
            const allUnsupported = [...summaryA.unsupportedConstructs, ...summaryB.unsupportedConstructs];
            interactions.push({
                type: "UNSUPPORTED_SYNTAX",
                affectedSymbol: "DYNAMIC_CONSTRUCT",
                filePath,
                reason: `Analysis uncertain due to dynamic constructs: ${allUnsupported.join(", ")}`,
                agentsInvolved: [proposalA.agentId, proposalB.agentId],
                intents: [proposalA.intent, proposalB.intent]
            });
        }
        const securityPatterns = ["isAdmin", "verifyToken", "authKey", "checkPermission", "hasAccess"];
        for (const pattern of securityPatterns) {
            if (baseCode.includes(pattern)) {
                if (!proposalA.code.includes(pattern)) {
                    interactions.push({
                        type: "SECURITY_GUARD_REMOVED",
                        affectedSymbol: pattern,
                        filePath,
                        reason: `Proposal from ${proposalA.agentId} removed authorization guard '${pattern}' present in base commit`,
                        agentsInvolved: [proposalA.agentId],
                        intents: [proposalA.intent]
                    });
                }
                if (!proposalB.code.includes(pattern)) {
                    interactions.push({
                        type: "SECURITY_GUARD_REMOVED",
                        affectedSymbol: pattern,
                        filePath,
                        reason: `Proposal from ${proposalB.agentId} removed authorization guard '${pattern}' present in base commit`,
                        agentsInvolved: [proposalB.agentId],
                        intents: [proposalB.intent]
                    });
                }
            }
        }
        const modifiedSymbolsA = new Set<string>();
        const modifiedSymbolsB = new Set<string>();
        for (const [name, defA] of summaryA.definitions.entries()) {
            const baseDef = baseSummary.definitions.get(name);
            if (!baseDef || baseDef.rawText !== defA.rawText) {
                modifiedSymbolsA.add(name);
                affectedSymbols.add(name);
            }
        }
        for (const [name, defB] of summaryB.definitions.entries()) {
            const baseDef = baseSummary.definitions.get(name);
            if (!baseDef || baseDef.rawText !== defB.rawText) {
                modifiedSymbolsB.add(name);
                affectedSymbols.add(name);
            }
        }
        for (const symbol of modifiedSymbolsA) {
            if (modifiedSymbolsB.has(symbol)) {
                const defA = summaryA.definitions.get(symbol)!;
                const defB = summaryB.definitions.get(symbol)!;
                if (defA.rawText !== defB.rawText) {
                    interactions.push({
                        type: "LEXICAL_OVERLAP",
                        affectedSymbol: symbol,
                        filePath,
                        sourceSpan: defA.span,
                        reason: `Both ${proposalA.agentId} and ${proposalB.agentId} modified '${symbol}' with conflicting implementations`,
                        agentsInvolved: [proposalA.agentId, proposalB.agentId],
                        intents: [proposalA.intent, proposalB.intent]
                    });
                }
            }
        }
        for (const [name, defA] of summaryA.definitions.entries()) {
            const baseDef = baseSummary.definitions.get(name);
            if (baseDef && hasArityRangeChanged(baseDef, defA)) {
                for (const callB of summaryB.callReferences) {
                    if (callB.calleeName !== name)
                        continue;
                    if (callB.hasSpreadArguments) {
                        interactions.push({
                            type: "UNSUPPORTED_SYNTAX",
                            affectedSymbol: name,
                            filePath,
                            sourceSpan: callB.span,
                            reason: `Cannot verify the spread-argument call to '${name}' against the changed signature; manual review is required.`,
                            agentsInvolved: [proposalA.agentId, proposalB.agentId],
                            intents: [proposalA.intent, proposalB.intent]
                        });
                    }
                    else if (!acceptsArity(defA, callB.argCount)) {
                        interactions.push({
                            type: "SIGNATURE_CALL_MISMATCH",
                            affectedSymbol: name,
                            filePath,
                            sourceSpan: callB.span,
                            reason: `${proposalA.agentId} modified signature of '${name}' (arity ${formatArity(baseDef)} -> ${formatArity(defA)}), but ${proposalB.agentId} calls '${name}' with ${callB.argCount} arguments at line ${callB.span.line}`,
                            agentsInvolved: [proposalA.agentId, proposalB.agentId],
                            intents: [proposalA.intent, proposalB.intent]
                        });
                    }
                }
            }
        }
        for (const [name, defB] of summaryB.definitions.entries()) {
            const baseDef = baseSummary.definitions.get(name);
            if (baseDef && hasArityRangeChanged(baseDef, defB)) {
                for (const callA of summaryA.callReferences) {
                    if (callA.calleeName !== name)
                        continue;
                    if (callA.hasSpreadArguments) {
                        interactions.push({
                            type: "UNSUPPORTED_SYNTAX",
                            affectedSymbol: name,
                            filePath,
                            sourceSpan: callA.span,
                            reason: `Cannot verify the spread-argument call to '${name}' against the changed signature; manual review is required.`,
                            agentsInvolved: [proposalA.agentId, proposalB.agentId],
                            intents: [proposalA.intent, proposalB.intent]
                        });
                    }
                    else if (!acceptsArity(defB, callA.argCount)) {
                        interactions.push({
                            type: "SIGNATURE_CALL_MISMATCH",
                            affectedSymbol: name,
                            filePath,
                            sourceSpan: callA.span,
                            reason: `${proposalB.agentId} modified signature of '${name}' (arity ${formatArity(baseDef)} -> ${formatArity(defB)}), but ${proposalA.agentId} calls '${name}' with ${callA.argCount} arguments at line ${callA.span.line}`,
                            agentsInvolved: [proposalA.agentId, proposalB.agentId],
                            intents: [proposalA.intent, proposalB.intent]
                        });
                    }
                }
            }
        }
        const hasSyntaxError = interactions.some(i => i.type === "SYNTAX_ERROR");
        const hasSecurityRisk = interactions.some(i => i.type === "SECURITY_GUARD_REMOVED");
        const hasLexicalOverlap = interactions.some(i => i.type === "LEXICAL_OVERLAP");
        const hasSignatureMismatch = interactions.some(i => i.type === "SIGNATURE_CALL_MISMATCH");
        const hasUnsupported = interactions.some(i => i.type === "UNSUPPORTED_SYNTAX");
        let outcome: AnalysisOutcome = "SAFE_INTEGRATION";
        let summaryText = "Proposals are compatible and safe to auto-merge.";
        if (hasSyntaxError || hasSecurityRisk || hasLexicalOverlap) {
            outcome = "UNRESOLVED_CONFLICT";
            summaryText = `Unresolved conflict detected: ${interactions.map(i => i.reason).join("; ")}`;
        }
        else if (hasSignatureMismatch || hasUnsupported) {
            outcome = "POTENTIAL_INTERACTION";
            summaryText = `Potential semantic interaction detected: ${interactions.map(i => i.reason).join("; ")}`;
        }
        let synthesizedCode: string | undefined;
        if (outcome === "SAFE_INTEGRATION") {
            const synth = this.synthesizeCleanMerge({ baseCode, filePath, codeA: proposalA.code, codeB: proposalB.code });
            if (synth.success) {
                synthesizedCode = synth.mergedCode;
            }
        }
        return {
            outcome,
            summary: summaryText,
            interactions,
            canAutoMerge: outcome === "SAFE_INTEGRATION",
            affectedSymbols: Array.from(affectedSymbols),
            diagnostics,
            synthesizedCode
        };
    }
    public static synthesizeCleanMerge(params: {
        baseCode: string;
        filePath: string;
        codeA: string;
        codeB: string;
    }): {
        success: boolean;
        mergedCode?: string;
        reason?: string;
    } {
        const { baseCode, filePath, codeA, codeB } = params;
        const baseSummary = this.parseFile(baseCode, filePath);
        const summaryA = this.parseFile(codeA, filePath);
        const summaryB = this.parseFile(codeB, filePath);
        if (summaryA.syntaxErrors.length > 0 || summaryB.syntaxErrors.length > 0) {
            return { success: false, reason: "Syntax error in one or both proposals" };
        }
        const modifiedInA = new Set<string>();
        for (const [name, defA] of summaryA.definitions.entries()) {
            const baseDef = baseSummary.definitions.get(name);
            if (!baseDef || baseDef.rawText.trim() !== defA.rawText.trim()) {
                modifiedInA.add(name);
            }
        }
        const modifiedInB = new Set<string>();
        for (const [name, defB] of summaryB.definitions.entries()) {
            const baseDef = baseSummary.definitions.get(name);
            if (!baseDef || baseDef.rawText.trim() !== defB.rawText.trim()) {
                modifiedInB.add(name);
            }
        }
        for (const sym of modifiedInA) {
            if (modifiedInB.has(sym)) {
                return { success: false, reason: `Conflicting changes to same symbol '${sym}'` };
            }
        }
        let merged = codeA;
        for (const sym of modifiedInB) {
            const defB = summaryB.definitions.get(sym)!;
            const defInA = summaryA.definitions.get(sym);
            if (defInA) {
                merged = merged.replace(defInA.rawText, defB.rawText);
            }
            else {
                merged = merged.trimEnd() + "\n\n" + defB.rawText + "\n";
            }
        }
        for (const impB of summaryB.imports) {
            const alreadyInA = summaryA.imports.some(impA => impA.specifier === impB.specifier);
            if (!alreadyInA) {
                merged = `import { ${impB.symbols.join(", ")} } from "${impB.specifier}";\n` + merged;
            }
        }
        const extension = filePath.toLowerCase().split(".").pop() || "";
        const scriptKind = extension === "tsx" ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
        const testFile = ts.createSourceFile("merged.ts", merged, ts.ScriptTarget.Latest, true, scriptKind);
        const diags = (testFile as any).parseDiagnostics;
        if (diags && Array.isArray(diags) && diags.length > 0) {
            return { success: false, reason: "Merged code failed TypeScript syntax validation" };
        }
        return { success: true, mergedCode: merged };
    }
    public static analyzeCrossFileProposals(params: {
        proposalA: {
            agentId: string;
            intent: string;
            filePath: string;
            code: string;
        };
        proposalB: {
            agentId: string;
            intent: string;
            filePath: string;
            code: string;
        };
    }): SemanticAnalysisReport {
        const { proposalA, proposalB } = params;
        const summaryA = this.parseFile(proposalA.code, proposalA.filePath);
        const summaryB = this.parseFile(proposalB.code, proposalB.filePath);
        const interactions: SemanticInteraction[] = [];
        const affectedSymbols = new Set<string>();
        if (summaryA.syntaxErrors.length > 0) {
            interactions.push({
                type: "SYNTAX_ERROR",
                affectedSymbol: proposalA.filePath,
                filePath: proposalA.filePath,
                reason: `${proposalA.agentId} proposal has parse errors: ${summaryA.syntaxErrors.join("; ")}`
            });
        }
        if (summaryB.syntaxErrors.length > 0) {
            interactions.push({
                type: "SYNTAX_ERROR",
                affectedSymbol: proposalB.filePath,
                filePath: proposalB.filePath,
                reason: `${proposalB.agentId} proposal has parse errors: ${summaryB.syntaxErrors.join("; ")}`
            });
        }
        for (const [name, defA] of summaryA.definitions.entries()) {
            if (defA.isExported) {
                for (const callB of summaryB.callReferences) {
                    if (callB.calleeName !== name)
                        continue;
                    if (callB.hasSpreadArguments) {
                        affectedSymbols.add(name);
                        interactions.push({
                            type: "UNSUPPORTED_SYNTAX",
                            affectedSymbol: name,
                            filePath: proposalB.filePath,
                            sourceSpan: callB.span,
                            reason: `Cannot verify the spread-argument call to exported '${name}'; manual review is required.`,
                            agentsInvolved: [proposalA.agentId, proposalB.agentId],
                            intents: [proposalA.intent, proposalB.intent]
                        });
                    }
                    else if (!acceptsArity(defA, callB.argCount)) {
                        affectedSymbols.add(name);
                        interactions.push({
                            type: "SIGNATURE_CALL_MISMATCH",
                            affectedSymbol: name,
                            filePath: proposalB.filePath,
                            sourceSpan: callB.span,
                            reason: `${proposalA.agentId} exports '${name}' accepting ${formatArity(defA)} arguments, but ${proposalB.agentId} in '${proposalB.filePath}' calls '${name}' with ${callB.argCount} arguments at line ${callB.span.line}`,
                            agentsInvolved: [proposalA.agentId, proposalB.agentId],
                            intents: [proposalA.intent, proposalB.intent]
                        });
                    }
                }
            }
        }
        for (const [name, defB] of summaryB.definitions.entries()) {
            if (defB.isExported) {
                for (const callA of summaryA.callReferences) {
                    if (callA.calleeName !== name)
                        continue;
                    if (callA.hasSpreadArguments) {
                        affectedSymbols.add(name);
                        interactions.push({
                            type: "UNSUPPORTED_SYNTAX",
                            affectedSymbol: name,
                            filePath: proposalA.filePath,
                            sourceSpan: callA.span,
                            reason: `Cannot verify the spread-argument call to exported '${name}'; manual review is required.`,
                            agentsInvolved: [proposalA.agentId, proposalB.agentId],
                            intents: [proposalA.intent, proposalB.intent]
                        });
                    }
                    else if (!acceptsArity(defB, callA.argCount)) {
                        affectedSymbols.add(name);
                        interactions.push({
                            type: "SIGNATURE_CALL_MISMATCH",
                            affectedSymbol: name,
                            filePath: proposalA.filePath,
                            sourceSpan: callA.span,
                            reason: `${proposalB.agentId} exports '${name}' accepting ${formatArity(defB)} arguments, but ${proposalA.agentId} in '${proposalA.filePath}' calls '${name}' with ${callA.argCount} arguments at line ${callA.span.line}`,
                            agentsInvolved: [proposalA.agentId, proposalB.agentId],
                            intents: [proposalA.intent, proposalB.intent]
                        });
                    }
                }
            }
        }
        const outcome: AnalysisOutcome = interactions.length === 0
            ? "SAFE_INTEGRATION"
            : interactions.some(i => i.type === "SYNTAX_ERROR")
                ? "UNRESOLVED_CONFLICT"
                : "POTENTIAL_INTERACTION";
        return {
            outcome,
            summary: outcome === "SAFE_INTEGRATION"
                ? "Cross-file changes are disjoint and safe to integrate."
                : `Cross-file interaction detected: ${interactions.map(i => i.reason).join("; ")}`,
            interactions,
            canAutoMerge: outcome === "SAFE_INTEGRATION",
            affectedSymbols: Array.from(affectedSymbols),
            diagnostics: []
        };
    }
}
function maximumArity(definition: SymbolDef): number | null {
    return definition.maxArity === undefined ? definition.arity : definition.maxArity;
}
function acceptsArity(definition: SymbolDef, actual: number): boolean {
    const maximum = maximumArity(definition);
    return actual >= definition.arity && (maximum === null || actual <= maximum);
}
function hasArityRangeChanged(before: SymbolDef, after: SymbolDef): boolean {
    return before.arity !== after.arity || maximumArity(before) !== maximumArity(after);
}
function formatArity(definition: SymbolDef): string {
    const maximum = maximumArity(definition);
    if (maximum === null)
        return `at least ${definition.arity}`;
    return maximum === definition.arity
        ? String(definition.arity)
        : `between ${definition.arity} and ${maximum}`;
}
