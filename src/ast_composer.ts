import ts from "typescript";
export type SymbolOpKind = "ADD" | "MODIFY" | "DELETE" | "RENAME";
export interface SymbolOp {
    kind: SymbolOpKind;
    symbolName: string;
    filePath: string;
    symbolKind: "function" | "method" | "arrow" | "class" | "interface" | "type" | "enum" | "const" | "file";
    oldNormalizedText?: string;
    newNormalizedText?: string;
    newRawText?: string;
    oldName?: string;
    newName?: string;
}
export interface SymbolChangeset {
    filePath: string;
    ops: SymbolOp[];
    imports: Array<{
        specifier: string;
        symbols: string[];
        isDefault?: boolean;
    }>;
    isNonCodeFile?: boolean;
}
export interface ParsedSymbol {
    name: string;
    kind: "function" | "method" | "arrow" | "class" | "interface" | "type" | "enum" | "const";
    rawText: string;
    normalizedText: string;
    span: {
        start: number;
        end: number;
    };
}
export class SymbolChangesetAnalyzer {
    public static normalizeAstText(code: string, isSnippet: boolean = false): string {
        const file = ts.createSourceFile("temp.ts", code, ts.ScriptTarget.Latest, true);
        const printer = ts.createPrinter({ removeComments: true });
        return printer.printFile(file).replace(/\s+/g, " ").trim();
    }
    public static extractSymbols(sourceCode: string, filePath: string): {
        symbols: Map<string, ParsedSymbol>;
        imports: Array<{
            specifier: string;
            symbols: string[];
            isDefault?: boolean;
        }>;
        syntaxErrors: string[];
    } {
        const symbols = new Map<string, ParsedSymbol>();
        const imports: Array<{
            specifier: string;
            symbols: string[];
            isDefault?: boolean;
        }> = [];
        const syntaxErrors: string[] = [];
        const ext = filePath.toLowerCase().split(".").pop() || "";
        const isTsOrJs = ["ts", "tsx", "js", "jsx", "mts", "mjs"].includes(ext);
        if (!isTsOrJs) {
            return { symbols, imports, syntaxErrors };
        }
        const scriptKind = ext === "tsx" ? ts.ScriptKind.TSX
            : ext === "jsx" ? ts.ScriptKind.JSX
                : ext === "js" ? ts.ScriptKind.JS
                    : ts.ScriptKind.TS;
        const sourceFile = ts.createSourceFile(filePath, sourceCode, ts.ScriptTarget.Latest, true, scriptKind);
        const parseDiags = (sourceFile as any).parseDiagnostics;
        if (parseDiags && parseDiags.length > 0) {
            for (const diag of parseDiags) {
                syntaxErrors.push(ts.flattenDiagnosticMessageText(diag.messageText, "\n"));
            }
        }
        const printer = ts.createPrinter({ removeComments: true });
        const visit = (node: ts.Node) => {
            if (ts.isImportDeclaration(node)) {
                const specifier = node.moduleSpecifier.getText(sourceFile).replace(/['"]/g, "");
                const importedSymbols: string[] = [];
                let isDefault = false;
                if (node.importClause) {
                    if (node.importClause.name) {
                        importedSymbols.push(node.importClause.name.getText(sourceFile));
                        isDefault = true;
                    }
                    if (node.importClause.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
                        for (const el of node.importClause.namedBindings.elements) {
                            importedSymbols.push(el.name.getText(sourceFile));
                        }
                    }
                }
                imports.push({ specifier, symbols: importedSymbols, isDefault });
            }
            if (ts.isFunctionDeclaration(node) && node.name) {
                const name = node.name.getText(sourceFile);
                const rawText = node.getText(sourceFile);
                const normalizedText = printer.printNode(ts.EmitHint.Unspecified, node, sourceFile).replace(/\s+/g, " ").trim();
                symbols.set(name, {
                    name,
                    kind: "function",
                    rawText,
                    normalizedText,
                    span: { start: node.getStart(sourceFile), end: node.getEnd() }
                });
                return;
            }
            if (ts.isInterfaceDeclaration(node)) {
                const name = node.name.getText(sourceFile);
                const rawText = node.getText(sourceFile);
                const normalizedText = printer.printNode(ts.EmitHint.Unspecified, node, sourceFile).replace(/\s+/g, " ").trim();
                symbols.set(name, {
                    name,
                    kind: "interface",
                    rawText,
                    normalizedText,
                    span: { start: node.getStart(sourceFile), end: node.getEnd() }
                });
                return;
            }
            if (ts.isClassDeclaration(node) && node.name) {
                const name = node.name.getText(sourceFile);
                const rawText = node.getText(sourceFile);
                const normalizedText = printer.printNode(ts.EmitHint.Unspecified, node, sourceFile).replace(/\s+/g, " ").trim();
                symbols.set(name, {
                    name,
                    kind: "class",
                    rawText,
                    normalizedText,
                    span: { start: node.getStart(sourceFile), end: node.getEnd() }
                });
                return;
            }
            if (ts.isTypeAliasDeclaration(node)) {
                const name = node.name.getText(sourceFile);
                const rawText = node.getText(sourceFile);
                const normalizedText = printer.printNode(ts.EmitHint.Unspecified, node, sourceFile).replace(/\s+/g, " ").trim();
                symbols.set(name, {
                    name,
                    kind: "type",
                    rawText,
                    normalizedText,
                    span: { start: node.getStart(sourceFile), end: node.getEnd() }
                });
                return;
            }
            if (ts.isEnumDeclaration(node)) {
                const name = node.name.getText(sourceFile);
                const rawText = node.getText(sourceFile);
                const normalizedText = printer.printNode(ts.EmitHint.Unspecified, node, sourceFile).replace(/\s+/g, " ").trim();
                symbols.set(name, {
                    name,
                    kind: "enum",
                    rawText,
                    normalizedText,
                    span: { start: node.getStart(sourceFile), end: node.getEnd() }
                });
                return;
            }
            if (ts.isVariableStatement(node)) {
                for (const decl of node.declarationList.declarations) {
                    if (ts.isIdentifier(decl.name)) {
                        const name = decl.name.getText(sourceFile);
                        const isArrow = decl.initializer && (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer));
                        const rawText = node.getText(sourceFile);
                        const normalizedText = printer.printNode(ts.EmitHint.Unspecified, node, sourceFile).replace(/\s+/g, " ").trim();
                        symbols.set(name, {
                            name,
                            kind: isArrow ? "arrow" : "const",
                            rawText,
                            normalizedText,
                            span: { start: node.getStart(sourceFile), end: node.getEnd() }
                        });
                    }
                }
                return;
            }
            ts.forEachChild(node, visit);
        };
        visit(sourceFile);
        return { symbols, imports, syntaxErrors };
    }
    public static diffFile(baseCode: string, candidateCode: string, filePath: string): SymbolChangeset {
        const ext = filePath.toLowerCase().split(".").pop() || "";
        const isCode = ["ts", "tsx", "js", "jsx", "mts", "mjs"].includes(ext);
        if (!isCode) {
            const ops: SymbolOp[] = [];
            if (baseCode !== candidateCode) {
                ops.push({
                    kind: "MODIFY",
                    symbolName: filePath,
                    filePath,
                    symbolKind: "file",
                    oldNormalizedText: baseCode,
                    newNormalizedText: candidateCode,
                    newRawText: candidateCode
                });
            }
            return { filePath, ops, imports: [], isNonCodeFile: true };
        }
        const baseParsed = this.extractSymbols(baseCode, filePath);
        const candParsed = this.extractSymbols(candidateCode, filePath);
        const ops: SymbolOp[] = [];
        for (const [name, candSym] of candParsed.symbols.entries()) {
            const baseSym = baseParsed.symbols.get(name);
            if (!baseSym) {
                ops.push({
                    kind: "ADD",
                    symbolName: name,
                    filePath,
                    symbolKind: candSym.kind,
                    newNormalizedText: candSym.normalizedText,
                    newRawText: candSym.rawText
                });
            }
            else if (baseSym.normalizedText !== candSym.normalizedText) {
                ops.push({
                    kind: "MODIFY",
                    symbolName: name,
                    filePath,
                    symbolKind: candSym.kind,
                    oldNormalizedText: baseSym.normalizedText,
                    newNormalizedText: candSym.normalizedText,
                    newRawText: candSym.rawText
                });
            }
        }
        for (const [name, baseSym] of baseParsed.symbols.entries()) {
            if (!candParsed.symbols.has(name)) {
                ops.push({
                    kind: "DELETE",
                    symbolName: name,
                    filePath,
                    symbolKind: baseSym.kind,
                    oldNormalizedText: baseSym.normalizedText
                });
            }
        }
        return {
            filePath,
            ops,
            imports: candParsed.imports
        };
    }
}
export interface CompositionResult {
    success: boolean;
    decision: "COMPOSE" | "DEDUPE" | "NEEDS_HUMAN";
    mergedCode?: string;
    reason?: string;
    creditedAgents: string[];
    sideBySide?: {
        symbolName: string;
        versionA: string;
        versionB: string;
    };
}
export class ASTComposer {
    public static tryComposeClass(baseClassText: string, aClassText: string, bClassText: string): {
        success: boolean;
        mergedClass?: string;
        reason?: string;
    } {
        const printer = ts.createPrinter({ removeComments: true });
        const parseClass = (code: string) => {
            const sf = ts.createSourceFile("temp.ts", code, ts.ScriptTarget.Latest, true);
            let classNode: ts.ClassDeclaration | undefined;
            ts.forEachChild(sf, node => {
                if (ts.isClassDeclaration(node))
                    classNode = node;
            });
            return { sf, classNode };
        };
        const base = parseClass(baseClassText);
        const a = parseClass(aClassText);
        const b = parseClass(bClassText);
        if (!base.classNode || !a.classNode || !b.classNode) {
            return { success: false, reason: "Could not parse class declarations" };
        }
        const getMethods = (sf: ts.SourceFile, cls: ts.ClassDeclaration) => {
            const map = new Map<string, {
                raw: string;
                norm: string;
                node: ts.ClassElement;
            }>();
            for (const m of cls.members) {
                if ((ts.isMethodDeclaration(m) || ts.isPropertyDeclaration(m) || ts.isConstructorDeclaration(m)) && m.name) {
                    const name = m.name.getText(sf);
                    const raw = m.getText(sf);
                    const norm = printer.printNode(ts.EmitHint.Unspecified, m, sf).replace(/\s+/g, " ").trim();
                    map.set(name, { raw, norm, node: m });
                }
            }
            return map;
        };
        const baseMethods = getMethods(base.sf, base.classNode);
        const aMethods = getMethods(a.sf, a.classNode);
        const bMethods = getMethods(b.sf, b.classNode);
        let mergedClass = baseClassText;
        const allNames = new Set([...baseMethods.keys(), ...aMethods.keys(), ...bMethods.keys()]);
        for (const name of allNames) {
            const baseM = baseMethods.get(name);
            const aM = aMethods.get(name);
            const bM = bMethods.get(name);
            const aChanged = aM && baseM ? aM.norm !== baseM.norm : !!aM !== !!baseM;
            const bChanged = bM && baseM ? bM.norm !== baseM.norm : !!bM !== !!baseM;
            if (aChanged && bChanged) {
                if (aM && bM && aM.norm === bM.norm) {
                    continue;
                }
                return { success: false, reason: `Conflicting changes to class member '${name}'` };
            }
            if (aChanged && aM && baseM) {
                mergedClass = mergedClass.replace(baseM.raw, aM.raw);
            }
            else if (bChanged && bM && baseM) {
                mergedClass = mergedClass.replace(baseM.raw, bM.raw);
            }
        }
        const testSf = ts.createSourceFile("check.ts", mergedClass, ts.ScriptTarget.Latest, true);
        const diags = (testSf as any).parseDiagnostics;
        if (diags && diags.length > 0) {
            return { success: false, reason: "Composed class syntax error" };
        }
        return { success: true, mergedClass };
    }
    public static compose(params: {
        baseCode: string;
        filePath: string;
        agentA: {
            id: string;
            code: string;
            intent?: string;
        };
        agentB: {
            id: string;
            code: string;
            intent?: string;
        };
    }): CompositionResult {
        const { baseCode, filePath, agentA, agentB } = params;
        const diffA = SymbolChangesetAnalyzer.diffFile(baseCode, agentA.code, filePath);
        const diffB = SymbolChangesetAnalyzer.diffFile(baseCode, agentB.code, filePath);
        if (diffA.isNonCodeFile || diffB.isNonCodeFile) {
            if (agentA.code === agentB.code) {
                return {
                    success: true,
                    decision: "DEDUPE",
                    mergedCode: agentA.code,
                    creditedAgents: [agentA.id, agentB.id]
                };
            }
            return {
                success: false,
                decision: "NEEDS_HUMAN",
                reason: `Non-code file '${filePath}' modified with diverging contents`,
                creditedAgents: [],
                sideBySide: {
                    symbolName: filePath,
                    versionA: agentA.code,
                    versionB: agentB.code
                }
            };
        }
        const opsABySym = new Map<string, SymbolOp>();
        for (const op of diffA.ops)
            opsABySym.set(op.symbolName, op);
        const opsBBySym = new Map<string, SymbolOp>();
        for (const op of diffB.ops)
            opsBBySym.set(op.symbolName, op);
        const allSymbols = new Set([...opsABySym.keys(), ...opsBBySym.keys()]);
        const credited = new Set<string>();
        const dedupeSymbols = new Set<string>();
        const composedClassReplacements = new Map<string, string>();
        const baseSymbols = SymbolChangesetAnalyzer.extractSymbols(baseCode, filePath);
        for (const sym of allSymbols) {
            const opA = opsABySym.get(sym);
            const opB = opsBBySym.get(sym);
            if (opA && opB) {
                if ((opA.kind === "DELETE" && opB.kind === "MODIFY") || (opA.kind === "MODIFY" && opB.kind === "DELETE")) {
                    return {
                        success: false,
                        decision: "NEEDS_HUMAN",
                        reason: `Conflicting delete-vs-modify on symbol '${sym}': Agent ${opA.kind === "DELETE" ? agentA.id : agentB.id} deleted '${sym}', while Agent ${opA.kind === "MODIFY" ? agentA.id : agentB.id} modified it.`,
                        creditedAgents: [],
                        sideBySide: {
                            symbolName: sym,
                            versionA: opA.kind === "DELETE" ? "[DELETED]" : (opA.newRawText || ""),
                            versionB: opB.kind === "DELETE" ? "[DELETED]" : (opB.newRawText || "")
                        }
                    };
                }
                if (opA.newNormalizedText && opB.newNormalizedText && opA.newNormalizedText === opB.newNormalizedText) {
                    credited.add(agentA.id);
                    credited.add(agentB.id);
                    dedupeSymbols.add(sym);
                    continue;
                }
                if (opA.symbolKind === "class" && opB.symbolKind === "class" && opA.newRawText && opB.newRawText) {
                    const baseSym = baseSymbols.symbols.get(sym);
                    if (baseSym) {
                        const classComp = this.tryComposeClass(baseSym.rawText, opA.newRawText, opB.newRawText);
                        if (classComp.success && classComp.mergedClass) {
                            composedClassReplacements.set(sym, classComp.mergedClass);
                            credited.add(agentA.id);
                            credited.add(agentB.id);
                            continue;
                        }
                    }
                }
                return {
                    success: false,
                    decision: "NEEDS_HUMAN",
                    reason: `Conflicting implementations on symbol '${sym}' by ${agentA.id} and ${agentB.id}`,
                    creditedAgents: [],
                    sideBySide: {
                        symbolName: sym,
                        versionA: opA.newRawText || "[DELETED]",
                        versionB: opB.newRawText || "[DELETED]"
                    }
                };
            }
            else if (opA) {
                credited.add(agentA.id);
            }
            else if (opB) {
                credited.add(agentB.id);
            }
        }
        let merged = baseCode;
        for (const [sym, mergedClassText] of composedClassReplacements.entries()) {
            const baseSym = baseSymbols.symbols.get(sym);
            if (baseSym) {
                merged = merged.replace(baseSym.rawText, mergedClassText);
            }
        }
        for (const [sym, opA] of opsABySym.entries()) {
            if (composedClassReplacements.has(sym))
                continue;
            const baseSym = baseSymbols.symbols.get(sym);
            if (opA.kind === "MODIFY" && baseSym && opA.newRawText) {
                merged = merged.replace(baseSym.rawText, opA.newRawText);
            }
            else if (opA.kind === "DELETE" && baseSym) {
                merged = merged.replace(baseSym.rawText, "");
            }
            else if (opA.kind === "ADD" && opA.newRawText) {
                merged = merged.trimEnd() + "\n\n" + opA.newRawText + "\n";
            }
        }
        for (const [sym, opB] of opsBBySym.entries()) {
            if (composedClassReplacements.has(sym))
                continue;
            if (dedupeSymbols.has(sym))
                continue;
            const baseSym = baseSymbols.symbols.get(sym);
            if (opB.kind === "MODIFY" && baseSym && opB.newRawText) {
                merged = merged.replace(baseSym.rawText, opB.newRawText);
            }
            else if (opB.kind === "DELETE" && baseSym) {
                merged = merged.replace(baseSym.rawText, "");
            }
            else if (opB.kind === "ADD" && opB.newRawText) {
                merged = merged.trimEnd() + "\n\n" + opB.newRawText + "\n";
            }
        }
        const baseImports = baseSymbols.imports;
        const allImports = [...diffA.imports, ...diffB.imports];
        const importMap = new Map<string, Set<string>>();
        for (const imp of allImports) {
            if (!importMap.has(imp.specifier)) {
                importMap.set(imp.specifier, new Set());
            }
            const set = importMap.get(imp.specifier)!;
            for (const s of imp.symbols)
                set.add(s);
        }
        const existingSpecifiers = new Set(baseImports.map(i => i.specifier));
        const newImportStatements: string[] = [];
        for (const [spec, syms] of importMap.entries()) {
            if (!existingSpecifiers.has(spec)) {
                newImportStatements.push(`import { ${Array.from(syms).join(", ")} } from "${spec}";`);
            }
        }
        if (newImportStatements.length > 0) {
            merged = newImportStatements.join("\n") + "\n" + merged;
        }
        const testFile = ts.createSourceFile("merged.ts", merged, ts.ScriptTarget.Latest, true);
        const parseDiags = (testFile as any).parseDiagnostics;
        if (parseDiags && parseDiags.length > 0) {
            return {
                success: false,
                decision: "NEEDS_HUMAN",
                reason: "Merged composition generated TypeScript syntax errors",
                creditedAgents: []
            };
        }
        return {
            success: true,
            decision: dedupeSymbols.size > 0 && allSymbols.size === dedupeSymbols.size ? "DEDUPE" : "COMPOSE",
            mergedCode: merged,
            creditedAgents: Array.from(credited)
        };
    }
}
