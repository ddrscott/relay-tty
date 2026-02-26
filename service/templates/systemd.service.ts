export function systemdService(opts: {
  nodePath: string;
  serverPath: string;
  port: number;
  jwtSecret?: string;
}): string {
  const envLines = [
    `Environment=PORT=${opts.port}`,
    `Environment=NODE_ENV=production`,
  ];

  if (opts.jwtSecret) {
    envLines.push(`Environment=JWT_SECRET=${opts.jwtSecret}`);
  }

  return `[Unit]
Description=relay-tty terminal relay service
After=network.target

[Service]
Type=simple
ExecStart=${opts.nodePath} ${opts.serverPath}
${envLines.join("\n")}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}
