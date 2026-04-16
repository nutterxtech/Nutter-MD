import { Router } from "express";
import { logger } from "../lib/logger";

const router = Router();
const GITHUB_API_BASE = "https://api.github.com";
const REPO_OWNER = "nutterxtech";
const REPO_NAME = "NUTTER-XMD";

function requireAdminPassword(req: Parameters<Parameters<typeof router.use>[0]>[0], res: Parameters<Parameters<typeof router.use>[0]>[1], next: Parameters<Parameters<typeof router.use>[0]>[2]) {
  const adminPassword = process.env["ADMIN_PASSWORD"];
  if (!adminPassword) {
    next();
    return;
  }
  const provided = req.headers["x-admin-password"];
  if (provided !== adminPassword) {
    res.status(401).json({ error: "UNAUTHORIZED", message: "Invalid admin password" });
    return;
  }
  next();
}

router.get("/admin/forks", requireAdminPassword, async (_req, res) => {
  try {
    const response = await fetch(`${GITHUB_API_BASE}/repos/${REPO_OWNER}/${REPO_NAME}/forks?per_page=100&sort=newest`, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "NUTTER-XMD-Bot",
        ...(process.env["GITHUB_TOKEN"] ? { Authorization: `Bearer ${process.env["GITHUB_TOKEN"]}` } : {}),
      },
    });

    if (!response.ok) {
      const err = await response.text();
      logger.error({ status: response.status, err }, "GitHub API error");
      res.status(502).json({ error: "GITHUB_ERROR", message: "Failed to fetch forks from GitHub" });
      return;
    }

    const data = await response.json() as Array<{
      id: number;
      owner: { login: string; avatar_url: string; html_url: string };
      html_url: string;
      created_at: string;
    }>;

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
    res.status(500).json({ error: "SERVER_ERROR", message: "Internal server error" });
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
