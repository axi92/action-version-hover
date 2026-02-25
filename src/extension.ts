import * as vscode from "vscode";
import * as https from "https";
import { IncomingMessage } from "http";

const cache = new Map<string, vscode.Hover>();

export function activate(ctx: vscode.ExtensionContext) {

  //
  // 1. Command: Add version as a comment
  //
  ctx.subscriptions.push(
    vscode.commands.registerCommand(
      "actionVersionHover.addVersion",
      async (version: string, lineNumber: number) => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;

        const line = editor.document.lineAt(lineNumber);
        const updated = line.text.replace(/\s*$/, "") + ` # ${version}`;

        await editor.edit(editBuilder => {
          editBuilder.replace(line.range, updated);
        });
      }
    )
  );

  //
  // 2. Hover Provider
  //
  ctx.subscriptions.push(
    vscode.languages.registerHoverProvider(["yaml", "json"], {
      async provideHover(document, position) {
        const text = document.lineAt(position.line).text;

        // Detect `uses: owner/repo@sha`
        const match = text.match(/uses:\s*([^@]+)@([a-f0-9]{40})/i);
        if (!match) return;

        const repo = match[1].trim();
        const sha = match[2].trim();
        const cacheKey = `${repo}:${sha}`;

        // Return result from cache if available
        if (cache.has(cacheKey)) return cache.get(cacheKey);

        // Call GitHub API
        const commitData = await githubApi(`/repos/${repo}/commits/${sha}`);
        if (!commitData) {
          const errMarkdown = new vscode.MarkdownString(`❌ Could not resolve commit SHA for ${repo}`);
          errMarkdown.isTrusted = true;
          const hover = new vscode.Hover(errMarkdown);
          cache.set(cacheKey, hover);
          return hover;
        }

        const tags = await githubApi(`/repos/${repo}/tags`) || [];
        const matchingTag = tags.find((t: any) => t.commit.sha === sha);
        const version = matchingTag?.name;

        //
        // Build hover markdown
        //
        const md = new vscode.MarkdownString();
        md.isTrusted = true;

        md.appendMarkdown(`### GitHub Action Version Info\n\n`);
        md.appendMarkdown(`**Repository:** ${repo}\n\n`);
        md.appendMarkdown(`**Commit:** \`${sha}\`\n\n`);
        md.appendMarkdown(`**Message:** ${commitData.commit?.message ?? "No commit message"}\n\n`);

        if (version) {
          md.appendMarkdown(`#### 🏷 Tag: **${version}**\n\n`);

          //
          // Command link (the only VS Code supported way to provide actions in hovers)
          //
          const args = encodeURIComponent(JSON.stringify([version, position.line]));
          md.appendMarkdown(
            `👉 [**Add version as comment**](command:actionVersionHover.addVersion?${args})\n\n`
          );
        } else {
          md.appendMarkdown(`#### ❌ No tag found for this SHA\n\n`);
        }

        const hover = new vscode.Hover(md);
        cache.set(cacheKey, hover);
        return hover;
      }
    })
  );
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

  return new Promise(resolve => {
    https
      .get(options, (res: IncomingMessage) => {
        let data = "";
        res.on("data", chunk => (data += chunk));
        res.on("end", () => {
          try {
            if (res.statusCode && res.statusCode >= 400) {
              return resolve(null);
            }
            resolve(JSON.parse(data));
          } catch (err) {
            resolve(null);
          }
        });
      })
      .on("error", () => resolve(null));
  });
}