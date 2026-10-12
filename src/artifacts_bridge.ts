import path from "path";
import git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { Env, ArtifactsQueueEvent, ArtifactsBinding, ArtifactsRepo, ArtifactsCreateRepoResult, ArtifactsCreateTokenResult } from "./types";
import { MemoryFS } from "./memory_fs";
export interface ArtifactsWorkspace {
    repo: string;
    cloneUrl: string;
    token: string;
    expiresAt: number;
}
export interface CommitLandingResult {
    success: boolean;
    commitSha?: string;
    error?: string;
    baseShaMismatch?: boolean;
}
export interface ArtifactsBranchSnapshot {
    repo: string;
    branch: string;
    cloneUrl: string;
    headSha: string;
    filePath: string;
    content: string | null;
}
export class ArtifactsBridge {
    private defaultLocalBinding?: ArtifactsBinding;
    private getBinding(env: Env): ArtifactsBinding {
        if (env.ARTIFACTS) return env.ARTIFACTS;
        if (!this.defaultLocalBinding) {
            this.defaultLocalBinding = createLocalArtifactsBinding();
        }
        return this.defaultLocalBinding;
    }
    public async getBranchHeadSha(repo: string, branch: string, env: Env): Promise<string> {
        const binding = this.getBinding(env);
        if (!isSafeBranchName(branch))
            throw new Error("Invalid Git branch name.");
        const handle = await binding.get(repo);
        const commits = handle.log ? await handle.log({ ref: branch, limit: 1 }) : [];
        const headSha = commits[0]?.hash || (typeof handle.headSha === "string" ? handle.headSha : "");
        if (!headSha) {
            if (!handle.log && typeof handle.headSha !== "string") {
                throw new Error("Artifacts binding cannot report the requested branch head.");
            }
            return "0000000000000000000000000000000000000000";
        }
        if (!isGitSha(headSha))
            throw new Error("Artifacts returned an invalid branch head SHA.");
        return headSha;
    }
    public async getBranchSnapshot(repo: string, branch: string, filePath: string, env: Env): Promise<ArtifactsBranchSnapshot> {
        const binding = this.getBinding(env);
        if (!isSafeBranchName(branch))
            throw new Error("Invalid Git branch name.");
        const normalizedPath = normalizeRepoPath(filePath);
        if (!normalizedPath)
            throw new Error("Invalid repository path.");
        let handle: ArtifactsRepo;
        try {
            handle = await binding.get(repo);
        }
        catch (err: any) {
            if (err?.code === "NOT_FOUND" || err?.message?.toLowerCase().includes("not found")) {
                const created = await binding.create(repo, { setDefaultBranch: branch });
                return {
                    repo,
                    branch,
                    cloneUrl: created.remote,
                    headSha: "0000000000000000000000000000000000000000",
                    filePath: normalizedPath,
                    content: null
                };
            }
            throw err;
        }
        const info = await handle.info();
        const commits = handle.log ? await handle.log({ ref: branch, limit: 1 }) : [];
        const headSha = commits[0]?.hash || (handle as any).headSha || "0000000000000000000000000000000000000000";
        if (/^0+$/.test(headSha))
            return { repo, branch, cloneUrl: info.remote, headSha: "0000000000000000000000000000000000000000", filePath: normalizedPath, content: null };
        let content: string | null = null;
        if (info.remote.startsWith("local://") && (handle as any).fs) {
            try {
                content = await (handle as any).fs.promises.readFile(`/workspace/${normalizedPath}`, "utf8");
            }
            catch {
                content = null;
            }
        }
        else if (handle.readFile) {
            const blob = await handle.readFile({ ref: branch, path: normalizedPath });
            content = blob ? await blob.text() : null;
        }
        return { repo, branch, cloneUrl: info.remote, headSha, filePath: normalizedPath, content };
    }
    public async provisionAgentWorkspace(agentId: string, repoName: string, env: Env): Promise<ArtifactsWorkspace> {
        const binding = this.getBinding(env);
        let cloneUrl = "";
        let token = "";
        const ttlSeconds = 86400;
        try {
            let repoHandle: ArtifactsRepo;
            try {
                repoHandle = await binding.get(repoName);
            }
            catch (err: any) {
                if (err?.code !== "NOT_FOUND")
                    throw err;
                const created = await binding.create(repoName, {
                    description: `Aether workspace for agent ${agentId}`,
                    setDefaultBranch: "main"
                });
                return { repo: repoName, cloneUrl: created.remote, token: created.token, expiresAt: Date.now() + ttlSeconds * 1000 };
            }
            const createdToken = await repoHandle.createToken("write", ttlSeconds);
            const info = await repoHandle.info();
            return { repo: repoName, cloneUrl: info.remote, token: createdToken.plaintext, expiresAt: Date.parse(createdToken.expiresAt) };
        }
        catch (err: any) {
            throw new Error(`Failed to provision Artifacts repository '${repoName}': ${err.message || String(err)}`);
        }
    }
    public async handleArtifactsQueueMessage(event: ArtifactsQueueEvent, env: Env): Promise<{
        processed: boolean;
        repo: string;
        commitSha: string;
    }> {
        const sourceRepo = typeof event.source === "object" ? event.source?.repoName : undefined;
        const repo = sourceRepo || event.payload?.repo || "";
        const isPush = event.type === "cf.artifacts.repo.pushed" || event.type === "repo.push";
        if (!isPush)
            return { processed: false, repo: repo || "unknown", commitSha: "" };
        if (!event.payload || !repo)
            throw new Error("Artifacts push event is missing its payload or repository name.");
        const commitSha = event.payload.after || event.payload.commit_sha || "";
        const beforeSha = event.payload.before || event.payload.before_sha || "";
        const rawPusher = typeof event.payload.pusher === "string" ? event.payload.pusher : event.payload.pusher?.name;
        const pusher = typeof rawPusher === "string" && rawPusher.length <= 256 && rawPusher.trim() ? rawPusher.trim() : "unknown";
        if (repo.length > 256 || /[\x00-\x1f\x7f]/.test(repo))
            throw new Error("Artifacts event contains an invalid repository name.");
        if (!commitSha)
            throw new Error("Artifacts push event did not contain payload.after commit SHA");
        if (!isGitSha(commitSha) || (beforeSha && !isGitSha(beforeSha))) {
            throw new Error("Artifacts push event contains an invalid commit SHA.");
        }
        const ref = event.payload.ref || (event.type === "repo.push" ? "refs/heads/main" : "");
        if (!ref)
            throw new Error("Artifacts push event did not contain a branch ref.");
        if (!ref.startsWith("refs/heads/"))
            return { processed: false, repo, commitSha };
        const branch = ref.slice("refs/heads/".length);
        if (!isSafeBranchName(branch))
            throw new Error("Artifacts push event contains an invalid branch name.");
        const observedHeadSha = await this.getBranchHeadSha(repo, branch, env);
        const coordinatorId = env.MESH_COORDINATOR_DO.idFromName(repo);
        const coordinatorStub = env.MESH_COORDINATOR_DO.get(coordinatorId);
        const response = await coordinatorStub.fetch(new Request("https://mesh-coordinator.internal/events/push", {
            method: "POST",
            body: JSON.stringify({
                repo,
                branch,
                commitSha,
                beforeSha,
                observedHeadSha,
                pusher,
                timestamp: Date.now()
            }),
            headers: { "Content-Type": "application/json" }
        }));
        if (!response.ok) {
            const detail = (await response.text()).slice(0, 500);
            const err: any = new Error(`Coordinator rejected Artifacts push event (${response.status}): ${detail}`);
            err.statusCode = 502;
            throw err;
        }
        const result = await response.json().catch(() => null) as {
            processed?: boolean;
        } | null;
        if (!result?.processed) {
            const err: any = new Error("Coordinator did not confirm Artifacts push event processing.");
            err.statusCode = 502;
            throw err;
        }
        return { processed: true, repo, commitSha };
    }
    public async handlePushWebhook(event: any, env: Env): Promise<{
        processed: boolean;
        repo: string;
        commitSha: string;
    }> {
        const payload = event?.payload || {};
        const normalized: ArtifactsQueueEvent = {
            type: event?.type || "cf.artifacts.repo.pushed",
            source: event?.source || { type: "artifacts.repo", repoName: event?.repo || "" },
            payload: {
                repo: payload.repo || event?.repo,
                ref: payload.ref || event?.ref || "refs/heads/main",
                after: payload.after || payload.commit_sha || event?.after || event?.commitSha,
                before: payload.before || payload.before_sha || event?.before || event?.beforeSha,
                pusher: payload.pusher || event?.pusher
            }
        };
        return this.handleArtifactsQueueMessage(normalized, env);
    }
    public async landVPRToArtifacts(repo: string, modulePath: string, targetBranch: string, expectedBaseSha: string, commitMessage: string, sourceContent: string, env: Env, extraFiles?: Array<{
        path: string;
        content: string;
    }>): Promise<CommitLandingResult> {
        const binding = this.getBinding(env);
        if (!isSafeBranchName(targetBranch))
            return { success: false, error: "Invalid Git branch name." };
        if (expectedBaseSha && !isGitSha(expectedBaseSha))
            return { success: false, error: "Invalid expected base commit SHA." };
        const normalizedPath = normalizeRepoPath(modulePath);
        if (!normalizedPath) {
            return { success: false, error: "Invalid repository path: absolute paths and '..' segments are not allowed." };
        }
        try {
            let rawToken = "";
            let remoteUrl = "";
            let repoHandle: ArtifactsRepo | undefined;
            try {
                repoHandle = await binding.get(repo);
            }
            catch (err: any) {
                if (err?.code !== "NOT_FOUND")
                    throw err;
                const created = await binding.create(repo, { setDefaultBranch: targetBranch });
                rawToken = created.token;
                remoteUrl = created.remote;
            }
            if (repoHandle) {
                const tokenResult = await repoHandle.createToken("write", 300);
                rawToken = tokenResult.plaintext;
                remoteUrl = (await repoHandle.info()).remote;
            }
            const tokenSecret = rawToken.split("?expires=")[0];
            if (!tokenSecret || !remoteUrl)
                throw new Error("Artifacts did not return a usable Git remote and write token.");
            let currentHeadSha: string | undefined;
            const isLocalBinding = remoteUrl.startsWith("local://");
            if (isLocalBinding) {
                try {
                    const repoHandle = await binding.get(repo);
                    const info = await repoHandle.info();
                    currentHeadSha = (repoHandle as any).headSha || (info as any).headSha || (expectedBaseSha || undefined);
                }
                catch {
                    currentHeadSha = expectedBaseSha || undefined;
                }
            }
            else {
                try {
                    const remoteInfo = await git.getRemoteInfo({
                        http,
                        url: remoteUrl,
                        onAuth: () => ({ username: "x", password: tokenSecret })
                    });
                    currentHeadSha = remoteInfo.refs?.heads?.[targetBranch];
                }
                catch (remoteErr: any) {
                    if (expectedBaseSha) {
                        return {
                            success: false,
                            error: `Failed to inspect remote repository head: ${remoteErr.message || String(remoteErr)}`
                        };
                    }
                }
            }
            if (expectedBaseSha && currentHeadSha && currentHeadSha !== expectedBaseSha) {
                let landedCommitSha: string | undefined;
                let landedMessage: string | undefined;
                let landedParents: string[] = [];
                let landedContent: string | null = null;
                if (isLocalBinding) {
                    try {
                        const localFs = (repoHandle as any)?.fs as MemoryFS | undefined;
                        if (localFs) {
                            const latest = (await git.log({ fs: localFs, dir: "/workspace", ref: targetBranch, depth: 1 }))[0];
                            if (latest) {
                                landedCommitSha = latest.oid;
                                landedMessage = latest.commit.message;
                                landedParents = latest.commit.parent;
                                landedContent = await localFs.promises.readFile(`/workspace/${normalizedPath}`, "utf8").catch(() => null);
                            }
                        }
                    }
                    catch { }
                }
                else if (repoHandle?.log && repoHandle.readFile) {
                    try {
                        const latest = (await repoHandle.log({ ref: targetBranch, limit: 1 }))[0];
                        const blob = await repoHandle.readFile({ ref: targetBranch, path: normalizedPath });
                        landedCommitSha = latest?.hash;
                        landedMessage = latest?.message;
                        landedParents = latest?.parents || [];
                        landedContent = blob ? await blob.text() : null;
                    }
                    catch { }
                }
                const expectedParentMatches = /^0+$/.test(expectedBaseSha)
                    ? landedParents.length === 0
                    : landedParents.includes(expectedBaseSha);
                if (landedCommitSha === currentHeadSha && landedMessage?.trim() === commitMessage.trim() &&
                    expectedParentMatches && landedContent === sourceContent) {
                    return { success: true, commitSha: landedCommitSha };
                }
                return {
                    success: false,
                    baseShaMismatch: true,
                    error: `Base-SHA mismatch: branch '${targetBranch}' head is ${currentHeadSha}, expected ${expectedBaseSha}. Concurrent update detected; re-arbitration required.`
                };
            }
            if (!isLocalBinding && expectedBaseSha && !currentHeadSha && !/^0+$/.test(expectedBaseSha)) {
                return { success: false, baseShaMismatch: true, error: `Remote branch '${targetBranch}' has no head, but proposal was based on ${expectedBaseSha}.` };
            }
            let fs: MemoryFS;
            const dir = "/workspace";
            if (isLocalBinding) {
                try {
                    const repoHandle = await binding.get(repo);
                    if ((repoHandle as any).fs) {
                        fs = (repoHandle as any).fs;
                    }
                    else {
                        fs = new MemoryFS();
                        (repoHandle as any).fs = fs;
                    }
                }
                catch {
                    fs = new MemoryFS();
                }
            }
            else {
                fs = new MemoryFS();
            }
            if (currentHeadSha && !isLocalBinding) {
                try {
                    await git.clone({
                        fs,
                        http,
                        dir,
                        url: remoteUrl,
                        ref: targetBranch,
                        singleBranch: true,
                        depth: 1,
                        onAuth: () => ({ username: "x", password: tokenSecret })
                    });
                }
                catch (cloneErr: any) {
                    return { success: false, error: `Failed to clone existing Artifacts branch '${targetBranch}': ${cloneErr.message || String(cloneErr)}` };
                }
            }
            else {
                try {
                    await fs.promises.stat(`${dir}/.git`);
                }
                catch {
                    await git.init({ fs, dir, defaultBranch: targetBranch });
                }
            }
            const allFiles: Array<{
                path: string;
                content: string;
            }> = [
                { path: normalizedPath, content: sourceContent },
                ...(extraFiles || []).map(f => ({ path: normalizeRepoPath(f.path) || f.path, content: f.content }))
            ];
            for (const f of allFiles) {
                if (!f.path)
                    continue;
                const fullFilePath = `${dir}/${f.path}`;
                const parentDir = path.dirname(fullFilePath);
                if (parentDir && parentDir !== dir && parentDir !== ".") {
                    await fs.promises.mkdir(parentDir, { recursive: true });
                }
                await fs.promises.writeFile(fullFilePath, f.content);
                await git.add({ fs, dir, filepath: f.path });
            }
            let parentList: string[] | undefined;
            const candidateParent = currentHeadSha || expectedBaseSha;
            if (candidateParent && !/^0+$/.test(candidateParent)) {
                try {
                    await git.readCommit({ fs, dir, oid: candidateParent });
                    parentList = [candidateParent];
                }
                catch {
                    parentList = undefined;
                }
            }
            const commitSha = await git.commit({
                fs,
                dir,
                message: commitMessage,
                author: {
                    name: "Project Aether Arbiter",
                    email: "arbiter@aether.cloudflare"
                },
                parent: parentList
            });
            if (!isLocalBinding) {
                const pushResult = await git.push({
                    fs,
                    http,
                    dir,
                    url: remoteUrl,
                    ref: targetBranch,
                    onAuth: () => ({ username: "x", password: tokenSecret })
                });
                if (!pushResult.ok) {
                    return {
                        success: false,
                        error: `Git push to Cloudflare Artifacts failed: ${pushResult.error || JSON.stringify((pushResult as any).errors || "Push rejected")}`
                    };
                }
            }
            else {
                try {
                    const repoHandle = await binding.get(repo);
                    if (repoHandle)
                        (repoHandle as any).headSha = commitSha;
                }
                catch { }
            }
            return {
                success: true,
                commitSha
            };
        }
        catch (err: any) {
            return {
                success: false,
                error: `Artifacts Git push exception: ${err.message || String(err)}`
            };
        }
    }
}
export function createLocalArtifactsBinding(): ArtifactsBinding {
    const repos = new Map<string, {
        name: string;
        remote: string;
        defaultBranch: string;
        headSha: string;
        files: Map<string, string>;
        fs: MemoryFS;
    }>();
    const createRepo = async (name: string, opts?: {
        readOnly?: boolean;
        description?: string;
        setDefaultBranch?: string;
    }): Promise<ArtifactsCreateRepoResult> => {
        const defaultBranch = opts?.setDefaultBranch || "main";
        const remote = `local://artifacts.local/${name}.git`;
        const token = `art_v1_local_token_${name}_${Date.now()}?expires=${Math.floor(Date.now() / 1000) + 86400}`;
        repos.set(name, {
            name,
            remote,
            defaultBranch,
            headSha: "0000000000000000000000000000000000000000",
            files: new Map(),
            fs: new MemoryFS()
        });
        return { id: `repo_${name}`, name, description: opts?.description || null, remote, defaultBranch, token };
    };
    return {
        create: createRepo,
        async get(name: string): Promise<ArtifactsRepo> {
            let repo = repos.get(name);
            if (!repo) {
                await createRepo(name);
                repo = repos.get(name)!;
            }
            return {
                async createToken(scope: "read" | "write" = "write", ttlSeconds = 3600): Promise<ArtifactsCreateTokenResult> {
                    return {
                        id: `token_${name}_${Date.now()}`,
                        plaintext: `art_v1_token_${name}_${scope}_${Date.now()}?expires=${Math.floor(Date.now() / 1000) + ttlSeconds}`,
                        scope,
                        expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString()
                    };
                },
                async info() {
                    return {
                        id: `repo_${repo.name}`,
                        name: repo.name,
                        remote: repo.remote,
                        defaultBranch: repo.defaultBranch,
                        readOnly: false
                    };
                },
                async fork(targetName: string) {
                    const created = await createRepo(targetName, { setDefaultBranch: repo.defaultBranch });
                    const targetRepo = repos.get(targetName)!;
                    for (const [k, v] of repo.files.entries()) {
                        targetRepo.files.set(k, v);
                    }
                    targetRepo.headSha = repo.headSha;
                    targetRepo.fs = repo.fs;
                    return created;
                },
                get fs() { return repo.fs; },
                get headSha() { return repo.headSha; },
                set headSha(value: string) { repo.headSha = value; }
            };
        },
        async delete(name: string) {
            const existed = repos.delete(name);
            return { success: existed };
        },
        async createToken(repoName: string, options: {
            scope: "read" | "write";
            ttlSeconds?: number;
        }) {
            const ttlSeconds = options.ttlSeconds || 3600;
            return {
                id: `token_${repoName}_${Date.now()}`,
                plaintext: `art_v1_token_${repoName}_${options.scope}_${Date.now()}?expires=${Math.floor(Date.now() / 1000) + ttlSeconds}`,
                scope: options.scope,
                expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString()
            };
        },
        async getRepository(name: string) {
            const r = repos.get(name);
            if (!r)
                return null;
            return { id: `repo_${r.name}`, name: r.name, defaultBranch: r.defaultBranch };
        }
    };
}
export function isGitSha(value: string): boolean {
    return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value);
}
export function isSafeBranchName(branch: string): boolean {
    if (!branch || branch.length > 255 || branch === "@" || branch.startsWith("/") || branch.endsWith("/") ||
        branch.includes("..") || branch.includes("//") || branch.includes("@{"))
        return false;
    if (/[\x00-\x20\x7f~^:?*\[\\]/.test(branch))
        return false;
    return branch.split("/").every(part => part.length > 0 && !part.startsWith(".") && !part.startsWith("-") &&
        !part.endsWith(".") && !part.endsWith(".lock"));
}
export function normalizeRepoPath(modulePath: string): string | null {
    if (!modulePath || modulePath.length > 1024 || modulePath.startsWith("/") || modulePath.includes("\\") || /[\x00-\x1f\x7f]/.test(modulePath))
        return null;
    const segments = modulePath.split("/");
    if (segments.some(segment => !segment || segment === "." || segment === ".."))
        return null;
    return segments.join("/");
}
