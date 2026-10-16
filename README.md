# OSS Desk (Tauri)

Aliyun OSS desktop client: React UI, Rust shell (downloads + lifecycle), embedded Node OSS API (no console window).

## Develop

```bash
npm install
npm run build:api   # bundle OSS API + fetch portable Node (Windows release)
npm run dev
```

Dev uses system `node` with `CREATE_NO_WINDOW` when the bundled runtime is not present.

## Release

```bash
npm run build:client
```

Installer: `src-tauri/target/release/bundle/nsis/OSSDesk_1.0.0_x64-setup.exe`

## Data

Download history: `%APPDATA%/oss/download-history.json` (same as the Electron build).
