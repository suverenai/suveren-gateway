{
  "name": "@humanagencyp/hap-gateway",
  "version": "__VERSION__",
  "description": "Human Agency Protocol — local gateway for governing AI agent tool use. Runs the UI, control plane, and MCP server in one Node process.",
  "type": "module",
  "main": "server.js",
  "bin": {
    "hap-gateway": "bin/hap-gateway.js"
  },
  "scripts": {
    "postinstall": "node scripts/postinstall.js"
  },
  "files": [
    "bin",
    "dist",
    "scripts",
    "content",
    "profiles",
    "server.js",
    "README.md"
  ],
  "engines": {
    "node": ">=20"
  },
  "dependencies": {},
  "repository": {
    "type": "git",
    "url": "git+https://github.com/humanagencyprotocol/hap-gateway.git"
  },
  "homepage": "https://www.humanagencyprotocol.com",
  "license": "MIT",
  "keywords": [
    "hap",
    "human-agency-protocol",
    "ai-agent",
    "mcp",
    "gateway",
    "authorization"
  ]
}
