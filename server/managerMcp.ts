// External managers use the console's commands through a separate authenticated MCP gateway.
import { timingSafeEqual } from 'node:crypto';
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { VERSION } from './config.ts';
import { HttpError } from './httpError.ts';
import { managerTokenDigest, type ManagerMcpSettings } from './managerMcpSettings.ts';
import type { Swarm } from './swarm.ts';

type Office = Pick<Swarm,
  'snapshot' | 'messageCeoFromMcp' | 'decideProposalFromMcp' |
  'addBox' | 'removeBox' | 'checkBox' | 'setMachineCapacity' |
  'stopAgent' | 'resetAgent' | 'assign' | 'message' | 'fireAgent' | 'screenshot' | 'updateAgent' | 'prepareImagePrompt' |
  'createRepo' | 'connectRepo' | 'connectFolder' | 'updateRepo' | 'disconnectRepo' | 'syncRepo' | 'syncFolderNow' | 'planFloor' | 'onboardFloor' | 'stopPreview' |
  'mergePull' | 'closePull' | 'sendToQa' | 'approvePrototype' | 'revisePrototype' |
  'closeOffice' | 'reopenOffice' | 'updateOffice' | 'updateSettings' |
  'telegramCommand' | 'markPhoneRead' | 'requestReview' | 'briefResearcher' |
  'submitIdea' | 'replyToIdea' | 'retryIdeaResearch' | 'rejectRequest' | 'retryPublication'
>;
const data = (value: object | void) => {
  const result = { ...(value ?? { ok: true }) };
  return { structuredContent: result, content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
};
const readOnly = { readOnlyHint: true, openWorldHint: false };
const id = z.string().trim().min(1).max(200);
const text = z.string().trim().min(1);
const pull = { repoId: id.describe('Floor ID (owner/repo).'), number: z.number().int().positive().describe('Pull request number.') };
const floorOptions = { mission: z.string().max(4000).optional(), autoAssign: z.boolean().default(false) };

function createManagerServer(office: Office) {
  const server = new McpServer({ name: 'cubefarm-manager', version: VERSION });
  function command<T extends z.ZodRawShape>(name: string, description: string, inputSchema: T,
    execute: (args: z.output<z.ZodObject<T>>) => object | void | Promise<object | void>, destructive = false) {
    const schema = z.object(inputSchema).strict();
    server.registerTool<z.ZodRawShape, typeof schema>(name, {
      description, inputSchema: schema,
      annotations: { readOnlyHint: false, destructiveHint: destructive, openWorldHint: true },
    }, (args) => runCommand(async () => data(await execute(args))));
  }
  server.registerTool('get_office_status', {
    description: 'See office availability, the CEO queue, project floors and which issues or PRs agents are working on.',
    annotations: readOnly,
  }, () => {
    const { demo, ceo, repos, agents, officeLifecycle } = office.snapshot();
    return data({
      demo, officeLifecycle, ceo,
      floors: repos.map(({ id, floor, fullName, autoAssign, cloneStatus }) => ({ id, floor, fullName, autoAssign, cloneStatus })),
      agents: agents.map(({ id, name, repoId, role, status, issueNumber, issueTitle, prNumber }) =>
        ({ id, name, repoId, role, status, issueNumber, issueTitle, prNumber })),
    });
  });

  server.registerTool('read_phone', {
    description: 'Read the shared manager–CEO phone thread without marking it read. Omit afterId for the latest page; use nextCursor as afterId to poll for newer messages.',
    inputSchema: { afterId: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(25).default(20) },
    annotations: readOnly,
  }, ({ afterId, limit }) => {
    const retained = office.snapshot().messages;
    const newer = afterId === undefined ? [] : retained.filter((message) => message.id > afterId);
    const page = afterId === undefined ? retained.slice(-limit) : newer.slice(0, limit);
    const messages = page.map(({ id, from, text, at, requestId, origin }) => ({ id, from, text, at, requestId, origin }));
    const oldestId = retained[0]?.id ?? null;
    return data({ messages, oldestId, nextCursor: messages.at(-1)?.id ?? afterId ?? 0, hasMore: newer.length > page.length,
      gap: afterId !== undefined && oldestId !== null && afterId < oldestId - 1 });
  });

  server.registerTool('send_message', {
    description: 'Send a manager instruction to the CEO through the shared phone. Accepted means submitted; poll read_phone for replies. Reuse the same UUID and text to retry an uncertain submission while its message is retained.',
    inputSchema: { text: z.string().trim().min(1).max(4000), requestId: z.uuid().transform((id) => id.toLowerCase()) },
    annotations: { destructiveHint: false, openWorldHint: true },
  }, async ({ text, requestId }) => runCommand(async () => data(await office.messageCeoFromMcp(text, requestId))));

  server.registerTool('list_proposals', {
    description: 'List CEO hiring and dismissal proposals and their current decisions. Filter to pending proposals if desired.',
    inputSchema: { status: z.enum(['pending', 'approved', 'rejected']).optional() },
    annotations: readOnly,
  }, ({ status }) => data({ proposals: office.snapshot().requests.filter((proposal) => !status || proposal.status === status) }));

  server.registerTool('decide_proposal', {
    description: 'Approve or reject one pending CEO hiring or dismissal proposal as the manager. Approval can hire or remove an agent. Check list_proposals if the outcome is uncertain.',
    inputSchema: { proposalId: z.string().trim().min(1).max(200), decision: z.enum(['approve', 'reject']) },
    annotations: { destructiveHint: true, openWorldHint: true },
  }, ({ proposalId, decision }) => runCommand(async () => data(await office.decideProposalFromMcp(proposalId, decision))));

  server.registerTool('get_office_snapshot', {
    description: 'Read the same full office snapshot as the console: floors with issues and pulls, agents, QA, settings, ideas, publications and delivery state. No arguments.',
    annotations: readOnly,
  }, () => data(office.snapshot()));
  server.registerTool('list_boxes', {
    description: 'List worker boxes, their IDs, connectivity and capacity, plus office machine telemetry and capacity. No arguments.',
    annotations: readOnly,
  }, () => {
    const { boxes, officeTelemetry, officeCapacity } = office.snapshot();
    return data({ boxes, officeTelemetry, officeCapacity });
  });

  command('add_box', 'Register and connect a worker box. Requires destination (SSH user@host, alias or Tailscale name); name is optional.',
    { destination: text, name: z.string().max(40).optional() }, ({ name, destination }) => office.addBox(name, destination));
  command('remove_box', 'Remove a worker box from the fleet and clear its floor/agent placements. Running CLIs finish there; the remote machine is not deleted. Requires boxId.',
    { boxId: id }, ({ boxId }) => office.removeBox(boxId), true);
  command('check_box', 'Reconnect or refresh a worker box and retry a failed version sync. Requires boxId.',
    { boxId: id }, ({ boxId }) => office.checkBox(boxId));
  command('set_fleet_capacity', 'Set a machine capacity classification. Requires machineId (box ID, or empty string for the office) and capacity.',
    { machineId: z.string().max(200), capacity: z.enum(['fixed', 'resizable', 'unknown']) },
    ({ machineId, capacity }) => office.setMachineCapacity(machineId, capacity));

  command('stop_agent', 'Stop an agent session and hold its work. Requires agentId.', { agentId: id }, ({ agentId }) => office.stopAgent(agentId), true);
  command('reset_agent', 'Reset an agent desk, clearing its current task and conversation so it can start fresh. Requires agentId.',
    { agentId: id }, ({ agentId }) => office.resetAgent(agentId), true);
  command('assign_agent', 'Assign a floor issue to an agent. Requires agentId and issueNumber; optionally include a note.',
    { agentId: id, issueNumber: z.number().int().positive(), note: z.string().optional() },
    ({ agentId, issueNumber, note }) => office.assign(agentId, issueNumber, note));
  command('message_agent', 'Send instructions to an agent session. Requires agentId and text.',
    { agentId: id, text }, ({ agentId, text }) => office.message(agentId, text));
  command('dismiss_agent', 'Dismiss an agent, stop its session and remove its desk/worktree. The only QA on a floor cannot be dismissed. Requires agentId.',
    { agentId: id }, ({ agentId }) => office.fireAgent(agentId), true);
  command('update_agent', 'Update an agent profile, CLI/model or box placement. Requires agentId and patch; null box restores the floor placement.',
    { agentId: id, patch: z.object({
      name: z.string().optional(), model: z.string().optional(), effort: z.string().optional(), cli: z.string().optional(),
      look: z.string().optional(), title: z.string().optional(), specialty: z.string().optional(), brief: z.string().optional(),
      color: z.string().optional(), hair: z.string().optional(), box: z.string().nullable().optional(),
    }).strict() }, ({ agentId, patch }) => office.updateAgent(agentId, patch));
  command('prepare_image_prompt', 'Prepare an image generation prompt for an agent. Requires agentId and text; returns the prepared text.',
    { agentId: id, text }, async ({ agentId, text }) => ({ text: await office.prepareImagePrompt(agentId, text) }));
  server.registerTool('get_agent_screen', {
    description: 'Get the latest agent screenshot as an MCP image with its capture time. Requires agentId; returns an error if no screenshot exists.',
    inputSchema: { agentId: id }, annotations: readOnly,
  }, ({ agentId }) => runCommand(async () => {
    const shot = office.screenshot(agentId);
    if (!shot) throw new HttpError(404, 'No screenshot available for this agent.');
    return { structuredContent: { agentId, at: shot.at }, content: [
      { type: 'image', data: shot.data.toString('base64'), mimeType: shot.mime },
    ] };
  }));

  command('add_floor', 'Create a new GitHub repository and connect it as a floor. Requires name; visibility defaults to private. Optionally set owner, description, mission and autoAssign.',
    { name: text, owner: text.optional(), description: z.string().optional(), visibility: z.enum(['private', 'public']).default('private'), ...floorOptions },
    ({ name, ...options }) => office.createRepo(name, options));
  command('connect_floor', 'Connect an existing GitHub repository as a floor. Requires fullName (owner/repo); optionally set mission and autoAssign.',
    { fullName: text, ...floorOptions }, ({ fullName, ...options }) => office.connectRepo(fullName, options));
  command('connect_folder', 'Connect a local project folder already on GitHub as a floor. Requires path on the office machine; optionally set mission and autoAssign.',
    { path: text, ...floorOptions }, ({ path, ...options }) => office.connectFolder(path, options));
  command('update_floor', 'Update a floor profile, automation, preview configuration or box placement. Requires repoId and patch; everyone clears agent box overrides when moving a floor.',
    { repoId: id, patch: z.object({
      autoAssign: z.boolean().optional(), autoMerge: z.boolean().optional(), browserTesting: z.boolean().optional(),
      color: z.string().optional(), links: z.array(id).optional(), mission: z.string().optional(), summary: z.string().optional(), qaBrief: z.string().optional(),
      previewCommand: z.string().nullable().optional(), previewEnv: z.record(z.string(), z.string()).nullable().optional(),
      box: z.string().optional(), everyone: z.boolean().optional(),
    }).strict() }, ({ repoId, patch }) => office.updateRepo(repoId, patch));
  command('remove_floor', 'Disconnect a floor, dismiss all its agents and remove its preview and QA state. The GitHub repository and project folder remain. Requires repoId.',
    { repoId: id }, ({ repoId }) => office.disconnectRepo(repoId), true);
  command('sync_floor', 'Refresh a floor issues and pulls from GitHub. Requires repoId.', { repoId: id }, ({ repoId }) => office.syncRepo(repoId));
  command('sync_floor_folder', 'Sync a floor project folder to its default branch. Requires repoId.', { repoId: id }, ({ repoId }) => office.syncFolderNow(repoId));
  command('plan_floor', 'Ask the CEO to plan work for a floor. Requires repoId; optionally replace its mission before planning.',
    { repoId: id, mission: z.string().max(4000).optional() }, ({ repoId, mission }) => office.planFloor(repoId, mission));
  command('onboard_floor', 'Queue CEO onboarding for a connected floor. Requires repoId.', { repoId: id }, ({ repoId }) => office.onboardFloor(repoId));
  command('stop_preview', 'Stop and remove a floor preview. Requires repoId.', { repoId: id }, ({ repoId }) => office.stopPreview(repoId), true);

  command('merge_pull', 'Merge a pull request into the floor default branch, modifying the repository and closing resolved issues. Uses the console merge checks. Requires repoId and number; method defaults to squash.',
    { ...pull, method: z.enum(['squash', 'merge', 'rebase']).default('squash') }, ({ repoId, number, method }) => office.mergePull(repoId, number, method), true);
  command('close_pull', 'Close an unmerged pull request on GitHub and refresh the floor. Requires repoId and number.', pull,
    ({ repoId, number }) => office.closePull(repoId, number), true);
  command('run_qa', 'Dispatch QA for a pull request. Requires repoId and number.', pull, ({ repoId, number }) => office.sendToQa(repoId, number));
  command('approve_prototype', 'Approve the reviewed prototype revision and turn its existing issue into an implementation issue. Requires repoId, number, head (reviewed commit SHA), title and body.',
    { ...pull, head: text, title: text, body: text }, ({ repoId, number, head, title, body }) => office.approvePrototype(repoId, number, head, title, body));
  command('revise_prototype', 'Request changes to the reviewed prototype revision. Requires repoId, number, head (reviewed commit SHA) and feedback.',
    { ...pull, head: text, feedback: text }, ({ repoId, number, head, feedback }) => office.revisePrototype(repoId, number, head, feedback));

  command('close_office', 'Close the office to new work across all floors. Running jobs drain before it becomes safe to shut down; reopen to resume scheduling. No arguments.', {}, () => office.closeOffice(), true);
  command('reopen_office', 'Reopen the office and resume scheduling held work. No arguments.', {}, () => office.reopenOffice());
  command('update_office', 'Request the office launcher update now, or postpone it. Requires action: now or later; the launcher must support updates.',
    { action: z.enum(['now', 'later']) }, ({ action }) => office.updateOffice(action), true);
  command('update_settings', 'Update office settings using the console rules. Requires patch with the settings to change; read get_office_snapshot for current values.',
    { patch: z.object({
      sessionLimit: z.number().int().nonnegative().optional(), defaultModel: z.string().optional(),
      defaultEffort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
      runtime: z.enum(['terminal', 'sdk']).optional(), defaultCli: z.enum(['claude', 'codex', 'opencode']).optional(),
      hiring: z.enum(['approve', 'auto']).optional(), teamCap: z.number().int().min(1).max(15).optional(),
      ceoHeartbeatMin: z.number().int().min(0).max(1440).optional(), managerName: z.string().optional(), companyName: z.string().optional(),
      projectsDir: text.optional(), setupDone: z.boolean().optional(), tutorialStep: z.number().int().min(-1).optional(),
      autoUpdate: z.boolean().optional(), pacingSessions: z.number().int().nonnegative().optional(),
    }).strict() }, ({ patch }) => office.updateSettings(patch));

  command('retry_telegram', 'Retry the first uncertain Telegram delivery. May deliver a duplicate if the original succeeded. No arguments.', {}, () => office.telegramCommand('retry'));
  command('skip_telegram', 'Discard the first uncertain Telegram delivery and continue with the outbox. No arguments.', {}, () => office.telegramCommand('skip'), true);
  command('mark_phone_read', 'Mark the shared phone read through at (epoch milliseconds), defaulting to now. No required arguments.',
    { at: z.number().int().nonnegative().optional() }, ({ at }) => office.markPhoneRead(at ?? Date.now()));
  command('send_ceo_message', 'Send a manager instruction through the shared phone, recording MCP origin. Requires text and a UUID requestId; reuse both for an uncertain retry. Same behavior as send_message.',
    { text: text.max(4000), requestId: z.uuid().transform((id) => id.toLowerCase()) }, ({ text, requestId }) => office.messageCeoFromMcp(text, requestId));
  command('request_ceo_review', 'Queue a company review by the CEO. Requires an open office with at least one floor; no arguments.', {}, () => office.requestReview());
  command('request_research', 'Brief the researcher. Requires text; optionally supply repoId for floor context.',
    { text, repoId: id.optional() }, ({ text, repoId }) => office.briefResearcher(text, repoId));

  command('create_idea', 'Submit an idea for research. Requires description; optionally include constraints, links, floorHints (floor IDs) or linkedFrom (existing idea ID).',
    { description: text.max(2000), constraints: z.string().max(10000).optional(), links: z.array(text).max(50).optional(),
      floorHints: z.array(id).max(50).optional(), linkedFrom: id.optional() }, (args) => office.submitIdea(args));
  command('reply_idea', 'Answer a researcher clarification on an idea. Requires ideaId and answer.',
    { ideaId: id, answer: text }, ({ ideaId, answer }) => office.replyToIdea(ideaId, answer));
  command('retry_idea', 'Retry research for an idea. Requires ideaId.', { ideaId: id }, ({ ideaId }) => office.retryIdeaResearch(ideaId));
  command('reject_request', 'Reject a pending staffing request. Requires requestId; optionally include a note explaining the decision.',
    { requestId: id, note: z.string().optional() }, ({ requestId, note }) => office.rejectRequest(requestId, note));
  command('retry_publication', 'Retry publication of an already approved proposal issue plan. Requires proposalId (the publication ID). Approval is never implied.',
    { proposalId: id }, ({ proposalId }) => office.retryPublication(proposalId));
  return server;
}

async function runCommand(command: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try { return await command(); }
  catch (error) {
    const message = error instanceof HttpError && error.status < 500 ? error.message
      : 'CubeFarm could not confirm the command. Check the office before sending new work.';
    return { isError: true, content: [{ type: 'text' as const, text: message }] };
  }
}

export function managerMcpRouter(office: Office, settings: ManagerMcpSettings) {
  const router = express.Router();

  router.all('/', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const fail = (status: number, message: string) => res.status(status).json({ jsonrpc: '2.0', id: null, error: { code: -32000, message } });
    const expected = settings.activeDigest();
    if (!expected) return void fail(404, 'Manager MCP is disabled.');
    // Native clients do not send Origin. This gateway has no browser clients or cross-origin access.
    if (req.get('Origin') !== undefined) return void fail(403, 'Browser origins are not allowed.');
    const supplied = /^Bearer ([A-Za-z0-9._~-]{32,256})$/i.exec(req.get('Authorization') ?? '')?.[1];
    if (!supplied || !timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(managerTokenDigest(supplied), 'hex'))) {
      res.set('WWW-Authenticate', 'Bearer realm="cubefarm-manager"');
      return void fail(401, 'A valid manager MCP bearer token is required.');
    }
    if (req.method !== 'POST') {
      res.set('Allow', 'POST');
      return void fail(405, 'This stateless gateway only supports POST.');
    }
    next();
  });

  router.post('/', express.json({ limit: '64kb' }), async (req, res) => {
    const server = createManagerServer(office);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } finally {
      await server.close();
    }
  });
  return router;
}
