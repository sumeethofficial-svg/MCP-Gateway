import { spawn } from "node:child_process";

/** Status of a Helm release as the provisioner cares about it. */
export type ReleaseState = "none" | "deployed" | "pending" | "failed";

export interface InstallRequest {
  namespace: string;
  release: string;
  chartPath: string;
  /** Values files, applied in order. */
  valuesFiles: string[];
  timeoutSeconds: number;
  signal: AbortSignal;
}

export interface Helm {
  state(namespace: string, release: string): Promise<ReleaseState>;
  /** Resolves when the release is installed and everything (including the setup job) is ready. */
  install(req: InstallRequest): Promise<void>;
  uninstall(namespace: string, release: string): Promise<void>;
}

export class HelmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HelmError";
  }
}

/** The last meaningful line of helm's output, with control characters removed. Never includes values. */
export function lastLine(output: string): string {
  const lines = output
    .split(/\r?\n/)
    .map((l) => l.replace(/[\u0000-\u001f\u007f]/g, " ").trim())
    .filter(Boolean);
  const line = lines[lines.length - 1] ?? "helm exited with an error";
  return line.length > 300 ? `${line.slice(0, 297)}...` : line;
}

function run(bin: string, args: string[], opts: { signal?: AbortSignal; env?: NodeJS.ProcessEnv } = {}): Promise<{ code: number; out: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env: opts.env, stdio: ["ignore", "pipe", "pipe"], signal: opts.signal });
    let out = "";
    const keep = (c: Buffer) => {
      out = (out + c.toString("utf8")).slice(-8192);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    child.on("error", (err) => reject(opts.signal?.aborted ? new HelmError("aborted") : new HelmError(`cannot run helm: ${err.message}`)));
    child.on("close", (code) => resolve({ code: code ?? 1, out }));
  });
}

export function cliHelm(bin = "helm", baseEnv: NodeJS.ProcessEnv = process.env): Helm {
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    HOME: baseEnv.HOME ?? "/tmp",
    HELM_CACHE_HOME: "/tmp/helm/cache",
    HELM_CONFIG_HOME: "/tmp/helm/config",
    HELM_DATA_HOME: "/tmp/helm/data",
  };
  return {
    async state(namespace, release) {
      const r = await run(bin, ["status", release, "--namespace", namespace, "--output", "json"], { env });
      if (r.code !== 0) {
        if (/not found/i.test(r.out)) return "none";
        throw new HelmError(lastLine(r.out));
      }
      try {
        const status = (JSON.parse(r.out) as { info?: { status?: string } }).info?.status ?? "";
        if (status === "deployed") return "deployed";
        if (status.startsWith("pending")) return "pending";
        return "failed";
      } catch {
        throw new HelmError("could not read helm status output");
      }
    },
    async install(req) {
      const args = [
        "upgrade", "--install", req.release, req.chartPath,
        "--namespace", req.namespace,
        ...req.valuesFiles.flatMap((f) => ["-f", f]),
        "--wait", "--wait-for-jobs", "--timeout", `${req.timeoutSeconds}s`,
      ];
      const r = await run(bin, args, { env, signal: req.signal });
      if (r.code !== 0) throw new HelmError(lastLine(r.out));
    },
    async uninstall(namespace, release) {
      const r = await run(bin, ["uninstall", release, "--namespace", namespace, "--wait=false"], { env });
      if (r.code !== 0 && !/not found/i.test(r.out)) throw new HelmError(lastLine(r.out));
    },
  };
}
