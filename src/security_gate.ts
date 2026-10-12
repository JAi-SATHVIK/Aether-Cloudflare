import crypto from "crypto";
export type ActionCapability = "workspace:create" | "proposal:submit" | "proposal:read" | "proposal:approve" | "repo:lock" | "repo:write" | "repo:read" | "audit:read";
export interface ScopedCredential {
    sub: string;
    repo: string;
    actions: ActionCapability[];
    exp: number;
    issuedAt: number;
}
export interface SecurityValidationResult {
    authorized: boolean;
    statusCode: number;
    credential?: ScopedCredential;
    error?: string;
}
const MIN_CLUSTER_SECRET_LENGTH = 16;
const VALID_ACTIONS = new Set<ActionCapability>([
    "workspace:create", "proposal:submit", "proposal:read", "proposal:approve",
    "repo:lock", "repo:write", "repo:read", "audit:read"
]);
let clusterAuthSecret: string | null = (typeof process !== "undefined" && process?.env?.AETHER_AUTH_SECRET)
    ? process.env.AETHER_AUTH_SECRET
    : "aether-cluster-secret-32-chars-fallback";
export const MAX_PAYLOAD_BYTES = 1024 * 1024;
export class SecurityGate {
    public static setClusterSecret(secret: string | null): void {
        clusterAuthSecret = secret;
    }
    public static getClusterSecret(): string | null {
        return clusterAuthSecret;
    }
    public static isConfigured(): boolean {
        return typeof clusterAuthSecret === "string" && clusterAuthSecret.length >= MIN_CLUSTER_SECRET_LENGTH;
    }
    public static mintToken(subject: string, repo: string, actions: ActionCapability[], ttlSeconds = 3600, overrideSecret?: string): string {
        const secret = overrideSecret || clusterAuthSecret;
        if (!secret || secret.length < MIN_CLUSTER_SECRET_LENGTH) {
            throw new Error(`SecurityGate signing secret must be at least ${MIN_CLUSTER_SECRET_LENGTH} characters. AETHER_AUTH_SECRET required.`);
        }
        if (!isValidSubject(subject) || !isValidRepositoryScope(repo) || !Array.isArray(actions) ||
            actions.length === 0 || actions.some(action => !VALID_ACTIONS.has(action)) || !Number.isSafeInteger(ttlSeconds)) {
            throw new Error("Invalid scoped credential claims.");
        }
        const nowSec = Math.floor(Date.now() / 1000);
        const payload: ScopedCredential = {
            sub: subject,
            repo,
            actions,
            exp: nowSec + ttlSeconds,
            issuedAt: nowSec
        };
        const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
        const signature = crypto.createHmac("sha256", secret)
            .update(payloadB64)
            .digest("base64url");
        return `aether_token.${payloadB64}.${signature}`;
    }
    public static mintWsTicket(subject: string, repo: string, ttlSeconds = 60, overrideSecret?: string): string {
        const secret = overrideSecret || clusterAuthSecret;
        if (!secret || secret.length < MIN_CLUSTER_SECRET_LENGTH) {
            throw new Error(`SecurityGate signing secret must be at least ${MIN_CLUSTER_SECRET_LENGTH} characters. AETHER_AUTH_SECRET required.`);
        }
        if (!isValidSubject(subject) || !isValidRepositoryScope(repo) || !Number.isSafeInteger(ttlSeconds)) {
            throw new Error("Invalid WebSocket ticket claims.");
        }
        const nowSec = Math.floor(Date.now() / 1000);
        const payload: ScopedCredential & {
            purpose: "ws-ticket";
        } = {
            sub: subject,
            repo,
            actions: ["repo:read"],
            exp: nowSec + Math.min(ttlSeconds, 120),
            issuedAt: nowSec,
            purpose: "ws-ticket"
        };
        const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
        const signature = crypto.createHmac("sha256", secret)
            .update(payloadB64)
            .digest("base64url");
        return `aether_ticket.${payloadB64}.${signature}`;
    }
    public static verifyWsTicket(ticket: string | null | undefined, requiredRepo: string, overrideSecret?: string): SecurityValidationResult {
        const secret = overrideSecret || clusterAuthSecret;
        if (!secret || secret.length < MIN_CLUSTER_SECRET_LENGTH) {
            return {
                authorized: false,
                statusCode: 500,
                error: "Server misconfiguration: AETHER_AUTH_SECRET signing secret is not configured."
            };
        }
        if (!ticket) {
            return {
                authorized: false,
                statusCode: 401,
                error: "Missing WebSocket connection ticket. Pass '?ticket=<ticket>' parameter."
            };
        }
        const parts = ticket.trim().split(".");
        if (parts.length !== 3 || parts[0] !== "aether_ticket") {
            return {
                authorized: false,
                statusCode: 401,
                error: "Malformed ticket format. Expected 'aether_ticket.<payload>.<sig>'."
            };
        }
        const [, payloadB64, signature] = parts;
        const expectedSig = crypto.createHmac("sha256", secret)
            .update(payloadB64)
            .digest("base64url");
        if (!constantTimeTextEqual(signature, expectedSig)) {
            return {
                authorized: false,
                statusCode: 401,
                error: "Cryptographic ticket signature verification failed."
            };
        }
        let credential: ScopedCredential & {
            purpose?: string;
        };
        try {
            credential = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf-8"));
        }
        catch {
            return { authorized: false, statusCode: 400, error: "Invalid ticket payload encoding." };
        }
        if (!isValidCredential(credential)) {
            return { authorized: false, statusCode: 401, error: "Invalid WebSocket ticket claims." };
        }
        if (credential.purpose !== "ws-ticket") {
            return {
                authorized: false,
                statusCode: 403,
                error: "Invalid ticket purpose: must be 'ws-ticket'."
            };
        }
        if (credential.actions.length !== 1 || credential.actions[0] !== "repo:read") {
            return { authorized: false, statusCode: 403, error: "WebSocket tickets must grant repository read only." };
        }
        const nowSec = Math.floor(Date.now() / 1000);
        if (nowSec >= credential.exp) {
            return {
                authorized: false,
                statusCode: 401,
                error: `WebSocket ticket expired at ${new Date(credential.exp * 1000).toISOString()}.`
            };
        }
        if (credential.repo !== "*" && credential.repo !== requiredRepo) {
            return {
                authorized: false,
                statusCode: 403,
                error: `Ticket repo scope '${credential.repo}' does not match requested repo '${requiredRepo}'.`
            };
        }
        return {
            authorized: true,
            statusCode: 200,
            credential
        };
    }
    public static verifyAuthorization(authHeader: string | null | undefined, requiredRepo: string, requiredAction: ActionCapability, overrideSecret?: string): SecurityValidationResult {
        const secret = overrideSecret || clusterAuthSecret;
        if (!secret || secret.length < MIN_CLUSTER_SECRET_LENGTH) {
            return {
                authorized: false,
                statusCode: 500,
                error: "Server misconfiguration: AETHER_AUTH_SECRET signing secret is not configured in Cloudflare environment."
            };
        }
        if (!authHeader) {
            return {
                authorized: false,
                statusCode: 401,
                error: "Missing Authorization header. Valid scoped credential required."
            };
        }
        const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : authHeader.trim();
        const parts = token.split(".");
        if (parts.length !== 3 || parts[0] !== "aether_token") {
            return {
                authorized: false,
                statusCode: 401,
                error: "Malformed credential format. Expected 'aether_token.<payload>.<sig>'."
            };
        }
        const [, payloadB64, signature] = parts;
        const expectedSignature = crypto.createHmac("sha256", secret)
            .update(payloadB64)
            .digest("base64url");
        if (!constantTimeTextEqual(signature, expectedSignature)) {
            return {
                authorized: false,
                statusCode: 401,
                error: "Cryptographic signature verification failed. Forged or corrupted credential."
            };
        }
        let credential: ScopedCredential;
        try {
            credential = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf-8"));
        }
        catch {
            return { authorized: false, statusCode: 400, error: "Invalid payload encoding." };
        }
        if (!isValidCredential(credential)) {
            return { authorized: false, statusCode: 401, error: "Invalid scoped credential claims." };
        }
        const nowSec = Math.floor(Date.now() / 1000);
        if (nowSec >= credential.exp) {
            return {
                authorized: false,
                statusCode: 401,
                error: `Credential expired at ${new Date(credential.exp * 1000).toISOString()} (current time: ${new Date().toISOString()}).`
            };
        }
        if (credential.repo !== "*" && credential.repo !== requiredRepo) {
            return {
                authorized: false,
                statusCode: 403,
                error: `Wrong repository scope: credential is valid for '${credential.repo}', but '${requiredRepo}' was requested.`
            };
        }
        if (!credential.actions.includes(requiredAction)) {
            return {
                authorized: false,
                statusCode: 403,
                error: `Wrong capability scope: credential lacks required action '${requiredAction}'. Permitted: [${credential.actions.join(", ")}].`
            };
        }
        return {
            authorized: true,
            statusCode: 200,
            credential
        };
    }
    public static validatePayloadSize(payloadBytes: number): {
        valid: boolean;
        error?: string;
    } {
        if (payloadBytes > MAX_PAYLOAD_BYTES) {
            return {
                valid: false,
                error: `Payload size (${payloadBytes} bytes) exceeds maximum allowable limit of ${MAX_PAYLOAD_BYTES} bytes (1MB).`
            };
        }
        return { valid: true };
    }
}
function isValidSubject(value: unknown): value is string {
    return typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value);
}
function isValidRepositoryScope(value: unknown): value is string {
    return typeof value === "string" && value.length > 0 && value.length <= 256 &&
        !/[\x00-\x1f\x7f]/.test(value);
}
function isValidCredential(value: unknown): value is ScopedCredential & {
    purpose?: string;
} {
    if (!value || typeof value !== "object")
        return false;
    const credential = value as Partial<ScopedCredential> & {
        purpose?: unknown;
    };
    return isValidSubject(credential.sub) && isValidRepositoryScope(credential.repo) &&
        Array.isArray(credential.actions) && credential.actions.length > 0 && credential.actions.length <= VALID_ACTIONS.size &&
        credential.actions.every(action => VALID_ACTIONS.has(action)) &&
        Number.isSafeInteger(credential.exp) && Number.isSafeInteger(credential.issuedAt) &&
        Number(credential.exp) > Number(credential.issuedAt) &&
        (credential.purpose === undefined || typeof credential.purpose === "string");
}
function constantTimeTextEqual(left: string, right: string): boolean {
    if (left.length !== right.length)
        return false;
    let difference = 0;
    for (let index = 0; index < left.length; index++) {
        difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
    }
    return difference === 0;
}
