import ts from "typescript";
import { TS_EMBEDDED_LIBS } from "./embedded_libs";
import { ASTSemanticAnalyzer } from "./ast_semantic_analyzer";
export interface DiagnosticResult {
    filePath: string;
    line: number;
    character: number;
    code: number;
    message: string;
}
export interface DifferentialTypecheckOutcome {
    passed: boolean;
    baseDiagnosticsCount: number;
    composedDiagnosticsCount: number;
    newDiagnostics: DiagnosticResult[];
    attributedErrors: Array<{
        filePath: string;
        diagnostic: DiagnosticResult;
        offendingSymbol?: string;
    }>;
    durationMs: number;
}
export class DifferentialTypecheckGate {
    private static cachedBaseDiags = new Map<string, string[]>();
    private static readonly compilerOptions: ts.CompilerOptions = {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        noLib: false,
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        allowJs: true
    };
    public static checkVirtualFiles(files: Record<string, string>): DiagnosticResult[] {
        const allFiles = { ...TS_EMBEDDED_LIBS, ...files };
        const host: ts.CompilerHost = {
            getSourceFile: (fileName: string) => {
                const norm = fileName.startsWith("/") ? fileName : "/" + fileName;
                const bare = fileName.replace(/^\//, "");
                const content = allFiles[norm] ?? allFiles[bare] ?? allFiles[fileName];
                if (content !== undefined) {
                    return ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true);
                }
                return undefined;
            },
            getDefaultLibFileName: () => "/lib.es2022.full.d.ts",
            getDefaultLibLocation: () => "/",
            writeFile: () => { },
            getCurrentDirectory: () => "/",
            getDirectories: () => [],
            getCanonicalFileName: (f: string) => f,
            useCaseSensitiveFileNames: () => true,
            getNewLine: () => "\n",
            fileExists: (fileName: string) => {
                const norm = fileName.startsWith("/") ? fileName : "/" + fileName;
                const bare = fileName.replace(/^\//, "");
                return (norm in allFiles) || (bare in allFiles) || (fileName in allFiles);
            },
            readFile: (fileName: string) => {
                const norm = fileName.startsWith("/") ? fileName : "/" + fileName;
                const bare = fileName.replace(/^\//, "");
                return allFiles[norm] ?? allFiles[bare] ?? allFiles[fileName];
            }
        };
        const rootNames = Object.keys(files)
            .filter(f => f.endsWith(".ts") || f.endsWith(".tsx") || f.endsWith(".js"))
            .map(f => f.startsWith("/") ? f : "/" + f);
        const program = ts.createProgram(rootNames, this.compilerOptions, host);
        const rawDiags = ts.getPreEmitDiagnostics(program);
        const results: DiagnosticResult[] = [];
        for (const d of rawDiags) {
            if (!d.file)
                continue;
            const fileName = d.file.fileName;
            if (fileName.startsWith("/lib.") || fileName.includes("lib.es") || fileName.includes("lib.d.ts"))
                continue;
            const pos = d.file.getLineAndCharacterOfPosition(d.start ?? 0);
            results.push({
                filePath: fileName.replace(/^\//, ""),
                line: pos.line + 1,
                character: pos.character + 1,
                code: d.code,
                message: ts.flattenDiagnosticMessageText(d.messageText, "\n")
            });
        }
        return results;
    }
    public static checkDifferential(params: {
        baseSha?: string;
        baseFiles: Record<string, string>;
        composedFiles: Record<string, string>;
        affectedSymbolsByFile?: Record<string, string[]>;
    }): DifferentialTypecheckOutcome {
        const start = performance.now();
        let baseKeyList: string[];
        if (params.baseSha && this.cachedBaseDiags.has(params.baseSha)) {
            baseKeyList = this.cachedBaseDiags.get(params.baseSha)!;
        }
        else {
            const baseDiags = this.checkVirtualFiles(params.baseFiles);
            baseKeyList = baseDiags.map(d => `${d.filePath}:${d.code}:${d.message}`);
            if (params.baseSha) {
                this.cachedBaseDiags.set(params.baseSha, baseKeyList);
            }
        }
        const baseCountMap = new Map<string, number>();
        for (const k of baseKeyList) {
            baseCountMap.set(k, (baseCountMap.get(k) || 0) + 1);
        }
        const composedDiags = this.checkVirtualFiles(params.composedFiles);
        const newDiagnostics: DiagnosticResult[] = [];
        const remainingBaseCounts = new Map(baseCountMap);
        for (const cd of composedDiags) {
            const key = `${cd.filePath}:${cd.code}:${cd.message}`;
            const count = remainingBaseCounts.get(key) || 0;
            if (count > 0) {
                remainingBaseCounts.set(key, count - 1);
            }
            else {
                newDiagnostics.push(cd);
            }
        }
        const attributedErrors = newDiagnostics.map(diag => {
            const symbolsInFile = params.affectedSymbolsByFile?.[diag.filePath] || [];
            let offendingSymbol: string | undefined;
            const fileContent = params.composedFiles[diag.filePath] ??
                params.composedFiles["/" + diag.filePath] ??
                params.composedFiles[diag.filePath.replace(/^\//, "")];
            if (fileContent) {
                try {
                    const summary = ASTSemanticAnalyzer.parseFile(fileContent, diag.filePath);
                    let bestMatch: {
                        name: string;
                        spanLen: number;
                    } | null = null;
                    for (const def of summary.definitions.values()) {
                        const startLine = def.span.line;
                        const lineCount = def.rawText.split("\n").length;
                        const endLine = startLine + lineCount - 1;
                        if (diag.line >= startLine && diag.line <= endLine) {
                            const spanLen = def.rawText.length;
                            const isInAffected = symbolsInFile.includes(def.name);
                            if (!bestMatch || (isInAffected && !symbolsInFile.includes(bestMatch.name)) || spanLen < bestMatch.spanLen) {
                                bestMatch = { name: def.name, spanLen };
                            }
                        }
                    }
                    if (bestMatch) {
                        offendingSymbol = bestMatch.name;
                    }
                }
                catch {
                }
            }
            if (!offendingSymbol && symbolsInFile.length > 0) {
                offendingSymbol = symbolsInFile[0];
            }
            return {
                filePath: diag.filePath,
                diagnostic: diag,
                offendingSymbol
            };
        });
        const durationMs = Math.round(performance.now() - start);
        return {
            passed: newDiagnostics.length === 0,
            baseDiagnosticsCount: baseKeyList.length,
            composedDiagnosticsCount: composedDiags.length,
            newDiagnostics,
            attributedErrors,
            durationMs
        };
    }
}
