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
const TAGS_TTL_MS = 10 * 60 * 1000; // 10 minutes

export function activate(ctx: vscode.ExtensionContext) {
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
        // Only add if the line has no comment (avoid creating a 2nd '#')
        const hashIdx = line.text.indexOf("#");
        const hasComment = hashIdx >= 0;

        const updated = hasComment
          ? line.text // leave as-is if already has a comment
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
  // 2) Hover Provider (unchanged behavior, still shows Add link)
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

        const version = await resolveVersion(repo, sha);
        const md = new vscode.MarkdownString();
        md.isTrusted = true;

        md.appendMarkdown(`### GitHub Action Version Info\n\n`);
        md.appendMarkdown(`**Repository:** ${repo}\n\n`);
        md.appendMarkdown(`**Commit:** \`${sha}\`\n\n`);

        // Fetch optional commit message (best-effort)
        const commitData = await githubApi(`/repos/${repo}/commits/${sha}`);
        md.appendMarkdown(`**Message:** ${commitData?.commit?.message ?? "No commit message"}\n\n`);

        if (version) {
          md.appendMarkdown(`#### 🏷 Tag: **${version}**\n\n`);
          const args = encodeURIComponent(JSON.stringify([version, position.line]));
          md.appendMarkdown(`👉 command:actionVersionHover.addVersion?${args}\n\n`);
        } else {
          md.appendMarkdown(`#### ❌ No tag found for this SHA\n\n`);
        }

        const hover = new vscode.Hover(md);
        hoverCache.set(cacheKey, hover);
        return hover;
      }
    })
  );

  //
  // 3) Automatic updates when SHA changes
  //
  const config = vscode.workspace.getConfiguration(CFG_NAMESPACE);
  const autoUpdate = config.get<boolean>(CFG_AUTO_UPDATE, true);
  const autoInsert = config.get<boolean>(CFG_AUTO_INSERT, false);
  const updateOn = config.get<string>(CFG_UPDATE_ON, "save");

  const isWorkflowDoc = (doc: vscode.TextDocument) =>
    ["yaml", "yml", "json"].includes(doc.languageId) ||
    doc.fileName.endsWith(".yml") ||
    doc.fileName.endsWith(".yaml") ||
    doc.fileName.endsWith(".json");

  const scheduleUpdate = (doc: vscode.TextDocument) => {
    const key = doc.uri.toString();
    if (changeDebounceTimers.has(key)) {
      clearTimeout(changeDebounceTimers.get(key)!);
    }
    changeDebounceTimers.set(
      key,
      setTimeout(() => {
        changeDebounceTimers.delete(key);
        updateDocumentVersionComments(doc, { autoInsert }).catch(() => {});
      }, 800)
    );
  };

  if (autoUpdate) {
    // On Save
    if (updateOn === "save") {
      ctx.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument(doc => {
          console.log("🔥 onDidSaveTextDocument triggered for:", doc.fileName);

          if (isWorkflowDoc(doc)) {
            console.log("📄 File recognized as workflow doc.");
            updateDocumentVersionComments(doc, { autoInsert }).then(() => {
              console.log("✔ updateDocumentVersionComments finished");
            }).catch(err => console.error("❌ update error", err));
          } else {
            console.log("⛔ File NOT recognized as workflow doc");
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
            updateDocumentVersionComments(doc, { autoInsert }).catch(() => {});
          }
        })
      );
      // Also run once for the currently active document on activate
      const active = vscode.window.activeTextEditor?.document;
      if (active && isWorkflowDoc(active)) {
        updateDocumentVersionComments(active, { autoInsert }).catch(() => {});
      }
    }
  }
}

// ============ Core auto-update logic ============

/**
 * Scan a document for `uses: owner/repo@sha` lines and fix/insert trailing `# vX.Y.Z` version comments.
 * - If a version comment exists and differs -> replace it.
 * - If no comment exists -> insert only if `autoInsert: true` (and only when there is no existing comment on the line).
 */
async function updateDocumentVersionComments(
  document: vscode.TextDocument,
  opts: { autoInsert: boolean }
): Promise<void> {
  const edits: { range: vscode.Range; newText: string }[] = [];
  console.log("🔍 Starting updateDocumentVersionComments...");
  for (let i = 0; i < document.lineCount; i++) {
    const line = document.lineAt(i);
    const parsed = parseLineForUpdate(line.text);
    console.log("Line", i, "=>", line, "parsed:", parsed);
    if (!parsed) continue;
    console.log("✔ uses: line detected", parsed);
    const { repo, sha, codePart, commentPart, hasVersion, versionTokenRange } = parsed;

    const version = await resolveVersion(repo, sha);
    if (!version) continue; // nothing to do if we can't resolve

    if (hasVersion) {
      const current = extractVersionFromComment(commentPart);
      if (!current || normalizeTag(current) !== normalizeTag(version)) {
        // Replace just the version token inside the comment
        const startCol = versionTokenRange!.start;
        const endCol = versionTokenRange!.end;
        const range = new vscode.Range(
          new vscode.Position(i, startCol),
          new vscode.Position(i, endCol)
        );
        edits.push({ range, newText: `# ${version}` });
      }
    } else {
      // No version token in comment
      if (!opts.autoInsert) continue;

      // Only insert if the line has no existing comment at all (to avoid creating a second '#')
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

  // Look for a version token inside the comment: "# v..." (keep it simple and robust)
  const versionMatch = commentPart.match(/#\s*v[\w.\-]+/i);
  let hasVersion = false;
  let versionTokenRange: { start: number; end: number } | undefined;

  if (versionMatch && hashIdx >= 0) {
    hasVersion = true;
    const start = hashIdx + versionMatch.index!;
    const end = start + versionMatch[0].length;
    versionTokenRange = { start, end };
  }

  return {
    repo: uses.repo,
    sha: uses.sha,
    codePart,
    commentPart,
    hasVersion,
    versionTokenRange
  };
}

/** Extract the version text from a comment fragment like "# v1.2.3", returns "v1.2.3" */
function extractVersionFromComment(commentPart: string): string | null {
  const m = commentPart.match(/#\s*(v[\w.\-]+)/i);
  return m ? m[1] : null;
}

/** Normalize tags for comparison (e.g., ensure leading 'v') */
function normalizeTag(tag: string): string {
  return tag.startsWith("v") ? tag : `v${tag}`;
}

/** Parse `uses: owner/repo@sha` in a single line (code portion only) */
function parseUsesLine(text: string): { repo: string; sha: string } | null {
  // keep it simple: search for "uses: <repo>@<40hex>"
  const m = text.match(/uses:\s*([^@\s#]+)@([a-f0-9]{40})/i);
  if (!m) return null;
  return { repo: m[1].trim(), sha: m[2].trim() };
}

// ============ Tag resolution & caching ============

/** Resolve a SHA to a tag name by consulting /repos/:repo/tags with caching. */
async function resolveVersion(repo: string, sha: string): Promise<string | null> {
  const tags = await getRepoTags(repo);
  if (!tags) return null;

  // Note: This matches lightweight tags. Annotated tags may require extra deref,
  // but this covers the common case without multiple API hits.
  const hit = tags.find((t: any) => t?.commit?.sha?.toLowerCase() === sha.toLowerCase());
  return hit?.name ?? null;
}

/** Get tags for a repo with TTL cache to reduce rate-limit pressure. */
async function getRepoTags(repo: string): Promise<any[] | null> {
  const cached = tagsCache.get(repo);
  const now = Date.now();
  if (cached && now - cached.ts < TAGS_TTL_MS) {
    return cached.tags;
  }
  const tags = await githubApi(`/repos/${repo}/tags`);
  if (Array.isArray(tags)) {
    tagsCache.set(repo, { tags, ts: now });
    return tags;
  }
  return null;
}

// ============ GitHub API helper ============

function githubApi(path: string): Promise<any | null> {
  const options = {
    hostname: "api.github.com",
    path,
    method: "GET",
    headers: {
      "User-Agent": "VSCode-Action-Version-Hover"
    }
  };

  return new Promise(resolve => {
    https
      .get(options, (res: IncomingMessage) => {
        let data = "";
        res.on("data", chunk => (data += chunk));
        res.on("end", () => {
          try {
            if (res.statusCode && res.statusCode >= 400) return resolve(null);
            resolve(JSON.parse(data));
          } catch {
            resolve(null);
          }
        });
      })
      .on("error", () => resolve(null));
  });
}