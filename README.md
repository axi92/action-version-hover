# GitHub Action Version Hover

This VS Code extension shows the **tag**, **release**, and **commit message**
for GitHub Actions referenced by commit SHA in workflow files.

Example:

```yaml
- uses: docker/login-action@c94ce9fb468520275223c153574b00df6fe4bcc9

Hover shows
```
Tag: v3.1.0
Release: Docker Login Action 3.1
Commit: Fix authentication flow
```