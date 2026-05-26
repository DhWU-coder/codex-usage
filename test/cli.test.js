import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

function jsonl(rows) {
  return rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
}

async function makeFixtureHome() {
  const fakeHome = await mkdtemp(path.join(tmpdir(), "codex-cli-"));
  const sessionDir = path.join(fakeHome, ".codex", "sessions", "2026", "05", "01");
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    path.join(sessionDir, "rollout.jsonl"),
    jsonl([
      {
        timestamp: "2026-05-01T02:00:00.000Z",
        type: "session_meta",
        payload: { id: "cli-run-1", source: "cli", originator: "codex-tui", cwd: "/work/cli" },
      },
      {
        timestamp: "2026-05-01T02:01:00.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              total_tokens: 77,
              input_tokens: 60,
              cached_input_tokens: 10,
              output_tokens: 17,
              reasoning_output_tokens: 3,
            },
          },
        },
      },
    ]),
  );
  return fakeHome;
}

function waitForServerUrl(child) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for server URL. Output: ${output}`));
    }, 5000);

    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[0]);
      }
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Server exited before ready: ${code}. Output: ${output}`));
    });
  });
}

function waitForExit(child) {
  if (child.exitCode !== null) {
    return Promise.resolve(child.exitCode);
  }
  return new Promise((resolve) => child.once("exit", resolve));
}

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["src/cli.js", ...args], {
      cwd: path.resolve(import.meta.dirname, ".."),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.on("exit", (code) => {
      if (code === 0) {
        resolve(output);
      } else {
        reject(new Error(`cli exited with ${code}: ${output}`));
      }
    });
  });
}

test("cli run starts a local usage server", async () => {
  const homeDir = await makeFixtureHome();
  const stateFile = path.join(homeDir, "services.json");
  const child = spawn(
    process.execPath,
    [
      "src/cli.js",
      "run",
      "--host",
      "127.0.0.1",
      "--port",
      "0",
      "--home-dir",
      homeDir,
      "--state-file",
      stateFile,
    ],
    {
      cwd: path.resolve(import.meta.dirname, ".."),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  try {
    const url = await waitForServerUrl(child);
    const usage = await fetch(`${url}/api/usage`).then((response) => response.json());
    assert.equal(usage.summary.totals.total, 77);
  } finally {
    if (child.exitCode === null && !child.killed) {
      child.kill("SIGTERM");
      await waitForExit(child);
    }
  }
});

test("cli gateway starts a background usage server and returns", async () => {
  const homeDir = await makeFixtureHome();
  const stateFile = path.join(homeDir, "services.json");
  let url = "";

  try {
    const output = await runCli([
      "gateway",
      "--host",
      "127.0.0.1",
      "--port",
      "0",
      "--home-dir",
      homeDir,
      "--state-file",
      stateFile,
    ]);
    const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)/);
    assert.ok(match, output);
    url = match[0];

    const usage = await fetch(`${url}/api/usage`).then((response) => response.json());
    assert.equal(usage.summary.totals.total, 77);
  } finally {
    await runCli(["stop", "--state-file", stateFile]);
  }
});

test("cli restart stops existing services and starts a new gateway", async () => {
  const homeDir = await makeFixtureHome();
  const stateFile = path.join(homeDir, "services.json");

  try {
    const startOutput = await runCli([
      "gateway",
      "--host",
      "127.0.0.1",
      "--port",
      "0",
      "--home-dir",
      homeDir,
      "--state-file",
      stateFile,
    ]);
    const startMatch = startOutput.match(/(http:\/\/127\.0\.0\.1:\d+).*pid (\d+)/);
    assert.ok(startMatch, startOutput);
    const firstPid = Number(startMatch[2]);
    assert.equal(isProcessRunning(firstPid), true);

    const restartOutput = await runCli([
      "restart",
      "--host",
      "127.0.0.1",
      "--port",
      "0",
      "--home-dir",
      homeDir,
      "--state-file",
      stateFile,
    ]);
    assert.match(restartOutput, /Stopped 1 Codex Usage service/);
    const restartMatch = restartOutput.match(/Codex Usage gateway restarted: (http:\/\/127\.0\.0\.1:\d+) \(pid (\d+)\)/);
    assert.ok(restartMatch, restartOutput);
    const restartUrl = restartMatch[1];
    const restartPid = Number(restartMatch[2]);

    assert.notEqual(restartPid, firstPid);
    assert.equal(isProcessRunning(firstPid), false);
    const usage = await fetch(`${restartUrl}/api/usage`).then((response) => response.json());
    assert.equal(usage.summary.totals.total, 77);

    const state = JSON.parse(await readFile(stateFile, "utf8"));
    assert.deepEqual(
      state.services.map((service) => service.pid),
      [restartPid],
    );
  } finally {
    await runCli(["stop", "--state-file", stateFile]);
  }
});

test("cli run recovers from a stale service lock", async () => {
  const homeDir = await makeFixtureHome();
  const stateFile = path.join(homeDir, "services.json");
  const lockDir = `${stateFile}.lock`;
  await mkdir(lockDir, { recursive: true });
  const oldDate = new Date(Date.now() - 60_000);
  await utimes(lockDir, oldDate, oldDate);

  const child = spawn(
    process.execPath,
    [
      "src/cli.js",
      "run",
      "--host",
      "127.0.0.1",
      "--port",
      "0",
      "--home-dir",
      homeDir,
      "--state-file",
      stateFile,
    ],
    {
      cwd: path.resolve(import.meta.dirname, ".."),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  try {
    const url = await waitForServerUrl(child);
    const usage = await fetch(`${url}/api/usage`).then((response) => response.json());
    assert.equal(usage.summary.totals.total, 77);
  } finally {
    if (child.exitCode === null && !child.killed) {
      child.kill("SIGTERM");
      await waitForExit(child);
    }
  }
});

test("cli dashboard starts a background service and prints the dashboard URL", async () => {
  const homeDir = await makeFixtureHome();
  const stateFile = path.join(homeDir, "services.json");

  try {
    const output = await runCli([
      "dashboard",
      "--no-open",
      "--host",
      "127.0.0.1",
      "--port",
      "0",
      "--home-dir",
      homeDir,
      "--state-file",
      stateFile,
    ]);
    const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)/);
    assert.ok(match, output);

    const usage = await fetch(`${match[0]}/api/usage`).then((response) => response.json());
    assert.equal(usage.summary.totals.total, 77);
  } finally {
    await runCli(["stop", "--state-file", stateFile]);
  }
});

test("cud command opens the dashboard by default", async () => {
  const homeDir = await makeFixtureHome();
  const stateFile = path.join(homeDir, "services.json");
  const binDir = await mkdtemp(path.join(tmpdir(), "codex-cud-bin-"));
  const cudPath = path.join(binDir, "cud");
  await symlink(path.resolve(import.meta.dirname, "..", "src", "cli.js"), cudPath);
  await chmod(cudPath, 0o755);

  try {
    const output = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [
        cudPath,
        "--no-open",
        "--host",
        "127.0.0.1",
        "--port",
        "0",
        "--home-dir",
        homeDir,
        "--state-file",
        stateFile,
      ]);
      let text = "";
      child.stdout.on("data", (chunk) => {
        text += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        text += chunk.toString();
      });
      child.on("exit", (code) => {
        if (code === 0) {
          resolve(text);
        } else {
          reject(new Error(`cud exited with ${code}: ${text}`));
        }
      });
    });
    assert.match(output, /Codex Usage dashboard/);
    assert.match(output, /http:\/\/127\.0\.0\.1:(\d+)/);
  } finally {
    await runCli(["stop", "--state-file", stateFile]);
  }
});

test("codex-usage -d opens the dashboard", async () => {
  const homeDir = await makeFixtureHome();
  const stateFile = path.join(homeDir, "services.json");

  try {
    const output = await runCli([
      "-d",
      "--no-open",
      "--host",
      "127.0.0.1",
      "--port",
      "0",
      "--home-dir",
      homeDir,
      "--state-file",
      stateFile,
    ]);
    assert.match(output, /Codex Usage dashboard/);
    assert.match(output, /http:\/\/127\.0\.0\.1:(\d+)/);
  } finally {
    await runCli(["stop", "--state-file", stateFile]);
  }
});

test("cli stop terminates all running usage services from the state file", async () => {
  const homeDir = await makeFixtureHome();
  const stateFile = path.join(homeDir, "services.json");
  const children = [0, 1].map(() =>
    spawn(
      process.execPath,
      [
        "src/cli.js",
        "run",
        "--host",
        "127.0.0.1",
        "--port",
        "0",
        "--home-dir",
        homeDir,
        "--state-file",
        stateFile,
      ],
      {
        cwd: path.resolve(import.meta.dirname, ".."),
        stdio: ["ignore", "pipe", "pipe"],
      },
    ),
  );

  try {
    await Promise.all(children.map((child) => waitForServerUrl(child)));

    const stop = spawn(process.execPath, ["src/cli.js", "stop", "--state-file", stateFile], {
      cwd: path.resolve(import.meta.dirname, ".."),
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stopOutput = await new Promise((resolve, reject) => {
      let output = "";
      stop.stdout.on("data", (chunk) => {
        output += chunk.toString();
      });
      stop.stderr.on("data", (chunk) => {
        output += chunk.toString();
      });
      stop.on("exit", (code) => {
        if (code === 0) {
          resolve(output);
        } else {
          reject(new Error(`stop exited with ${code}: ${output}`));
        }
      });
    });

    assert.match(stopOutput, /Stopped 2 Codex Usage service/);
    const exitCodes = await Promise.all(children.map((child) => waitForExit(child)));
    assert.deepEqual(exitCodes, [0, 0]);
  } finally {
    for (const child of children) {
      if (child.exitCode === null && !child.killed) {
        child.kill("SIGTERM");
        await waitForExit(child);
      }
    }
  }
});
