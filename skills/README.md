# CubeFarm release skills

Put each skill in `skills/cubefarm-<name>/SKILL.md`, with its supporting files alongside it. Set the YAML `name` to the directory name and include a `description`. The office and its workers use the skills from their deployed release.

The QA bundle uses `cubefarm-tdd` and `cubefarm-diagnosing-bugs` from the local `~/.agents/skills` copies. The other vendored QA sources are pinned below. Their licenses travel with the bundle.

| Skill | Upstream revision |
| --- | --- |
| `cubefarm-verification-before-completion` | [obra/superpowers](https://github.com/obra/superpowers/tree/2ce8aa15d05bd57213e6f746f953aafb7ded7a8b/skills/verification-before-completion) |
| `cubefarm-pr-security-review` | [EricTechPro/super-board](https://github.com/EricTechPro/super-board/tree/d0b7d5a6850614ca809477c1af43d5d7da408726/skills/pr-security-review) |
| `cubefarm-test-strategy-skill` | [jovd83/test-strategy-skill](https://github.com/jovd83/test-strategy-skill/tree/35f44773e790c6a25b07991a81da8260129f4221) |
