import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { RUN_HOURS } from "./plan.js";

// 평일 9~19시 매 정각에 `jade-mcp gcal sync` 를 띄우는 LaunchAgent.
// 잠자기 중 놓친 정각은 launchd 가 깨어날 때 한 번 몰아서 띄우는데, 정각+3분이 지났으면 sync 가 건너뛴다.

const run = promisify(execFile);
export const LABEL = "local.jade-mcp.gcal-sync";
export const PLIST_PATH = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);

function escapeXml(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

export interface PlistInput {
  programArguments: string[];
  workingDirectory: string;
  logDir: string;
}

export function buildPlist({ programArguments, workingDirectory, logDir }: PlistInput): string {
  const intervals: string[] = [];
  for (let weekday = 1; weekday <= 5; weekday++) {
    for (let hour = RUN_HOURS.from; hour <= RUN_HOURS.to; hour++) {
      intervals.push(
        `    <dict><key>Weekday</key><integer>${weekday}</integer><key>Hour</key><integer>${hour}</integer><key>Minute</key><integer>0</integer></dict>`,
      );
    }
  }
  const args = programArguments.map((a) => `    <string>${escapeXml(a)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>WorkingDirectory</key><string>${escapeXml(workingDirectory)}</string>
  <key>StartCalendarInterval</key>
  <array>
${intervals.join("\n")}
  </array>
  <key>RunAtLoad</key><false/>
  <key>StandardOutPath</key><string>${escapeXml(join(logDir, "launchd.out.log"))}</string>
  <key>StandardErrorPath</key><string>${escapeXml(join(logDir, "launchd.err.log"))}</string>
</dict>
</plist>
`;
}

function domain(): string {
  return `gui/${process.getuid?.() ?? ""}`;
}

export async function installAgent(input: PlistInput): Promise<void> {
  await mkdir(input.logDir, { recursive: true });
  await mkdir(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
  await writeFile(PLIST_PATH, buildPlist(input));
  await run("plutil", ["-lint", PLIST_PATH]);
  await run("launchctl", ["bootout", `${domain()}/${LABEL}`]).catch(() => {});
  await run("launchctl", ["bootstrap", domain(), PLIST_PATH]);
}

export async function uninstallAgent(): Promise<void> {
  await run("launchctl", ["bootout", `${domain()}/${LABEL}`]).catch(() => {});
  await rm(PLIST_PATH, { force: true });
}

/** launchctl print 의 요약 줄(상태·실행 횟수·마지막 종료코드). 등록되지 않았으면 undefined. */
export async function agentState(): Promise<string[] | undefined> {
  try {
    const { stdout } = await run("launchctl", ["print", `${domain()}/${LABEL}`]);
    // 하위 블록(소켓·엔드포인트)에도 state 줄이 있어 항목마다 첫 줄만 쓴다.
    const lines = new Map<string, string>();
    for (const line of stdout.split("\n").map((l) => l.trim())) {
      const key = line.match(/^(state|runs|last exit code) =/)?.[1];
      if (key && !lines.has(key)) lines.set(key, line);
    }
    return [...lines.values()];
  } catch {
    return undefined;
  }
}
