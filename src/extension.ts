import * as vscode from "vscode";
import * as https from "https";
import { IncomingMessage } from "http";

type TagsCacheEntry = { tags: any[]; ts: number };

const hoverCache = new Map<string, vscode.Hover>();          // key: `${repo}:${sha}`
const tagsCache = new Map<string, TagsCacheEntry>();         // key: repo => tags list cache
const changeDebounceTimers = new Map<string, NodeJS.Timeout>(); // key: document.uri.toString()

// --- Settings keys & defaults
const CFG_NAMESPACE = "actionVersionHover";
const CFG_AUTO_UPDATE = "autoUpdateComment";
const CFG_AUTO_INSERT = "autoInsertComment";
const CFG_UPDATE_ON = "updateOn"; // "save" | "type" | "open"
const CFG_AUTO_UPDATE_TO_LATEST = "autoUpdateToLatestOnSave";
const TAGS_TTL_MS = 10 * 60 * 1000; // 10 minutes

let githubToken: string | undefined;

export function activate(ctx: vscode.ExtensionContext) {
  console.log('✅ action-version-hover: activate() called');

  vscode.authentication.getSession('github', ['read:user'], { createIfNone: false })
    .then(session => {
      if (session) {
        githubToken = session.accessToken;
      }
    });
  //
  // 1) Command: Add version as comment (from hover link)
  //
  ctx.subscriptions.push(
    vscode.commands.registerCommand(
      "actionVersionHover.addVersion",
      async (version: string, lineNumber: number) => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;

        const line = editor.document.lineAt(lineNumber);
        const hashIdx = line.text.indexOf("#");
        const hasComment = hashIdx >= 0;

        const updated = hasComment
          ? line.text
          : line.text.replace(/\s*$/, "") + ` # ${version}`;

        if (updated !== line.text) {
          await editor.edit(editBuilder => {
            editBuilder.replace(line.range, updated);
          });
          vscode.window.setStatusBarMessage(`Added version comment # ${version}`, 2000);
        }
      }
    )
  );

  //
  // 2) Command: Update to latest version (from hover link)
  //
  ctx.subscriptions.push(
    vscode.commands.registerCommand(
      "actionVersionHover.updateToLatest",
      async (repo: string, lineNumber: number) => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;

        vscode.window.setStatusBarMessage(`Fetching latest version for ${repo}…`, 5000);

        const latest = await getLatestTag(repo);
        if (!latest) {
          vscode.window.showErrorMessage(`Could not fetch latest version for ${repo}`);
          return;
        }

        const line = editor.document.lineAt(lineNumber);
        let newText = line.text;

        // Replace the 40-char SHA with the latest SHA
        newText = newText.replace(/@[a-f0-9]{40}/i, `@${latest.sha}`);

        // Update or insert the version comment
        const hashIdx = newText.indexOf("#");
        if (hashIdx >= 0) {
          const before = newText.slice(0, hashIdx);
          const comment = newText.slice(hashIdx);
          if (/# *v[\w.\-]+/i.test(comment)) {
            // Replace existing version token in place
            newText = before + comment.replace(/# *v[\w.\-]+/i, `# ${latest.name}`);
          } else {
            // Has a comment but no version tag - append version at end
            newText = newText.replace(/\s*$/, "") + ` # ${latest.name}`;
          }
        } else {
          // No comment at all - add one
          newText = newText.replace(/\s*$/, "") + ` # ${latest.name}`;
        }

        await editor.edit(editBuilder => {
          editBuilder.replace(line.range, newText);
        });

        // Invalidate hover cache for all entries of this repo so the next hover is fresh
        for (const key of hoverCache.keys()) {
          if (key.startsWith(`${repo}:`)) {
            hoverCache.delete(key);
          }
        }

        vscode.window.setStatusBarMessage(`Updated ${repo} to ${latest.name}`, 3000);
      }
    )
  );

  //
  // 3) Hover Provider - shows current tag + "Update to latest" link when a newer version exists
  //
  ctx.subscriptions.push(
    vscode.languages.registerHoverProvider(["yaml", "json"], {
      async provideHover(document, position) {
        const text = document.lineAt(position.line).text;
        const match = parseUsesLine(text);
        if (!match) return;

        const { repo, sha } = match;
        const cacheKey = `${repo}:${sha}`;
        if (hoverCache.has(cacheKey)) return hoverCache.get(cacheKey);

        // Fetch current tag, latest tag, and commit message in parallel
        const [version, latestTag, commitData] = await Promise.all([
          resolveVersion(repo, sha),
          getLatestTag(repo),
          githubApi(`/repos/${repo}/commits/${sha}`)
        ]);

        const md = new vscode.MarkdownString();
        md.isTrusted = true;

        md.appendMarkdown(`### GitHub Action Version Info\n\n`);
        md.appendMarkdown(`**Repository:** ${repo}\n\n`);
        md.appendMarkdown(`**Commit:** \`${sha}\`\n\n`);
        md.appendMarkdown(`**Message:** ${commitData?.commit?.message ?? "No commit message"}\n\n`);

        if (version) {
          md.appendMarkdown(`---\n\n`);
          const addArgs = encodeURIComponent(JSON.stringify([version, position.line]));
          md.appendMarkdown(`#### 🏷 Tag: **${version}** 👉 [**Add version as comment**](command:actionVersionHover.addVersion?${addArgs})\n\n`);
        } else {
          md.appendMarkdown(`#### ❌ No tag found for this SHA\n\n`);
        }

        // Show update link only when a newer version is available
        if (latestTag) {
          const isLatest = latestTag.sha.toLowerCase() === sha.toLowerCase();
          
          md.appendMarkdown(`---\n\n`);
          if (isLatest) {
            md.appendMarkdown(`✅ Already on latest version (**${latestTag.name}**)\n\n`);
          } else {
            const updateArgs = encodeURIComponent(JSON.stringify([repo, position.line]));
            md.appendMarkdown(`⬆️ Latest: **${latestTag.name}** - [**Update to latest version**](command:actionVersionHover.updateToLatest?${updateArgs})\n\n`);
          }
        }

        const hover = new vscode.Hover(md);
        hoverCache.set(cacheKey, hover);
        return hover;
      }
    })
  );

  //
  // 4) Automatic updates when SHA changes / on save
  //
  const config = vscode.workspace.getConfiguration(CFG_NAMESPACE);
  const autoUpdate = config.get<boolean>(CFG_AUTO_UPDATE, true);
  const autoInsert = config.get<boolean>(CFG_AUTO_INSERT, false);
  const updateOn = config.get<string>(CFG_UPDATE_ON, "save");
  const autoUpdateToLatest = config.get<boolean>(CFG_AUTO_UPDATE_TO_LATEST, false);

  const isWorkflowDoc = (doc: vscode.TextDocument) =>
    ["yaml", "yml", "json"].includes(doc.languageId) ||
    doc.fileName.endsWith(".yml") ||
    doc.fileName.endsWith(".yaml") ||
    doc.fileName.endsWith(".json");

  const runAutoTasks = (doc: vscode.TextDocument) => {
    const tasks: Promise<void>[] = [];
    if (autoUpdate) {
      tasks.push(updateDocumentVersionComments(doc, { autoInsert }));
    }
    if (autoUpdateToLatest) {
      tasks.push(updateDocumentToLatestVersions(doc));
    }
    return Promise.all(tasks).catch(err => console.error("❌ update error", err));
  };

  const scheduleUpdate = (doc: vscode.TextDocument) => {
    const key = doc.uri.toString();
    if (changeDebounceTimers.has(key)) {
      clearTimeout(changeDebounceTimers.get(key)!);
    }
    changeDebounceTimers.set(
      key,
      setTimeout(() => {
        changeDebounceTimers.delete(key);
        runAutoTasks(doc);
      }, 800)
    );
  };

  if (autoUpdate || autoUpdateToLatest) {
    // On Save
    if (updateOn === "save") {
      ctx.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument(doc => {
          if (isWorkflowDoc(doc)) {
            runAutoTasks(doc);
          }
        })
      );
    }

    // On Type (debounced)
    if (updateOn === "type") {
      ctx.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(e => {
          if (isWorkflowDoc(e.document)) {
            scheduleUpdate(e.document);
          }
        })
      );
    }

    // On Open
    if (updateOn === "open") {
      ctx.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument(doc => {
          if (isWorkflowDoc(doc)) {
            runAutoTasks(doc);
          }
        })
      );
      // Also run immediately for the currently active document
      const active = vscode.window.activeTextEditor?.document;
      if (active && isWorkflowDoc(active)) {
        runAutoTasks(active);
      }
    }
  }
}

// ============ Core auto-update logic ============

/**
 * Scan a document for `uses: owner/repo@sha` lines and fix/insert trailing `# vX.Y.Z`
 * version comments to match the tag that corresponds to the current SHA.
 */
async function updateDocumentVersionComments(
  document: vscode.TextDocument,
  opts: { autoInsert: boolean }
): Promise<void> {
  const edits: { range: vscode.Range; newText: string }[] = [];

  for (let i = 0; i < document.lineCount; i++) {
    const line = document.lineAt(i);
    const parsed = parseLineForUpdate(line.text);
    if (!parsed) continue;

    const { repo, sha, codePart, commentPart, hasVersion, versionTokenRange } = parsed;
    const version = await resolveVersion(repo, sha);
    if (!version) continue;

    if (hasVersion) {
      const current = extractVersionFromComment(commentPart);
      if (!current || normalizeTag(current) !== normalizeTag(version)) {
        const startCol = versionTokenRange!.start;
        const endCol = versionTokenRange!.end;
        const range = new vscode.Range(
          new vscode.Position(i, startCol),
          new vscode.Position(i, endCol)
        );
        edits.push({ range, newText: `# ${version}` });
      }
    } else {
      if (!opts.autoInsert) continue;
      if (commentPart.trim().length === 0) {
        const newText = codePart.replace(/\s*$/, "") + ` # ${version}`;
        edits.push({ range: line.range, newText });
      }
    }
  }

  if (edits.length === 0) return;

  const we = new vscode.WorkspaceEdit();
  for (const e of edits) {
    we.replace(document.uri, e.range, e.newText);
  }
  await vscode.workspace.applyEdit(we);
  vscode.window.setStatusBarMessage(`Updated ${edits.length} version comment(s)`, 2000);
}

/**
 * Scan a document for `uses: owner/repo@sha` lines, check if a newer tag exists,
 * and replace the SHA + version comment with the latest available version.
 * Only runs when `actionVersionHover.autoUpdateToLatestOnSave` is enabled.
 */
async function updateDocumentToLatestVersions(
  document: vscode.TextDocument
): Promise<void> {
  const edits: { range: vscode.Range; newText: string }[] = [];

  for (let i = 0; i < document.lineCount; i++) {
    const line = document.lineAt(i);
    const parsed = parseLineForUpdate(line.text);
    if (!parsed) continue;

    const { repo, sha } = parsed;
    const latest = await getLatestTag(repo);
    if (!latest) continue;

    // Skip if already on the latest SHA
    if (latest.sha.toLowerCase() === sha.toLowerCase()) continue;

    let newText = line.text;

    // Replace SHA
    newText = newText.replace(/@[a-f0-9]{40}/i, `@${latest.sha}`);

    // Update or insert version comment
    const hashIdx = newText.indexOf("#");
    if (hashIdx >= 0) {
      const before = newText.slice(0, hashIdx);
      const comment = newText.slice(hashIdx);
      if (/# *v[\w.\-]+/i.test(comment)) {
        newText = before + comment.replace(/# *v[\w.\-]+/i, `# ${latest.name}`);
      } else {
        newText = newText.replace(/\s*$/, "") + ` # ${latest.name}`;
      }
    } else {
      newText = newText.replace(/\s*$/, "") + ` # ${latest.name}`;
    }

    edits.push({ range: line.range, newText });
  }

  if (edits.length === 0) return;

  const we = new vscode.WorkspaceEdit();
  for (const e of edits) {
    we.replace(document.uri, e.range, e.newText);
  }
  await vscode.workspace.applyEdit(we);
  vscode.window.setStatusBarMessage(`Auto-updated ${edits.length} action(s) to latest version`, 3000);
}

// ============ Parsing helpers ============

/**
 * Parse a full line and split into code and comment, plus find a uses-pattern.
 * Also detect a version token in the comment ("# v1.2.3" etc.) and its column range.
 */
function parseLineForUpdate(lineText: string): {
  repo: string;
  sha: string;
  codePart: string;
  commentPart: string;
  hasVersion: boolean;
  versionTokenRange?: { start: number; end: number };
} | null {
  const hashIdx = lineText.indexOf("#");
  const codePart = hashIdx >= 0 ? lineText.slice(0, hashIdx) : lineText;
  const commentPart = hashIdx >= 0 ? lineText.slice(hashIdx) : "";

  const uses = parseUsesLine(codePart);
  if (!uses) return null;

  const versionMatch = commentPart.match(/#\s*v[\w.\-]+/i);
  let hasVersion = false;
  let versionTokenRange: { start: number; end: number } | undefined;

  if (versionMatch && hashIdx >= 0) {
    hasVersion = true;
    const start = hashIdx + versionMatch.index!;
    const end = start + versionMatch[0].length;
    versionTokenRange = { start, end };
  }

  return { repo: uses.repo, sha: uses.sha, codePart, commentPart, hasVersion, versionTokenRange };
}

/** Extract the version text from a comment fragment like "# v1.2.3", returns "v1.2.3" */
function extractVersionFromComment(commentPart: string): string | null {
  const m = commentPart.match(/#\s*(v[\w.\-]+)/i);
  return m ? m[1] : null;
}

/** Normalize tags for comparison (ensure leading 'v') */
function normalizeTag(tag: string): string {
  return tag.startsWith("v") ? tag : `v${tag}`;
}

/** Parse `uses: owner/repo@sha` in a single line (code portion only) */
function parseUsesLine(text: string): { repo: string; sha: string } | null {
  const m = text.match(/uses:\s*([^@\s#]+)@([a-f0-9]{40})/i);
  if (!m) return null;
  return { repo: m[1].trim(), sha: m[2].trim() };
}

// ============ Tag resolution & caching ============

/** Resolve a SHA to a tag name by consulting /repos/:repo/tags with caching. */
async function resolveVersion(repo: string, sha: string): Promise<string | null> {
  const tags = await getRepoTags(repo);
  if (!tags) return null;
  const hit = tags.find((t: any) => t?.commit?.sha?.toLowerCase() === sha.toLowerCase());
  return hit?.name ?? null;
}

/**
 * Get the latest (highest semver) tag for a repo.
 * Returns { name, sha } or null if unavailable.
 */
async function getLatestTag(repo: string): Promise<{ name: string; sha: string } | null> {
  const tags = await getRepoTags(repo);
  if (!tags || tags.length === 0) return null;

  // Sort descending by semver so index 0 is the newest
  const sorted = [...tags].sort((a, b) => compareSemver(b.name, a.name));
  const latest = sorted[0];
  if (!latest?.name || !latest?.commit?.sha) return null;
  return { name: latest.name, sha: latest.commit.sha };
}

/** Simple semver comparator - handles "v1.2.3" and "1.2.3" formats */
function compareSemver(a: string, b: string): number {
  const parse = (s: string) =>
    s.replace(/^v/, "").split(".").map(n => parseInt(n, 10) || 0);
  const [aMaj = 0, aMin = 0, aPatch = 0] = parse(a);
  const [bMaj = 0, bMin = 0, bPatch = 0] = parse(b);
  return aMaj - bMaj || aMin - bMin || aPatch - bPatch;
}

/** Get tags for a repo with TTL cache to reduce rate-limit pressure. */
async function getRepoTags(repo: string): Promise<any[] | null> {
  console.log(`action-version-hover: getRepoTags`)
  const cached = tagsCache.get(repo);
  const now = Date.now();
  if (cached && now - cached.ts < TAGS_TTL_MS) {
    return cached.tags;
  }
  const tags = await githubApi(`/repos/${repo}/tags`);
  console.log(`action-version-hover: return from githubApi with call to /repos/${repo}/tags - tags:`, tags);
  if (Array.isArray(tags)) {
    tagsCache.set(repo, { tags, ts: now });
    return tags;
  }
  return null;
}

// ============ GitHub API helper ============

function githubApi(path: string): Promise<any | null> {
  const headers: Record<string, string> = {
    "User-Agent": "VSCode-Action-Version-Hover"
  };
  if (githubToken) {
    headers["Authorization"] = `Bearer ${githubToken}`;
  }

  const options = {
    hostname: "api.github.com",
    path,
    method: "GET",
    headers
  };

  return new Promise(resolve => {
    https
      .get(options, (res: IncomingMessage) => {
        let data = "";
        res.on("data", chunk => (data += chunk));
        res.on("end", () => {
          try {
            if (res.statusCode && res.statusCode >= 400){
              console.warn(`action-version-hover: ${res.statusCode}`);
              return resolve(null);
            }
            resolve(JSON.parse(data));
          } catch {
            resolve(null);
          }
        });
      })
      .on("error", () => resolve(null));
  });
}
