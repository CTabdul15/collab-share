# Publishing Collab Share

Both stores are free. Do steps 1–2 once; for every new version, repeat steps 3–5.

## 1. Pick your publisher ID (once)

1. Go to https://marketplace.visualstudio.com/manage and sign in with a Microsoft account.
2. Click **Create publisher**. The **ID** (e.g. `abdul-dev`) is permanent and becomes part of the extension's address: `<publisher>.collab-share`.
3. Put that ID in `package.json` → `"publisher"` (set to `CTabdul15`).

## 2. Open VSX account (once, for Cursor, VSCodium, Windsurf…)

1. Go to https://open-vsx.org, click **Log in**, and sign in with GitHub.
2. In your profile, sign the **Eclipse Publisher Agreement** (it requires an Eclipse account, which is free).
3. Under **Access Tokens**, create a token and keep it somewhere safe. It is like a password.
4. Create your namespace once, using the same name as your Marketplace publisher ID:
   ```bash
   npx ovsx create-namespace <publisher-id> -p <your-open-vsx-token>
   ```

## 3. Build the package

```bash
npm install
npm run package
```

This creates `collab-share-<version>.vsix`. Bump `"version"` in `package.json` (e.g. 1.0.0 → 1.0.1) for every new upload, and add a line to `CHANGELOG.md`.

## 4. Upload to the VS Code Marketplace

On https://marketplace.visualstudio.com/manage, select your publisher, choose **New extension → Visual Studio Code** (or **Update** for an existing one), and upload the `.vsix`. The Marketplace scans it, and it usually goes live within minutes.

## 5. Upload to Open VSX

```bash
npx ovsx publish collab-share-<version>.vsix -p <your-open-vsx-token>
```

## Notes

- Keep tokens out of the code and out of git. Pass them on the command line or as an environment variable.
- To show screenshots on the store page, put the code on GitHub, add `"repository": { "type": "git", "url": "https://github.com/<you>/collab-share" }` to `package.json`, and reference the images in the README with relative paths.
- To update the pinned cloudflared version, edit `CLOUDFLARED_VERSION` and the fingerprints in `src/cloudflaredInstall.ts`. Take them from that release's page on GitHub.
