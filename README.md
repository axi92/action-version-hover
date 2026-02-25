# GitHub Action Version Hover

This VS Code extension shows the **tag**, **release**, and **commit message**
for GitHub Actions referenced by commit SHA in workflow files.

Example:

```yaml
- uses: docker/login-action@c94ce9fb468520275223c153574b00df6fe4bcc9
```

Hover shows
```
GitHub Action Version Info
Repository: docker/login-action
Commit: c94ce9fb468520275223c153574b00df6fe4bcc9
Message: Merge pull request #915 from docker/dependabot/npm_and_yarn/lodash-4.17.23
build(deps): bump lodash from 4.17.21 to 4.17.23
🏷 Tag: v3.7.0
👉 Add version as comment
```

When clicking the link in the hover window the version is appended as a comment.

```diff
- - uses: docker/login-action@c94ce9fb468520275223c153574b00df6fe4bcc9
+ - uses: docker/login-action@c94ce9fb468520275223c153574b00df6fe4bcc9 # v3.7.0
```

# Install

There is no package published, you have to build it yourself.

- Clone repo and `cd` into it
- `npm ci`
- `npm run compile`
- `npm run package`
- [install .vsix in vscode](https://code.visualstudio.com/docs/configure/extensions/extension-marketplace#_install-from-a-vsix)

### LLM Notice

This project includes code generated with the help of LLM coding assistants (e.g., Copilot).