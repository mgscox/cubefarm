// npm run exports the office's script policy, which npm rejects in project-scoped installs.
// Gateway credentials must never enter agent or preview environments.
// Projects must read their own npmrc/package policy; all other inherited npm settings remain useful.
export function projectEnv(inherited: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(inherited).filter(([key]) => !/^(npm_config_allow_scripts|CUBEFARM_(TELEGRAM|MCP)_TOKEN|UPSTASH_BOX_API_KEY)$/i.test(key)));
}
