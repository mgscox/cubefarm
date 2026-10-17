# LAN CI runners and artifacts

CI uses repository-scoped self-hosted runners and no GitHub Actions caches or artifact uploads. macOS jobs target the Mac mini M2 (`mac-mini-m2-cubefarm`); Windows jobs target Tower's Windows_10 VM (`tower-windows-cubefarm`). These provide native OS-family coverage; the matrix display names preserve the existing check names and do not specify the installed OS version. macOS runner startup awaits Xcode license acceptance.

Linux jobs target `tower-cubefarm`, using `tower-actions-runner:2026-10-17`. Chromium system libraries are baked into that image; the workflow installs the browser. Public fork PRs do not execute on LAN runners.

Windows artifacts are retained under `C:\CIArtifacts\cubefarm`; macOS artifacts under `/Users/mattcox/CI/artifacts/cubefarm`. Linux browser diagnostics use `/artifacts/cubefarm` inside the runner, backed by `/mnt/user/appdata/github-runners/cubefarm/artifacts/cubefarm` on Tower.

`scripts/retain-ci-artifacts.mjs` copies matching files with relative paths and a run/ref/commit manifest, and links the local path in the job summary. It removes expired runs in the same artifact group when new files are retained. Diagnostics retain 14 days; Waifu installers retain 5 days and are required after a successful packaging job. Files remain on the LAN and are not downloadable from GitHub's artifact UI. Runner operators can retrieve them from the recorded paths.

Keep the runners online for queued jobs to start. Restart the Windows runner services through the VM; macOS launch agents are managed using `svc.sh` in `/Users/mattcox/CI/runners/cubefarm`. Checkout credentials are not persisted. Existing PR branches need the migrated workflow before rerunning their CI.
