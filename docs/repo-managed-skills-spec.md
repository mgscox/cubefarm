# Deploy repo-managed skills across CubeFarm

Each CubeFarm release carries its own agent skills. The main office and each sub-office activate the skills when they deploy that release. Linked worker boxes pick up the release through their office's existing worker update path. Each launch uses the bundle on the machine running the agent. [Wayfinder map](https://github.com/mgscox/cubefarm/issues/160)

## Authoring and packaging

- Add a skill at `skills/<name>/SKILL.md`. Keep its scripts, references, and assets inside that directory. Change or delete the directory in Git to update or remove the skill.
- Require valid skill metadata, a unique `cubefarm-` name matching the directory name, and files contained within the bundle. Keep runtime registration metadata with the release where needed. All runtimes use the same skill contents.
- Ship the complete bundle in Git checkouts and npm packages. Derive the current registry from the active release. Record its identity, skill names, and release-relative paths. Verify the npm package against that inventory using the existing package smoke test. [Packaging decision](https://github.com/mgscox/cubefarm/issues/162#issuecomment-6611873276)

## Agent discovery

| Runtime | Registration |
| --- | --- |
| Claude Code terminal | Pass the release's local skill plugin with `--plugin-dir` on each CubeFarm launch. |
| Claude Agent SDK | Add the same local plugin to the query options. |
| OpenCode v2 | Add the release skill directory to the existing per-process configuration. |
| Codex terminal | Reconcile the active bundle into `.agents/skills/cubefarm-bundle/` in the CubeFarm desk before each fresh or resumed process starts. Codex discovers it as a project skill directory. |

Use the shared local and remote terminal preparation path and the separate local SDK launch path. Preserve the runtime's normal working directory, settings, and account. [Runtime research](https://github.com/mgscox/cubefarm/issues/164/artifacts/1)

For Codex, use CubeFarm's existing local Git exclude mechanism for the exact managed subtree. Verify the exclude takes effect before copying. Preserve adjacent project skills and reject a tracked or unmanaged path conflict with an actionable error. A manual Codex session started in the same desk can discover the staged bundle.

Each runtime handles exact name collisions with personal or project skills. Claude exposes the qualified plugin name, OpenCode gives the explicit bundle source precedence over implicit sources, and Codex can expose both entries. [Visibility decision](https://github.com/mgscox/cubefarm/issues/161#issuecomment-6612450022)

## Activation and recovery

- At startup or worker release activation, validate the incoming bundle and derive its registry. Fresh launches use the active release. Prepare Codex's desk copy before process start, including on resume.
- Remove retired skills from the active registry and new-session discovery. Reclaim only copies CubeFarm recorded as its own, inside the dedicated managed subtree or storage. Let an already-running session finish and retain any managed copy it still uses until it ends.
- Use the existing release update and rollback paths. Rollback restores the previous release's registry and recreates its managed copies as needed. Report update failures through the existing Fleet status and desk preparation failures through the existing launch error path.

## Acceptance checks

Prepare two releases. Include a fixture skill in the first release that reads a distinctive version marker from a supporting file. Remove the fixture in the second release.

| Check | Evidence required |
| --- | --- |
| Package | The checkout and unpacked npm package contain the expected complete skill directories and supporting files. |
| Deploy | A fresh session on the main office, a sub-office, and a linked worker can invoke the fixture and read the marker expected for that host's active release. Exercise all four runtime paths across their supported placements, including a Codex launch on a worker. |
| Remove and resume | Fresh sessions lose the fixture after the second release activates. A running session can finish. A freshly resumed Codex process uses the active bundle. `git add -A` skips the managed subtree and still stages a neighbouring project skill. |
| Roll back | A fresh session can invoke the restored fixture and read the original marker. For a checkout fleet, deploy a revert commit so workers can still fast-forward. |
| Offline and failed worker | An offline worker remains pending until it reconnects and a fresh session proves the expected marker. A failed update is visible in the existing Fleet status. |

Record the host, runtime, release identity, and observed marker or absence. These checks define implementation acceptance and remain pending until exercised. [Rollout decision](https://github.com/mgscox/cubefarm/issues/163#issuecomment-6612530338)
