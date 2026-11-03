// External manager tools share the phone and proposal workflow without exposing the CEO's internal MCP tools.
import { timingSafeEqual } from 'node:crypto';
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { VERSION } from './config.ts';
import { HttpError } from './httpError.ts';
import { managerTokenDigest, type ManagerMcpSettings } from './managerMcpSettings.ts';
import type { Swarm } from './swarm.ts';

type Office = Pick<Swarm, 'snapshot' | 'messageCeoFromMcp' | 'decideProposalFromMcp'>;
const data = (value: Record<string, unknown>) => ({
  structuredContent: value,
  content: [{ type: 'text' as const, text: JSON.stringify(value) }],
});
const readOnly = { readOnlyHint: true, openWorldHint: false };

function createManagerServer(office: Office) {
  const server = new McpServer({ name: 'cubefarm-manager', version: VERSION });
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
  return server;
}

async function runCommand(command: () => Promise<ReturnType<typeof data>>) {
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
