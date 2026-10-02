// npm run exports the office's script policy, which npm rejects in project-scoped installs.
// Projects must read their own npmrc/package policy; all other inherited npm settings remain useful.
export function projectEnv(inherited: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(inherited).filter(([key]) => !/^npm_config_allow_scripts$/i.test(key)));
}
