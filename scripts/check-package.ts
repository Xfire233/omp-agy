// Public-release smoke: install the packed artifact into an empty Bun project.
// No OMP, CLI activation, credentials, or provider requests are needed.
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../", import.meta.url));
const root = await mkdtemp(join(tmpdir(), "agy-package-"));
async function command(cwd: string, argv: string[]) {
  const child = Bun.spawn(argv, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [exit, out, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (exit !== 0) throw new Error(`${argv[1]} failed (${exit}): ${error.slice(-1600)}`);
  return out;
}
try {
  const tarball = join(root, "bridge.tgz");
  await command(repository, [process.execPath, "pm", "pack", "--ignore-scripts", "--filename", tarball]);
  const paths = (await command(root, ["tar", "-tzf", tarball])).trim().split(/\r?\n/).map(path => path.replace(/^package\//, ""));
  const allowed = /^(?:package\.json|README\.md|CHANGELOG\.md|LICENSE|core\.ts|index\.ts|(?:src|examples)\/[\w/-]+\.ts|scripts\/(?:bootstrap|supervisor|account-login)\.sh)$/;
  if (paths.some(path => !allowed.test(path))) throw new Error("Unexpected file in release payload; inspect pack contents before distributing.");
  for (const path of ["index.ts", "core.ts", "scripts/bootstrap.sh", "scripts/supervisor.sh", "scripts/account-login.sh", "examples/standalone.ts", "README.md", "CHANGELOG.md", "LICENSE"]) {
    if (!paths.includes(path)) throw new Error(`Missing package asset: ${path}`);
  }
  const consumer = join(root, "consumer"); await mkdir(consumer);
  await writeFile(join(consumer, "package.json"), JSON.stringify({ name: "bridge-consumer", private: true, dependencies: { "omp-agy": "file:../bridge.tgz" } }));
  await command(consumer, [process.execPath, "install", "--ignore-scripts"]);
  await command(consumer, [process.execPath, "-e", `import { Agent } from 'omp-agy/core';
    if (typeof Agent.open !== 'function') throw new Error('missing Agent.open');
    for (const peer of ['@oh-my-pi/pi-ai', '@oh-my-pi/pi-coding-agent', '@oh-my-pi/snapcompact']) {
      if (Bun.resolveSync && (() => {try { Bun.resolveSync(peer, process.cwd()); return true; } catch { return false; }})()) throw new Error('unintended OMP dependency: '+peer);
    }`]);
  console.log(`Verified ${paths.length} packaged files; omp-agy/core loaded in a standalone consumer without OMP.`);
} finally { await rm(root, { recursive: true, force: true, maxRetries: 3 }); }
