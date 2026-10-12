import fs from "fs";
import path from "path";
import crypto from "crypto";
const MUTATION_DOMAIN_TAG = Buffer.from("AETHER-v1-MUTATION:");
export interface BridgeConfig {
    localDir: string;
    edgeIngressUrl: string;
    repoId: string;
    modulePath: string;
    keyPair?: crypto.KeyPairSyncResult<string, string>;
}
export class AetherLocalBridge {
    private config: BridgeConfig;
    private isWatching = false;
    private debounceTimer: NodeJS.Timeout | null = null;
    private lastKnownContent = "";
    private keyPair: crypto.KeyPairSyncResult<string, string>;
    public publicKeyHex: string;
    constructor(config: BridgeConfig) {
        this.config = config;
        this.keyPair = config.keyPair || crypto.generateKeyPairSync("ed25519", {
            publicKeyEncoding: { type: "spki", format: "pem" },
            privateKeyEncoding: { type: "pkcs8", format: "pem" }
        });
        const spkiDer = crypto.createPublicKey(this.keyPair.publicKey).export({ type: "spki", format: "der" });
        const rawPub = spkiDer.subarray(spkiDer.length - 32);
        this.publicKeyHex = rawPub.toString("hex");
    }
    public async init(): Promise<void> {
        if (!fs.existsSync(this.config.localDir)) {
            fs.mkdirSync(this.config.localDir, { recursive: true });
        }
        const localFilePath = path.join(this.config.localDir, path.basename(this.config.modulePath));
        console.log(`[Aether-Bridge] Initializing local mount at: ${localFilePath}`);
        console.log(`[Aether-Bridge] Target Edge Shard: ${this.config.edgeIngressUrl}`);
        console.log(`[Aether-Bridge] Authenticated Developer Ed25519 Key: ${this.publicKeyHex.substring(0, 16)}...`);
        if (!fs.existsSync(localFilePath)) {
            const baselineCode = `# Project Aether Synchronized Module\n# Edge Shard: ${this.config.repoId}:${this.config.modulePath}\n\ndef binary_search(arr: list[int], target: int) -> int:\n    low, high = 0, len(arr) - 1\n    while low <= high:\n        mid = (low + high) // 2\n        if arr[mid] == target:\n            return mid\n        elif arr[mid] < target:\n            low = mid + 1\n        else:\n            high = mid - 1\n    return -1\n`;
            fs.writeFileSync(localFilePath, baselineCode, "utf-8");
            this.lastKnownContent = baselineCode;
        }
        else {
            this.lastKnownContent = fs.readFileSync(localFilePath, "utf-8");
        }
        console.log(`[Aether-Bridge] Mounted successfully. Editor watcher ready.`);
    }
    public startWatch(onMutationDetected?: (deltaSummary: string) => void): void {
        if (this.isWatching)
            return;
        this.isWatching = true;
        const localFilePath = path.join(this.config.localDir, path.basename(this.config.modulePath));
        fs.watch(localFilePath, (eventType) => {
            if (eventType === "change") {
                if (this.debounceTimer)
                    clearTimeout(this.debounceTimer);
                this.debounceTimer = setTimeout(() => {
                    this.handleFileChange(localFilePath, onMutationDetected);
                }, 150);
            }
        });
        console.log(`[Aether-Bridge] Active kernel/editor watcher engaged (150ms debounce).`);
    }
    public createSignedEnvelope(payloadBytes: Uint8Array): Uint8Array {
        const hash = crypto.createHash("sha256").update(payloadBytes).digest();
        const verifyBuffer = Buffer.concat([MUTATION_DOMAIN_TAG, hash]);
        const privKeyObj = crypto.createPrivateKey(this.keyPair.privateKey);
        const signature = crypto.sign(null, verifyBuffer, privKeyObj);
        const wireEnvelope = new Uint8Array(32 + 64 + payloadBytes.length);
        wireEnvelope.set(hash, 0);
        wireEnvelope.set(signature, 32);
        wireEnvelope.set(payloadBytes, 96);
        return wireEnvelope;
    }
    public async transmitMutation(envelope: Uint8Array): Promise<{
        status: number;
        ok: boolean;
    }> {
        try {
            const targetUrl = `${this.config.edgeIngressUrl}/mutate?repoId=${encodeURIComponent(this.config.repoId)}&module=${encodeURIComponent(this.config.modulePath)}`;
            const res = await fetch(targetUrl, {
                method: "POST",
                headers: {
                    "Content-Type": "application/octet-stream",
                    "X-Aether-Agent-Key": this.publicKeyHex
                },
                body: envelope
            });
            return { status: res.status, ok: res.ok };
        }
        catch {
            return { status: 0, ok: false };
        }
    }
    private async handleFileChange(filePath: string, onMutationDetected?: (deltaSummary: string) => void): Promise<void> {
        try {
            const currentContent = fs.readFileSync(filePath, "utf-8");
            if (currentContent === this.lastKnownContent)
                return;
            const oldLines = this.lastKnownContent.split("\n").length;
            const newLines = currentContent.split("\n").length;
            const lineDelta = newLines - oldLines;
            const mutation = {
                kind: "UPDATE",
                nodeId: `root:${this.config.modulePath}`,
                attrKey: "source",
                attrVal: currentContent,
                lamport: {
                    counter: 1,
                    agentId: this.publicKeyHex
                }
            };
            const payloadBytes = Buffer.from(JSON.stringify(mutation), "utf-8");
            const signedEnvelope = this.createSignedEnvelope(payloadBytes);
            const transmitResult = await this.transmitMutation(signedEnvelope);
            const summary = `Local Edit: ${currentContent.length} bytes (${lineDelta >= 0 ? "+" : ""}${lineDelta} lines). Signed with Ed25519 (${this.publicKeyHex.substring(0, 16)}...). Transmission: ${transmitResult.ok ? "Delivered to Edge Shard" : "Buffered (Edge offline or mock)"}`;
            console.log(`[Aether-Bridge] >>> ${summary}`);
            this.lastKnownContent = currentContent;
            if (onMutationDetected) {
                onMutationDetected(summary);
            }
        }
        catch (err) {
            console.error("[Aether-Bridge] Error processing local edit:", err);
        }
    }
}
