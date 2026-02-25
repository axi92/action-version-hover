import * as vscode from "vscode";
import * as https from "https";
import { IncomingMessage } from "http";

const cache = new Map<string, any>();

export function activate(ctx: vscode.ExtensionContext) {
  const provider = vscode.languages.registerHoverProvider(
    ["yaml", "json"],
    {

      async provideHover(
        document: vscode.TextDocument,
        position: vscode.Position
      ) {

        const line = document.lineAt(position.line).text;

        const match = line.match(/uses:\s*([^@]+)@([a-f0-9]{40})/i);
        if (!match) return;

        const repo = match[1].trim();
        const sha = match[2].trim();
        const cacheKey = `${repo}:${sha}`;

        if (cache.has(cacheKey)) {
          return new vscode.Hover(cache.get(cacheKey));
        }

        const commitData = await githubApi(`/repos/${repo}/commits/${sha}`);
        if (!commitData) {
          const msg = `❌ Could not resolve commit SHA for ${repo}`;
          cache.set(cacheKey, msg);
          return new vscode.Hover(msg);
        }

        const tags = await githubApi(`/repos/${repo}/tags`) || [];
        const releases = await githubApi(`/repos/${repo}/releases`) || [];

        const matchingTag = tags.find((t: any) => t.commit.sha === sha);

        let matchingRelease = releases.find((r: any) =>
          r.target_commitish === sha ||
          r.tag_name === (matchingTag ? matchingTag.name : "")
        );

        const commitMessage = commitData.commit?.message ?? "No commit message";

        let markdown = `### GitHub Action Version Info\n`;
        markdown += `**Repository:** ${repo}\n\n`;
        markdown += `**Commit:** \`${sha}\`\n\n`;
        markdown += `**Message:** ${commitMessage}\n\n`;

        if (matchingTag) {
          markdown += `#### 🏷 Tag: **${matchingTag.name}**\n\n`;
        } else {
          markdown += `#### 🏷 No tag found for this SHA\n\n`;
        }

        if (matchingRelease) {
          markdown += `#### 🚀 Release: **${matchingRelease.name}**`;
        }

        cache.set(cacheKey, markdown);
        return new vscode.Hover(markdown);
      }
    }
  );

  ctx.subscriptions.push(provider);

  vscode.commands.registerCommand("actionVersionHover.addVersion", async (version: string, position: vscode.Position) => {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;

  const line = editor.document.lineAt(position.line);
  const updated = line.text.replace(/\s*$/, "") + ` # ${version}`;

  await editor.edit(editBuilder => {
    editBuilder.replace(line.range, updated);
  });
});
}

function githubApi(path: string): Promise<any | null> {
  const options = {
    hostname: "api.github.com",
    path,
    method: "GET",
    headers: {
      "User-Agent": "VSCode-GitHub-Action-Hover"
    }
  };

  return new Promise((resolve) => {
    https
      .get(options, (res: IncomingMessage) => {
        let data = "";
        res.on("data", (chunk: any) => (data += chunk));
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