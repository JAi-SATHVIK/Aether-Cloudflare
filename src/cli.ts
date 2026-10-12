import { ASTSemanticAnalyzer } from "./ast_semantic_analyzer";
const baseCode = [
    "export function divide(a: number, b: number): number {",
    "  return a / b;",
    "}",
    "",
    "export function calculate(values: number[]): number {",
    "  return divide(values[0] ?? 0, values[1] ?? 1);",
    "}"
].join("\n");
const guardCandidate = [
    "export function divide(a: number, b: number): number {",
    "  if (b === 0) throw new Error('division by zero');",
    "  return a / b;",
    "}",
    "",
    "export function calculate(values: number[]): number {",
    "  return divide(values[0] ?? 0, values[1] ?? 1);",
    "}"
].join("\n");
const signatureCandidate = [
    "export function divide(a: number, b: number, precision: number): number {",
    "  return Number((a / b).toFixed(precision));",
    "}",
    "",
    "export function calculate(values: number[]): number {",
    "  return divide(values[0] ?? 0, values[1] ?? 1);",
    "}"
].join("\n");
function main(): void {
    console.log("Aether local AST-analysis illustration");
    console.log("This command analyzes in-memory TypeScript fixtures only.");
    console.log("It does not call Cloudflare, create Git commits, run candidate code, or execute tests.\n");
    const guard = ASTSemanticAnalyzer.parseFile(guardCandidate, "src/calculator.ts");
    console.log("Fixture 1: TypeScript syntax diagnostics");
    console.log(JSON.stringify({ syntaxErrors: guard.syntaxErrors }, null, 2));
    const interaction = ASTSemanticAnalyzer.analyzeProposals({
        baseCode,
        filePath: "src/calculator.ts",
        proposalA: {
            agentId: "agent-guard",
            intent: "Add a zero-division guard",
            code: guardCandidate
        },
        proposalB: {
            agentId: "agent-signature",
            intent: "Add a precision parameter",
            code: signatureCandidate
        }
    });
    console.log("\nFixture 2: Two candidates based on the same source");
    console.log(JSON.stringify({
        outcome: interaction.outcome,
        canAutoMerge: interaction.canAutoMerge,
        summary: interaction.summary,
        affectedSymbols: interaction.affectedSymbols,
        diagnostics: interaction.diagnostics
    }, null, 2));
    console.log("\nInterpretation: this is parser/analyzer output, not a merge, typecheck, test result, or safety proof.");
}
main();
