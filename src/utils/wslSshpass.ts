import { execFileSync } from "child_process";

let cachedDistro: string | null = null;

function hasWsl(): boolean {
  try {
    execFileSync("wsl.exe", ["-l", "-q"], { stdio: "ignore", timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

function listDistros(): string[] {
  const buf = execFileSync("wsl.exe", ["-l", "-q"]);
  let text = buf.toString("utf16le").replace(/\0/g, "").trim();
  if (!text || text.includes("�")) {
    text = buf.toString("utf8").trim();
  }

  return text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function distroHasSshpass(distro: string): boolean {
  try {
    execFileSync(
      "wsl.exe",
      ["-d", distro, "--", "sh", "-lc", "command -v sshpass >/dev/null 2>&1"],
      { stdio: "ignore", timeout: 2500 }
    );
    return true;
  } catch {
    return false;
  }
}

export function pickWslDistroWithSshpassSync(opts?: {
  forceRescan?: boolean;
}): { distro: string | null; distros: string[]; reason?: string } {
  // Step 1: check WSL exists
  if (!hasWsl()) {
    return { distro: null, distros: [], reason: "WSL_NOT_FOUND" };
  }

  // Step 2: use cache if possible
  if (!opts?.forceRescan && cachedDistro) {
    if (distroHasSshpass(cachedDistro)) {
      return { distro: cachedDistro, distros: [], reason: "CACHED" };
    }
    cachedDistro = null;
  }

  // Step 3: list distros
  let distros: string[] = [];
  try {
    distros = listDistros();
  } catch {
    return { distro: null, distros: [], reason: "LIST_FAILED" };
  }

  // Step 4: check one by one
  for (const d of distros) {
    if (distroHasSshpass(d)) {
      cachedDistro = d;
      return { distro: d, distros, reason: "FOUND" };
    }
  }

  return { distro: null, distros, reason: "NO_SSHPASS" };
}
