import { Router, type Request, type Response, type NextFunction } from "express";
import { logger } from "../lib/logger";

const router = Router();
const GITHUB_API_BASE = "https://api.github.com";
// Override with GITHUB_REPO_OWNER / GITHUB_REPO_NAME config vars on Heroku
const REPO_OWNER = process.env["GITHUB_REPO_OWNER"] ?? "BILLNUTTER";
const REPO_NAME = process.env["GITHUB_REPO_NAME"] ?? "Nutter-MD";

function requireAdminPassword(req: Request, res: Response, next: NextFunction) {
  const adminPassword = process.env["ADMIN_PASSWORD"];
  if (!adminPassword) {
    res.status(503).json({ error: "MISCONFIGURED", message: "ADMIN_PASSWORD environment variable is not set. Configure it to enable the admin dashboard." });
    return;
  }
  const provided = req.headers["x-admin-password"];
  if (provided !== adminPassword) {
    res.status(401).json({ error: "UNAUTHORIZED", message: "Invalid admin password" });
    return;
  }
  next();
}

type GithubFork = {
  id: number;
  owner: { login: string; avatar_url: string; html_url: string };
  html_url: string;
  created_at: string;
};

async function fetchAllForks(): Promise<GithubFork[]> {
  const githubHeaders = {
    Accept: "application/vnd.github+json",
    "User-Agent": "NUTTER-XMD-Bot",
    ...(process.env["GITHUB_TOKEN"] ? { Authorization: `Bearer ${process.env["GITHUB_TOKEN"]}` } : {}),
  };

  const all: GithubFork[] = [];
  let page = 1;
  const perPage = 100;

  while (true) {
    const response = await fetch(
      `${GITHUB_API_BASE}/repos/${REPO_OWNER}/${REPO_NAME}/forks?per_page=${perPage}&page=${page}&sort=newest`,
      { headers: githubHeaders },
    );

    if (!response.ok) {
      const errText = await response.text();
      logger.error({ status: response.status, errText }, "GitHub API error fetching forks");
      throw Object.assign(new Error("GitHub API error"), { status: response.status });
    }

    const page_data = await response.json() as GithubFork[];
    all.push(...page_data);

    if (page_data.length < perPage) break;
    page++;
  }

  return all;
}

router.get("/admin/forks", requireAdminPassword, async (_req, res) => {
  try {
    const data = await fetchAllForks();

    const forks = data.map((fork) => ({
      id: fork.id,
      login: fork.owner.login,
      avatarUrl: fork.owner.avatar_url,
      profileUrl: fork.owner.html_url,
      forkUrl: fork.html_url,
      createdAt: fork.created_at,
    }));

    res.json({ forks, total: forks.length });
  } catch (err) {
    logger.error({ err }, "Error fetching forks");
    const status = (err instanceof Error && "status" in err && typeof (err as { status?: unknown }).status === "number")
      ? (err as { status: number }).status
      : 500;
    if (status >= 500 && status < 600) {
      res.status(502).json({ error: "GITHUB_ERROR", message: "Failed to fetch forks from GitHub" });
    } else {
      res.status(500).json({ error: "SERVER_ERROR", message: "Internal server error" });
    }
  }
});

router.get("/deploy/verify-fork", async (req, res) => {
  const username = req.query["username"] as string;
  if (!username) {
    res.status(400).json({ error: "MISSING_USERNAME", message: "Provide a GitHub username" });
    return;
  }

  try {
    const response = await fetch(`${GITHUB_API_BASE}/repos/${username}/${REPO_NAME}`, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "NUTTER-XMD-Bot",
        ...(process.env["GITHUB_TOKEN"] ? { Authorization: `Bearer ${process.env["GITHUB_TOKEN"]}` } : {}),
      },
    });

    if (response.status === 404) {
      res.json({ forked: false, username, forkUrl: null, deployUrl: null });
      return;
    }

    if (!response.ok) {
      res.status(502).json({ error: "GITHUB_ERROR", message: "Failed to verify fork" });
      return;
    }

    const data = await response.json() as { fork: boolean; html_url: string; source?: { full_name: string } };

    const isFork = data.fork && data.source?.full_name === `${REPO_OWNER}/${REPO_NAME}`;
    const deployUrl = isFork
      ? `https://heroku.com/deploy?template=https://github.com/${username}/${REPO_NAME}`
      : null;

    res.json({
      forked: isFork,
      username,
      forkUrl: isFork ? data.html_url : null,
      deployUrl,
    });
  } catch (err) {
    logger.error({ err }, "Fork verification error");
    res.status(500).json({ error: "SERVER_ERROR", message: "Internal server error" });
  }
});

export default router;
