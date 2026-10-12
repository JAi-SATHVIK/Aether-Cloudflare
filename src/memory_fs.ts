export type Entry = {
    kind: "dir";
    children: Set<string>;
    mtimeMs: number;
} | {
    kind: "file";
    data: Uint8Array;
    mtimeMs: number;
};
export class MemoryStats {
    entry: Entry;
    constructor(entry: Entry) {
        this.entry = entry;
    }
    get size(): number {
        return this.entry.kind === "file" ? this.entry.data.byteLength : 0;
    }
    get mtimeMs(): number {
        return this.entry.mtimeMs;
    }
    get ctimeMs(): number {
        return this.entry.mtimeMs;
    }
    get mode(): number {
        return this.entry.kind === "file" ? 0o100644 : 0o040000;
    }
    isFile(): boolean {
        return this.entry.kind === "file";
    }
    isDirectory(): boolean {
        return this.entry.kind === "dir";
    }
    isSymbolicLink(): boolean {
        return false;
    }
}
export class MemoryFS {
    private encoder = new TextEncoder();
    private decoder = new TextDecoder();
    public entries = new Map<string, Entry>([
        ["/", { kind: "dir", children: new Set<string>(), mtimeMs: Date.now() }]
    ]);
    public promises = {
        readFile: this.readFile.bind(this),
        writeFile: this.writeFile.bind(this),
        unlink: this.unlink.bind(this),
        readdir: this.readdir.bind(this),
        mkdir: this.mkdir.bind(this),
        rmdir: this.rmdir.bind(this),
        stat: this.stat.bind(this),
        lstat: this.lstat.bind(this),
        readlink: this.readlink.bind(this),
        symlink: this.symlink.bind(this)
    };
    public async readlink(pathStr: string): Promise<string> {
        throw new Error(`ENOSYS: symlinks not supported in MemoryFS (${pathStr})`);
    }
    public async symlink(target: string, pathStr: string): Promise<void> {
        throw new Error(`ENOSYS: symlinks not supported in MemoryFS (${pathStr} -> ${target})`);
    }
    public normalize(input: string): string {
        const segments: string[] = [];
        for (const part of input.split("/")) {
            if (!part || part === ".")
                continue;
            if (part === "..") {
                segments.pop();
                continue;
            }
            segments.push(part);
        }
        return `/${segments.join("/")}` || "/";
    }
    public parent(pathStr: string): string {
        const normalized = this.normalize(pathStr);
        if (normalized === "/")
            return "/";
        const parts = normalized.split("/").filter(Boolean);
        parts.pop();
        return parts.length ? `/${parts.join("/")}` : "/";
    }
    public basename(pathStr: string): string {
        return this.normalize(pathStr).split("/").filter(Boolean).pop() ?? "";
    }
    public getEntry(pathStr: string): Entry | undefined {
        return this.entries.get(this.normalize(pathStr));
    }
    public requireEntry(pathStr: string): Entry {
        const entry = this.getEntry(pathStr);
        if (!entry) {
            const err: any = new Error(`ENOENT: no such file or directory, stat '${pathStr}'`);
            err.code = "ENOENT";
            err.errno = -2;
            throw err;
        }
        return entry;
    }
    public requireDir(pathStr: string): Entry & {
        kind: "dir";
    } {
        const entry = this.requireEntry(pathStr);
        if (entry.kind !== "dir") {
            const err: any = new Error(`ENOTDIR: not a directory, '${pathStr}'`);
            err.code = "ENOTDIR";
            throw err;
        }
        return entry as Entry & {
            kind: "dir";
        };
    }
    public async mkdir(pathStr: string, options?: {
        recursive?: boolean;
    }): Promise<void> {
        const target = this.normalize(pathStr);
        if (target === "/")
            return;
        const recursive = typeof options === "object" && options !== null && !!options.recursive;
        const parentPath = this.parent(target);
        if (!this.entries.has(parentPath)) {
            if (!recursive) {
                const err: any = new Error(`ENOENT: no such file or directory, mkdir '${parentPath}'`);
                err.code = "ENOENT";
                throw err;
            }
            await this.mkdir(parentPath, { recursive: true });
        }
        if (this.entries.has(target)) {
            return;
        }
        this.entries.set(target, {
            kind: "dir",
            children: new Set<string>(),
            mtimeMs: Date.now()
        });
        this.requireDir(parentPath).children.add(this.basename(target));
    }
    public async writeFile(pathStr: string, data: string | Uint8Array): Promise<void> {
        const target = this.normalize(pathStr);
        await this.mkdir(this.parent(target), { recursive: true });
        const bytes = typeof data === "string"
            ? this.encoder.encode(data)
            : data instanceof Uint8Array
                ? data
                : new Uint8Array(data);
        this.entries.set(target, {
            kind: "file",
            data: bytes,
            mtimeMs: Date.now()
        });
        this.requireDir(this.parent(target)).children.add(this.basename(target));
    }
    public async readFile(pathStr: string, options?: {
        encoding?: string;
    } | string): Promise<any> {
        const entry = this.requireEntry(pathStr);
        if (entry.kind !== "file") {
            const err: any = new Error(`EISDIR: illegal operation on a directory, read '${pathStr}'`);
            err.code = "EISDIR";
            throw err;
        }
        const encoding = typeof options === "string" ? options : options?.encoding;
        return encoding ? this.decoder.decode(entry.data) : entry.data;
    }
    public async readdir(pathStr: string): Promise<string[]> {
        return [...this.requireDir(pathStr).children].sort();
    }
    public async unlink(pathStr: string): Promise<void> {
        const target = this.normalize(pathStr);
        const entry = this.requireEntry(target);
        if (entry.kind !== "file") {
            const err: any = new Error(`EISDIR: illegal operation on a directory, unlink '${target}'`);
            err.code = "EISDIR";
            throw err;
        }
        this.entries.delete(target);
        this.requireDir(this.parent(target)).children.delete(this.basename(target));
    }
    public async rmdir(pathStr: string): Promise<void> {
        const target = this.normalize(pathStr);
        const entry = this.requireDir(target);
        if (entry.children.size > 0) {
            const err: any = new Error(`ENOTEMPTY: directory not empty, rmdir '${target}'`);
            err.code = "ENOTEMPTY";
            throw err;
        }
        this.entries.delete(target);
        this.requireDir(this.parent(target)).children.delete(this.basename(target));
    }
    public async stat(pathStr: string): Promise<MemoryStats> {
        return new MemoryStats(this.requireEntry(pathStr));
    }
    public async lstat(pathStr: string): Promise<MemoryStats> {
        return this.stat(pathStr);
    }
}
