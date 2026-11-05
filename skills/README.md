# CubeFarm release skills

Put each release skill in `skills/<name>/SKILL.md`, with its supporting files alongside it. Use the `cubefarm-<name>` naming convention or the reserved name `cubebase-prototype`. Set the YAML `name` to the directory name and include a `description`. The office and its workers use the skills from their deployed release.

The QA bundle uses `cubefarm-tdd` and `cubefarm-diagnosing-bugs` from the local `~/.agents/skills` copies. The following vendored skills are pinned to upstream revisions. Their licenses travel with the bundle.

| Skill | Upstream revision |
| --- | --- |
| `cubebase-prototype` | [mattpocock/skills](https://github.com/mattpocock/skills/tree/321658273cb1d20b76026717d027d505790106d4/skills/engineering/prototype) |
| `cubefarm-verification-before-completion` | [obra/superpowers](https://github.com/obra/superpowers/tree/2ce8aa15d05bd57213e6f746f953aafb7ded7a8b/skills/verification-before-completion) |
| `cubefarm-pr-security-review` | [EricTechPro/super-board](https://github.com/EricTechPro/super-board/tree/d0b7d5a6850614ca809477c1af43d5d7da408726/skills/pr-security-review) |
| `cubefarm-test-strategy-skill` | [jovd83/test-strategy-skill](https://github.com/jovd83/test-strategy-skill/tree/35f44773e790c6a25b07991a81da8260129f4221) |
| `cubefarm-security-audit` | [cloudflare/security-audit-skill](https://github.com/cloudflare/security-audit-skill/tree/c1c8a8c1471069fb0e188eeaff69b8e8db6564a8/skills/security-audit) |
| `cubefarm-ponytail-review` | [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail/tree/96608e078b2d5ea607c5c3b8b5a54d1c1fba6846/skills/ponytail-review) |
