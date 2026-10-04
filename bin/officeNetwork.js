// Bind configuration is separate from the local URLs used by browsers, probes and agent callbacks.
export function officeHost(env = process.env) {
  return env.SWARM_HOST || '127.0.0.1';
}

export function bindMessage(host, port) {
  const bind = `Listening on ${host}:${port}`;
  return host === '127.0.0.1'
    ? `${bind} (loopback only)`
    : `${bind} · remote: http://<office-machine-LAN-IP>:${port} · trusted LAN only: manager API and terminals have no manager login`;
}
