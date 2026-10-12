import Parser from "web-tree-sitter";
import { ASTMutationPayload } from "./types";
export interface ParserDelta {
    startIndex: number;
    oldEndIndex: number;
    newEndIndex: number;
    startPosition: Parser.Point;
    oldEndPosition: Parser.Point;
    newEndPosition: Parser.Point;
}
export class DynamicEdgeParser {
    private parser?: Parser;
    private isInitialized = false;
    private loadedGrammars: Map<string, Parser.Language> = new Map();
    private assetsFetcher?: Fetcher;
    constructor(assetsFetcher?: Fetcher) {
        this.assetsFetcher = assetsFetcher;
    }
    public async init(): Promise<void> {
        if (this.isInitialized)
            return;
        try {
            await Parser.init();
            this.parser = new Parser();
            this.isInitialized = true;
        }
        catch {
            this.isInitialized = false;
        }
    }
    public async getOrLoadLanguage(lang: "tsx" | "python" | "rust"): Promise<Parser.Language | null> {
        await this.init();
        if (!this.parser)
            return null;
        let language = this.loadedGrammars.get(lang);
        if (language)
            return language;
        if (!this.assetsFetcher) {
            return null;
        }
        try {
            const assetRes = await this.assetsFetcher.fetch(`http://assets/tree-sitter-${lang}.wasm`);
            if (!assetRes.ok)
                return null;
            const wasmBinary = await assetRes.arrayBuffer();
            language = await Parser.Language.load(new Uint8Array(wasmBinary));
            this.loadedGrammars.set(lang, language);
            return language;
        }
        catch {
            return null;
        }
    }
    public async computeIncrementalDeltas(oldSource: string, newSource: string, lang: "tsx" | "python" | "rust", agentId: string): Promise<ASTMutationPayload[]> {
        const lamportCounter = Date.now();
        const language = await this.getOrLoadLanguage(lang);
        if (this.parser && language) {
            try {
                this.parser.setLanguage(language);
                const tree = this.parser.parse(newSource);
                return this.extractASTDeltas(tree, agentId, lamportCounter);
            }
            catch {
            }
        }
        return this.extractFallbackDeltas(oldSource, newSource, lang, agentId, lamportCounter);
    }
    public extractASTDeltas(tree: Parser.Tree, agentId: string, lamportCounter: number): ASTMutationPayload[] {
        const deltas: ASTMutationPayload[] = [];
        const rootCursor = tree.walk();
        let siblingCounter = 1;
        const baseFractional = 32768;
        const traverse = (parentId: string | null) => {
            const node = rootCursor.currentNode;
            const nodeId = this.generateDeterministicNodeId(parentId, node.type, node.startIndex);
            const posFractional = (siblingCounter * baseFractional).toString();
            siblingCounter++;
            const isLeaf = node.childCount === 0;
            deltas.push({
                kind: "INSERT",
                nodeId,
                parentId,
                grammarType: node.type,
                posFractional,
                attrVal: isLeaf ? node.text : undefined,
                triviaLead: " ",
                lamport: { counter: lamportCounter, agentId },
                vectorClock: { [agentId]: lamportCounter }
            });
            if (rootCursor.gotoFirstChild()) {
                do {
                    traverse(nodeId);
                } while (rootCursor.gotoNextSibling());
                rootCursor.gotoParent();
            }
        };
        traverse(null);
        return deltas;
    }
    private extractFallbackDeltas(oldSource: string, newSource: string, lang: string, agentId: string, lamportCounter: number): ASTMutationPayload[] {
        const oldLines = oldSource.split("\n");
        const newLines = newSource.split("\n");
        const deltas: ASTMutationPayload[] = [];
        let prefix = 0;
        while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix])
            prefix++;
        const oldMiddleEnd = oldLines.length;
        const newMiddleEnd = newLines.length;
        const sharedMiddle = Math.min(oldMiddleEnd - prefix, newMiddleEnd - prefix);
        const clock = { counter: lamportCounter, agentId };
        for (let offset = 0; offset < sharedMiddle; offset++) {
            const index = prefix + offset;
            deltas.push({
                kind: "UPDATE",
                nodeId: this.generateDeterministicNodeId("ROOT", `${lang}_line`, index),
                parentId: "root",
                grammarType: `${lang}_statement`,
                posFractional: ((index + 1) * 32768).toString(),
                attrKey: "token",
                attrVal: newLines[index],
                lamport: clock,
                vectorClock: { [agentId]: lamportCounter }
            });
        }
        for (let index = prefix + sharedMiddle; index < oldMiddleEnd; index++) {
            deltas.push({
                kind: "DELETE",
                nodeId: this.generateDeterministicNodeId("ROOT", `${lang}_line`, index),
                parentId: "root",
                grammarType: `${lang}_statement`,
                posFractional: ((index + 1) * 32768).toString(),
                lamport: clock,
                vectorClock: { [agentId]: lamportCounter }
            });
        }
        for (let index = prefix + sharedMiddle; index < newMiddleEnd; index++) {
            deltas.push({
                kind: "INSERT",
                nodeId: this.generateDeterministicNodeId("ROOT", `${lang}_line`, index),
                parentId: "root",
                grammarType: `${lang}_statement`,
                posFractional: ((index + 1) * 32768).toString(),
                attrVal: newLines[index],
                triviaLead: "",
                triviaTrail: index < newLines.length - 1 ? "\n" : "",
                lamport: clock,
                vectorClock: { [agentId]: lamportCounter }
            });
        }
        return deltas;
    }
    private generateDeterministicNodeId(parentId: string | null, grammarType: string, byteOffset: number): string {
        const input = `${parentId || "ROOT"}:${grammarType}:${byteOffset}`;
        let hash = 0;
        for (let i = 0; i < input.length; i++) {
            hash = (hash << 5) - hash + input.charCodeAt(i);
            hash |= 0;
        }
        return Math.abs(hash).toString(16).padStart(64, "0");
    }
}
export type IncrementalASTParser = DynamicEdgeParser;
export const IncrementalASTParser = DynamicEdgeParser;
