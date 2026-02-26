export function launchdPlist(opts: {
  nodePath: string;
  serverPath: string;
  port: number;
  logDir: string;
  jwtSecret?: string;
}): string {
  const envEntries = [
    `      <key>PORT</key>
      <string>${opts.port}</string>`,
    `      <key>NODE_ENV</key>
      <string>production</string>`,
  ];

  if (opts.jwtSecret) {
    envEntries.push(
      `      <key>JWT_SECRET</key>
      <string>${opts.jwtSecret}</string>`
    );
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.relay-tty</string>

  <key>ProgramArguments</key>
  <array>
    <string>${opts.nodePath}</string>
    <string>${opts.serverPath}</string>
  </array>

  <key>EnvironmentVariables</key>
  <dict>
${envEntries.join("\n")}
  </dict>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <key>StandardOutPath</key>
  <string>${opts.logDir}/relay-tty.stdout.log</string>

  <key>StandardErrorPath</key>
  <string>${opts.logDir}/relay-tty.stderr.log</string>
</dict>
</plist>
`;
}
